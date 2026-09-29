/**
 * `computer_use_act` —— 在窗口上执行一个输入动作。
 *
 * 纪律来自 Codex 的 guidance：先观察（computer_use_state）、再动作、动作后立即重新观察。
 * 因此每个动作默认会自动刷新一次窗口状态并回传，省掉一次模型往返；刷新失败也不会
 * 吞掉动作本身的结果。
 *
 * 两条工程上的加固：
 *   - 窗口状态失效（最小化 / 几何变化 / 句柄失效）时就地恢复并重试一次，不占用模型回合；
 *   - `paste_text` 走「写剪贴板 + Ctrl+V」，用于中文与长文本——逐字符注入对这两者都不可靠。
 * @module dsh-computer-use/tools/act
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { setClipboardText } from '../input/clipboard.ts'
import { probeDesktopSession } from '../desktop/session.ts'
import type { ComputerUseHelper } from '../transport/helper.ts'
import type { ApprovalAsker, WindowRef, WindowState } from '../transport/types.ts'
import {
  clampText,
  formatError,
  formatWindowState,
  readBool,
  readInt,
  readString,
  windowOf,
  type ToolHost,
} from './context.ts'
import { withWindowRecovery } from './recovery.ts'

/** 支持的动作类型。 */
const ACTIONS = [
  'click',
  'click_element',
  'type_text',
  'paste_text',
  'press_key',
  'scroll',
  'drag',
  'set_value',
  'perform_secondary_action',
  'activate_window',
] as const

type ActionName = (typeof ACTIONS)[number]

/**
 * 需要键盘焦点的动作。
 *
 * 实测结论（本机 Windows 10 + Codex 26.901.51231）：**凡是注入键盘输入的路径都依赖目标窗口
 * 持有真正的键盘焦点**——包括 `type_text`。焦点不在目标窗口时，helper 照样返回成功，
 * 界面却毫无变化，形成最难排查的"假成功"。
 *
 * 焦点还有个特点：一旦被其它进程（编辑器、终端、任何被拉起的窗口）抢走，后台进程
 * 就**再也夺不回来**，因为 Windows 只允许"最近收到过用户输入"的进程调用
 * `SetForegroundWindow`。所以这里的激活既必要、又可能失败——失败时宁可报错，
 * 也不要让调用方拿到一个看起来成功的空动作。
 */
const FOCUS_REQUIRED = new Set<ActionName>(['type_text', 'press_key', 'paste_text'])

