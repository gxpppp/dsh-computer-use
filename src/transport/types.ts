/**
 * helper 协议层的公共类型。
 *
 * 协议形态取自 Codex 实装（`@oai/sky` 的 Windows WindowsHelperTransport）：
 * stdio 按 `\n` 分帧，请求为扁平 `{id, method, params, meta}`，
 * 响应为 `{id, ok, result}` / `{id, ok, error}` / `{id, ok:false, approvalRequest}`。
 *
 * 注意：这些结构刻意声明为 `type` 而非 `interface` —— DSH 工具要求返回值满足
 * `Record<string, JsonValue>`，而对象类型别名才会带上 TS 的隐式索引签名。
 * @module dsh-computer-use/transport/types
 */

/** helper 支持的 RPC 方法（Windows 后端全集）。 */
export type HelperMethod =
  | 'list_apps'
  | 'list_windows'
  | 'get_window'
  | 'get_window_state'
  | 'click'
  | 'click_element'
  | 'scroll'
  | 'drag'
  | 'press_key'
  | 'type_text'
  | 'launch_app'
  | 'activate_window'
  | 'set_value'
  | 'perform_secondary_action'
  | 'start_audio_recording'
  | 'stop_audio_recording'
  | 'end_turn'
  | 'close'

/** 可目标化窗口。`app` 形如 `process:C:\...\app.exe` 或包标识。 */
export type WindowRef = {
  app: string
  id: number
  title?: string
}

/** 一个可启动的应用条目。 */
export type AppEntry = {
  id: string
  displayName?: string
  isRunning?: boolean
  lastUsedDate?: string
  useCount?: number
  windows: WindowRef[]
}

/** helper 返回的截图条目（`url` 为 data URL）。 */
export type Screenshot = {
  id: string
  zIndex: number
  url: string
  originX?: number
  originY?: number
  width?: number
  height?: number
}

/** helper 返回的可访问性状态。 */
export type AccessibilityState = {
  tree: string
  focused_element?: string
  selected_text?: string
  selected_elements?: string[]
  document_text?: string
}

export type WindowState = {
  window: WindowRef
  screenshots: Screenshot[]
  accessibility: AccessibilityState | null
}

/** helper 的审批请求：首次触碰某个应用时返回。 */
export type HelperApprovalRequest = {
  app: string
  displayName: string
  riskLevel?: 'low' | 'high'
  allowPersistentApproval: boolean
}

/** 原始响应帧。 */
export type RawResponse = {
  id?: number
  ok?: boolean
  result?: unknown
  error?: unknown
  approvalRequest?: HelperApprovalRequest
}

/**
 * helper 侧返回的业务错误。
 *
 * helper 的错误文案是英文的、且往往只描述现象。这里对已知的几类做一次中文附注，
 * 让模型和用户不必去猜「为什么被拒绝」。
 */
export class HelperError extends Error {
  readonly method: string
  readonly detail: unknown
  constructor(method: string, message: string, detail?: unknown) {
    super(`computer-use helper 在 ${method} 上失败：${message}${hintFor(message)}`)
    this.name = 'HelperError'
    this.method = method
    this.detail = detail
  }
}

/** 已知错误文案 → 处置提示。 */
const ERROR_HINTS: { match: RegExp; hint: string }[] = [
  {
    match: /could not determine the current browser URL/i,
    hint:
      '（策略边界：在 Windows 上通过 UI 自动化操作浏览器时，helper 必须能判定当前 URL 才能执行策略，' +
      '而本地独立运行环境不提供该通道，因此被拒绝。浏览器任务请改用专门的浏览器通道，或让用户手动完成。这一轮不要再对浏览器重试。）',
  },
  {
    match: /SetIsBorderRequired failed/i,
    hint:
      '（本机 Windows 版本（< 22000）缺少 GraphicsCaptureSession.SetIsBorderRequired，' +
      'helper 的截图路径不可用；请改用 include_tree，可访问性树不受影响。）',
  },
  {
    match: /window is minimized/i,
    hint: '（目标窗口处于最小化状态。先用 computer_use_act 的 activate_window 恢复，再重新观察。）',
  },
  {
    match: /bounds changed|window changed before coordinate input/i,
    hint: '（窗口几何在观察之后发生了变化，旧的坐标或索引已失效。请重新调用 computer_use_state。）',
  },
  {
    match: /failed to launch codex app-server/i,
    hint: '（helper 需要 CODEX_CLI_PATH 指向 codex.exe。请确认 Codex 已安装，或在插件设置里指定 codexCliPath。）',
  },
]

function hintFor(message: string): string {
  for (const entry of ERROR_HINTS) {
    if (entry.match.test(message)) return `\n${entry.hint}`
  }
  return ''
}

/** 审批未通过（用户拒绝或超时）。 */
export class HelperApprovalDeniedError extends Error {
  readonly app: string
  readonly displayName: string
  constructor(app: string, displayName: string) {
    super(`未授权 Computer Use 使用「${displayName}」（${app}）`)
    this.name = 'HelperApprovalDeniedError'
    this.app = app
    this.displayName = displayName
  }
}

/** 询问用户是否允许该应用。返回 true 表示放行。 */
export type ApprovalAsker = (request: HelperApprovalRequest) => Promise<boolean>
