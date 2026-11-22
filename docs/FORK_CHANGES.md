# Fork 起源与改进说明

本文档清晰说明 **T3 Claude VPS（`t3-claude-vps`）** 的上游来源、开源许可证合规声明、保留的上游能力，以及本 Fork 新增与改进的全部内容。

---

## 一、上游来源与许可证声明

- **上游项目**：[`vv-get-ti/claude-vps-bridge`](https://github.com/vv-get-ti/claude-vps-bridge)
- **分叉基线**：`0.14.1`（上游提交 `0acd8a0`）
- **本 Fork 品牌名**：**T3 Claude VPS**（`t3-claude-vps`）
- **首个正式版本**：`v1.0.0`（`2026-11-23`）
- **许可证**：严格沿用上游 **[LGPL-3.0-only](../LICENSE)**（随附 [GPL-3.0 全文](../LICENSE-GPL-3.0)），完整保留上游版权与 [第三方声明](../THIRD_PARTY_NOTICES.md)。
- **为什么新建并重命名本 Fork**：上游 `claude-vps-bridge` 专注于 CodexHost 桌面端插件；本 Fork 在完整复用并兼容上游核心桥接与 CodexHost 插件的基础上，将其扩展为面向 **[T3 Code](https://github.com/pingdotgg/t3code)** 的官方 `claudeAgent` 原生远程 VPS Claude Code 方案，并支持脱离 CodexHost 独立安装。

---

## 二、完整保留并致敬的上游核心底座

本 Fork 完整继承了上游 `vv-get-ti/claude-vps-bridge`（`0.14.1`）的全部核心工程能力，并未破坏任何原有 CodexHost 路径：

- **桥接协议 3 与 SSH 双向复用传输**：分块流控、按字节确认、小请求插队、断线按游标恢复与请求去重。
- **多线路自动选路**：支持 `direct`、本机 SOCKS5 代理与 `cloudflared` 自动切换及入口一致性观测。
- **Windows 本机工作区运行时**：本机文件读写、ripgrep 搜索快照分页、独立长任务执行器（命名管道）、写入协作锁与 Git worktree 支持。
- **本机项目环境与附件能力**：`CLAUDE.md`、`AGENTS.md`、`.claude/rules`、Hooks、权限预检、图片/PDF 哈希缓存与媒体导出。
- **原子事务式部署与回滚**：两端文件清单校验、依赖版本与 SHA256 验证、保留数据停用与统一诊断（`diagnose.mjs`）。
- **CodexHost 0.20.0+ 完整兼容**：原有 CodexHost 插件入口（`plugin/plugin.mjs`、`remote/remote-server.mjs`）及会话续接行为保持兼容。

---

## 三、本 Fork 的四大核心改进

### 1. 新增 T3 Code 官方 `claudeAgent` 原生 Shim（`t3-native/` + `remote/claude-stream-relay.mjs`）

在 T3 Code 中直接注册独立的官方 `claudeAgent` 实例，完整获得 T3 原生 Claude 体验：

- **独立实例与目录隔离**：在 T3 Code 注册为独立实例 **`claude-vps`**（显示名 **Claude VPS**，`driver: claudeAgent`）并配置独立 `homePath`（`claude-home`），完全不修改默认 `claudeAgent`、不触碰本机 `~/.claude`，也不改动 T3 Code 任何程序文件。
- **直通官方 `stream-json` 协议（零反代、零逆向）**：Windows 轻量启动器（`claude-vps-shim.cs` → `.exe`）+ Node 代理（`claude-vps-shim.mjs`）经现有免密 SSH 通道连至 `remote/claude-stream-relay.mjs`，直接驱动 VPS 原版 `claude` CLI。
- **完整支持 T3 内置 `claudeAgent` 能力**：
  - 顶部 / 账号页 **5h & 7d 实时额度圆环**（直通 `get_usage` 与 `rate_limit_event`）。
  - **单套原生权限**（T3 Supervised / Auto-accept / Full-access 直通 `can_use_tool`）。
  - **内置 `textGeneration`**（自动标题、Commit、PR 描述、PR Review Guide）。
  - 完整模型列表 + `effort` / `ultracode` / `fastMode` / `autoCompactWindow` / `beforeCacheExpires` 缓存过期前自动压缩。
- **本机全量 MCP 代理与安全策略（凭据零出境）**：`LocalMcpHub`（`t3-native/http-mcp-client.mjs`）+ `t3-native/mcp-policy.mjs` 统一拦截 `--mcp-config` 与动态 `control_request: mcp_set_servers`，将 `t3-code` HTTP 端点（支持流式逐事件 SSE）、用户自定义本机 HTTP MCP 及 Windows 本地 Stdio MCP 全部留在 Windows 侧运行，URL/Token/本机环境变量永不发往 VPS；VPS 端通过 `mcp-local.py --server <name>` 与会话私有白名单文件（`WINDOWS_ALLOWED_MCP_FILE`，0600 权限）安全转发，并放行 `ToolSearch` 延迟加载。Plan 模式实施 Fail-Closed 硬拦截，并叠加 `T3_MCP_ALLOW_TOOLS` / `T3_MCP_DENY_TOOLS` 与项目 `permissions.deny`。
- **远端读图 / PDF 路径双向回映射**：记录 Windows 侧 `media-export` 产生的 VPS `.bridge-media/<session>/<sha256>.<ext>` 与 Windows 原始路径对应关系（按 `projectId` 持久化至 `media-path-cache.json` 兼容 `--resume`），自动回映射流向 T3 Code 的原生 `Read`（分块 `stream_event`、`assistant` `tool_use`、`user` `tool_use_result`、Markdown 引用与 `can_use_tool` 审批弹窗），并在审批放行回传 `control_response.updatedInput` 时反向还原为 VPS 路径，确保 T3 Code 读图预览正常渲染。
- **多 SSH 线路自动选路、Hook 阻断与任务取消找回**：启动期通过 `SshRoutes.firstAvailable()` 自动在 `cloudflared` / `socks5` / `direct` 线路间故障切换（自动缓冲早期 `initialize`/`mcp_set_servers` 帧不丢包）；发送用户消息时自动展开 Windows 本机 `.claude/{skills,commands}`（替换 `$ARGUMENTS` 不劫持内置命令）、执行 `UserPromptSubmit` 本机 Hooks（阻断时明确反馈且不锁死会话）；停止会话主动取消本机长任务，SSH 意外断线自动查回并保留原 `requestId` 防重放。
- **原子暂存升级与自检回滚**：`manage-native.mjs` 先在独立暂存目录编译并跑完离线 `--self-test` 与远端 `--version --live` 校验后再原子热替换（支持在旧 `.exe` 运行时安全切换），失败自动回滚。

### 2. 新增纯 T3 独立安装模式与灵活组合开关

- `installer/configure.py` 新增 `--t3-only`，允许在未安装 CodexHost 桌面端的 Windows 机器上生成配置。
- `install.ps1` 新增 `-T3Only` 与 `-WithT3`（并兼容 `-WithT3Native`），支持：
  - 纯 T3 Code 部署（`-T3Only`）
  - T3 Code + CodexHost 双宿共存（`-WithT3`）
  - 仅 CodexHost（无附加参数，与上游完全一致）
- 提供独立管理工具 `t3-native/manage-native.mjs`，支持单独执行 `install` / `status` / `uninstall`，互不干扰且保留会话数据。

### 3. 核心桥接与 VPS 守卫加固（向后兼容）

- **`remote/workspace-guard.py` 零改写设计**：移除全部 `updatedInput` 命令改写（JSON 含未转义单引号时直接拒绝并提示 `\u0027`），彻底修复 Claude Code `auto` 模式下简写与 JSON 并发调用触发分类器拒批的问题，并补齐 `ToolSearch`、任务工具、`ExitPlanMode` / `EnterPlanMode` 与 `WINDOWS_ALLOWED_MCP_FILE` 动态本地 MCP 放行名单。
- **`remote/claude-windows`、`remote/mcp-local.py` 与 `plugin/runtime/workspace-runtime.mjs`**：允许受控内置任务/规划/工具发现工具，支持 `mcp-local.py --server <name>` 路由转发，并增强本机轮次任务取消（`cancel-jobs`）与活动任务查询（`listProjectJobs`）。
- **`scripts/check.py`**：扩展静态语法与受管资产校验，覆盖 `t3-native/` 全部模块。

### 4. 底层兼容性承诺（为什么不改动内部 ID 与目录名）

为确保从上游 `claude-vps-bridge` 迁移、或与 CodexHost 共存的用户**零成本升级、不丢失已有配置、项目映射与历史会话**，本 Fork 刻意保持以下底层技术标识不变：

- CodexHost 插件 ID：`claude-vps`（`plugin/manifest.json`）
- 配置文件名：`bridge-config.local.json` / `bridge-config.json` 与环境变量 `CLAUDE_VPS_CONFIG`
- VPS 远端部署根目录默认仍兼容 `~/.codexhost/windows-bridge`（可通过 `--remote-root` 自定义）

---

## 四、相对上游基线（`0acd8a0`）的文件变更总览

| 路径 | 变更类型 | 说明 |
|---|---|---|
| `t3-native/*` | **Fork 新增** | `claude-vps-shim.cs`、`claude-vps-shim.mjs`、`http-mcp-client.mjs`、`mcp-policy.mjs`、`bridge-installation.mjs`、`manage-native.mjs` |
| `remote/claude-stream-relay.mjs` | **Fork 新增** | 供 `t3-native/` 直通 VPS 原版 Claude Code `stream-json` 的轻量中继 |
| `docs/T3CODE.md`、`docs/FORK_CHANGES.md` | **Fork 新增** | T3 Code 原生接入指南与本 Fork 改进说明文档 |
| `install.ps1`、`installer/*` | **Fork 增强** | `--t3-only` / `-T3Only` / `-WithT3` 与新远端文件受管部署 |
| `plugin/diagnose.mjs`、`plugin/runtime/*` | **Fork 增强** | 无 CodexHost 独立运行支持、轮次任务取消与活动任务查询 |
| `remote/workspace-guard.py`、`remote/claude-windows`、`remote/mcp-local.py`、`remote/tool-bridge.mjs`、`remote/bridge-instructions.md` | **Fork 增强** | 零改写并发修复、任务/规划/`ToolSearch` 放行、动态本机 MCP 转发与读图路径约束 |
| `scripts/check.py`、`README.md`、`CHANGELOG.md`、`THIRD_PARTY_NOTICES.md`、`docs/*` | **Fork 增强** | 项目更名重构为 **T3 Claude VPS**，补全校验、全套文档与深浅色矢量图示 |