export function registerActTool(host: ToolHost): ToolDefinition[] {
  const act = defineTool({
    name: 'computer_use_act',
    description: [
      'Perform exactly ONE input action on a window, then (by default) refresh and return the window state.',
      'Element indexes come from the latest computer_use_state call and are invalid after any action — observe again before the next one.',
      'Prefer click_element over coordinate clicks when the accessibility tree exposes the target.',
      'Use paste_text instead of type_text for Chinese text or more than a short phrase.',
      'Never automate terminal apps, credential prompts, or security dialogs.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: [...ACTIONS],
        description: [
          'click = coordinate click (needs x,y); click_element = click an indexed element (needs element_index);',
          'type_text = type literal text into current focus; paste_text = put text on the clipboard and send Ctrl+V (use this for Chinese or long text);',
          'press_key = one key or +-joined chord; scroll = scroll from a coordinate (needs x,y,scroll_x,scroll_y);',
          'drag = drag between two coordinates; set_value = replace an indexed editable element\'s value;',
          'perform_secondary_action = invoke an indexed element\'s secondary action; activate_window = bring the window to the foreground.',
        ].join(' '),
        required: true,
      },
      window_app: { type: 'string', description: 'Window app identifier, verbatim from computer_use_apps.', required: true },
      window_id: { type: 'number', description: 'Window id, verbatim from computer_use_apps.', required: true },
      element_index: { type: 'number', description: 'Element index from the latest computer_use_state accessibility tree.' },
      x: { type: 'number', description: 'Window-relative X for click / scroll / drag origin.' },
      y: { type: 'number', description: 'Window-relative Y for click / scroll / drag origin.' },
      from_x: { type: 'number', description: 'Drag origin X.' },
      from_y: { type: 'number', description: 'Drag origin Y.' },
      to_x: { type: 'number', description: 'Drag destination X.' },
      to_y: { type: 'number', description: 'Drag destination Y.' },
      scroll_x: { type: 'number', description: 'Horizontal scroll delta; negative scrolls left.' },
      scroll_y: { type: 'number', description: 'Vertical scroll delta; negative scrolls up.' },
      text: { type: 'string', description: 'Literal text for type_text, or the payload for paste_text. Control keys need press_key instead.' },
      key: { type: 'string', description: 'Key or +-joined chord for press_key, e.g. Return, Tab, Control_L+a, KP_0.' },
      value: { type: 'string', description: 'Replacement value for set_value.' },
      secondary_action: { type: 'string', description: 'Secondary action label for perform_secondary_action, e.g. Expand, Scroll Down.' },
      click_count: { type: 'number', description: 'Number of clicks, 1-3. Default 1.' },
      mouse_button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Default left.' },
      refresh: { type: 'boolean', description: 'Refresh window state after the action. Defaults to the plugin setting.' },
    },
    output: {
      schema: { type: 'object' as const, additionalProperties: true as const },
      render: (_args: unknown, value: Record<string, unknown>): ContentBlock[] => [
        { type: 'text', text: typeof value.summary === 'string' ? value.summary : JSON.stringify(value, null, 2) },
      ],
    },
    execute: async (args, exec) => {
      const config = host.config()
      const action = readString(args, 'action') as ActionName | undefined
      if (action === undefined || !ACTIONS.includes(action)) {
        throw new Error(`action 必须是以下之一：${ACTIONS.join(' / ')}`)
      }
      const window = windowOf(args)
      const helper = host.helper()
      const ask = host.approver(exec.agent, 'computer_use_act', exec.signal)
      const notes: string[] = []

      const notesBefore = notes.length
      let applied: { window: WindowRef; description: string }
      try {
        applied = await applyAction(action, args, window, helper, ask, notes)
      } catch (error) {
        throw await explainActionFailure(action, error)
      }
      if (notes.length > notesBefore) {
        // 恢复说明已经在 notes 里了，不再重复。
      }
      const effectiveWindow = applied.window
      const description = applied.description

      const shouldRefresh = readBool(args, 'refresh') ?? config.autoRefreshAfterAction
      let refreshed: WindowState | null = null
      let refreshNote = ''
      if (shouldRefresh) {
        try {
          refreshed = await helper.call<WindowState>(
            'get_window_state',
            { window: effectiveWindow, include_screenshot: false, include_text: true },
            { ask, timeoutMs: config.requestTimeoutMs + 5_000 },
          )
        } catch (error) {
          refreshNote = `动作已执行，但自动刷新失败：${formatError(error)}。请在下一步重新调用 computer_use_state。`
        }
      }

      const parts = [`已执行 ${description}。`]
      if (refreshNote !== '') parts.push(refreshNote)
      parts.push(...notes)

      if (refreshed !== null) {
        const clamped = clampText(refreshed.accessibility?.tree ?? '', config.maxTreeChars)
        parts.push('动作后状态：')
        parts.push(
          formatWindowState(
            { window: refreshed.window ?? effectiveWindow, screenshots: [], accessibility: refreshed.accessibility },
            config.maxTreeChars,
          ),
        )
        parts.push('（若还需继续操作，请基于上面这棵树的新索引。）')
        return {
          action,
          description,
          refreshed: true,
          window: refreshed.window ?? effectiveWindow,
          tree: clamped.text,
          notes,
          summary: parts.join('\n'),
        }
      }

      parts.push('未自动刷新；下一步请先调用 computer_use_state 重新观察。')
      return {
        action,
        description,
        refreshed: false,
        window: effectiveWindow,
        tree: '',
        notes,
        summary: parts.join('\n'),
      }
    },
    isConcurrencySafe: () => false,
  })
  return [act]
}

/**
 * 输入类动作失败时的错误增强。
 *
 * 「failed to activate captured window」在锁屏时会成片出现，而它的字面意思完全指不到
 * 真正的原因。这里补一次桌面探测，把原因直说出来，免得模型换着法子重试。
 */
async function explainActionFailure(action: ActionName, error: unknown): Promise<Error> {
  const message = formatError(error)
  const original = error instanceof Error ? error : new Error(message)
  if (!/failed to activate|activate captured window|SetForegroundWindow/i.test(message)) return original

  try {
    const session = await probeDesktopSession()
    if (!session.locked) return original
    return new Error(
      `桌面已锁定，无法把窗口带到前台，因此 ${action} 没有执行。\n` +
        `前台进程：${session.foregroundProcess}${session.foregroundTitle === '' ? '' : `（${session.foregroundTitle}）`}\n` +
        '请让用户先解锁桌面，或手动点击目标窗口使其成为前台，然后再重试。' +
        '锁定期间不要重复尝试任何输入类动作——它们会以完全相同的方式失败。',
    )
  } catch {
    return original
  }
}

