/**
 * `computer_use_wait` —— 等待界面进入某个状态。
 *
 * 桌面操作里最常见的错误是"动作发得太早"：对话框还没弹出来、列表还没加载完。
 * 让模型反复调用 `computer_use_state` 去轮询既慢又费 token；这个工具把轮询收到一次
 * 调用里，条件满足即返回，超时也会明确说"没等到"而不是假装成功。
 * @module dsh-computer-use/tools/wait
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { WindowRef, WindowState } from '../transport/types.ts'
import { clampText, formatError, readInt, readString, windowOf, type ToolHost } from './context.ts'

/** 支持的等待条件。 */
const CONDITIONS = ['tree_contains', 'tree_not_contains', 'window_closed'] as const
type Condition = (typeof CONDITIONS)[number]

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_INTERVAL_MS = 600
const MIN_INTERVAL_MS = 200

export function registerWaitTool(host: ToolHost): ToolDefinition[] {
  const wait = defineTool({
    name: 'computer_use_wait',
    description: [
      'Wait until a window reaches a state: accessibility text appears or disappears, or the window closes.',
      'Use it instead of polling computer_use_state in a loop after an action that triggers loading, a dialog, or a close.',
      'Returns matched=true only when the condition was observed; on timeout it returns matched=false and the last observed tree.',
      'A condition on a window that no longer exists returns matched=false with a clear note — re-check with computer_use_apps.',
    ].join(' '),
    parameters: {
      window_app: { type: 'string', description: 'Window app identifier, verbatim from computer_use_apps.', required: true },
      window_id: { type: 'number', description: 'Window id, verbatim from computer_use_apps.', required: true },
      until: {
        type: 'string',
        enum: [...CONDITIONS],
        description:
          'tree_contains = the accessibility text starts containing value; tree_not_contains = it stops containing value; window_closed = the window disappears.',
        required: true,
      },
      value: { type: 'string', description: 'Substring to look for in the accessibility text. Required for the tree_* conditions; ignored by window_closed.' },
      timeout_ms: { type: 'number', description: `Give up after this many milliseconds, 500-120000. Default ${DEFAULT_TIMEOUT_MS}.` },
      interval_ms: { type: 'number', description: `Polling interval, ${MIN_INTERVAL_MS}-5000. Default ${DEFAULT_INTERVAL_MS}.` },
      max_tree_chars: { type: 'number', description: 'Cap for the tree returned in the result. Defaults to the plugin setting.' },
    },
    output: {
      schema: { type: 'object' as const, additionalProperties: true as const },
      render: (_args: unknown, value: Record<string, unknown>): ContentBlock[] => [
        { type: 'text', text: typeof value.summary === 'string' ? value.summary : JSON.stringify(value, null, 2) },
      ],
    },
    execute: async (args, exec) => {
      const config = host.config()
      const window = windowOf(args)
      const until = readString(args, 'until') as Condition | undefined
      if (until === undefined || !CONDITIONS.includes(until)) {
        throw new Error(`until 必须是以下之一：${CONDITIONS.join(' / ')}`)
      }
      const value = readString(args, 'value')
      if (until !== 'window_closed' && value === undefined) {
        throw new Error(`${until} 需要 value（要等待出现的文本片段）。`)
      }
      const timeoutMs = readInt(args, 'timeout_ms', 500, 120_000) ?? DEFAULT_TIMEOUT_MS
      const intervalMs = readInt(args, 'interval_ms', MIN_INTERVAL_MS, 5_000) ?? DEFAULT_INTERVAL_MS
      const maxChars = readInt(args, 'max_tree_chars', 2_000, 200_000) ?? config.maxTreeChars

      const helper = host.helper()
      const ask = host.approver(exec.agent, 'computer_use_wait', exec.signal)
      const started = Date.now()
      const deadline = started + timeoutMs

      let attempts = 0
      let lastTree = ''
      let windowGone = false

      for (;;) {
        exec.signal.throwIfAborted()
        attempts += 1

        if (until === 'window_closed') {
          const windows = await helper.call<WindowRef[]>('list_windows', {}, { ask, timeoutMs: 20_000 })
          if (!windows.some((item) => item.id === window.id)) {
            return finish(true, '窗口已关闭。')
          }
        } else {
          try {
            const state = await helper.call<WindowState>(
              'get_window_state',
              { window, include_screenshot: false, include_text: true },
              { ask, timeoutMs: Math.min(20_000, Math.max(2_000, deadline - Date.now())) },
            )
            lastTree = state.accessibility?.tree ?? ''
            const contains = value !== undefined && lastTree.includes(value)
            if (until === 'tree_contains' ? contains : !contains) {
              return finish(
                true,
                until === 'tree_contains'
                  ? `界面已出现「${value}」。`
                  : `界面已不再包含「${value}」。`,
              )
            }
          } catch (error) {
            const message = formatError(error)
            if (/helper 会话结束|会话结束|closed/i.test(message)) {
              windowGone = true
              if (until !== 'tree_contains') return finish(true, '窗口已不可访问，视为满足条件。')
            }
            // 其它错误继续轮询：窗口可能正在重建（例如应用重启）。
          }
        }

        if (Date.now() >= deadline) {
          return finish(
            false,
            windowGone
              ? `等待 ${timeoutMs} ms 超时：窗口当前不可访问。`
              : `等待 ${timeoutMs} ms 超时，条件仍未满足。`,
          )
        }
        await delay(Math.max(MIN_INTERVAL_MS, Math.min(intervalMs, deadline - Date.now())))
      }

      function finish(matched: boolean, note: string) {
        const clamped = clampText(lastTree, maxChars)
        const elapsedMs = Date.now() - started
        const summary = [
          matched ? '条件满足。' : '条件未满足。',
          `条件   : ${until}${value === undefined ? '' : ` = "${value}"`}`,
          `耗时   : ${elapsedMs} ms（轮询 ${attempts} 次）`,
          note,
          matched ? '下一步请基于 computer_use_state 的新观察决定动作。' : '可以再等一次，或改用 computer_use_state 看清当前界面。',
        ].join('\n')
        return {
          matched,
          // until 在进入循环前已收窄；闭包内 TS 无法复用该收窄，这里显式标注。
          condition: until as Condition,
          value: value ?? '',
          elapsedMs,
          attempts,
          windowGone,
          tree: clamped.text,
          notes: [note],
          summary,
        }
      }
    },
    isConcurrencySafe: () => false,
  })
  return [wait]
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
