/**
 * 与 `codex-computer-use.exe` 的进程与协议管理。
 *
 * 这是整个插件的命脉：一个惰性启动、可自愈、带审批闭环的 JSON-RPC 客户端。
 * 协议层事实全部来自 Codex 实装（`@oai/sky` 的 WindowsHelperTransport）与本机探针验证：
 *
 * - stdio 按 `\n` 分帧；请求 `{id, method, params, meta}`，响应 `{id, ok, result|error|approvalRequest}`。
 * - helper 需要 `CODEX_HOME` 与 `CODEX_CLI_PATH`（用于拉起 codex app-server），否则报
 *   `failed to launch codex app-server: program not found`。
 * - 首次触碰某应用返回 `approvalRequest`；客户端以 `x-oai-cua-approved-app` 元数据重试即放行。
 * - `list_apps` / `list_windows` 不需审批；`get_window_state` 及各类输入动作需要。
 * @module dsh-computer-use/transport/helper
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  HelperApprovalDeniedError,
  HelperError,
  type ApprovalAsker,
  type HelperApprovalRequest,
  type HelperMethod,
  type RawResponse,
} from './types.ts'

/** 请求预算元数据键（helper 用它决定单请求开销上限）。 */
const BUDGET_KEY = 'x-oai-cua-request-budget-ms'
/** 审批放行元数据键。 */
const APPROVED_APP_KEY = 'x-oai-cua-approved-app'
/** 审批重试上限，防止 helper 与服务端来回扯皮。 */
const MAX_APPROVAL_ROUNDS = 3

/**
 * 在 `%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\<hash>\...` 下定位最新 helper。
 *
 * 目录名是内容哈希，随 Codex 升级变化，因此按 mtime 取最新并缓存探测结果。
 */
export function discoverHelperPath(): string | undefined {
  const local = process.env.LOCALAPPDATA
  if (local === undefined || local === '') return undefined
  return newestUnder(join(local, 'OpenAI', 'Codex', 'runtimes', 'cua_node'), (dir) =>
    join(dir, 'bin', 'node_modules', '@oai', 'sky', 'bin', 'windows', 'codex-computer-use.exe'),
  )
}

/** 在 `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe` 下定位最新主程序。 */
export function discoverCodexCliPath(): string | undefined {
  const local = process.env.LOCALAPPDATA
  if (local === undefined || local === '') return undefined
  return newestUnder(join(local, 'OpenAI', 'Codex', 'bin'), (dir) => join(dir, 'codex.exe'))
}

/** 默认 Codex 数据根：`%CODEX_HOME%`，否则 `%USERPROFILE%\.codex`。 */
export function defaultCodexHome(): string {
  const fromEnv = process.env.CODEX_HOME
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()
  const userProfile = process.env.USERPROFILE
  if (userProfile !== undefined && userProfile !== '') return join(userProfile, '.codex')
  return join(homedir(), '.codex')
}

function newestUnder(root: string, build: (dir: string) => string): string | undefined {
  if (!existsSync(root)) return undefined
  let best: { path: string; mtime: number } | undefined
  for (const entry of safeReaddir(root)) {
    const candidate = build(join(root, entry))
    if (!existsSync(candidate)) continue
    let mtime = 0
    try {
      mtime = statSync(candidate).mtimeMs
    } catch {
      continue
    }
    if (best === undefined || mtime > best.mtime) best = { path: candidate, mtime }
  }
  return best?.path
}

