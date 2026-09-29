/**
 * `computer_use_state` —— 取窗口快照（可访问性树 / 截图）。
 *
 * 这是 Computer Use 的「眼睛」。对应 helper 的 `get_window_state`，是唯一会返回
 * 元素索引的方法：索引只在产生它的那一次观察内有效，任何动作之后都必须重新观察。
 *
 * 截图有两条后端：
 *   - Windows 11 及以上走 helper 的 Windows.Graphics.Capture；
 *   - 更早的系统（helper 会返回 0x80004002）改走本地 `PrintWindow` 兜底。
 * 两条路对调用方是透明的，结果里会注明实际用的是哪一条。
 * @module dsh-computer-use/tools/state
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { AttachmentId, type ImageMediaType, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { captureWindowBitmap } from '../capture/printwindow.ts'
import type { Screenshot, WindowState } from '../transport/types.ts'
import { withWindowRecovery } from './recovery.ts'
import { clampText, formatError, formatWindowState, readBool, readInt, safeToken, windowOf, type ToolHost } from './context.ts'
import { detectCaptureCapability } from './status.ts'

/** 已发布的截图引用，供 render 生成图片块。 */
type PublishedShot = {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name: string
}

export function registerStateTool(host: ToolHost): ToolDefinition[] {
  const state = defineTool({
    name: 'computer_use_state',
    description: [
      'Capture one window\'s state: the accessibility tree (element indexes, names, focus) and optionally a screenshot.',
      'This is the only tool that returns element indexes, and an index is valid ONLY for the observation that produced it —',
      'observe, decide, act once, then observe again. Prefer include_tree for apps with a usable accessibility tree;',
      'request a screenshot only when the tree is not enough. On Windows 10 the screenshot is taken locally via PrintWindow,',
      'which cannot read hardware-accelerated windows.',
    ].join(' '),
    parameters: {
      window_app: { type: 'string', description: 'Window app identifier, verbatim from computer_use_apps.', required: true },
      window_id: { type: 'number', description: 'Window id, verbatim from computer_use_apps.', required: true },
      include_tree: { type: 'boolean', description: 'Capture the accessibility tree with element indexes. Default true.' },
      include_screenshot: { type: 'boolean', description: 'Capture a screenshot. Default false. Windows 11 uses the native capture; earlier systems fall back to a local PrintWindow grab.' },
      max_tree_chars: { type: 'number', description: 'Override the configured accessibility-tree character cap for this call.' },
    },
    output: {
      schema: { type: 'object' as const, additionalProperties: true as const },
      render: (_args: unknown, value: Record<string, unknown>): ContentBlock[] => {
        const blocks: ContentBlock[] = []
        const shots = Array.isArray(value.screenshots) ? value.screenshots : []
        for (const item of shots) {
          const record = item as Record<string, unknown>
          const attachmentId = typeof record.attachmentId === 'string' ? record.attachmentId : ''
          if (attachmentId === '') continue
          blocks.push({
            type: 'image',
            attachment: {
              attachmentId: AttachmentId(attachmentId),
              mediaType: record.mediaType as ImageMediaType,
              bytes: Number(record.bytes ?? 0),
              width: Number(record.width ?? 0),
              height: Number(record.height ?? 0),
              name: typeof record.name === 'string' ? record.name : undefined,
            },
          })
        }
        blocks.push({
          type: 'text',
          text: typeof value.summary === 'string' ? value.summary : JSON.stringify(value, null, 2),
        })
        return blocks
      },
    },
    execute: async (args, exec) => {
      const config = host.config()
      const window = windowOf(args)
      const includeTree = readBool(args, 'include_tree') ?? true
      const includeScreenshot = readBool(args, 'include_screenshot') ?? false
      const maxChars = readInt(args, 'max_tree_chars', 2_000, 200_000) ?? config.maxTreeChars

      if (!includeTree && !includeScreenshot) {
        throw new Error('include_tree 与 include_screenshot 至少要有一个为真，否则这次观察拿不到任何信息。')
      }
      if (includeScreenshot && !config.allowScreenshots) {
        throw new Error(
          '截图被插件设置关闭了（allowScreenshots=false）。' +
            '请改用 include_tree，或在设置里打开截图。',
        )
      }

      const capability = detectCaptureCapability()
      const nativeCapture = capability.screenshot
      // 原生截图不可用时完全不向 helper 请求截图：那必然失败，还会白跑一次往返。
      const useHelperScreenshot = includeScreenshot && nativeCapture

      const helper = host.helper()
      const ask = host.approver(exec.agent, 'computer_use_state', exec.signal)
      const notes: string[] = []
      // 窗口最小化 / 句柄失效在这里就地恢复，不让一次观察白白失败。
      const call = await withWindowRecovery(
        helper,
        window,
        ask,
        (target) =>
          helper.call<WindowState>(
            'get_window_state',
            {
              window: target,
              include_screenshot: useHelperScreenshot,
              // helper 要求二者至少一个为真；走本地截图时也得让它带上 text。
              include_text: includeTree || !useHelperScreenshot,
            },
            { ask },
          ),
        notes,
      )
      const observed = call.result
      const effectiveWindow = call.window

      const published: PublishedShot[] = []
      let captureBackend = 'none'
      if (includeScreenshot) {
        if (nativeCapture) {
          captureBackend = 'helper/wgc'
          await publishHelperShots(host, observed.screenshots, effectiveWindow.id, published, notes)
        } else {
          captureBackend = 'local/printwindow'
          await captureViaPrintWindow(host, effectiveWindow.id, published, notes)
        }
      }

      const tree = observed.accessibility?.tree ?? ''
      const clamped = includeTree ? clampText(tree, maxChars) : undefined
      const body = formatWindowState(
        {
          window: observed.window ?? effectiveWindow,
          screenshots: observed.screenshots ?? [],
          accessibility: includeTree ? observed.accessibility : null,
        },
        maxChars,
      )

      const summary = [
        body,
        published.length > 0
          ? `已发布 ${published.length} 张截图（后端：${captureBackend}）。`
          : includeScreenshot
            ? `截图未产出（后端：${captureBackend}）。`
            : '',
        ...notes,
        '提示：元素索引只对本次观察有效，动作后请重新调用本工具。',
      ]
        .filter((line) => line !== '')
        .join('\n')

      return {
        window: observed.window ?? effectiveWindow,
        tree: clamped?.text ?? '',
        treeChars: clamped?.originalLength ?? 0,
        treeTruncated: clamped?.truncated ?? false,
        screenshotBackend: captureBackend,
        screenshots: published,
        notes,
        summary,
      }
    },
    isConcurrencySafe: () => false,
  })
  return [state]
}

