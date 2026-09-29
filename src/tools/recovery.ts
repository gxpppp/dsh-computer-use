/**
 * 窗口级故障恢复。
 *
 * helper 会主动拒绝三类"窗口状态已经不对了"的请求：最小化、几何变化、句柄失效。
 * 这些都不是逻辑错误，而是时序问题——激活窗口、重新取一次句柄就能继续。
 * 把它们交给模型去处理，等于每次都浪费一个模型回合；这里就地修掉。
 *
 * 恢复只做一次，且必须在同一次工具调用内完成；再失败就把原始错误抛出去。
 * @module dsh-computer-use/tools/recovery
 */
import type { ComputerUseHelper } from '../transport/helper.ts'
import type { ApprovalAsker, WindowRef } from '../transport/types.ts'

/** 可恢复的窗口故障与其人类可读名称。 */
const RECOVERY_PATTERNS: { match: RegExp; label: string }[] = [
  { match: /window is minimized/i, label: '窗口最小化' },
  { match: /bounds changed|window changed before coordinate input|window changed before/i, label: '窗口几何变化' },
  { match: /verify current window|window id is required|read current window bounds|coordinate input target is unavailable/i, label: '窗口句柄失效' },
]

/** 命中返回故障名称，否则返回 undefined。 */
export function classifyWindowFault(message: string): string | undefined {
  for (const entry of RECOVERY_PATTERNS) {
    if (entry.match.test(message)) return entry.label
  }
  return undefined
}

/**
 * 执行一次窗口操作；若因窗口状态失效而失败，就地恢复并重试一次。
 *
 * @param notes - 恢复动作会追加一行说明，让模型知道发生过什么。
 * @returns `run` 的结果，以及实际生效的窗口引用（句柄可能已更新）。
 */
export async function withWindowRecovery<T>(
  helper: ComputerUseHelper,
  window: WindowRef,
  ask: ApprovalAsker | undefined,
  run: (window: WindowRef) => Promise<T>,
  notes: string[],
): Promise<{ result: T; window: WindowRef }> {
  try {
    return { result: await run(window), window }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const fault = classifyWindowFault(message)
    if (fault === undefined) throw error

    const recovered = await recover(helper, window, ask)
    notes.push(
      `检测到${fault}，已自动激活窗口并刷新句柄后重试一次` +
        (recovered === undefined ? '（激活未成功，可能仍会失败）' : ''),
    )
    const effective = recovered ?? window
    return { result: await run(effective), window: effective }
  }
}

/** 激活窗口并取回一个新句柄；任一步失败都返回 undefined 而不是抛出。 */
async function recover(
  helper: ComputerUseHelper,
  window: WindowRef,
  ask: ApprovalAsker | undefined,
): Promise<WindowRef | undefined> {
  try {
    await helper.call('activate_window', { window }, { ask, timeoutMs: 20_000 })
  } catch {
    // 激活失败也继续尝试取句柄：句柄本身可能仍然有效。
  }
  await delay(400)
  try {
    const fresh = await helper.call<WindowRef>(
      'get_window',
      { id: window.id, app: window.app },
      { ask, timeoutMs: 20_000 },
    )
    if (fresh !== null && typeof fresh === 'object' && typeof fresh.id === 'number') return fresh
  } catch {
    // 句柄确实没了，交给调用方用原引用再试一次。
  }
  return undefined
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
