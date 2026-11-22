# Fork 起源与改进说明

本文档清晰说明 **T3 Claude VPS（`t3-claude-vps`）** 的上游来源、开源许可证合规声明、保留的上游能力，以及本 Fork 新增与改进的全部内容。

---

## 一、上游来源与许可证声明

- **上游项目**：[`vv-get-ti/claude-vps-bridge`](https://github.com/vv-get-ti/claude-vps-bridge)
- **分叉基线**：`0.14.1`（上游提交 `0acd8a0`）
- **本 Fork 品牌名**：**T3 Claude VPS**（`t3-claude-vps`）
- **主要改造时间**：`2026-11-22` 起
- **许可证**：严格沿用上游 **[LGPL-3.0-only](../LICENSE)**（随附 [GPL-3.0 全文](../LICENSE-GPL-3.0)），完整保留上游版权与 [第三方声明](../THIRD_PARTY_NOTICES.md)。
- **为什么新建并重命名本 Fork**：上游 `claude-vps-bridge` 专注于 CodexHost 桌面端插件；本 Fork 在完整复用并兼容上游核心桥接与 CodexHost 插件的基础上，将其深度扩展为面向 **[T3 Code](https://github.com/pingdotgg/t3code)** 的双引擎（官方 `claudeAgent` 原生 Shim + Local ACP v2 适配器）远程 VPS Claude Code 方案，并支持脱离 CodexHost 独立安装。

---

## 二、完整保留并致敬的上游核心底座

本 Fork 完整继承了上游 `vv-get-ti/claude-vps-bridge`（`0.14.1`）的全部核心工程能力，并未破坏任何原有 CodexHost 路径：

- **桥接协议 3 与 SSH 双向复用传输**：分块流控、按字节确认、小请求插队、断线按游标恢复与请求去重。
- **多线路自动选路**：支持 `direct`、本机 SOCKS5 代理与 `cloudflared` 自动切换及入口一致性观测。
- **Windows 本机工作区运行时**：本机文件读写、ripgrep 搜索快照分页、独立长任务执行器（命名管道）、写入协作锁与 Git worktree 支持。
- **本机项目环境与附件能力**：`CLAUDE.md`、`AGENTS.md`、`.claude/rules`、Hooks、权限预检、图片/PDF 哈希缓存与媒体导出。
- **原子事务式部署与回滚**：两端文件清单校验、依赖版本与 SHA256 验证、保留数据停用与统一诊断（`diagnose.mjs`）。
- **CodexHost 0.20.0+ 完整兼容**：原有 CodexHost 插件入口（`plugin/plugin.mjs`）及会话续接行为保持兼容。

---

## 三、本 Fork 的五大核心改进

### 1. 新增 T3 Code 官方 `claudeAgent` 原生 Shim（`t3-native/` + `remote/claude-stream-relay.mjs`）

为了突破通用 ACP 协议在 T3 Code 中的宿主硬限制（无顶部实时额度圆环、两套权限叠加、无原生 `textGeneration`），本 Fork 新增了一套独立、无侵入的官方 `claudeAgent` 原生 Shim：

- **独立实例与目录隔离**：在 T3 Code 注册为独立实例 **`claude-vps`**（显示名 **Claude VPS**，`driver: claudeAgent`）并配置独立 `homePath`（`claude-home`），完全不修改默认 `claudeAgent`、不触碰本机 `~/.claude`，也不改动 T3 Code 任何程序文件。
- **直通官方 `stream-json` 协议（零反代、零逆向）**：Windows 轻量启动器（`claude-vps-shim.cs` → `.exe`）+ Node 代理（`claude-vps-shim.mjs`）经现有免密 SSH 通道连至 `remote/claude-stream-relay.mjs`，直接驱动 VPS 原版 `claude` CLI。
- **完整解锁一等公民体验**：
  - 顶部 / 账号页 **5h & 7d 实时额度圆环**（直通 `get_usage` 与 `rate_limit_event`）。
  - **单套原生权限**（T3 Supervised / Auto-accept / Full-access 直通 `can_use_tool`）。
  - **内置 `textGeneration`**（自动标题、Commit、PR 描述、PR Review Guide）。
  - 完整模型列表 + `effort` / `ultracode` / `fastMode` / `autoCompactWindow` / `beforeCacheExpires` 缓存过期前自动压缩。
- **本机全量 MCP 代理（凭据零出境）**：`LocalMcpHub`（`t3-native/http-mcp-client.mjs`）统一拦截 `--mcp-config` 与动态 `control_request: mcp_set_servers`，将 `t3-code` HTTP 端点、用户自定义本机 HTTP MCP 及 Windows 本地 Stdio MCP 全部留在 Windows 侧运行，URL/Token/本机环境变量永不发往 VPS；VPS 端通过 `mcp-local.py --server <name>` 与会话私有白名单文件（`WINDOWS_ALLOWED_MCP_FILE`，0600 权限）安全转发，并放行 `ToolSearch` 延迟加载。
- **多 SSH 线路自动选路与本机能力补齐**：启动阶段通过 `SshRoutes.firstAvailable()` 自动在 `cloudflared` / `socks5` / `direct` 线路间故障切换（自动缓冲早期 `initialize`/`mcp_set_servers` 帧不丢包）；发送用户消息时自动展开 Windows 本机 `.claude/{skills,commands}`（替换 `$ARGUMENTS` 且不劫持 Claude 内置斜杠命令）、执行 `UserPromptSubmit` 本机 Hooks，并自动授权 T3 附件目录中的图片/PDF 路径供 `windows-workspace media` 导出读取。
- **系统规则自动合并与全场景真机验收**：`remote/claude-stream-relay.mjs` 将 `bridge-instructions.md` 与本机项目上下文合并注入 `initialize.appendSystemPrompt`；已完成 `textGeneration`、多 SSH 线路切换、自定义 HTTP+Stdio MCP、本地 Skill 展开、图片/媒体传输、`--resume`/`--fork-session`、`Supervised` 审批（拒绝+放行）及真实 T3 `claudeAgent` 会话的全链路真机验证。

### 2. 新增 T3 Code Local ACP v2 适配器（`t3/`）

提供独立实例 **`claude-vps-bridge`**（显示名 **Claude VPS Bridge**，`driver: acpRegistry`），适合偏爱原生本地工具卡片、红绿 Diff 与零消耗诊断命令的场景：

- **原生本地工具卡片与红绿 Diff**：自动解包 `windows-workspace` JSON 响应（含搜索 `output`、`batch` 汇总与 PowerShell 进度 CLIXML 噪音过滤），翻译为 `Read` / `List` / `Grep` / `Edit`（原生 ACP `diff` 红绿视图与可点击 Windows 绝对路径 `locations`）/`Write` / `PowerShell` / `Batch` 卡片，并将权限审批弹窗改写为人类可读标题与路径。
- **MCP-over-ACP 安全透传**：声明 `mcpCapabilities.acp = true`，严格按插件绑定的 `acpSessionId` 精确隔离同项目多会话；在 Plan 模式实施 **Fail-Closed 只读白名单**（默认拦截写操作、启动/取消任务、修改线程、设备开关与未来新增工具）；支持 `T3_MCP_ALLOW_TOOLS` / `T3_MCP_DENY_TOOLS` 及断线自动重连。
- **模型、思考深度与权限联动**：同步 VPS 完整模型目录，通过 `_meta.reasoningEfforts` 按模型过滤不兼容的 Thinking 档位；暴露 `Claude Mode` 与 T3 Plan 开关自动同步（可选 `T3_CLAUDE_HIDE_MODE_OPTION=1`）。
- **跨轮 Plan 任务面板与审批卡片**：放行 `TodoWrite` / `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet` / `ExitPlanMode` / `EnterPlanMode`，映射至跨轮持久的 ACP `plan` 面板（含 `session/load` 重建）及 `elicitation/create` 表单卡片。
- **本地 Skills / Commands 热刷新与真实执行**：自动扫描 `~/.claude` 与项目 `.claude/{skills,commands}` 推送至 T3 补全菜单，每轮自动检测热刷新；选中 `$skill` 或 `/command` 发送后在远端大小写不敏感匹配并加载对应 Windows 文件替换 `$ARGUMENTS` 执行。
- **零消耗诊断命令与完整生命周期**：提供 0 Token 的 `/usage`（别名 `/account`，查 5h/7d 额度与倒计时、缓存命中率、速度、费用）与 `/status`（SSH 路由、T3 MCP 连通数、本机扩展状态），≥90% 推送原生 `notice`；支持 `/compact`、图片附件、流式 `tool_call_content_chunk` 及 `new`/`load`/`resume`/`fork`/`list`/`close`/`delete`。

### 3. 新增纯 T3 独立安装模式与灵活组合开关

- `installer/configure.py` 新增 `--t3-only`，允许在未安装 CodexHost 桌面端的 Windows 机器上生成配置。
- `install.ps1` 新增 `-T3Only`、`-WithT3`、`-WithT3Native` 组合开关，支持：
  - 纯 T3 Code 部署（`-T3Only -WithT3Native` 或 `-T3Only`）
  - T3 Code + CodexHost 双宿共存（`-WithT3 -WithT3Native`）
  - 仅 CodexHost（无附加参数，与上游完全一致）
- 提供独立管理工具 `t3-native/manage-native.mjs` 与 `t3/manage.mjs`，支持分别 `install` / `status` / `uninstall`，互不干扰且保留会话数据。

### 4. 核心桥接与 VPS 守卫加固（向后兼容）

- **`remote/workspace-guard.py` 零改写设计**：移除全部 `updatedInput` 命令改写（JSON 含未转义单引号时直接拒绝并提示 `\u0027`），彻底修复 Claude Code `auto` 模式下简写与 JSON 并发调用触发分类器拒批的问题，并补齐 `ToolSearch`、任务工具与 `ExitPlanMode` 放行名单。
- **`remote/claude-windows` 与 `remote/mcp-local.py`**：允许受控内置任务/规划/工具发现工具，并在 `mcp-local.py` 路由中支持 `--server t3-code` 转发至本机代理。
- **`plugin/plugin.mjs` 与 `remote/remote-server.mjs`**：支持按会话显式启用 `t3Mcp` 并强制注入本机绑定的 `acpSessionId`；增强 `$skill`/`/command` 匹配与容错。
- **`scripts/check.py`**：扩展静态语法与受管资产校验，覆盖 `t3/` 与 `t3-native/` 全部模块。

### 5. 底层兼容性承诺（为什么不改动内部 ID 与目录名）

为确保从上游 `claude-vps-bridge` 迁移、或与 CodexHost 共存的用户**零成本升级、不丢失已有配置、项目映射与历史会话**，本 Fork 刻意保持以下底层技术标识不变：

- CodexHost 插件 ID：`claude-vps`（`plugin/manifest.json`）
- 配置文件名：`bridge-config.local.json` / `bridge-config.json` 与环境变量 `CLAUDE_VPS_CONFIG`
- VPS 远端部署根目录默认仍兼容 `~/.codexhost/windows-bridge`（可通过 `--remote-root` 自定义）

---

## 四、相对上游基线（`0acd8a0`）的文件变更总览

| 路径 | 变更类型 | 说明 |
|---|---|---|
| `t3-native/*` | **Fork 新增** | `claude-vps-shim.cs`、`claude-vps-shim.mjs`、`http-mcp-client.mjs`、`manage-native.mjs` |
| `t3/*` | **Fork 新增** | `claude-vps-acp.mjs`、`acp-helpers.mjs`、`bridge-installation.mjs`、`manage.mjs` |
| `remote/claude-stream-relay.mjs` | **Fork 新增** | 供 `t3-native/` 直通 VPS 原版 Claude Code `stream-json` 的轻量中继 |
| `docs/T3CODE.md`、`docs/FORK_CHANGES.md` | **Fork 新增** | T3 Code 双方案指南与本 Fork 改进说明文档 |
| `install.ps1`、`installer/*` | **Fork 增强** | `--t3-only` / `-T3Only` / `-WithT3` / `-WithT3Native` 与新远端文件受管部署 |
| `plugin/plugin.mjs`、`plugin/diagnose.mjs`、`plugin/runtime/*` | **Fork 增强** | T3 MCP 会话隔离路由、无 CodexHost 独立运行支持 |
| `remote/workspace-guard.py`、`remote/claude-windows`、`remote/mcp-local.py`、`remote/remote-server.mjs`、`remote/tool-bridge.mjs`、`remote/bridge-instructions.md` | **Fork 增强** | 零改写并发修复、任务/规划/`ToolSearch` 放行、`t3-code` MCP 转发与 `$skill` 执行 |
| `scripts/check.py`、`README.md`、`CHANGELOG.md`、`THIRD_PARTY_NOTICES.md`、`docs/*` | **Fork 增强** | 项目更名重构为 **T3 Claude VPS**，补全校验与全套文档 |
