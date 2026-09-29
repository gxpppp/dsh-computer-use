/**
 * `computer_use_status` —— 环境自检与授权重置。
 *
 * 这是排查「CU 为什么不动」的第一站：它报告 helper 定位结果、进程状态、
 * 系统截图能力、已授权应用清单，并可选地做一次只读连通性探针。
 * @module dsh-computer-use/tools/status
 */
import { existsSync } from 'node:fs'
import { release as osRelease } from 'node:os'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { probeDesktopSession } from '../desktop/session.ts'
import { discoverCodexCliPath, discoverHelperPath, describeError } from '../transport/helper.ts'
import { formatError, type ToolHost } from './context.ts'

/** 当前系统的截图能力判定。 */
export type CaptureCapability = {
  /** Windows 主版本号，例如 10 / 11。 */
  windowsMajor: number
  /** 完整构建号，例如 19045。 */
  build: number
  /**
   * Windows.Graphics.Capture 的 SetIsBorderRequired 是否可用。
   * 该 API 自 Windows 11 (build 22000) 起提供，缺失时 helper 的截图路径整体失败。
   */
  screenshot: boolean
  /** 说明文本。 */
  note: string
}

/** 判断本机是否具备 helper 的截图能力。 */
export function detectCaptureCapability(): CaptureCapability {
  const release = osRelease()
  const parts = release.split('.')
  const major = Number(parts[0] ?? 0)
  // Windows 上报形如 "10.0.19045"：主版本恒为 10，真正的代际区分在第三段构建号。
  const build = Number(parts[2] ?? 0)
  const isWindows = process.platform === 'win32'

  if (!isWindows) {
    return {
      windowsMajor: major,
      build,
      screenshot: false,
      note: `当前平台为 ${process.platform}，本插件只实现 Windows 后端。`,
    }
  }
  if (build >= 22000) {
    return { windowsMajor: major, build, screenshot: true, note: 'Windows 11 及以上：WGC 截图可用。' }
  }
  return {
    windowsMajor: major || 10,
    build,
    screenshot: false,
    note:
      `Windows 构建号 ${build} 低于 22000，缺少 GraphicsCaptureSession.SetIsBorderRequired；` +
      'helper 的截图调用会返回 0x80004002。可访问性树与输入注入不受影响。',
  }
}

