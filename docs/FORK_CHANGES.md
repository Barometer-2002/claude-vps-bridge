# Fork 说明

**T3 Claude VPS（`t3-claude-vps`）fork 自 [`vv-get-ti/claude-vps-bridge`](https://github.com/vv-get-ti/claude-vps-bridge)。** 上游让 CodexHost 使用 VPS 上的 Claude Code；本 fork 用同一套桥接，让 **T3 Code** 也能这样用，并且可以不装 CodexHost。

本文说明 fork 的基线、原因、与上游的差异，以及许可证义务。

---

## 上游与基线

| 项目 | 内容 |
|---|---|
| 上游仓库 | [`vv-get-ti/claude-vps-bridge`](https://github.com/vv-get-ti/claude-vps-bridge) |
| fork 基线 | `0.14.1`（上游提交 `0acd8a0`） |
| 本 fork 名称 | T3 Claude VPS（仓库名 `t3-claude-vps`） |
| 本 fork 版本 | 从 `v1.0.0` 起独立编号，当前 `v1.1.0`，见 [CHANGELOG](../CHANGELOG.md) |
| 许可证 | 与上游相同，[LGPL-3.0-only](../LICENSE)（随附 [GPL-3.0 全文](../LICENSE-GPL-3.0)） |

跟进上游新版本时，会在 CHANGELOG 中注明新的基线版本和提交。

## 为什么要 fork

上游的定位是 CodexHost 桌面端插件：宿主接口、安装流程和文档都以 CodexHost 为前提。

本 fork 要解决的是另一个场景：**主力客户端是 T3 Code，希望在 T3 里直接选一个 Provider 就能用 VPS 上的 Claude Code，不额外安装 CodexHost。** T3 Code 的接入方式和 CodexHost 完全不同（T3 直接启动 Claude Code CLI 并通过 `stream-json` 通信），需要新增一层 Shim 和 VPS 端中继，还要处理 T3 特有的 MCP、读图预览和 Provider 注册。这些改动超出了上游插件的范围，所以单独维护为 fork。

---

## 与上游的差异

### 新增

**1. T3 Code 原生 Shim（`shim/`、`t3-native/` 与 `remote/claude-stream-relay.mjs`）**

- 在 T3 Code 中注册独立实例 `claude-vps`（显示名 **Claude VPS**，`driver: claudeAgent`），使用单独的 `homePath`（`claude-home`）。不改默认 `claudeAgent` 实例，不碰本机 `~/.claude`，不改 T3 Code 程序文件。
- 中立内核 `shim/` 提供 Windows 启动器（`claude-vps-shim.cs` 编译为 `.exe`）和 Node 代理（`claude-vps-shim.mjs`），`t3-native/` 只负责把它注册为 T3 的 `claude-vps` 实例。Shim 通过 SSH 连接 VPS 上的 `claude-stream-relay.mjs`，由 relay 启动官方 `claude` CLI 并转发 `stream-json`。
- 因为走的是官方协议，T3 自带的 Claude 功能可以直接使用：5 小时 / 7 天额度（`get_usage`、`rate_limit_event`）、权限审批（`can_use_tool`）、`textGeneration`（自动标题、Commit、PR 描述）、`--resume` / `--fork-session`、`effort` / `fastMode` 等模型参数，以及缓存过期前自动压缩。

**2. 只装 T3 的安装模式**

- `installer/configure.py --t3-only`：没有 CodexHost 的机器也能生成配置。
- `install.ps1` 增加 `-T3Only`（只装 T3 接入）和 `-WithT3`（T3 与 CodexHost 共存，兼容旧参数 `-WithT3Native`）；不加参数时与上游行为一致，只装 CodexHost 插件。
- `t3-native/manage-native.mjs` 单独管理 T3 接入：`install`、`status`、`uninstall`。安装先在暂存目录编译，通过离线 `--self-test` 和远端 `--version --live` 检查后再切换，失败时回滚。`uninstall.ps1` 是 `install.ps1 -T3Only -Uninstall` 的简写。

**3. Windows 端 MCP 代理与权限检查（`http-mcp-client.mjs`、`mcp-policy.mjs`）**

- 接管 `--mcp-config` 和运行中的 `mcp_set_servers`，在 Windows 本机连接 T3 内置 MCP 和自定义 HTTP MCP（支持 SSE），或启动 Stdio MCP。VPS 端通过 `mcp-local.py --server <name>` 转发调用，支持 `ToolSearch` 延迟加载。
- 每次 `tools/call` 前，在 Windows 端检查当前权限模式、`T3_MCP_ALLOW_TOOLS` / `T3_MCP_DENY_TOOLS` 和项目 `.claude/settings*.json` 的 `permissions.deny`。Plan 模式下只放行只读白名单，以及声明了 `readOnlyHint: true` 且非破坏性的自定义工具。
- T3 的本地 MCP 地址和 Token 只留在 Windows。
- 会话失效（`-32001`）与结果不明（`-32002`）分开报告，有副作用的调用不会自动重放。

**4. 读图 / PDF 路径映射**

- 图片和 PDF 经 `media-export` 传到 VPS 后，路径变成 `.bridge-media/<session>/<sha256>.<ext>`。Shim 记录这个路径与 Windows 原始路径的对应关系（按 `projectId` 保存在 `media-path-cache.json`，`--resume` 后仍有效）。
- 发给 T3 的 `Read` 调用、结果、Markdown 引用和审批弹窗里的路径会换回 Windows 路径，T3 的读图卡片因此能正常显示；审批通过后回传的 `updatedInput` 再换回 VPS 路径。

**5. 会话体验**

- 启动时在 `sshRoutes` 配置的多条线路（`cloudflared` / `socks5` / `direct`）之间自动选择，并缓存选路期间收到的早期帧。
- 发送 `/skill`、`$skill`、`/command` 时展开 Windows 本机 `.claude/{skills,commands}`（替换 `$ARGUMENTS`，不覆盖内置命令）。
- 执行本机 `UserPromptSubmit` Hook；被阻断时向 T3 返回原因，会话仍可继续。
- 停止会话时取消本机长任务并等待确认；SSH 意外断线后查询原任务状态并保留 `requestId`，不盲目重放。
- 自动授权 T3 附件目录中的图片 / PDF；把 `bridge-instructions.md` 与本机项目规则合并进 `initialize.appendSystemPrompt`。

**6. 中立 Shim 与标准 ACP 包装器（`shim/`、`acp/`）**

- Shim 内核从 `t3-native/` 抽到 `shim/`：`manage-shim.mjs` 负责安装、状态与卸载，共享 Shim 安装在 `%USERPROFILE%\.claude-vps\shim\`。`t3-native/` 与 `acp/` 作为使用方登记，卸载时按登记情况决定是否保留共享 Shim。
- `acp/` 是基于官方 `@agentclientprotocol/claude-agent-acp`（锁定版本）的标准 ACP 薄包装，通过 `CLAUDE_CODE_EXECUTABLE` 指向共享 Shim，收窄到 ACP v1，并在执行侧拒绝未知的 `isolation`、`job`、`agent` 动作。用 `install.ps1 -AcpOnly` 或 `-WithAcp` 安装，用 `node .\acp\manage-acp.mjs` 管理。

**7. T3 原生工具卡片与提示词合并（`shim/stream-presenter.mjs`、`remote/initialize-prompt.mjs`）**

- 把 `windows-workspace` 的 `read`、`search`、`list`、`run`、`edit`、`write` 以及 `batch`、`info`、`status`、`job` 结果转换成 T3 的 Read、Grep、Glob、Bash、Edit、Write 卡片；Edit 和 Write 附带本机生成的 unified diff。非 workspace 的 Bash 保持原样。
- 宿主在 `initialize` 阶段下发自己的 `appendSystemPrompt` 时，Relay 将它与桥接说明合并，不让宿主内容覆盖桥接说明。

### 修改（向后兼容）

- **`remote/workspace-guard.py`**：不再改写 `updatedInput`。JSON 中出现未转义单引号时直接拒绝并提示写成 `\u0027`，修复 Claude Code `auto` 模式下并发调用被分类器拒绝的问题；放行 `ToolSearch`、任务工具、`EnterPlanMode` / `ExitPlanMode`，并支持 `WINDOWS_ALLOWED_MCP_FILE` 动态放行本机 MCP。
- **`remote/claude-windows`、`remote/mcp-local.py`、`remote/tool-bridge.mjs`、`remote/bridge-instructions.md`**：配合上面的放行规则和 `--server <name>` 路由；补充读图路径的使用约束。
- **`plugin/runtime/*`、`plugin/diagnose.mjs`**：支持在没有 CodexHost 的情况下运行和诊断；新增轮次任务取消（`cancel-jobs`）和活动任务查询（`listProjectJobs`）；1.0.1 起可在确认安全时回收已停止执行器留下的写锁。
- **`scripts/check.py`**：语法与受管文件检查覆盖 `shim/`、`t3-native/` 和 `acp/`。

### 保持不变

以下部分沿用上游，不改变行为：

- 桥接协议 3：SSH 双向复用、分块与按字节确认、小请求插队、断线按游标恢复、请求去重。
- 多线路选路（`direct` / SOCKS5 / `cloudflared`）与入口观测。
- Windows 工作区运行时：文件读写、ripgrep 搜索快照、独立长任务执行器、写入协作锁、Git worktree。
- 项目环境：`CLAUDE.md`、`AGENTS.md`、`.claude/rules`、Hooks、权限预检、图片 / PDF 缓存。
- 事务式部署与回滚、统一诊断（`diagnose.mjs`）。
- CodexHost 0.20.0+ 插件入口（`plugin/plugin.mjs`、`remote/remote-server.mjs`）及会话续接行为。
- 标识与目录：插件 ID `claude-vps`、配置文件 `bridge-config.local.json` / `bridge-config.json`、环境变量 `CLAUDE_VPS_CONFIG`、VPS 默认目录 `~/.codexhost/windows-bridge`（可用 `--remote-root` 修改）。从上游迁移时不需要改配置。

### 已移除

- 开发过程中试验过的 Local ACP 适配器（`t3/`）已在 `v1.0.0` 移除，由 `t3-native/` 取代。它从未出现在上游中。`v1.1.0` 新增的 `acp/` 是另一套实现（复用官方 `claude-agent-acp` 的薄包装），不是该适配器的恢复。

---

## 文件变更清单（相对 `0acd8a0`）

| 路径 | 类型 | 说明 |
|---|---|---|
| `shim/*` | 新增 | 中立 Shim 内核：`claude-vps-shim.cs`、`claude-vps-shim.mjs`、`http-mcp-client.mjs`、`mcp-policy.mjs`、`bridge-installation.mjs`、`stream-presenter.mjs`、`manage-shim.mjs` |
| `t3-native/manage-native.mjs` | 新增 | T3 原生实例的注册、状态与卸载（Shim 内核在 `v1.1.0` 迁到 `shim/`） |
| `acp/*` | 新增 | 标准 ACP 薄包装：`claude-vps-acp.cs`、`claude-vps-acp.mjs`、`manage-acp.mjs`、`workspace-presenter.mjs`、`package.json` 与锁文件 |
| `remote/initialize-prompt.mjs` | 新增 | 合并宿主 `appendSystemPrompt` 与桥接说明 |
| `remote/claude-stream-relay.mjs` | 新增 | T3 Shim 使用的 VPS 端 `stream-json` 中继 |
| `uninstall.ps1` | 新增 | 卸载 T3 接入的简写入口 |
| `docs/T3CODE.md`、`docs/FORK_CHANGES.md` | 新增 | T3 接入指南与本文 |
| `install.ps1`、`installer/*` | 修改 | `--t3-only` / `-T3Only` / `-WithT3`，以及新增远端文件的受管部署 |
| `plugin/diagnose.mjs`、`plugin/runtime/*` | 修改 | 无 CodexHost 运行、轮次任务取消、活动任务查询、写锁回收 |
| `remote/workspace-guard.py`、`remote/claude-windows`、`remote/mcp-local.py`、`remote/tool-bridge.mjs`、`remote/bridge-instructions.md` | 修改 | 不改写输入的并发修复、任务 / 规划 / `ToolSearch` 放行、本机 MCP 转发、读图路径约束 |
| `plugin/manifest.json` | 修改 | 版本号改为本 fork 的版本 |
| `README.md`、`CHANGELOG.md`、`THIRD_PARTY_NOTICES.md`、`docs/*`、`docs/assets/*` | 修改 | 更名为 T3 Claude VPS，重写文档与图示 |

---

## 许可证义务

- 本 fork 与上游一样采用 LGPL-3.0-only，保留上游版权声明，上游来源和第三方依赖列在 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
- 相对上游修改过的文件列在上方清单中。
- 本仓库不分发 Claude Code、T3 Code 或 CodexHost 的二进制文件、账号或凭据，它们各自的条款不受本仓库许可证影响。
