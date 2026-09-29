# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-29

首个可用版本。把 Codex 的 Windows Computer Use 能力接进 DeepSeek Harness。

### Added

- **六个模型工具**：`computer_use_status`、`computer_use_apps`、`computer_use_state`、
  `computer_use_act`、`computer_use_wait`、`computer_use_launch`。
- **stdio JSON-RPC 传输层**：直接驱动 `codex-computer-use.exe`，按 `\n` 分帧，
  含惰性启动、崩溃自愈、空闲回收与超时管理。
- **审批闭环**：helper 的 `approvalRequest` 接到 DSH `approval.request()`，
  放行后以 `x-oai-cua-approved-app` 元数据重试；无审批器时 fail closed。
- **截图双后端**：Windows 11 走 helper 原生 Windows.Graphics.Capture；
  更早的系统自动降级为本地 `PrintWindow` + GDI+ 兜底。
- **剪贴板粘贴**：`paste_text` 写剪贴板后发 `Ctrl+V`，剪贴板不可用时降级为逐字符注入。
- **窗口故障自愈**：最小化 / 几何变化 / 句柄失效就地恢复并重试一次。
- **键盘焦点前置**：键盘类动作执行前自动把目标窗口带到前台，激活失败即报错，
  避免"返回成功但界面无变化"的静默失败。
- **桌面锁定探测**：识别锁屏状态并在诊断与错误路径中直说，
  避免把锁屏的连带症状误判成互不相关的故障。
- **提示词三层**：常驻 system prompt 安全基线（675 字符）、`SKILL.md` 技能索引、
  `docs/` 下的工作流与确认策略全文。
- **三套测试**：`load-check`（mock context 验证注册）、`smoke`（真实驱动 helper）、
  `smoke-capture`（截图 / 剪贴板 / 会话探测）。

### Known limitations

- 仅实现 Windows 后端；上游存在 macOS / Linux 的 target，本插件未接入。
- 依赖本机已安装的 Codex 桌面版提供 helper 与 `codex.exe`，不自包含。
- 浏览器窗口会被 helper 的策略拒绝（无法判定当前 URL），需改用专门的浏览器通道。
- 可访问性读数可能滞后；确认动作结果应以截图为判据。
