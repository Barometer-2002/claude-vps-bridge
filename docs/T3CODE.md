# T3 Code 适配说明

本仓库内置 **T3 Code Local ACP 适配器（`t3/`）**，支持在 Windows 端 [T3 Code](https://github.com/pingdotgg/t3code) 中直接调用 VPS 上的官方 Claude Code，并与 CodexHost 共用同一套本机与 VPS 桥接运行时；也支持**纯 T3 Code 独立安装（无需安装 CodexHost 桌面端）**。

## 已适配的能力

| 能力 | 在 T3 Code 中的实现与体验 |
|---|---|
| **模型列表与会话内切换** | 同步 VPS Claude 全部模型（含默认模型与解析后的模型标识），通过 ACP `configOptions`（`category: "model"`）与 `models` 支持会话内切换。 |
| **按模型区分的推理深度（Thinking）** | 通过 ACP `category: "thought_level"` 原生接入 T3 推理深度选择器，并通过每个模型的 `_meta.reasoningEfforts` 声明支持档位（如 Haiku 4.5 仅展示 `Off / Auto`，Opus 5.5 展示 `Auto ~ Ultracode`）；切换模型时自动回退不兼容档位。 |
| **权限模式与 Plan 模式联动** | 同步 `Default / Accept edits / Plan mode / Auto mode / Bypass permissions`（显示为 **Claude Mode**，与 T3 审批开关叠加生效），并与 T3 的 Plan 开关自动联动、远端状态变化自动回同步。如需隐藏下拉项仅保留 T3 Plan 开关，可设置环境变量 `T3_CLAUDE_HIDE_MODE_OPTION=1`。 |
| **T3 Code 原生 MCP 工具透传（MCP-over-ACP）** | 声明 `mcpCapabilities.acp = true`，复用现有认证 SSH 双向通道，严格按 `acpSessionId` 隔离将 T3 Code 内置的 `t3-code` MCP 服务透传给 VPS 上的 Claude Code。**权限与数据流边界**：T3 本地 HTTP 接口与鉴权 Token 永不离开 Windows，但工具入参与返回值（如 `t3_thread_read` 文本）会返回给 VPS Claude 参与推理；`mcp__t3-code__*` 不经过 Windows 工作区 `preflight`，而是由本机 ACP 适配器执行 **Plan 模式只读白名单（默认拦截所有变更/启动类及未知新增工具）** 与可选 `T3_MCP_ALLOW_TOOLS` / `T3_MCP_DENY_TOOLS` 策略，并叠加 Claude/T3 自身权限审批。当前支持 Claude → T3 的请求与通知，不反向推送服务端主动通知（如 `tools/list_changed`），连接中断后自动重连。 |
| **本地项目 Skills 与 Slash Commands 自动补全与执行** | 扫描本机项目及用户目录的 `.claude/skills` 与 `.claude/commands`，以 `$skill` / `/command` 形式注入 T3 Code 输入框补全菜单，并在每轮对话自动检测变更刷新；选中 `$skill` 或 `/command` 发送后，VPS 远端直接加载对应本机文件内容并注入 `$ARGUMENTS` 执行；加载失败时会在 `/status` 中显示原因。 |
| **原生本地工具卡片、Diff 与可读审批** | 自动将 `windows-workspace` 调用翻译为原生语义卡片：`Read`、`List`、`Grep`、`Edit`/`Write`（附带可点击的 Windows 绝对路径 `locations` 与原生红绿 Diff）、`PowerShell`、`Batch`、`Skill`、`Worktree`，并自动解包 JSON 信封展示干净输出；权限审批弹窗同步显示可读操作标题与路径而非原始 JSON。 |
| **Plan 任务进度面板与流式工具输出** | 放行 Claude 原生任务工具（`TodoWrite`、`TaskCreate`、`TaskUpdate`、`TaskList`、`TaskGet`）并将任务列表实时同步至 T3 原生 `plan` 面板（自动解析 `TaskCreate` 返回的真实任务 ID 供后续 `TaskUpdate` 更新）；命令输出通过 T3 Code 支持的 ACP v2 `tool_call_content_chunk` 逐段流式展示，并支持 `session_info_update` 动态会话标题与 `name` / `rawOutput` 传递。 |
| **上下文窗口与会话费用** | 实时将 Bridge 的 `initialUsage` 与 `session.usage.changed` 映射为 ACP `usage_update`（已用 Token、窗口上限与估算 USD 费用），驱动 T3 原生上下文占用指示器；并在 `PromptResponse.usage` 报告单轮 Token 消耗。 |
| **账号 5h/7d 额度、缓存与速度** | 注册零模型消耗的本地斜杠命令 `/usage`（别名 `/account`）与 `/status`，即时展示账号套餐、5 小时/7 天已用比例与本地重置时间、上下文占用、缓存命中率、Prompt Cache 倒计时、输出速度、首字延迟、`usage.request` 实测响应模型，以及 SSH 路由、T3 MCP 连通状态和本地 Skills/Commands 数量；当 5h/7d 额度 ≥ 90% 时推送 T3 原生系统通知（`notice`）。 |
| **上下文压缩（`/compact`）** | 接入远端 `claude.compact`（支持可选保留说明），并将 `contextCompaction` 映射为 T3 原生 `compaction_update` 卡片，兼容 T3 原生 `/compact` 与空闲压缩。 |
| **交互式提问与计划审批** | 通过 ACP `elicitation/create` 表单接入 `AskUserQuestion`（单选、多选、自定义输入）与 `ExitPlanMode` 计划审批，在 T3 中以原生交互卡片呈现。 |
| **图片附件与文件 Diff** | 开启 `promptCapabilities.image`，直接将 T3 粘贴或附加的本机图片转为 Bridge 内联图片传给 VPS；文件改动附带本机路径与 Diff。 |
| **完整会话生命周期** | 支持 `session/new`、`session/load`（带历史回放）、`session/resume`、`session/fork`（原生分支）、`session/list`、`session/close` 与 `session/delete`。 |

> **关于顶部 5h/7d 额度圆环的说明**：T3 Code 的通用 ACP（`acpRegistry`）驱动目前仅支持上下文窗口与费用指标（`usage_update`），尚未开放独立账号配额圆环 API。因此在 T3 Code 中可通过 `/usage` 零消耗即时查看完整 5h/7d 额度与重置时间，并在高额度时收到系统通知。

## 环境要求

- Windows 10/11、Node.js 24+、PowerShell 7、OpenSSH 客户端、Python 3.11+、npm、ripgrep（`rg`）
- 支持 **Local ACP command** 的 Windows 版 T3 Code（请先至少打开一次 T3 Code 以生成 `%USERPROFILE%\.t3\userdata\settings.json`）
- Linux x64 VPS 上已安装并登录官方 Claude Code，且配置好免密 SSH 别名（见 [安装指南](SETUP.md) 第 1–3 步）

## 安装方式

### 方式一：仅用 T3 Code（无需安装 CodexHost 桌面端）

在仓库根目录打开 PowerShell 7：

```powershell
python .\installer\configure.py --ssh-host my-linux-host --t3-only
pwsh -NoProfile -File .\install.ps1 -T3Only
```

该流程会：
1. 使用本机 Node.js 24+ 准备 Bridge 依赖，并完成 Windows 本机插件（`%USERPROFILE%\.codexhost\plugins\claude-vps`）与 VPS 端（含受管理的 `@codexhost/cli` Claude 适配器）的事务式部署。
2. 将 `t3/` 下的 ACP 适配器安装到 `%USERPROFILE%\.t3\integrations\claude-vps`，并在 T3 Code 设置中注册 `claude-vps-bridge`。

### 方式二：与 CodexHost 共存安装

若已安装 CodexHost，可一步同时部署两端并注册 T3 Code：

```powershell
python .\installer\configure.py --ssh-host my-linux-host --host-root 'D:\Apps\CodexHost'
pwsh -NoProfile -File .\install.ps1 -WithT3
```

若此前已装好 Bridge，只想单独安装或更新 T3 Code 适配器：

```powershell
node .\t3\manage.mjs install
node .\t3\manage.mjs status
```

自定义 T3 数据目录时，可设置 `T3CODE_HOME` 或传入 `-T3Home <目录>` / `--t3-home <目录>`。

## 开始使用

1. 在 T3 Code 中刷新 **Settings → Providers → Claude VPS Bridge**（或重启 T3 Code）。
2. 打开一个 **本机 Windows 项目**，新建会话。
3. 在输入框旁的模型选择器选择 **Claude VPS Bridge**，按需选择模型、**Thinking（推理深度）** 与 **Mode（权限模式）**。
4. 可先发送以下指令验证本机工具和额度查询：
   - `/usage` — 即时查看 5h/7d 额度、套餐与当前会话配置（不消耗模型 Token）。
   - `请在当前项目运行 Get-Location，返回实际命令输出，不修改文件。` — 确认命令运行在本机 Windows 项目目录。

日常使用由 T3 Code 按需启动适配器，CodexHost 可以保持关闭。

## 更新与卸载

- **同步升级两端 Bridge 与 T3 适配器**：重新运行 `pwsh -NoProfile -File .\install.ps1 -T3Only`（或 `-WithT3`）。
- **仅卸载 T3 Code 接入（保留会话映射与 Bridge）**：

```powershell
node .\t3\manage.mjs uninstall
```

或使用 `pwsh -NoProfile -File .\install.ps1 -Uninstall -T3Only`。卸载会移除 T3 设置中的 `claude-vps-bridge` 注册和适配器脚本，保留 `%USERPROFILE%\.t3\integrations\claude-vps\sessions` 中的会话映射，重装后可继续原有会话。
