/**
 * 新能力的离线冒烟：截图兜底与剪贴板写入。
 *
 * 这两个模块只依赖 Node 内置能力，因此可以脱离 DSH 直接验证。
 * 不动用户的剪贴板内容之外，不做任何输入动作。
 */
import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const probeDir = resolve(root, '.smoke')
await mkdir(probeDir, { recursive: true })

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures += 1
}

// 两个模块各自独立打包，避免把 transport 那套也拖进来。
for (const [name, entry] of [
  ['capture', 'src/capture/printwindow.ts'],
  ['clipboard', 'src/input/clipboard.ts'],
  ['session', 'src/desktop/session.ts'],
]) {
  await build({
    entryPoints: [resolve(root, entry)],
    outfile: resolve(probeDir, `${name}.mjs`),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    logLevel: 'warning',
  })
}

const capture = await import(pathToFileURL(resolve(probeDir, 'capture.mjs')).href)
const clipboard = await import(pathToFileURL(resolve(probeDir, 'clipboard.mjs')).href)
const sessionModule = await import(pathToFileURL(resolve(probeDir, 'session.mjs')).href)

const notepad = spawn('notepad.exe', [], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 3000))

try {
  console.log('=== 1. PrintWindow 截图兜底 ===')
  const hwndText = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-Process -Name notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle.ToInt64()',
    ],
    { encoding: 'utf8', timeout: 30000 },
  ).trim()
  const hwnd = Number(hwndText)
  check('拿到记事本 HWND', Number.isFinite(hwnd) && hwnd > 0, String(hwnd))

  if (Number.isFinite(hwnd) && hwnd > 0) {
    const started = Date.now()
    const shot = await capture.captureWindowBitmap(hwnd)
    const elapsed = Date.now() - started
    check('截图成功', shot.ok, shot.note)
    check('拿到 PNG 字节', shot.data !== null && shot.data.byteLength > 1000, `${shot.data?.byteLength ?? 0} B`)
    check('尺寸合理', shot.width > 100 && shot.height > 100, `${shot.width}x${shot.height}`)
    check('非黑像素充足', shot.nonBlackRatio > 50, `${shot.nonBlackRatio}%`)
    console.log(`      耗时 ${elapsed} ms（含 PowerShell 启动与 Add-Type 编译）`)

    // PNG magic number：确认真的是图片而不是错误页
    const magic = shot.data?.slice(0, 8) ?? []
    const isPng =
      magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47
    check('字节确实是 PNG', isPng)

    console.log('\n=== 2. 无效句柄的失败路径 ===')
    const bad = await capture.captureWindowBitmap(999999999)
    check('无效句柄返回 ok=false 而非抛异常', bad.ok === false, bad.note)
    check('失败时没有字节', bad.data === null)
  }

  console.log('\n=== 3. 桌面会话探测 ===')
  const probe = await sessionModule.probeDesktopSession()
  check('探测返回布尔锁定标志', typeof probe.locked === 'boolean', probe.note)
  console.log(`      locked=${probe.locked}  foreground=${probe.foregroundProcess || '(unknown)'}`)

  console.log('\n=== 4. 剪贴板写入 ===')
  if (probe.locked) {
    console.log('SKIP  桌面已锁定：剪贴板被系统独占，本环境无法验证写入。')
    console.log('      这正是插件要提前说清的事实——锁定时输入类能力整体不可用，')
    console.log('      而不是让模型把 ExternalException 当成各自独立的故障去逐个排查。')
  } else {
    const payload = 'Computer Use 剪贴板测试 · 中文标点，符号：()[]{}、换行在下方\n第二行'
    const clip = await clipboard.setClipboardText(payload)
    check('写入成功', clip.ok, clip.note)
    check('字符数正确', clip.chars === payload.length, `${clip.chars} / ${payload.length}`)

    // 读回校验只在测试里做；插件本身从不读取剪贴板。
    const readBack = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
      { encoding: 'utf8', timeout: 30000 },
    )
    const normalized = readBack.replace(/\r\n/g, '\n').replace(/\n$/, '')
    check('读回内容一致', normalized === payload, JSON.stringify(normalized.slice(0, 60)))
  }
} catch (error) {
  check('未预期异常', false, `${error?.name}: ${error?.message}`)
} finally {
  try { notepad.kill() } catch {}
  await rm(probeDir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`)
process.exit(failures === 0 ? 0 : 1)