/** 执行一个动作（含剪贴板捷径与窗口自愈）。 */
async function applyAction(
  action: ActionName,
  args: Record<string, unknown>,
  window: WindowRef,
  helper: ComputerUseHelper,
  ask: ApprovalAsker,
  notes: string[],
): Promise<{ window: WindowRef; description: string }> {
  // 键盘类动作先确保前台：否则按键会静默落空，而调用方无从察觉。
  const target = FOCUS_REQUIRED.has(action)
    ? await ensureForeground(helper, window, ask)
    : window

  if (action === 'paste_text') {
    const text = args.text
    if (typeof text !== 'string' || text === '') throw new Error('paste_text 需要非空的 text。')
    const clipboard = await setClipboardText(text)

    if (!clipboard.ok) {
      // 剪贴板可能被系统独占（锁屏）或在受限环境里不可用。退回逐字符注入：
      // 短文本与 ASCII 仍能输入，长中文可能不完整——把这次降级如实写进 notes。
      notes.push(`剪贴板不可用（${clipboard.note}），已降级为逐字符输入。`)
      const fallback = await withWindowRecovery(
        helper,
        target,
        ask,
        (win) => helper.call('type_text', { window: win, text }, { ask }),
        notes,
      )
      return {
        window: fallback.window,
        description: `逐字符输入 ${text.length} 个字符（剪贴板不可用，已降级）`,
      }
    }

    notes.push(clipboard.note)
    const outcome = await withWindowRecovery(
      helper,
      target,
      ask,
      (win) => helper.call('press_key', { window: win, key: 'Control_L+v' }, { ask }),
      notes,
    )
    return { window: outcome.window, description: `经剪贴板粘贴 ${text.length} 个字符` }
  }

  if (action === 'activate_window') {
    const outcome = await withWindowRecovery(
      helper,
      window,
      ask,
      (win) => helper.call('activate_window', { window: win }, { ask }),
      notes,
    )
    return { window: outcome.window, description: '激活窗口' }
  }

  const outcome = await withWindowRecovery(
    helper,
    target,
    ask,
    (win) => {
      const built = buildCall(action, args, win)
      return helper.call(built.method, built.params, { ask })
    },
    notes,
  )
  return { window: outcome.window, description: buildCall(action, args, outcome.window).description }
}

/**
 * 把窗口带到前台，供键盘类动作使用。
 *
 * 激活失败时**直接抛错**而不是继续：目标不在前台时按键必然落空，
 * 与其让调用方拿到一个"动作成功但界面没变"的结果，不如当场说清原因。
 */