/** 把 helper（WGC）返回的 data-URL 截图发布成 DSH 附件。 */
async function publishHelperShots(
  host: ToolHost,
  shots: Screenshot[],
  windowId: number,
  published: PublishedShot[],
  notes: string[],
): Promise<void> {
  if (shots.length === 0) {
    notes.push('helper 未返回截图（可能窗口最小化或被系统裁剪）。')
    return
  }
  const store = host.attachments()
  if (store === undefined) {
    notes.push('本次环境未提供附件仓库，截图无法呈现给模型（可改用 include_tree）。')
    return
  }

  const inputs: SaveImageAttachment[] = []
  const meta: { width: number; height: number }[] = []
  for (const [index, shot] of shots.entries()) {
    try {
      inputs.push({
        data: decodeDataUrl(shot.url),
        mediaType: 'image/png',
        name: shotName(windowId, index),
      })
      meta.push({ width: shot.width ?? 0, height: shot.height ?? 0 })
    } catch (error) {
      notes.push(`第 ${index + 1} 张截图解码失败：${formatError(error)}`)
    }
  }
  if (inputs.length === 0) return

  try {
    const refs = await store.saveImages(inputs)
    for (const [index, ref] of refs.entries()) {
      published.push({
        attachmentId: String(ref.attachmentId),
        mediaType: 'image/png',
        bytes: ref.bytes ?? inputs[index]?.data.length ?? 0,
        width: meta[index]?.width ?? 0,
        height: meta[index]?.height ?? 0,
        name: inputs[index]?.name ?? '',
      })
    }
  } catch (error) {
    notes.push(`截图发布失败：${formatError(error)}`)
  }
}

/** 用本地 PrintWindow 兜底抓图并发布。 */
async function captureViaPrintWindow(
  host: ToolHost,
  hwnd: number,
  published: PublishedShot[],
  notes: string[],
): Promise<void> {
  let outcome
  try {
    outcome = await captureWindowBitmap(hwnd)
  } catch (error) {
    notes.push(`本地截图失败：${formatError(error)}`)
    return
  }
  if (!outcome.ok || outcome.data === null) {
    notes.push(`本地截图未产出：${outcome.note}`)
    return
  }

  const store = host.attachments()
  if (store === undefined) {
    notes.push('本次环境未提供附件仓库，截图无法呈现给模型（可改用 include_tree）。')
    return
  }

  const name = shotName(hwnd, 0)
  try {
    const refs = await store.saveImages([{ data: outcome.data, mediaType: 'image/png', name }])
    const ref = refs[0]
    if (ref === undefined) {
      notes.push('附件仓库没有返回截图引用。')
      return
    }
    published.push({
      attachmentId: String(ref.attachmentId),
      mediaType: 'image/png',
      bytes: ref.bytes ?? outcome.data.byteLength,
      width: outcome.width,
      height: outcome.height,
      name,
    })
    notes.push(outcome.note)
  } catch (error) {
    notes.push(`截图发布失败：${formatError(error)}`)
  }
}

function shotName(windowId: number, index: number): string {
  return `computer-use-${safeToken(String(windowId), 'window')}-${index}.png`
}

/** 把 `data:image/png;base64,...` 解回字节。 */
function decodeDataUrl(url: string): Uint8Array {
  const comma = url.indexOf(',')
  if (comma === -1) throw new Error('截图数据不是合法的 data URL')
  return new Uint8Array(Buffer.from(url.slice(comma + 1), 'base64'))
}
