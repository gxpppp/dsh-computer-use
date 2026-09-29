/**
 * dsh-computer-use —— 把 Codex 的 Windows Computer Use 能力接进 DSH。
 *
 * 架构（与 Codex 自身同源，但去掉了它那层 node_repl / JS 中转）：
 *
 *   DSH 工具层（5 个原生工具）
 *        ↓
 *   ComputerUseHelper：stdio JSON-RPC + 审批闭环 + 进程自愈
 *        ↓
 *   codex-computer-use.exe：SendInput + UI Automation（+ Windows 11 的 WGC 截图）
 *
 * 提示词分两层：常驻的短策略进 system prompt，完整策略与工作流放 SKILL.md + docs/，
 * 由模型按需读取，避免每次请求都背上上万字符。
 * @module dsh-computer-use
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  COMPUTER_USE_SETTINGS_NAMESPACE,
  Config,
  DEFAULT_CONFIG,
  validateConfig,
  type Config as PluginConfig,
} from './settings/schema.ts'
import { ComputerUseHelper, defaultCodexHome, discoverCodexCliPath, discoverHelperPath } from './transport/helper.ts'
import { COMPUTER_USE_POLICY_SECTION, COMPUTER_USE_SYSTEM_POLICY } from './prompt/policy.ts'
import { createToolHost } from './tools/context.ts'
import { registerStatusTool } from './tools/status.ts'
import { registerAppsTool } from './tools/apps.ts'
import { registerStateTool } from './tools/state.ts'
import { registerActTool } from './tools/act.ts'
import { registerLaunchTool } from './tools/launch.ts'
import { registerWaitTool } from './tools/wait.ts'

export const inject = ['tools']

/** system prompt 里策略段落的序位：紧随 DSH 内置工具段之后。 */
const POLICY_SECTION_ORDER = 1400

/**
 * 插件入口。
 *
 * 工具只注册一次，其行为通过闭包读取实时配置；helper 进程按需拉起，空闲自动回收。
 */
export function apply(ctx: Context, config?: PluginConfig): void {
  const initial = config ?? DEFAULT_CONFIG
  validateConfig(initial)

  let current: PluginConfig = initial
  const readConfig = (): PluginConfig => current

  const helper = new ComputerUseHelper({
    helperPath: () => resolveHelperPath(readConfig()),
    codexCliPath: () => resolveCodexCliPath(readConfig()),
    codexHome: () => resolveCodexHome(readConfig()),
    requestTimeoutMs: () => readConfig().requestTimeoutMs,
    launchTimeoutMs: () => readConfig().launchTimeoutMs,
    idleShutdownMs: () => readConfig().idleShutdownMs,
    alwaysAllowed: () => readConfig().alwaysAllowedAppIds,
    onEvent: (event) => {
      if (event.kind === 'exit') {
        ctx.logger?.debug?.(`computer-use helper 退出：${event.stderr.slice(0, 500)}`)
      }
    },
  })

  const host = createToolHost({
    config: readConfig,
    helper: () => helper,
    approver: (agent, toolName, signal) => async (request) => {
      // 没有 agent 就没有可审计的提问主体；fail closed。
      if (agent === undefined) return false
      const approval = ctx.get('approval')
      if (approval === undefined) return false
      try {
        const outcome = await approval.request({
          agent,
          toolName,
          reason: `Computer Use 需要取得「${request.displayName}」(${request.app}) 的界面访问权限以便操作其窗口`,
          signal,
        })
        // 'allowed-once' 是唯一授权结果；其余（rejected/cancelled/unavailable）都视为拒绝。
        return outcome === 'allowed-once'
      } catch {
        return false
      }
    },
    attachments: () => ctx.get('attachments'),
    notice: (message) => {
      ctx.logger?.debug?.(message)
    },
  })

  const tools: ToolDefinition[] = [
    ...registerStatusTool(host),
    ...registerAppsTool(host),
    ...registerStateTool(host),
    ...registerActTool(host),
    ...registerLaunchTool(host),
    ...registerWaitTool(host),
  ]

  ctx.inject(['tools'], (toolsCtx) => {
    for (const tool of tools) toolsCtx.tools.register(tool)
  })

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, COMPUTER_USE_SETTINGS_NAMESPACE, Config, initial, {
      setSource: (source: () => PluginConfig) => {
        current = source()
      },
      onChange: () => {
        // 路径类配置只在下次 spawn 生效；旧进程可能连的是旧 helper，直接回收最省心。
        void helper.restart()
      },
      validate: validateConfig,
    })
  })

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: COMPUTER_USE_POLICY_SECTION,
      order: POLICY_SECTION_ORDER,
      text: COMPUTER_USE_SYSTEM_POLICY,
    })
  })

  ctx.effect(() => () => {
    void helper.stop()
  }, 'dsh-computer-use.helper')
}

/** 显式配置优先；否则在 Codex 运行时目录里探测。 */
export function resolveHelperPath(config: PluginConfig): string {
  const explicit = config.helperPath.trim()
  if (explicit !== '') return explicit
  return discoverHelperPath() ?? ''
}

/** 显式配置优先；否则在 Codex 安装目录里探测。 */
export function resolveCodexCliPath(config: PluginConfig): string {
  const explicit = config.codexCliPath.trim()
  if (explicit !== '') return explicit
  return discoverCodexCliPath() ?? ''
}

/** 显式配置优先；否则读 %CODEX_HOME% 或 %USERPROFILE%\.codex。 */
export function resolveCodexHome(config: PluginConfig): string {
  const explicit = config.codexHome.trim()
  if (explicit !== '') return explicit
  return defaultCodexHome()
}

export { Config, DEFAULT_CONFIG, validateConfig, COMPUTER_USE_SETTINGS_NAMESPACE }
export type { PluginConfig }