function safeReaddir(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

interface PendingCall {
  resolve: (response: RawResponse) => void
  timer: NodeJS.Timeout
  method: string
}

export interface HelperOptions {
  /** 解析后的 helper 绝对路径（惰性读取，配置变更在下一次启动生效）。 */
  helperPath: () => string
  /** 解析后的 codex.exe 绝对路径。 */
  codexCliPath: () => string
  /** Codex 数据根。 */
  codexHome: () => string
  requestTimeoutMs: () => number
  launchTimeoutMs: () => number
  idleShutdownMs: () => number
  /** 免审批白名单（每次读取，配置变更即时生效）。 */
  alwaysAllowed: () => string[]
  /** 订阅事件流（无 id 的帧、进程退出）。用于诊断工具。 */
  onEvent?: (event: HelperEvent) => void
}

export type HelperEvent =
  | { kind: 'notice'; message: string }
  | { kind: 'exit'; code: number | null; signal: string | null; stderr: string }
  | { kind: 'broadcast'; payload: unknown }

export interface CallOptions {
  /** 需要审批时调用；缺省视为拒绝（fail closed）。 */
  ask?: ApprovalAsker
  /** 覆盖超时。 */
  timeoutMs?: number
}

/**
 * helper 的进程与协议门面。
 *
 * 单实例即可服务整个 host：进程惰性启动、崩溃后自动重建、空闲自动回收。
 */
export class ComputerUseHelper {
  private child: ChildProcess | null = null
  private readonly pending = new Map<number, PendingCall>()
  private readonly approvedApps = new Set<string>()
  private idles: NodeJS.Timeout | null = null
  private buffer = ''
  private stderrTail = ''
  private seq = 0
  private starting: Promise<void> | null = null

  constructor(private readonly options: HelperOptions) {}

  /** 本进程内已获授权的应用标识。 */
  get authorizedApps(): string[] {
    return [...this.approvedApps].sort()
  }

  /** 手动清除授权缓存（computer_use_reset 使用）。 */
  forgetApprovals(): number {
    const count = this.approvedApps.size
    this.approvedApps.clear()
    return count
  }

  /** helper 是否已在本进程内启动。 */
  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed
  }

  /** 当前进程 pid，未启动时为 undefined。 */
  get pid(): number | undefined {
    return this.child?.pid
  }

  /**
   * 发起一次 RPC，自动穿过审批闭环。
   *
   * 收到 `approvalRequest` 时先查白名单与授权缓存，再询问用户；
   * 放行后以 `x-oai-cua-approved-app` 重试同一请求。拒绝即抛
   * {@link HelperApprovalDeniedError}，业务错误抛 {@link HelperError}。
   */
  async call<T = unknown>(
    method: HelperMethod,
    params: Record<string, unknown> = {},
    options: CallOptions = {},
  ): Promise<T> {
    const budget =
      options.timeoutMs ??
      (method === 'launch_app' ? this.options.launchTimeoutMs() : this.options.requestTimeoutMs())
    let retryApproval: string | undefined

    for (let round = 0; round < MAX_APPROVAL_ROUNDS; round++) {
      const response = await this.frame(method, params, budget, retryApproval)
      if (response.ok === true) return response.result as T

      const approval = normalizeApproval(response.approvalRequest)
      if (approval === null) {
        throw new HelperError(method, describeError(response.error))
      }

      const allowed = await this.settleApproval(approval, options.ask)
      if (!allowed) throw new HelperApprovalDeniedError(approval.app, approval.displayName)
      this.approvedApps.add(approval.app)
      // helper 回传的应用标识与请求里的窗口标识未必同名（实测 Edge 是 "msedge.exe" vs "MSEdge"），
      // 所以重试时直接带上刚批准的那个值，而不是回头去猜匹配关系。
      retryApproval = approval.app
    }

    throw new HelperError(method, `审批重试超过 ${MAX_APPROVAL_ROUNDS} 轮仍未放行`)
  }

  /** 关闭 helper；容忍它已经退出。 */
  async stop(): Promise<void> {
    const child = this.child
    this.clearIdle()
    if (child === null) return
    try {
      if (child.exitCode === null && !child.killed) {
        // 优雅路径：让 helper 自己收尾；失败则硬杀。
        await Promise.race([
          this.frame('close', {}, 3_000).catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 3_000)),
        ])
      }
    } finally {
      this.teardown(child, '客户端主动关闭', null)
    }
  }

  /** 立即重建 helper（下个请求会重新 spawn）。 */
  async restart(): Promise<void> {
    await this.stop()
    this.approvedApps.clear()
  }

  private async settleApproval(
    approval: HelperApprovalRequest,
    ask: ApprovalAsker | undefined,
  ): Promise<boolean> {
    if (this.isAllowedByConfig(approval.app)) return true
    if (this.approvedApps.has(approval.app)) return true
    if (ask === undefined) return false
    return ask(approval)
  }

  private isAllowedByConfig(app: string): boolean {
    const allowed = this.options.alwaysAllowed()
    if (allowed.length === 0) return false
    for (const entry of allowed) {
      if (entry === app) return true
      // 配置里可能写 exe 名、完整路径或包标识；两端都做归一化再比。
      if (normalizeAppId(entry) === normalizeAppId(app)) return true
    }
    return false
  }

  private async frame(
    method: HelperMethod | 'close',
    params: Record<string, unknown>,
    timeoutMs: number,
    approvedOverride?: string,
  ): Promise<RawResponse> {
    const child = await this.ensureChild()
    const id = ++this.seq
    const meta = this.buildMeta(method, params, timeoutMs, approvedOverride)

    return new Promise<RawResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new HelperError(method, `请求超时（${timeoutMs} ms）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, timer, method })
      const payload = JSON.stringify({ id, method, params, meta }) + '\n'
      try {
        child.stdin?.write(payload, 'utf8', (error) => {
          if (error === null || error === undefined) return
          const entry = this.pending.get(id)
          if (entry === undefined) return
          this.pending.delete(id)
          clearTimeout(entry.timer)
          reject(new HelperError(method, `写入 helper 失败：${error.message}`))
        })
      } catch (error) {
        const entry = this.pending.get(id)
        if (entry !== undefined) {
          this.pending.delete(id)
          clearTimeout(entry.timer)
        }
        reject(new HelperError(method, `写入 helper 失败：${describeError(error)}`))
      }
    })
  }

  private buildMeta(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    approvedOverride?: string,
  ): Record<string, unknown> {
    const meta: Record<string, unknown> = { [BUDGET_KEY]: timeoutMs }
    // 只对可能触发审批的方法附带授权；只读枚举无需。
    if (method === 'list_apps' || method === 'list_windows' || method === 'close') return meta

    // 审批刚通过的那一个：直接照搬，不做匹配。
    if (approvedOverride !== undefined) {
      meta[APPROVED_APP_KEY] = approvedOverride
      return meta
    }

    const target = targetAppOf(params)
    if (target !== undefined) {
      const approved = this.matchApproved(target)
      if (approved !== undefined) meta[APPROVED_APP_KEY] = approved
    }
    return meta
  }

  private matchApproved(target: string): string | undefined {
    if (this.approvedApps.has(target)) return target
    const wanted = normalizeAppId(target)
    for (const approved of this.approvedApps) {
      if (normalizeAppId(approved) === wanted) return approved
    }
    return undefined
  }

  private ensureChild(): Promise<ChildProcess> {
    const existing = this.child
    if (existing !== null && existing.exitCode === null && !existing.killed) {
      this.clearIdle()
      return Promise.resolve(existing)
    }
    if (this.starting !== null) {
      return this.starting.then(() => {
        const child = this.child
        if (child === null) throw new HelperError('spawn', 'helper 未能启动')
        return child
      })
    }

    this.starting = new Promise<void>((resolve, reject) => {
      const helperPath = this.options.helperPath()
      const codexCliPath = this.options.codexCliPath()
      const codexHome = this.options.codexHome()
      if (!existsSync(helperPath)) {
        reject(
          new HelperError(
            'spawn',
            `未找到 codex-computer-use.exe：${helperPath}。请安装 Codex 桌面版，或在插件设置中指定 helperPath。`,
          ),
        )
        return
      }

      let child: ChildProcess
      try {
        child = spawn(helperPath, ['--parent-pid', String(process.pid)], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            CODEX_HOME: codexHome,
            ...(codexCliPath === '' ? {} : { CODEX_CLI_PATH: codexCliPath }),
          },
        })
      } catch (error) {
        reject(new HelperError('spawn', `启动 helper 失败：${describeError(error)}`))
        return
      }

      this.child = child
      this.buffer = ''
      this.stderrTail = ''

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => this.consume(chunk))
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-4_000)
      })

      // spawn 成功不等于可通信：等 stdout 出现任意帧，或等到第一个请求超时。
      child.once('spawn', () => resolve())
      child.once('error', (error) => {
        this.teardown(child, `启动失败：${error.message}`, null)
        reject(new HelperError('spawn', `helper 启动失败：${error.message}`))
      })
      child.once('exit', (code, signal) => {
        const stderr = this.stderrTail.trim()
        this.teardown(child, code === 130 ? '用户按 ESC 中断' : `退出 code=${code} signal=${signal}`, stderr)
      })
    }).finally(() => {
      this.starting = null
    })

    return this.starting.then(() => {
      const child = this.child
      if (child === null) throw new HelperError('spawn', 'helper 未能启动')
      return child
    })
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index === -1) return
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line !== '') this.dispatch(line)
    }
  }

  private dispatch(line: string): void {
    let payload: RawResponse
    try {
      payload = JSON.parse(line) as RawResponse
    } catch {
      this.options.onEvent?.({ kind: 'notice', message: `helper 输出了非 JSON 行：${line.slice(0, 200)}` })
      return
    }

    if (typeof payload.id !== 'number') {
      // 无 id = helper 的事件广播（例如中断通知）。
      this.options.onEvent?.({ kind: 'broadcast', payload })
      return
    }

    const entry = this.pending.get(payload.id)
    if (entry === undefined) return
    this.pending.delete(payload.id)
    clearTimeout(entry.timer)
    entry.resolve(payload)
  }

  private teardown(child: ChildProcess, reason: string, stderr: string | null): void {
    if (this.child === child) {
      this.child = null
      this.buffer = ''
      this.scheduleIdle()
    }
    const error = new HelperError('transport', `helper 会话结束：${reason}`)
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve({ id, ok: false, error: error.message })
    }
    this.pending.clear()
    if (stderr !== null && stderr !== '') {
      this.options.onEvent?.({ kind: 'exit', code: child.exitCode, signal: child.signalCode, stderr })
    }
    try {
      if (child.exitCode === null && !child.killed) child.kill()
    } catch {
      /* 已退出 */
    }
  }

  private scheduleIdle(): void {
    this.clearIdle()
    const idle = this.options.idleShutdownMs()
    if (idle <= 0) return
    this.idles = setTimeout(() => {
      this.idles = null
      const child = this.child
      if (child !== null && this.pending.size === 0) {
        this.teardown(child, '空闲回收', null)
      }
    }, idle)
    this.idles.unref?.()
  }

  private clearIdle(): void {
    if (this.idles !== null) {
      clearTimeout(this.idles)
      this.idles = null
    }
  }
}

/** 从请求参数里推断目标应用标识，用于匹配授权缓存。 */
function targetAppOf(params: Record<string, unknown>): string | undefined {
  const window = params.window
  if (isRecord(window)) {
    const app = window.app
    if (typeof app === 'string' && app.trim() !== '') return app.trim()
  }
  const app = params.app
  if (typeof app === 'string' && app.trim() !== '') return app.trim()
  return undefined
}

/**
 * 归一化应用标识，让三种写法能互相匹配：
 *
 * - `MSEdge`（包标识）
 * - `msedge.exe`（helper 审批返回的 exe 名）
 * - `process:C:\Windows\System32\notepad.exe`（窗口对象里的进程标识）
 *
 * 统一成小写、去扩展名的叶子名。
 */
function normalizeAppId(value: string): string {
  const cleaned = value.replace(/^process:/i, '')
  const parts = cleaned.split(/[\\/]/)
  const leaf = (parts[parts.length - 1] ?? cleaned).toLowerCase()
  return leaf.endsWith('.exe') ? leaf.slice(0, -4) : leaf
}

/** 规范化 helper 的审批请求；字段不合法时返回 null（交由错误路径处理）。 */
export function normalizeApproval(raw: unknown): HelperApprovalRequest | null {
  if (!isRecord(raw)) return null
  const app = raw.app
  if (typeof app !== 'string' || app.trim() === '') return null
  const display = raw.displayName
  const risk = raw.riskLevel
  return {
    app: app.trim(),
    displayName: typeof display === 'string' && display.trim() !== '' ? display.trim() : app.trim(),
    riskLevel: risk === 'high' || risk === 'low' ? risk : undefined,
    allowPersistentApproval: raw.allowPersistentApproval !== false,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 把任意 error 载荷压成一句可读文本。 */
export function describeError(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (isRecord(error) && typeof error.message === 'string') return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
