/**
 * 冒烟测试：在不启动 DSH 的前提下验证传输层。
 *
 * 覆盖四件事：
 *   1. 路径探测（helper 与 codex.exe 都能从本机实装里被找到）
 *   2. 进程启动与 stdio JSON-RPC 往返（list_apps / list_windows）
 *   3. 审批闭环（无 asker 时必须拒绝，有 asker 时必须重试成功）
 *   4. 进程回收
 *
 * 只做只读操作，不会点击或输入任何东西。
 */
import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const probeDir = resolve(root, '.smoke')
const probeEntry = resolve(probeDir, 'helper.mjs')

await rm(probeDir, { recursive: true, force: true })
await mkdir(probeDir, { recursive: true })

await build({
  entryPoints: [resolve(root, 'src/transport/helper.ts')],
  outfile: probeEntry,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  logLevel: 'warning',
})

const {
  ComputerUseHelper,
  discoverHelperPath,
  discoverCodexCliPath,
  defaultCodexHome,
} = await import(pathToFileURL(probeEntry).href)

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures += 1
}

console.log('=== 1. 路径探测 ===')
const helperPath = discoverHelperPath() ?? ''
const codexCliPath = discoverCodexCliPath() ?? ''
const codexHome = defaultCodexHome()
check('helper 定位', helperPath !== '', helperPath || '未找到 codex-computer-use.exe')
check('codex.exe 定位', codexCliPath !== '', codexCliPath || '未找到 codex.exe')
console.log(`      CODEX_HOME = ${codexHome}`)
if (helperPath === '') {
  console.log('helper 不可用，后续测试跳过。')
  process.exit(1)
}

const helper = new ComputerUseHelper({
  helperPath: () => helperPath,
  codexCliPath: () => codexCliPath,
  codexHome: () => codexHome,
  requestTimeoutMs: () => 25_000,
  launchTimeoutMs: () => 30_000,
  idleShutdownMs: () => 0,
  alwaysAllowed: () => [],
  onEvent: (event) => {
    if (event.kind === 'exit') console.log(`      [event:exit] ${event.stderr.slice(0, 200)}`)
  },
})

try {
  console.log('\n=== 2. 启动与只读 RPC ===')
  const apps = await helper.call('list_apps')
  check('list_apps 返回数组', Array.isArray(apps), `${apps.length} 个应用`)
  check('进程已启动', helper.running, `pid=${helper.pid ?? '?'}`)

  const windows = await helper.call('list_windows')
  check('list_windows 返回数组', Array.isArray(windows), `${windows.length} 个窗口`)

  console.log('\n=== 3. 审批闭环 ===')
  // 浏览器窗口在 Windows 上受 URL 策略管控，独立运行时会被 helper 主动拒绝，
  // 因此优先挑一个非浏览器应用来验证「审批 → 重试 → 取树」这条正路。
  const BROWSER_HINT = /edge|chrome|chromium|firefox|brave|opera|vivaldi|browser|iexplore/i
  const candidates = apps.filter((app) => Array.isArray(app.windows) && app.windows.length > 0)
  const withWindow =
    candidates.find((app) => !BROWSER_HINT.test(app.id) && !BROWSER_HINT.test(app.displayName ?? '')) ??
    candidates[0]
  if (withWindow === undefined) {
    check('审批探针', false, '找不到带窗口的应用，无法测试')
  } else {
    const target = withWindow.windows[0]
    const window = { app: target.app, id: target.id }
    console.log(`      目标：${target.title ?? '(无标题)'} / ${target.app}`)

    let denied = false
    try {
      await helper.call('get_window_state', { window, include_screenshot: false, include_text: true })
    } catch (error) {
      denied = error?.name === 'HelperError' || error?.name === 'HelperApprovalDeniedError'
      console.log(`      首次调用（无 asker）：${error?.name} — ${error?.message?.slice(0, 120)}`)
    }
    check('无 asker 时 fail closed', denied)

    let askedCount = 0
    const state = await helper.call(
      'get_window_state',
      { window, include_screenshot: false, include_text: true },
      {
        ask: async (request) => {
          askedCount += 1
          console.log(`      [approve] ${request.displayName} (${request.app}) risk=${request.riskLevel ?? '-'}`)
          return true
        },
      },
    )
    check('审批后重试成功', askedCount >= 1 && state !== undefined)
    check('授权被记录', helper.authorizedApps.length > 0, helper.authorizedApps.join(', '))
    const tree = state?.accessibility?.tree ?? ''
    console.log(`      可访问性树 ${tree.split('\n').length} 行 / ${tree.length} 字符`)

    console.log('\n=== 4. 授权缓存生效（第二次不应再问）===')
    let askedAgain = 0
    await helper.call(
      'get_window_state',
      { window, include_screenshot: false, include_text: true },
      {
        ask: async () => {
          askedAgain += 1
          return true
        },
      },
    )
    check('缓存命中，未重复询问', askedAgain === 0, `询问 ${askedAgain} 次`)
  }
} catch (error) {
  check('未预期异常', false, `${error?.name}: ${error?.message}`)
} finally {
  console.log('\n=== 5. 回收 ===')
  await helper.stop()
  check('进程已回收', !helper.running)
}

await rm(probeDir, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`)
process.exit(failures === 0 ? 0 : 1)
