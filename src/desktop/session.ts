/**
 * 桌面会话探测。
 *
 * 锁屏会改变一大批 API 的行为，而且症状彼此看起来毫不相关：
 *   - `SetForegroundWindow` 被拒 → 表现为「failed to activate captured window」；
 *   - 剪贴板被系统独占 → 表现为 `ExternalException` / `Access is denied`；
 *   - 输入注入没有焦点可送 → 表现为操作"成功"但界面毫无变化。
 * 而 `PrintWindow` 截图照常可用，因为它不需要前台。
 *
 * 于是"锁定"这件事必须主动探测并直说，否则模型会把这些现象当成五花八门的故障，
 * 一遍遍换着法子重试。Codex 的 guidance 对此的处置是：立即停止，请用户解锁。
 * @module dsh-computer-use/desktop/session
 */
import { spawn } from 'node:child_process'

export type DesktopSession = {
  /** 前台窗口是否属于锁屏界面。 */
  locked: boolean
  /** 前台窗口所属进程名；探测失败时为空串。 */
  foregroundProcess: string
  /** 前台窗口标题；可能含用户信息，仅用于诊断。 */
  foregroundTitle: string
  /** 人类可读说明。 */
  note: string
}

const DEFAULT_TIMEOUT_MS = 12_000

/** 属于"桌面被锁"的进程名（小写）。 */
const LOCK_PROCESSES = new Set(['lockapp', 'logonui', 'winlogon'])

/**
 * 探测当前会话是否被锁定。
 *
 * 判据是**前台窗口的归属进程**，而不是"LockApp 是否存在"——解锁后 LockApp
 * 往往仍然驻留，只看进程存在会误判。探测需要拉起一次 PowerShell（约 300–800 ms），
 * 因此只在诊断路径与错误增强里调用，不要放进每次动作的热路径。
 */
export async function probeDesktopSession(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<DesktopSession> {
  try {
    const stdout = await runPowerShell(buildScript(), timeoutMs)
    const line = stdout
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter((item) => item.startsWith('RESULT|'))
      .pop()
    if (line === undefined) {
      return unknown('探测脚本没有返回可解析的结果')
    }
    const rest = line.slice('RESULT|'.length)
    const first = rest.indexOf('|')
    if (first === -1) return unknown('探测结果格式不正确')
    const lockedFlag = rest.slice(0, first).trim()
    const payload = rest.slice(first + 1)
    const second = payload.indexOf('|')
    const processName = second === -1 ? payload.trim() : payload.slice(0, second).trim()
    const title = second === -1 ? '' : payload.slice(second + 1).trim()

    const locked = lockedFlag === '1'
    return {
      locked,
      foregroundProcess: processName,
      foregroundTitle: title,
      note: locked
        ? `桌面处于锁定状态（前台进程 ${processName}）。任何需要前台的界面操作都会失败。`
        : `桌面未锁定（前台进程 ${processName || '未知'}）。`,
    }
  } catch (error) {
    return unknown(error instanceof Error ? error.message : String(error))
  }
}

function unknown(reason: string): DesktopSession {
  return {
    locked: false,
    foregroundProcess: '',
    foregroundTitle: '',
    note: `无法判定桌面锁定状态：${reason}`,
  }
}

function buildScript(): string {
  const lockList = [...LOCK_PROCESSES].map((name) => `'${name}'`).join(',')
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DshSession {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public static string Title(IntPtr hWnd) {
    StringBuilder sb = new StringBuilder(512);
    GetWindowTextW(hWnd, sb, 512);
    return sb.ToString();
  }
  public static uint PidOf(IntPtr hWnd) {
    uint pid = 0;
    GetWindowThreadProcessId(hWnd, out pid);
    return pid;
  }
}
'@ | Out-Null

$h = [DshSession]::GetForegroundWindow()
$name = ''
$title = ''
if ($h -ne [IntPtr]::Zero) {
  $title = [DshSession]::Title($h)
  $fgPid = [DshSession]::PidOf($h)
  if ($fgPid -gt 0) {
    try { $name = (Get-Process -Id $fgPid -ErrorAction Stop).ProcessName } catch { $name = '' }
  }
}

$lockNames = @(${lockList})
$locked = 0
if ($lockNames -contains $name.ToLower()) { $locked = 1 }

Write-Output ('RESULT|' + $locked + '|' + $name + '|' + $title)
`
}

function runPowerShell(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // -EncodedCommand 传 UTF-16LE：窗口标题里的中文能原样带回。
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`桌面会话探测超时（${timeoutMs} ms）`))
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-1_000)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`无法启动 powershell.exe：${error.message}`))
    })
    child.once('close', () => {
      clearTimeout(timer)
      if (stdout.includes('RESULT|')) {
        resolve(stdout)
        return
      }
      reject(new Error(stderr.trim() === '' ? '探测脚本未报告结果' : stderr.trim().slice(-300)))
    })
  })
}
