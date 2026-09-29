/**
 * 剪贴板写入。
 *
 * 用途是把长文本或中文一次性送进目标应用：`SendInput` 逐字符注入对中文和超长文本
 * 既慢又不可靠，而「写剪贴板 + Ctrl+V」是应用自己处理粘贴，走的是它原生的输入路径。
 *
 * 文本经临时文件传给 PowerShell，避免 Windows 命令行 32767 字符的上限。
 * @module dsh-computer-use/input/clipboard
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type ClipboardOutcome = {
  ok: boolean
  /** 写入的字符数。 */
  chars: number
  note: string
}

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * 把文本放进剪贴板。
 *
 * 只写不读——本插件从不读取用户的剪贴板内容。
 */
export async function setClipboardText(
  text: string,
  options: { timeoutMs?: number } = {},
): Promise<ClipboardOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cu-clip-'))
  const textPath = join(dir, 'payload.txt')

  try {
    // 不加尾随换行：粘贴进输入框时多一个换行往往就会触发提交。
    await writeFile(textPath, text, 'utf8')
    const script = buildScript(textPath)
    const stdout = await runPowerShell(script, timeoutMs)
    if (!stdout.includes('RESULT|ok')) {
      return { ok: false, chars: 0, note: `写入剪贴板失败：${stdout.trim().slice(-300) || '脚本没有报告成功'}` }
    }
    return { ok: true, chars: text.length, note: `已写入剪贴板（${text.length} 字符）` }
  } catch (error) {
    return { ok: false, chars: 0, note: `写入剪贴板失败：${describe(error)}` }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function buildScript(textPath: string): string {
  const escaped = textPath.replace(/'/g, "''")
  return `$ErrorActionPreference = 'Stop'
$text = Get-Content -LiteralPath '${escaped}' -Raw -Encoding UTF8
if ($null -eq $text) { $text = '' }
Set-Clipboard -Value $text
Write-Output 'RESULT|ok'
`
}

function runPowerShell(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // -EncodedCommand 传 UTF-16LE base64：中文路径与内容都不会被转义规则破坏。
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
      reject(new Error(`剪贴板脚本超时（${timeoutMs} ms）`))
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
      if (stdout.includes('RESULT|ok')) {
        resolve(stdout)
        return
      }
      reject(new Error(stderr.trim() === '' ? '剪贴板脚本未报告成功' : stderr.trim().slice(-300)))
    })
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
