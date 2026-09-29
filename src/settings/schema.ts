/**
 * dsh-computer-use 的持久化配置与校验规则。
 *
 * 默认值面向本机实况：Codex 已安装、helper 位于 `cua_node` 运行时目录下、
 * 系统为 Windows 10（WGC 截图不可用，UIA 路径可用）。
 * @module dsh-computer-use/settings
 */
import z from '@deepseek-ai/schemastery'

export const COMPUTER_USE_SETTINGS_NAMESPACE = 'dsh-computer-use'

export interface Config {
  enabled: boolean
  /** codex-computer-use.exe 绝对路径；空串表示自动探测。 */
  helperPath: string
  /** codex.exe 绝对路径（helper 需要拉起其 app-server）；空串表示自动探测。 */
  codexCliPath: string
  /** Codex 数据根目录；空串表示 `%USERPROFILE%\.codex`。 */
  codexHome: string
  /** 单次 RPC 超时（毫秒）。 */
  requestTimeoutMs: number
  /** launch_app 专用超时（毫秒），首次启动应用较慢。 */
  launchTimeoutMs: number
  /** 免审批白名单：命中的应用不再弹确认。 */
  alwaysAllowedAppIds: string[]
  /** 动作成功后自动刷新窗口状态并回传，省掉一次模型往返。 */
  autoRefreshAfterAction: boolean
  /** 回传的可访问性树字符上限，超出截断（防止上下文爆炸）。 */
  maxTreeChars: number
  /**
   * 是否允许截图请求。
   *
   * Windows 11 及以上走 helper 的原生捕获；更早的系统自动改走本地 PrintWindow 兜底
   * （约 1–3 秒一次，且读不到硬件加速窗口）。关掉它就完全不请求截图。
   */
  allowScreenshots: boolean
  /** helper 空闲多少毫秒后自动关闭；0 表示常驻。 */
  idleShutdownMs: number
}

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  helperPath: '',
  codexCliPath: '',
  codexHome: '',
  requestTimeoutMs: 15_000,
  launchTimeoutMs: 25_000,
  alwaysAllowedAppIds: [],
  autoRefreshAfterAction: true,
  maxTreeChars: 12_000,
  allowScreenshots: true,
  idleShutdownMs: 5 * 60 * 1000,
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled),
  helperPath: z.string().default(DEFAULT_CONFIG.helperPath),
  codexCliPath: z.string().default(DEFAULT_CONFIG.codexCliPath),
  codexHome: z.string().default(DEFAULT_CONFIG.codexHome),
  requestTimeoutMs: z.number().default(DEFAULT_CONFIG.requestTimeoutMs),
  launchTimeoutMs: z.number().default(DEFAULT_CONFIG.launchTimeoutMs),
  alwaysAllowedAppIds: z.array(z.string()).default([...DEFAULT_CONFIG.alwaysAllowedAppIds]),
  autoRefreshAfterAction: z.boolean().default(DEFAULT_CONFIG.autoRefreshAfterAction),
  maxTreeChars: z.number().default(DEFAULT_CONFIG.maxTreeChars),
  allowScreenshots: z.boolean().default(DEFAULT_CONFIG.allowScreenshots),
  idleShutdownMs: z.number().default(DEFAULT_CONFIG.idleShutdownMs),
})

function assertRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} 必须落在 ${min}–${max} 之间`)
  }
}

/** 拒绝插件无法执行的配置组合。 */
export function validateConfig(config: Config): void {
  assertRange('requestTimeoutMs', config.requestTimeoutMs, 1_000, 300_000)
  assertRange('launchTimeoutMs', config.launchTimeoutMs, 1_000, 600_000)
  assertRange('maxTreeChars', config.maxTreeChars, 2_000, 200_000)
  assertRange('idleShutdownMs', config.idleShutdownMs, 0, 3_600_000)

  for (const appId of config.alwaysAllowedAppIds) {
    if (appId.trim() === '') throw new Error('alwaysAllowedAppIds 不允许空字符串项')
  }
}
