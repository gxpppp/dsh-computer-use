# 工具 API 参考

## 通用约定

### 窗口标识

凡是对窗口的操作都要 `window_app` 与 `window_id` 两个参数，**两者必须逐字来自 `computer_use_apps` 的返回**：

```
computer_use_apps 返回：
  - 记事本  [运行中]
      id: {1AC14E77-...}\notepad.exe
      窗口: 无标题 - 记事本  id=4654036
        app: process:C:\Windows\System32\notepad.exe

→ 后续调用传：
  window_app  = "process:C:\\Windows\\System32\\notepad.exe"
  window_id   = 4654036
```

`window_id` 就是 Win32 窗口句柄（HWND），不要自己构造。

### 元素索引的时效

`element_index` 只对**产生它的那一次 `computer_use_state` 观察**有效。
任何动作之后都必须重新观察。`computer_use_act` 默认会自动刷新并回传新树，那是新的基准。

### 坐标系

`x` / `y` 是**窗口相对**坐标（窗口内容区左上角为原点），不是屏幕坐标。

### 窗口故障自动恢复

窗口最小化、几何变化、句柄失效这三类故障，`computer_use_state` / `computer_use_act` /
`computer_use_wait` 会就地激活窗口、刷新句柄并重试一次（只重试一次），并在结果的 `notes`
里注明发生过什么。不需要模型自己处理，也不要因此重复发送同一个动作。

### 授权

首次触碰某个应用时，工具会走 DSH 审批流程；被拒绝即中止该动作。
`computer_use_status` 的 `action="reset"` 可清空本进程内的授权缓存。
`alwaysAllowedAppIds` 设置项可把常用应用加入免确认白名单。

### 截图后端

`computer_use_status` 报告的 `capture.screenshot` 决定走哪条路：

| 系统 | 后端 | 特点 |
|---|---|---|
| Windows 11 (build ≥ 22000) | helper 的 `Windows.Graphics.Capture` | 快、能截被遮挡的窗口 |
| Windows 10 及更早 | 本地 `PrintWindow` + GDI+ | 约 1–3 秒一张；**读不到硬件加速窗口**，会明确报"几乎全黑" |

两条路对调用方透明，结果里的 `screenshotBackend` 字段注明实际用了哪条。
`allowScreenshots=false` 会整体关闭截图请求。

---

## computer_use_status

自检与重置。**失败排查的第一站。**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | `"report"` \| `"reset"` | 否 | 默认 `report`；`reset` 清空授权缓存并重启 helper |
| `probe` | boolean | 否 | 为真时额外跑一次只读的 `list_windows` 验证连通性 |

返回：`helperPath` / `helperFound` / `codexCliPath` / `codexFound` / `processRunning` / `processPid` /
`capture`（含 `build`、`screenshot`、`note`）/ `authorizedApps` / `alwaysAllowedAppIds` /
`probeResult` / `problems` / `summary`。

---

## computer_use_apps

枚举应用或窗口。**只读，不需授权。**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `scope` | `"apps"` \| `"windows"` | 否 | 默认 `apps`（按应用分组）；`windows` 列出全部可目标化窗口 |
| `query` | string | 否 | 大小写不敏感的子串过滤，匹配应用名、应用 id、窗口标题 |
| `limit` | number | 否 | 返回条数上限 1–200（默认 apps 40 / windows 80） |
| `include_windows` | boolean | 否 | `scope="apps"` 时是否带出各应用的窗口，默认 true |

返回：`scope` / `total` / `apps[]` / `windows[]` / `summary`。

---

## computer_use_state

取窗口快照。**这是唯一返回元素索引的工具。**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `window_app` | string | **是** | 来自 `computer_use_apps` |
| `window_id` | number | **是** | 来自 `computer_use_apps` |
| `include_tree` | boolean | 否 | 取可访问性树（含索引与焦点），默认 **true** |
| `include_screenshot` | boolean | 否 | 取截图，默认 false |
| `max_tree_chars` | number | 否 | 本次调用的树字符上限，覆盖插件设置 |

两者不能同时为 false。

返回：`window` / `tree` / `treeChars` / `treeTruncated` / `screenshotBackend` /
`screenshots[]`（已发布为附件）/ `notes` / `summary`。

