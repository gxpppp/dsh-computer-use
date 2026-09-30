/**
 * 加载验证：用最小 mock 的 cordis context 跑一遍插件的 apply()。
 *
 * 目的是在改 DSH profile 配置之前，先确认：
 *   - lib/index.js 能被 import（外部依赖可解析）
 *   - apply() 不抛异常
 *   - 六个工具都完成了注册
 *   - settings / systemPrompt 两条注入路径都能走通
 *
 * 不执行任何工具，因此不会触碰桌面。
 */
import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = pathToFileURL(resolve(root, 'lib/index.js')).href

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures += 1
}

const mod = await import(entry)
check('模块可加载', true)
check('导出 apply', typeof mod.apply === 'function')
check('声明 inject', Array.isArray(mod.inject), JSON.stringify(mod.inject))

const registered = []
const promptSections = []
const settingsSections = []

const makeCtx = () => ({
  inject(deps, callback) {
    const services = {}
    if (deps.includes('tools')) services.tools = { register: (tool) => registered.push(tool) }
    if (deps.includes('settings')) {
      services.settings = {
        installSection: (_ctx, namespace, _schema, _initial, options) => {
          settingsSections.push({ namespace, options })
        },
      }
    }
    if (deps.includes('systemPrompt')) {
      services.systemPrompt = { section: (section) => promptSections.push(section) }
    }
    callback(services)
  },
  get() {
    return undefined
  },
  effect(fn, label) {
    void label
    const dispose = fn()
    if (typeof dispose === 'function') dispose()
  },
  logger: { debug() {} },
})

try {
  mod.apply(makeCtx(), undefined)
  check('apply() 未抛异常', true)
} catch (error) {
  check('apply() 未抛异常', false, `${error?.name}: ${error?.message}`)
}

check('注册了 6 个工具', registered.length === 6, registered.map((t) => t.name).join(', '))
const names = registered.map((t) => t.name).sort()
check(
  '工具命名符合预期',
  JSON.stringify(names) ===
    JSON.stringify([
      'computer_use_act',
      'computer_use_apps',
      'computer_use_launch',
      'computer_use_state',
      'computer_use_status',
      'computer_use_wait',
    ]),
  names.join(', '),
)

for (const tool of registered) {
  const hasShape =
    typeof tool.name === 'string' &&
    typeof tool.description === 'string' &&
    typeof tool.parameters === 'object' &&
    typeof tool.output?.schema === 'object' &&
    typeof tool.output?.render === 'function' &&
    typeof tool.execute === 'function'
  check(`工具 ${tool.name} 结构完整`, hasShape)
}

check('注入了 system prompt 策略段', promptSections.length === 1, promptSections[0]?.name ?? '（无）')
check(
  '策略段文本非空',
  typeof promptSections[0]?.text === 'string' && promptSections[0].text.length > 200,
  `${promptSections[0]?.text?.length ?? 0} 字符`,
)
check('装配了 settings 段', settingsSections.length === 1, settingsSections[0]?.namespace ?? '（无）')

// 错误配置必须在 apply 阶段就被挡下。
try {
  mod.apply(makeCtx(), { requestTimeoutMs: 10, launchTimeoutMs: 25000, maxTreeChars: 12000, idleShutdownMs: 300000, alwaysAllowedAppIds: [] })
  check('非法配置被拒绝', false, '未抛异常')
} catch {
  check('非法配置被拒绝', true)
}

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`)
process.exit(failures === 0 ? 0 : 1)