async function ensureForeground(
  helper: ComputerUseHelper,
  window: WindowRef,
  ask: ApprovalAsker,
): Promise<WindowRef> {
  try {
    await helper.call('activate_window', { window }, { ask, timeoutMs: 20_000 })
  } catch (error) {
    throw new Error(
      `无法把「${window.title ?? window.app}」带到前台，键盘类动作会静默落空，因此没有执行。\n` +
        `原因：${formatError(error)}\n` +
        '请让用户手动点击该窗口使其获得焦点，或确认桌面未处于锁定状态。',
    )
  }
  await delay(350)
  try {
    const fresh = await helper.call<WindowRef>(
      'get_window',
      { id: window.id, app: window.app },
      { ask, timeoutMs: 20_000 },
    )
    if (fresh !== null && typeof fresh === 'object' && typeof fresh.id === 'number') return fresh
  } catch {
    // 句柄刷新失败就用原引用继续，激活本身已经成功了。
  }
  return window
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type HelperMethodName =
  | 'click'
  | 'click_element'
  | 'scroll'
  | 'drag'
  | 'press_key'
  | 'type_text'
  | 'set_value'
  | 'perform_secondary_action'
  | 'activate_window'

/** 把扁平的工具参数翻译成 helper 的调用形态。 */
function buildCall(
  action: ActionName,
  args: Record<string, unknown>,
  window: WindowRef,
): { method: HelperMethodName; params: Record<string, unknown>; description: string } {
  switch (action) {
    case 'activate_window':
      return { method: 'activate_window', params: { window }, description: '激活窗口' }

    case 'click_element': {
      const elementIndex = readInt(args, 'element_index', 0, Number.MAX_SAFE_INTEGER)
      if (elementIndex === undefined) throw new Error('click_element 需要 element_index（来自最近一次 computer_use_state 的可访问性树）。')
      return {
        method: 'click_element',
        params: {
          window,
          element_index: elementIndex,
          click_count: readInt(args, 'click_count', 1, 3) ?? 1,
          mouse_button: readString(args, 'mouse_button') ?? 'left',
        },
        description: `点击元素 #${elementIndex}`,
      }
    }

    case 'click': {
      const x = readInt(args, 'x', -100_000, 100_000)
      const y = readInt(args, 'y', -100_000, 100_000)
      if (x === undefined || y === undefined) throw new Error('click 需要 x 与 y 坐标。')
      return {
        method: 'click',
        params: {
          window,
          x,
          y,
          click_count: readInt(args, 'click_count', 1, 3) ?? 1,
          mouse_button: readString(args, 'mouse_button') ?? 'left',
        },
        description: `在 (${x}, ${y}) 处点击`,
      }
    }

    case 'type_text': {
      const text = args.text
      if (typeof text !== 'string') throw new Error('type_text 需要 text。')
      return { method: 'type_text', params: { window, text }, description: `输入 ${text.length} 个字符` }
    }

    case 'press_key': {
      const key = readString(args, 'key')
      if (key === undefined) throw new Error('press_key 需要 key，例如 Return、Tab、Control_L+a。')
      return { method: 'press_key', params: { window, key }, description: `按下 ${key}` }
    }

    case 'scroll': {
      const x = readInt(args, 'x', -100_000, 100_000)
      const y = readInt(args, 'y', -100_000, 100_000)
      const scrollX = readInt(args, 'scroll_x', -100_000, 100_000) ?? 0
      const scrollY = readInt(args, 'scroll_y', -100_000, 100_000) ?? 0
      if (x === undefined || y === undefined) throw new Error('scroll 需要 x 与 y 指定滚动起点。')
      if (scrollX === 0 && scrollY === 0) throw new Error('scroll 需要非零的 scroll_x 或 scroll_y。')
      return {
        method: 'scroll',
        params: { window, x, y, scrollX, scrollY },
        description: `从 (${x}, ${y}) 滚动 Δ(${scrollX}, ${scrollY})`,
      }
    }

    case 'drag': {
      const fromX = readInt(args, 'from_x', -100_000, 100_000)
      const fromY = readInt(args, 'from_y', -100_000, 100_000)
      const toX = readInt(args, 'to_x', -100_000, 100_000)
      const toY = readInt(args, 'to_y', -100_000, 100_000)
      if (fromX === undefined || fromY === undefined || toX === undefined || toY === undefined) {
        throw new Error('drag 需要 from_x / from_y / to_x / to_y。')
      }
      return {
        method: 'drag',
        params: { window, from_x: fromX, from_y: fromY, to_x: toX, to_y: toY },
        description: `拖拽 (${fromX}, ${fromY}) → (${toX}, ${toY})`,
      }
    }

    case 'set_value': {
      const elementIndex = readInt(args, 'element_index', 0, Number.MAX_SAFE_INTEGER)
      if (elementIndex === undefined) throw new Error('set_value 需要 element_index。')
      if (typeof args.value !== 'string') throw new Error('set_value 需要 value。')
      return {
        method: 'set_value',
        params: { window, element_index: elementIndex, value: args.value },
        description: `设置元素 #${elementIndex} 的值`,
      }
    }

    case 'perform_secondary_action': {
      const elementIndex = readInt(args, 'element_index', 0, Number.MAX_SAFE_INTEGER)
      if (elementIndex === undefined) throw new Error('perform_secondary_action 需要 element_index。')
      const label = readString(args, 'secondary_action')
      if (label === undefined) throw new Error('perform_secondary_action 需要 secondary_action 标签。')
      return {
        method: 'perform_secondary_action',
        params: { window, element_index: elementIndex, action: label },
        description: `对元素 #${elementIndex} 执行次要动作 ${label}`,
      }
    }

    case 'paste_text':
      throw new Error('paste_text 由剪贴板路径处理，不应到达这里。')

    default: {
      const exhaustive: never = action
      throw new Error(`未实现的动作：${String(exhaustive)}`)
    }
  }
}
