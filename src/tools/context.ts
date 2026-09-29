/**
 * 工具层共享的运行时缝隙与格式化助手。
 *
 * 工具本身对 {@link ToolHost} 保持惰性：配置、helper、审批器都在每次调用时解析，
 * 因此设置变更在下一次工具调用即生效，无需重建工具。
 * @module dsh-computer-use/tools/context
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { Config } from '../settings/schema.ts'
import type { ComputerUseHelper } from '../transport/helper.ts'
import type { ApprovalAsker, WindowRef, WindowState } from '../transport/types.ts'

/** 工具需要从插件外壳拿到的全部能力。 */
export interface ToolHost {
  /** 当前生效的配置。 */
  config(): Config
  /** helper 门面（进程与协议）。 */
  helper(): ComputerUseHelper
  /** 绑定到具体 agent 的审批询问器。 */
  approver(agent: Agent | undefined, toolName: string, signal: AbortSignal): ApprovalAsker
  /** DSH 附件仓库；环境未提供时为 undefined（截图退化为仅描述）。 */
  attachments(): AttachmentStore | undefined
  /** 记录一行诊断信息。 */
  notice(message: string): void
}

export function createToolHost(options: {
  config: () => Config
  helper: () => ComputerUseHelper
  approver: (agent: Agent | undefined, toolName: string, signal: AbortSignal) => ApprovalAsker
  attachments: () => AttachmentStore | undefined
  notice: (message: string) => void
}): ToolHost {
  return {
    config: options.config,
    helper: options.helper,
    approver: options.approver,
    attachments: options.attachments,
    notice: options.notice,
  }
}

/** 从参数对象里读一个非空字符串。 */
export function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 从参数对象里读一个整数；越界返回 undefined。 */
export function readInt(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = args[key]
  const num =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(num)) return undefined
  const rounded = Math.round(num)
  if (rounded < min || rounded > max) return undefined
  return rounded
}

/** 从参数对象里读一个布尔开关。 */
export function readBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key]
  return typeof value === 'boolean' ? value : undefined
}

/**
 * 规范化并校验一个窗口引用。
 *
 * helper 只接受「从 list_apps / list_windows 原样返回」的窗口对象，
 * 因此这里拒绝任何拼凑出的形状，并把原因说清楚。
 */
export function windowOf(args: Record<string, unknown>): WindowRef {
  const app = readString(args, 'window_app')
  const id = readInt(args, 'window_id', 0, Number.MAX_SAFE_INTEGER)
  if (app === undefined || id === undefined) {
    throw new Error(
      '需要 window_app 与 window_id：请先调用 computer_use_apps 取得窗口对象，并把其中的 app 与 id 原样传入。',
    )
  }
  return { app, id }
}

export interface ClampResult {
  text: string
  truncated: boolean
  originalLength: number
}

/** 按字符上限截断长文本，保留头部（可访问性树的有效信息集中在开头）。 */
export function clampText(text: string, max: number): ClampResult {
  if (text.length <= max) return { text, truncated: false, originalLength: text.length }
  return {
    text: text.slice(0, max) + `\n…（已截断，原文 ${text.length} 字符，上限 ${max}）`,
    truncated: true,
    originalLength: text.length,
  }
}

/**
 * 把窗口状态压成模型可读的文本块。
 *
 * 截图不进文本（它作为图片块单独回传），这里只描述结构与可访问性内容。
 */
export function formatWindowState(state: WindowState, maxTreeChars: number): string {
  const lines: string[] = []
  lines.push(`窗口：${state.window.title ?? '(无标题)'}`)
  lines.push(`  app=${state.window.app}  id=${state.window.id}`)

  const accessibility = state.accessibility
  if (accessibility === null) {
    lines.push('可访问性：本次未请求（include_tree=false）')
  } else {
    const tree = accessibility.tree ?? ''
    const clamped = clampText(tree, maxTreeChars)
    lines.push(`可访问性树（${clamped.originalLength} 字符）：`)
    lines.push(clamped.text)
    if (accessibility.focused_element !== undefined && accessibility.focused_element !== '') {
      lines.push(`当前焦点：${accessibility.focused_element}`)
    }
    if (accessibility.selected_text !== undefined && accessibility.selected_text !== '') {
      lines.push(`选中文本：${accessibility.selected_text.slice(0, 400)}`)
    }
    if (accessibility.document_text !== undefined && accessibility.document_text !== '') {
      lines.push(`文档文本前 800 字符：${accessibility.document_text.slice(0, 800)}`)
    }
  }

  if (state.screenshots.length > 0) {
    const shot = state.screenshots[0]
    lines.push(
      `截图：${state.screenshots.length} 张，首张 ${shot?.width ?? '?'}×${shot?.height ?? '?'}（id=${shot?.id ?? '?'}）`,
    )
  }

  return lines.join('\n')
}

/** 把未知错误压成可读文本。 */
export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** 生成一个文件系统安全的短标签。 */
export function safeToken(value: string, fallback: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned === '' ? fallback : cleaned.slice(0, 48)
}