`summary` 里会给出：窗口标题与标识、树内容、`当前焦点：`、`选中文本：`、`文档文本前 800 字符：`。

---

## computer_use_act

执行**一个**动作，然后默认自动刷新窗口状态。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | 见下表 | **是** | 动作类型 |
| `window_app` | string | **是** | 来自 `computer_use_apps` |
| `window_id` | number | **是** | 来自 `computer_use_apps` |
| `element_index` | number | 视动作 | 来自最近一次 `computer_use_state` |
| `x` / `y` | number | 视动作 | 窗口相对坐标 |
| `from_x` / `from_y` / `to_x` / `to_y` | number | 视动作 | `drag` 用 |
| `scroll_x` / `scroll_y` | number | 视动作 | `scroll` 的增量；向上/向左为负 |
| `text` | string | 视动作 | `type_text` / `paste_text` 的文本 |
| `key` | string | 视动作 | `press_key` 的按键或 `+` 组合 |
| `value` | string | 视动作 | `set_value` 的新值 |
| `secondary_action` | string | 视动作 | `perform_secondary_action` 的动作标签 |
| `click_count` | number | 否 | 1–3，默认 1 |
| `mouse_button` | `"left"` \| `"right"` \| `"middle"` | 否 | 默认 left |
| `refresh` | boolean | 否 | 动作后是否自动刷新，默认跟随插件设置（true） |

动作与必填参数对照：

| `action` | 必填 | 说明 |
|---|---|---|
| `click_element` | `element_index` | 点可访问性元素；**优先用这个** |
| `click` | `x`, `y` | 坐标点击 |
| `type_text` | `text` | 逐字符输入文本。中文实测完全正确；超长文本会明显变慢 |
| `paste_text` | `text` | 写剪贴板 + `Ctrl+V`。目标应用不支持该快捷键时改用 `type_text` |
| `press_key` | `key` | 单个按键或组合，如 `Return`、`Tab`、`Control_L+a`、`KP_0` |
| `scroll` | `x`, `y`, `scroll_x` 或 `scroll_y` | 从指定点滚动 |
| `drag` | `from_x`, `from_y`, `to_x`, `to_y` | 拖拽 |
| `set_value` | `element_index`, `value` | 直接替换可编辑元素的值 |
| `perform_secondary_action` | `element_index`, `secondary_action` | 触发次要动作（展开、滚动条等） |
| `activate_window` | — | 把窗口带到前台 |

返回：`action` / `description` / `refreshed` / `window` / `tree` / `notes` / `summary`。

---

## computer_use_wait

等待界面进入指定状态。**用替代手写轮询。**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `window_app` | string | **是** | 来自 `computer_use_apps` |
| `window_id` | number | **是** | 来自 `computer_use_apps` |
| `until` | `"tree_contains"` \| `"tree_not_contains"` \| `"window_closed"` | **是** | 等待的条件 |
| `value` | string | 视条件 | 要匹配的文本片段；`window_closed` 忽略它 |
| `timeout_ms` | number | 否 | 500–120000，默认 15000 |
| `interval_ms` | number | 否 | 200–5000，默认 600 |
| `max_tree_chars` | number | 否 | 结果里回传的树字符上限 |

返回：`matched` / `condition` / `value` / `elapsedMs` / `attempts` / `windowGone` / `tree` / `notes` / `summary`。

`matched=true` 只表示**观察到了**条件；超时返回 `matched=false`，此时应改用
`computer_use_state` 看清当前界面，而不是盲目重试。

典型用法：

- 点了「保存」后等 `until="tree_contains"`, `value="已保存"`；
- 提交表单后等对话框出现，再 `computer_use_state` 拿它的元素索引；
- 点了「关闭」后等 `until="window_closed"` 确认窗口真的消失。

---

## computer_use_launch

启动应用并轮询等待窗口出现。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `app` | string | **是** | `computer_use_apps` 返回的应用 id，或 `.exe` 绝对路径 |
| `wait_ms` | number | 否 | 轮询等待上限 0–30000，默认 4000 |

返回：`app` / `windows[]`（新出现的窗口，可直接用于 `computer_use_state`）/ `notes` / `summary`。

不支持 pid 型标识。
