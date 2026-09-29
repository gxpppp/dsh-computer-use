/**
 * `computer_use_launch` —— 启动一个应用并等它出现可目标化窗口。
 *
 * helper 的 `launch_app` 只接受 `list_apps()` 返回的应用 id 或显式 `.exe` 路径；
 * 不接受 pid 型标识。启动后窗口往往需要一点时间才可枚举，因此这里会轮询
 * `list_apps()` 直到出现窗口或超时，省掉模型侧的盲等。
 * @module dsh-computer-use/tools/launch
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AppEntry, WindowRef } from '../transport/types.ts'
import type { ComputerUseHelper } from '../transport/helper.ts'
import type { ApprovalAsker } from '../transport/types.ts'
import { formatError, readInt, readString, type ToolHost } from './context.ts'

/** 轮询窗口出现的默认间隔与上限。 */
const POLL_INTERVAL_MS = 500
const DEFAULT_WAIT_MS = 4_000
const MAX_WAIT_MS = 30_000

export function registerLaunchTool(host: ToolHost): ToolDefinition[] {
  const launch = defineTool({
    name: 'computer_use_launch',
    description: [
      'Launch an app so its window can be targeted, then wait briefly for that window to appear.',
      'Pass an app id returned by computer_use_apps, or an explicit absolute .exe path for an app that is not yet discoverable.',
      'Process ids are not accepted. Returns the windows that appeared, ready to pass to computer_use_state.',
    ].join(' '),
    parameters: {
      app: {
        type: 'string',
        description: 'App id from computer_use_apps, or an absolute path to a launcher .exe. Escape backslashes are not needed; pass the raw Windows path.',
        required: true,
      },
      wait_ms: {
        type: 'number',
        description: `How long to poll for the app window before giving up, 0-${MAX_WAIT_MS}. Default ${DEFAULT_WAIT_MS}.`,
      },
    },
    output: {
      schema: { type: 'object' as const, additionalProperties: true as const },
      render: (_args: unknown, value: Record<string, unknown>): ContentBlock[] => [
        { type: 'text', text: typeof value.summary === 'string' ? value.summary : JSON.stringify(value, null, 2) },
      ],
    },
    execute: async (args, exec) => {
      const app = readString(args, 'app')
      if (app === undefined) throw new Error('launch 需要 app（应用 id 或 .exe 绝对路径）。')
      const waitMs = readInt(args, 'wait_ms', 0, MAX_WAIT_MS) ?? DEFAULT_WAIT_MS

      const helper = host.helper()
      const ask = host.approver(exec.agent, 'computer_use_launch', exec.signal)
      const notes: string[] = []

      // 启动前先记下已知窗口，便于区分"新出现的"窗口。
      const before = await safeListApps(helper, ask)
      await helper.call('launch_app', { app }, { ask })

      const deadline = Date.now() + waitMs
      let windows: WindowRef[] = []
      while (Date.now() < deadline) {
        await delay(POLL_INTERVAL_MS)
        const after = await safeListApps(helper, ask)
        if (after === undefined) break
        windows = freshWindows(before, after, app)
        if (windows.length > 0) break
      }

      if (windows.length === 0) {
        notes.push(
          `未能在 ${waitMs} ms 内确认新窗口。应用可能仍在启动、或以启动器/闪屏形式存在；` +
            '请稍后调用 computer_use_apps 再确认一次。',
        )
      }

      const summary = [
        `已请求启动：${app}`,
        windows.length === 0
          ? '（暂无新窗口）'
          : `发现 ${windows.length} 个窗口：\n${windows
              .map((w) => `  ${w.title ?? '(无标题)'}  id=${w.id}\n    app: ${w.app}`)
              .join('\n')}`,
        ...notes,
      ].join('\n')

      return { app, windows, notes, summary }
    },
    isConcurrencySafe: () => false,
  })
  return [launch]
}

/** 枚举应用；只读且不需要审批，失败时不打断启动流程（返回 undefined 让调用方收手）。 */
async function safeListApps(helper: ComputerUseHelper, ask: ApprovalAsker): Promise<AppEntry[] | undefined> {
  try {
    return await helper.call<AppEntry[]>('list_apps', {}, { ask, timeoutMs: 25_000 })
  } catch {
    return undefined
  }
}

function freshWindows(before: AppEntry[] | undefined, after: AppEntry[], app: string): WindowRef[] {
  const seen = new Set<number>()
  for (const entry of before ?? []) {
    for (const window of entry.windows) seen.add(window.id)
  }
  const target = app.toLowerCase()
  const candidateApps = after.filter(
    (entry) => entry.id.toLowerCase() === target || entry.id.toLowerCase().includes(baseName(target)),
  )
  const pool = candidateApps.length > 0 ? candidateApps : after
  const fresh: WindowRef[] = []
  for (const entry of pool) {
    for (const window of entry.windows) {
      if (seen.has(window.id)) continue
      fresh.push(window)
    }
  }
  return fresh
}

function baseName(value: string): string {
  const parts = value.split(/[\\/]/)
  return (parts[parts.length - 1] ?? value).toLowerCase()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { formatError }