export function registerStatusTool(host: ToolHost): ToolDefinition[] {
  const status = defineTool({
    name: 'computer_use_status',
    description: [
      'Report whether Windows Computer Use can run on this machine: helper discovery, process state,',
      'screenshot capability, and which apps are already authorized.',
      'Call this first when a Computer Use tool fails, or before promising desktop automation.',
      'Set action="reset" to drop every in-process app authorization and restart the helper.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ['report', 'reset'],
        description: 'report (default) inspects the stack; reset clears authorizations and restarts the helper.',
      },
      probe: {
        type: 'boolean',
        description: 'When true, also run one read-only list_windows call to prove the helper answers. Default false.',
      },
    },
    output: {
      schema: { type: 'object' as const, additionalProperties: true as const },
      render: (_args: unknown, value: Record<string, unknown>): ContentBlock[] => [
        { type: 'text', text: typeof value.summary === 'string' ? value.summary : JSON.stringify(value, null, 2) },
      ],
    },
    execute: async (args, exec) => {
      const config = host.config()
      const helper = host.helper()
      const action = typeof args.action === 'string' ? args.action : 'report'

      const notices: string[] = []
      let clearedApprovals = 0
      if (action === 'reset') {
        clearedApprovals = helper.forgetApprovals()
        await helper.restart()
        notices.push(`已清除 ${clearedApprovals} 个应用授权并重启 helper；下次触碰应用会重新请求确认。`)
      }

      const problems: string[] = []
      if (!config.enabled) problems.push('插件已在设置中禁用（enabled=false）。')

      const helperPath = config.helperPath.trim() !== '' ? config.helperPath.trim() : (discoverHelperPath() ?? '')
      const codexCliPath = config.codexCliPath.trim() !== '' ? config.codexCliPath.trim() : (discoverCodexCliPath() ?? '')

      const helperFound = helperPath !== '' && existsSync(helperPath)
      if (!helperFound) {
        problems.push('未定位到 codex-computer-use.exe。请安装 Codex 桌面版，或在插件设置里指定 helperPath。')
      }
      const codexFound = codexCliPath !== '' && existsSync(codexCliPath)
      if (!codexFound) {
        problems.push('未定位到 codex.exe（helper 需要它拉起 app-server）。可在设置里指定 codexCliPath。')
      }

      const capability = detectCaptureCapability()
      // 锁屏会让「激活窗口 / 剪贴板 / 输入注入」同时失灵，是输入类失败的共同根因；
      // 而截图不受影响，所以很容易被误判成一堆互不相关的故障。
      const session = await probeDesktopSession()
      if (session.locked) {
        problems.push(
          `桌面已锁定（前台进程 ${session.foregroundProcess}）：输入类工具会全部失败，截图仍然可用。请先解锁桌面。`,
        )
      }

      let probeResult: string | undefined
      if (args.probe === true && helperFound) {
        try {
          const windows = await helper.call<unknown[]>('list_windows', {}, {
            ask: host.approver(exec.agent, 'computer_use_status', exec.signal),
            timeoutMs: 20_000,
          })
          probeResult = `list_windows 正常返回 ${Array.isArray(windows) ? windows.length : '?'} 个窗口。`
        } catch (error) {
          probeResult = `list_windows 探针失败：${formatError(error)}`
          problems.push(probeResult)
        }
      }

      const summary = [
        'Computer Use 自检',
        `  插件状态     : ${config.enabled ? '启用' : '禁用'}`,
        `  helper       : ${helperFound ? helperPath : '未找到'}`,
        `  codex.exe    : ${codexFound ? codexCliPath : '未找到'}`,
        `  CODEX_HOME   : ${config.codexHome.trim() !== '' ? config.codexHome.trim() : '(默认 %USERPROFILE%\\.codex)'}`,
        `  进程         : ${helper.running ? `运行中 pid=${String(helper.pid ?? '?')}` : '未启动（按需拉起）'}`,
        `  系统         : Windows 构建号 ${capability.build}`,
        `  截图后端     : ${capability.screenshot ? '原生 WGC' : '本地 PrintWindow 兜底'}`,
        `  桌面会话     : ${session.locked ? '已锁定 —— 输入类工具会全部失败' : '正常'}`,
        `  前台进程     : ${session.foregroundProcess || '未知'}`,
        `  已授权应用   : ${helper.authorizedApps.length === 0 ? '（无）' : helper.authorizedApps.join(', ')}`,
        `  免审批白名单 : ${config.alwaysAllowedAppIds.length === 0 ? '（空）' : config.alwaysAllowedAppIds.join(', ')}`,
        ...(probeResult !== undefined ? [`  连通性探针   : ${probeResult}`] : []),
        capability.note,
        ...notices,
        problems.length === 0 ? '结论：可以开始桌面自动化。' : `结论：${problems.length} 项待处理 —— ${problems.join(' / ')}`,
      ].join('\n')

      return {
        action,
        clearedApprovals,
        enabled: config.enabled,
        helperPath,
        helperFound,
        codexCliPath,
        codexFound,
        processRunning: helper.running,
        processPid: helper.pid ?? 0,
        capture: capability,
        desktopLocked: session.locked,
        foregroundProcess: session.foregroundProcess,
        foregroundTitle: session.foregroundTitle,
        authorizedApps: helper.authorizedApps,
        alwaysAllowedAppIds: config.alwaysAllowedAppIds,
        probeResult: probeResult ?? '',
        problems,
        summary,
      }
    },
    isConcurrencySafe: () => true,
  })
  return [status]
}

export { describeError }
