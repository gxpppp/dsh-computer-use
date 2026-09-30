# dsh-computer-use

把 **Codex 的 Windows Computer Use 能力**接进 DeepSeek Harness 的插件。

它不做像素级识别：用 **UI Automation 可访问性树**「看」窗口，用 **SendInput 输入注入**「动」窗口。
底层复用本机已安装的 Codex 原生助手 `codex-computer-use.exe`，不重新实现一遍 Win32 交互。

**目录**：[和 Codex 原版的关系](#它和-codex-原版的关系) · [依赖](#依赖) · [能力矩阵](#能力矩阵) · [六个工具](#六个工具) · [授权模型](#授权模型) · [配置项](#配置项) · [架构](#架构) · [安装](#安装) · [开发](#开发) · [故障排查](#故障排查)

---

## 它和 Codex 原版的关系

| 维度 | Codex 原版 | 本插件 |
|---|---|---|
| 模型接口 | `node_repl` 持久 JS 会话 + `@oai/sky` | 6 个扁平 DSH 工具 |
| 传输 | stdio / 命名管道 JSON-RPC | **同一套** stdio JSON-RPC（4 字节长度前缀在管道模式下，stdio 模式按 `\n` 分帧） |
| 原生层 | `codex-computer-use.exe` | **同一个 exe，直接复用** |
| 审批 | MCP elicitation | DSH `approval.request()` |
| 提示词 | SKILL.md + guidance/api/confirmations | 同一结构，改写为 DSH 工具形态 |

去掉了 JS 中转层，因为 DSH 的工具调用本身就很轻，扁平工具的 token 成本低于"写 JS 调 API"。

---

## 依赖

**必须本机已安装 Codex 桌面版**（helper 与 `codex.exe` 由它提供）。
插件会自动在以下位置探测，也支持在设置里手写路径：

- helper：`%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\<hash>\bin\node_modules\@oai\sky\bin\windows\codex-computer-use.exe`
- codex：`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`

helper 需要 `CODEX_CLI_PATH` 指向 codex.exe，否则报 `failed to launch codex app-server: program not found`。
插件默认自动注入这两个环境变量。

---

## 能力矩阵

| 能力 | Windows 11 (build ≥ 22000) | Windows 10 | 说明 |
|---|---|---|---|
| 应用/窗口枚举 | ✅ | ✅ | 只读，不需授权 |
| 可访问性树 + 元素索引 | ✅ | ✅ | 桌面自动化的主力路径 |
| 输入注入（点击/输入/按键/滚动/拖拽） | ✅ | ✅ | SendInput |
| 剪贴板粘贴（中文/长文本） | ✅ | ✅ | 写剪贴板 + `Ctrl+V`，走应用自己的粘贴路径 |
| 截图 | ✅ 原生 WGC | ✅ `PrintWindow` 兜底 | Win10 上约 1–3 秒一张，且读不到硬件加速窗口 |
| 窗口故障自愈 | ✅ | ✅ | 最小化 / 几何变化 / 句柄失效就地恢复并重试一次 |
| 等待原语 | ✅ | ✅ | 等文本出现/消失或窗口关闭，替代手写轮询 |
| 桌面锁定探测 | ✅ | ✅ | 锁屏时主动报告并解释连带失败，避免模型逐个误判 |
| 浏览器窗口自动化 | ❌ | ❌ | helper 需要判定当前 URL 才能执行策略；独立运行环境不提供该通道，会主动拒绝 |
| 终端类应用 | ❌ | ❌ | 提示词与原生层双重禁止 |

---

## 六个工具

| 工具 | 作用 | 首次触碰某应用需授权 |
|---|---|---|
| `computer_use_status` | 自检（helper 定位、进程、截图能力、已授权应用、免审批白名单）；`action="reset"` 清授权并重启 helper | 否 |
| `computer_use_apps` | 枚举应用或窗口（只读） | 否 |
| `computer_use_state` | 取窗口快照：可访问性树（含索引与焦点）、截图，或两者 | 是 |
| `computer_use_act` | 执行**一个**动作（含 `paste_text`），默认自动刷新并回传新状态 | 是 |
| `computer_use_wait` | 等界面就绪：文本出现/消失、窗口关闭 | 是 |
| `computer_use_launch` | 启动应用并轮询等待窗口出现 | 是 |

完整参数见 `docs/api.md`；工作流纪律见 `docs/guidance.md`；确认策略见 `docs/confirmations.md`；
面向模型侧的精简版在 `SKILL.md`。

---

## 授权模型

**每个应用在被操作之前，都要先拿到一张票。** 拿不到就报
`未授权 Computer Use 使用「应用名」`——而且一次都不会真正碰到那个窗口。

票只有两个来源，按这个顺序检查：

| 顺序 | 来源 | 判定条件 |
|---|---|---|
| 1 | **免审批白名单** | 应用名命中 `alwaysAllowedAppIds`（归一化后比较） |
| 2 | **审批弹窗** | 走 DSH `approval.request()`，必须返回 `allowed-once` |

票缓存在 **helper 进程的内存**里，DSH 或 helper 重启即失效。

### `alwaysAllowedAppIds` 的匹配规则

比较前会把两边都归一化成**小写、去扩展名、去路径、去 `process:` 前缀**的叶子名：

| 你写的 | helper 上报的 | 归一化后 | 是否命中 |
|---|---|---|---|
| `msedge.exe` | `MSEdge` | `msedge` / `msedge` | ✅ |
| `msedge` | `process:C:\...\msedge.exe` | `msedge` / `msedge` | ✅ |
| `画图` | `mspaint.exe` | `画图` / `mspaint` | ❌ |

**写 exe 名的命中率最高**；中文显示名只有在 helper 上报的恰好就是该中文名时才匹配。

### 配置写在哪

```yaml
# cordis.patch.yml —— profile 的 loader patch 层
- id: computer-use
  disabled: false
  config:
    alwaysAllowedAppIds:
      - mddclass.exe
      - msedge.exe
```

**这条路别指望 GUI 设置页。** 插件用 `settings.installSection()` 注册配置项，而部分 DSH
版本只提供旧的 `register()`，从设置面板写进去的值不会落地到插件读的配置对象上。把白名单
固定在 loader patch 层最稳；改完**重启 DSH** 生效。

### 拿不到票时按这个顺序排查

1. `computer_use_status` 的「免审批白名单」一行，确认目标应用确实在里面；
2. 审批弹窗那条路要求当前会话的 approval 策略是 **`ask`**。策略为 `never` 时审批请求会被
   **直接判定为拒绝**，弹窗根本不会出现——这不是插件故障，是策略本身的行为；
3. 两条路都走不通时，用 `computer_use_status` 的 `action="reset"` 清空已授权集合再重试。

---

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `helperPath` | `''` | 空 = 自动探测 |
| `codexCliPath` | `''` | 空 = 自动探测 |
| `codexHome` | `''` | 空 = `%USERPROFILE%\.codex` |
| `requestTimeoutMs` | `15000` | 单次 RPC 超时 |
| `launchTimeoutMs` | `25000` | `launch_app` 专用超时 |
| `alwaysAllowedAppIds` | `[]` | 免审批白名单；写法与匹配规则见[授权模型](#授权模型) |
| `autoRefreshAfterAction` | `true` | 动作后自动刷新状态 |
| `maxTreeChars` | `12000` | 回传的树字符上限 |
| `allowScreenshots` | `true` | 是否允许截图请求；Win10 上建议设 `false`（`PrintWindow` 每张 1–3 秒，且读不到硬件加速窗口） |
| `idleShutdownMs` | `300000` | helper 空闲回收时间，0 = 常驻 |

---

## 架构

```
DSH 工具层（6 个工具）
      │  参数校验、树截断、截图发布为附件、错误中文化
      ▼
ComputerUseHelper（src/transport/helper.ts）
      │  · 惰性 spawn codex-computer-use.exe（带 --parent-pid）
      │  · stdio JSON-RPC，按 \n 分帧
      │  · 审批闭环：approvalRequest → DSH approval → 带 x-oai-cua-approved-app 重试
      │  · 崩溃自愈、空闲回收、超时管理
      ▼
codex-computer-use.exe（Rust 原生助手）
      │  SendInput + UI Automation + Windows.Graphics.Capture
```

---

## 安装

**前置条件**：Node `^22.19.0 || >=24.0.0`（见 `package.json` 的 `engines`）。

**从 git 安装（开箱即用）：**

```jsonc
{
  "dependencies": {
    "dsh-computer-use": "github:gxpppp/dsh-computer-use"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …其它 bundle
        "dsh-computer-use"
      ]
    }
  }
}
```

仓库自带预构建的 `lib/index.js`，装完直接可用，不需要任何构建步骤。

> 这一点是刻意的：DSH 从 git 安装插件时**只加载 `lib/index.js`，不会执行构建**。
> 仓库里没有它，插件就会以 `failed to import` 启动失败。

**本地开发（link 模式）：**

```jsonc
{
  "dependencies": {
    "dsh-computer-use": "link:<本插件所在目录>/dsh-computer-use"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …其它 bundle
        "dsh-computer-use"
      ]
    }
  }
}
```

改完重启 DSH。`cordis.patch.yml` 会把插件行插进配置。

---

## 开发

```bash
npm run build   # esbuild 打包 src/index.ts → lib/index.js
npm run smoke   # 真实驱动 helper 的冒烟测试（只读，不点击不输入）
```

另有两个直接 `node` 跑的脚本，没有挂进 `npm run`：

```bash
node scripts/load-check.mjs      # 加载验证：用 mock context 跑一遍 apply()，确认工具注册与注入路径
node scripts/smoke-capture.mjs   # 离线冒烟：截图兜底、剪贴板写入、桌面会话探测（不依赖 DSH）
```

`npm run smoke` 覆盖：路径探测、进程启动、JSON-RPC 往返、审批闭环（含 fail-closed 与缓存命中）、进程回收。
`load-check` 适合**在改 profile 配置之前**先跑一次——它完全不触碰桌面。

---

## 故障排查

先跑 `computer_use_status`：

- `桌面会话：已锁定` → **这是最容易被误判的一条**。锁屏会让激活窗口、剪贴板、输入注入
  同时失灵，而截图照常可用，症状看起来像一堆互不相关的故障。锁定时请先解锁桌面，
  换法子重试没有任何意义。
- `helper 未找到` → Codex 未安装，或把 `helperPath` 设成实际路径。
- `codex.exe 未找到` → 同上，设 `codexCliPath`。
- 提示 `failed to activate captured window` → 优先怀疑桌面锁定；解锁后若仍失败，
  多半是目标窗口被别的进程占着前台。
- 提示 `could not determine the current browser URL` → 目标是浏览器。这是策略边界，
  不是 bug；浏览器任务改用专门通道或让用户手动完成。
- 提示 `SetIsBorderRequired failed` → 只会出现在强制指定 helper 截图后端时；
  Win10 默认已改走本地 PrintWindow。
- 截图报「几乎全黑」 → 该窗口使用硬件加速渲染，PrintWindow 读不到；改用可访问性树。
- 报 `未授权 Computer Use 使用「X」`、或每次操作都要重新确认 → 该应用没拿到授权票，
  处理办法见[授权模型](#授权模型)。

### 为什么锁屏要单独识别

锁屏时三类 API 会同时变脸，而它们的报错各说各话：

| API | 锁屏时的表现 |
|---|---|
| `SetForegroundWindow` | 被拒 → `failed to activate captured window` |
| 剪贴板 | 被系统独占 → `ExternalException` / `Access is denied` |
| 输入注入 | 没有焦点可送 → 操作"成功"但界面纹丝不动 |
| `PrintWindow` | **照常可用**（不需要前台），所以最容易被当成"一切正常"的证据 |

插件因此把桌面锁定做成显式探测：`computer_use_status` 直接报告，
输入类动作失败时也会补一次探测并把真正原因写进错误里。

---

## 许可

MIT，见 [LICENSE](./LICENSE)。

配套文件：[SKILL.md](./SKILL.md)（模型侧精简说明）、[docs/api.md](./docs/api.md)（完整参数）、
[docs/guidance.md](./docs/guidance.md)（工作流纪律）、[docs/confirmations.md](./docs/confirmations.md)（确认策略）。
