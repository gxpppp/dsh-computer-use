/**
 * Windows 10 上的截图兜底。
 *
 * helper 的截图走 Windows.Graphics.Capture，而 `GraphicsCaptureSession.SetIsBorderRequired`
 * 是 Windows 11 (build 22000) 才有的 API；更早的系统上整条路径返回 0x80004002，
 * helper 不会降级。这里用 `user32!PrintWindow` + GDI+ 补上这一段。
 *
 * 代价是每次调用要拉起一个 PowerShell（首次还会编译内嵌的 C#），约 1–3 秒；
 * 因此它只在 helper 截图不可用时才被使用，且调用方应把结果缓存到本次观察内。
 *
 * 已知限制：PrintWindow 对部分 DirectComposition / 硬件加速渲染的窗口只能拿到黑图，
 * 这时会返回 `ok: false` 与可读的原因，而不是静默给一张全黑图片。
 * @module dsh-computer-use/capture/printwindow
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 抓图方式，用于在结果里说明这张图是怎么来的。 */
export type CaptureMethod = 'printwindow'

/** 一次抓图的结果。 */
export type CaptureOutcome = {
  ok: boolean
  /** PNG 字节；失败时为 null。 */
  data: Uint8Array | null
  width: number
  height: number
  method: CaptureMethod
  /** 采样得到的非黑像素占比（0–100）；用于判断是否拿到一张空图。 */
  nonBlackRatio: number
  /** 失败原因或补充说明。 */
  note: string
}

const DEFAULT_TIMEOUT_MS = 25_000
/** 非黑像素占比低于此值视为"没渲染出来"。 */
const BLACK_IMAGE_THRESHOLD = 0.5

/**
 * 抓取一个 HWND 的窗口位图。
 *
 * `hwnd` 直接取自 `computer_use_apps` 返回的 `window_id`——它本身就是 Win32 句柄。
 */
export async function captureWindowBitmap(
  hwnd: number,
  options: { timeoutMs?: number } = {},
): Promise<CaptureOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cu-'))
  const outPath = join(dir, 'window.png')

  try {
    const script = buildScript(hwnd, outPath)
    const stdout = await runPowerShell(script, timeoutMs)
    const parsed = parseResult(stdout)
    if (parsed === null) {
      return failure(`捕获脚本没有返回可解析的结果：${stdout.slice(-300)}`)
    }
    if (!parsed.ok) {
      return failure(parsed.note, parsed.width, parsed.height)
    }

    let data: Uint8Array
    try {
      data = new Uint8Array(await readFile(outPath))
    } catch (error) {
      return failure(`截图已生成但读取失败：${describe(error)}`)
    }
    if (data.byteLength === 0) return failure('截图文件为空')

    if (parsed.nonBlackRatio < BLACK_IMAGE_THRESHOLD) {
      return {
        ok: false,
        data: null,
        width: parsed.width,
        height: parsed.height,
        method: 'printwindow',
        nonBlackRatio: parsed.nonBlackRatio,
        note:
          `PrintWindow 返回的位图几乎全黑（非黑像素 ${parsed.nonBlackRatio}%）。` +
          '该窗口多半使用硬件加速渲染，PrintWindow 无法读取其内容；请改用可访问性树。',
      }
    }

    return {
      ok: true,
      data,
      width: parsed.width,
      height: parsed.height,
      method: 'printwindow',
      nonBlackRatio: parsed.nonBlackRatio,
      note: `由 PrintWindow 抓取（${parsed.width}×${parsed.height}）`,
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function failure(note: string, width = 0, height = 0): CaptureOutcome {
  return { ok: false, data: null, width, height, method: 'printwindow', nonBlackRatio: 0, note }
}

type ParsedResult =
  | { ok: true; width: number; height: number; nonBlackRatio: number; note: string }
  | { ok: false; width: number; height: number; note: string }

/**
 * 解析脚本的 `RESULT|` 行。
 *
 * 脚本把机器可读的结果单独打成一行，避免 PowerShell 的多余输出（Add-Type 警告等）干扰解析。
 */
function parseResult(stdout: string): ParsedResult | null {
  const line = stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.startsWith('RESULT|'))
    .pop()
  if (line === undefined) return null

  const parts = line.split('|')
  const status = parts[1] ?? ''
  const detail = parts[2] ?? ''
  const width = Number(parts[3] ?? 0)
  const height = Number(parts[4] ?? 0)

  if (status === 'ok') {
    return {
      ok: true,
      width,
      height,
      nonBlackRatio: Number(parts[5] ?? 0),
      note: detail,
    }
  }
  return { ok: false, width, height, note: detail === '' ? 'PrintWindow 失败' : detail }
}

/** 调用 PowerShell 并拿到 stdout；非零退出码也照样返回输出，由解析层决定成败。 */
function runPowerShell(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // -EncodedCommand 传 UTF-16LE base64，彻底绕开引号与中文的转义问题。
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
      reject(new Error(`PrintWindow 脚本超时（${timeoutMs} ms）`))
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`无法启动 powershell.exe：${error.message}`))
    })
    child.once('close', () => {
      clearTimeout(timer)
      if (stdout.trim() === '' && stderr.trim() !== '') {
        reject(new Error(`PrintWindow 脚本报错：${stderr.trim().slice(-400)}`))
        return
      }
      resolve(stdout)
    })
  })
}

/**
 * 生成捕获脚本。
 *
 * C# 部分只做 P/Invoke；尺寸、保存与非黑比例统计留在 PowerShell 里，
 * 这样 C# 编译失败时错误信息更容易定位。
 */
function buildScript(hwnd: number, outPath: string): string {
  const escapedPath = outPath.replace(/'/g, "''")
  return `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DshCap {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@ | Out-Null

$h = [IntPtr]${hwnd}
if ([DshCap]::IsIconic($h)) {
  Write-Output 'RESULT|fail|目标窗口处于最小化状态，无法抓图；请先激活窗口|0|0|0'
  exit 0
}

$rect = New-Object DshCap+RECT
if (-not [DshCap]::GetWindowRect($h, [ref]$rect)) {
  Write-Output 'RESULT|fail|GetWindowRect 失败，句柄可能已失效|0|0|0'
  exit 0
}
$w = $rect.Right - $rect.Left
$ht = $rect.Bottom - $rect.Top
if ($w -le 0 -or $ht -le 0) {
  Write-Output ('RESULT|fail|窗口尺寸非法 ' + $w + 'x' + $ht + '|0|0|0')
  exit 0
}

$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [DshCap]::PrintWindow($h, $hdc, [uint32]2)
$g.ReleaseHdc($hdc) | Out-Null
$g.Dispose()

if (-not $ok) {
  $bmp.Dispose()
  Write-Output 'RESULT|fail|PrintWindow 调用失败|0|0|0'
  exit 0
}

$bmp.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)

$nonBlack = 0
$total = 0
for ($y = 0; $y -lt $ht; $y += 8) {
  for ($x = 0; $x -lt $w; $x += 8) {
    $c = $bmp.GetPixel($x, $y)
    $total++
    if ($c.R -gt 12 -or $c.G -gt 12 -or $c.B -gt 12) { $nonBlack++ }
  }
}
$bmp.Dispose()
$ratio = 0
if ($total -gt 0) { $ratio = [math]::Round(100.0 * $nonBlack / $total, 1) }
Write-Output ('RESULT|ok|printwindow|' + $w + '|' + $ht + '|' + $ratio)
`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
