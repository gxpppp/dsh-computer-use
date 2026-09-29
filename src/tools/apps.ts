/**
 * `computer_use_apps` —— 枚举可目标化的应用与窗口。
 *
 * 对应 helper 的只读方法 `list_apps` / `list_windows`，两者都不触发应用授权。
 * 返回的窗口对象必须原样回传给其它工具：`window_app` 取 `app`，`window_id` 取 `id`。
 * @module dsh-computer-use/tools/apps
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AppEntry, WindowRef } from '../transport/types.ts'
import { clampText, formatError, readBool, readInt, readString, type ToolHost } from './context.ts'

export function registerAppsTool(host: ToolHost): ToolDefinition[] {
  const apps = defineTool({
    name: 'computer_use_apps',
    description: [
      'List targetable Windows apps (scope="apps", default) or every open targetable window (scope="windows").',
      'Both are read-only and need no approval. Pick exactly one returned window, then pass its app and id',
      'verbatim as window_app / window_id to computer_use_state and computer_use_act.',
      'Never invent or reconstruct a window from guessed fields.',
    ].join(' '),
    parameters: {
      scope: {
        type: 'string',
        enum: ['apps', 'windows'],
        description: 'apps lists installed apps with their open windows; windows lists all open targetable windows flat. Default apps.',
      },
      query: {
        type: 'string',
        description: 'Case-insensitive substring filter over app display name, app id, and window title.',
      },
      limit: { type: 'number', description: 'Maximum entries to return, 1-200. Default 40 for apps, 80 for windows.' },
      include_windows: {
        type: 'boolean',
        description: 'With scope="apps", include each app\'s open windows. Default true.',
      },
    },
    output: {
      schema: { type: 'object' as const, additionalProperties: true as const },
      render: (_args: unknown, value: Record<string, unknown>): ContentBlock[] => [
        { type: 'text', text: typeof value.summary === 'string' ? value.summary : JSON.stringify(value, null, 2) },
      ],
    },
    execute: async (args, exec) => {
      const scope = readString(args, 'scope') === 'windows' ? 'windows' : 'apps'
      const query = readString(args, 'query')?.toLowerCase()
      const limit = readInt(args, 'limit', 1, 200) ?? (scope === 'windows' ? 80 : 40)
      const includeWindows = readBool(args, 'include_windows') ?? true
      const ask = host.approver(exec.agent, 'computer_use_apps', exec.signal)

      const helper = host.helper()

      if (scope === 'windows') {
        const all = await helper.call<WindowRef[]>('list_windows', {}, { ask, timeoutMs: 20_000 })
        const filtered = filterWindows(all, query)
        const shown = filtered.slice(0, limit)
        return {
          scope,
          total: filtered.length,
          apps: [],
          windows: shown,
          summary: renderWindows(shown, filtered.length, all.length),
        }
      }

      const all = await helper.call<AppEntry[]>('list_apps', {}, { ask, timeoutMs: 25_000 })
      const filtered = filterApps(all, query)
      const shown = filtered.slice(0, limit)
      return {
        scope,
        total: filtered.length,
        apps: shown.map((app) => ({
          id: app.id,
          displayName: app.displayName ?? '',
          isRunning: app.isRunning === true,
          windows: includeWindows ? app.windows : [],
        })),
        windows: [],
        summary: renderApps(shown, filtered.length, all.length, includeWindows),
      }
    },
    isConcurrencySafe: () => true,
  })
  return [apps]
}

function filterApps(all: AppEntry[], query: string | undefined): AppEntry[] {
  if (query === undefined) return all
  return all.filter((app) => {
    const haystack = [app.id, app.displayName ?? '', ...app.windows.map((w) => w.title ?? '')]
      .join('\n')
      .toLowerCase()
    return haystack.includes(query)
  })
}

function filterWindows(all: WindowRef[], query: string | undefined): WindowRef[] {
  if (query === undefined) return all
  return all.filter((window) =>
    `${window.app}\n${window.title ?? ''}`.toLowerCase().includes(query),
  )
}

function renderApps(apps: AppEntry[], shown: number, total: number, includeWindows: boolean): string {
  if (apps.length === 0) return `未匹配到应用（共 ${total} 个可枚举应用）。`
  const lines: string[] = [`应用 ${shown} / ${total} 个：`]
  for (const app of apps) {
    const running = app.isRunning === true ? '运行中' : '未运行'
    lines.push(`- ${app.displayName ?? '(无名称)'}  [${running}]`)
    lines.push(`    id: ${app.id}`)
    if (includeWindows && app.windows.length > 0) {
      for (const window of app.windows) {
        lines.push(`    窗口: ${window.title ?? '(无标题)'}  id=${window.id}`)
        lines.push(`      app: ${window.app}`)
      }
    }
  }
  lines.push('提示：把某个窗口的 app / id 原样传给 computer_use_state。')
  return lines.join('\n')
}

function renderWindows(windows: WindowRef[], shown: number, total: number): string {
  if (windows.length === 0) return `未匹配到窗口（共 ${total} 个可目标化窗口）。`
  const lines: string[] = [`窗口 ${shown} / ${total} 个：`]
  for (const window of windows) {
    lines.push(`- ${clampText(window.title ?? '(无标题)', 120).text}  id=${window.id}`)
    lines.push(`    app: ${window.app}`)
  }
  return lines.join('\n')
}

export { formatError }
