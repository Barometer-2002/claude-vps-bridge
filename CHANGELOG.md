# 更新记录

本记录分为两部分：上方 `Unreleased` 为 **T3 Claude VPS（`t3-claude-vps`）** 首个正式大版本开发周期内的未发布变更（基于上游 `vv-get-ti/claude-vps-bridge@0.14.1` / `0acd8a0`，尚未正式定版或打 Git Tag）；下方完整保留上游历史发布记录。完整改进对比见 [docs/FORK_CHANGES.md](docs/FORK_CHANGES.md)。

---

## Unreleased

当前处于 **T3 Claude VPS（`t3-claude-vps`）** 首个正式大版本开发周期（遵循 LGPL-3.0-only，保留上游 `0.14.1` 核心桥接协议与运行标识不变）：

**官方 `claudeAgent` 原生 Shim（`t3-native/`）**

- 新增独立的 `claude-vps`（显示名 **Claude VPS**，`driver: claudeAgent`）实例与专属 `claude-home`，不修改默认 `claudeAgent` 与本机 `~/.claude`。
- 新增 Windows 轻量启动器（`claude-vps-shim.cs` → `.exe`）、Node 代理（`claude-vps-shim.mjs`）、多协议本机 MCP 代理中心（`http-mcp-client.mjs`，同时支持 Streamable HTTP 与本机 Stdio MCP）及 VPS 直通中继（`remote/claude-stream-relay.mjs`）。
- 完整直通 VPS 原版 Claude Code 标准 `stream-json` 协议：解锁顶部 5h/7d 实时额度圆环（`get_usage` + `rate_limit_event`）、单套原生权限（`can_use_tool`）、原生 `textGeneration`、`--resume`/`--fork-session`、`effort`/`ultracode`/`fastMode` 与缓存过期自动压缩。
- **P0 本机 Hook 拒绝与共享 MCP 策略**：与 ACP 共用 `t3/mcp-policy.mjs`；`UserPromptSubmit` 返回 `HOOK_BLOCKED` 等阻断错误时立即终止提交并向 T3 返回明确原因且保持会话可继续；在 `tools/call` 前统一按本机会话绑定、当前模式（Plan 模式 Fail-Closed 拒绝有副作用或未知工具）、`T3_MCP_ALLOW_TOOLS`/`T3_MCP_DENY_TOOLS` 及本机项目 `permissions.deny` 规则拦截；严格校验本机 MCP 配置，拒绝无法识别的配置，杜绝将 `url`/`headers`/`env` 误发往 VPS。
- **P1 HTTP MCP 逐事件 SSE 与可靠性**：`LocalHttpMcpClient` 改为流式逐事件解析 SSE（收到匹配回复立即返回，不阻塞等待长连接 EOF），严格匹配 JSON-RPC `id`（错 ID 或无回复明确失败），为请求和 `DELETE` 关闭设置超时，区分会话失效（`-32001`）与结果不明（`-32002`）且严禁盲目重放有副作用调用。
- **P1 主动停止与断线任务找回**：`control_request: interrupt` 与 `SIGINT`/`SIGTERM` 接入本机 `cancel-jobs` 轮次任务取消并等待确认后向 T3 反馈已停止或未确认状态；SSH 中途意外断线时查询并保留原 Windows 任务 `requestId` 与状态，明确提示通过 `windows-workspace job` 查询原结果，并在后续/续接会话上下文中自动带出活动或不确定任务 ID，禁止盲目重放。
- **P2 原子暂存升级、回滚与状态区分**：`manage-native.mjs` 支持 `.manage.lock`、Provider 归属检查、保留用户自定义配置、先在独立暂存目录编译并执行离线 `--self-test` 与实时 `--version --live` 校验后再原子切换与并发修改检测，失败自动回滚不破坏旧入口；`status` 明确区分 `cachedVersion`、`liveCheck` 与 `offlineSelfTest`。
- 接入启动期多 SSH 线路自动故障切换（`SshRoutes.firstAvailable` + 启动前帧缓冲）、修复默认模式 `probeOnly` 误判、支持发送消息时自动展开 Windows 本机 `.claude/{skills,commands}`（替换 `$ARGUMENTS`）、自动授权 T3 附件路径供 `windows-workspace media` 导出，并将 `bridge-instructions.md` 与本机项目规则合并入 `initialize.appendSystemPrompt`。

**Local ACP 适配器（`t3/`）**

- 支持完整模型目录、按模型过滤的推理深度（`thought_level` + `_meta.reasoningEfforts`）、`Claude Mode` 与 Plan 开关联动（可选 `T3_CLAUDE_HIDE_MODE_OPTION=1`）、上下文 `usage_update`、零消耗 `/usage` 与 `/status`、≥90% 额度通知、`/compact` 压缩、交互式提问与计划审批、图片附件及 `new`/`load`/`resume`/`fork`/`list`/`close`/`delete` 全生命周期。
- 接入 MCP-over-ACP（`mcpCapabilities.acp = true`），共用 `t3/mcp-policy.mjs`，严格按 `acpSessionId` 隔离多会话，Plan 模式采用 Fail-Closed 只读白名单，支持 `T3_MCP_ALLOW_TOOLS` / `T3_MCP_DENY_TOOLS` 与断线自动重连。
- 将 `windows-workspace` 调用自动解包并翻译为原生 `Read` / `List` / `Grep` / `Edit`(红绿 Diff) / `Write` / `PowerShell` / `Batch` 卡片与可点击 Windows 绝对路径 `locations`，同步优化权限审批弹窗可读性并过滤 PowerShell 进度 CLIXML 噪音。
- 放行 `TodoWrite`、`TaskCreate`、`TaskUpdate`、`TaskList`、`TaskGet`、`ExitPlanMode`、`EnterPlanMode`，实现跨轮持久的 T3 Plan 任务进度面板与历史会话重建。
- 自动扫描本机 `.claude/{skills,commands}` 注入 T3 补全菜单并支持每轮热刷新；远端同步支持 `$skill` 与 `/command`（含 `<user_request>` 包裹）大小写不敏感匹配与 `$ARGUMENTS` 注入执行。
- 移除 `remote/workspace-guard.py` 所有 `updatedInput` 改写（未转义单引号直接拒绝并提示 `\u0027`），彻底修复 `auto` 模式下简写与 JSON 并发调用冲突。

**安装、校验与文档重构**

- `installer/configure.py` 与 `install.ps1` 新增 `--t3-only` / `-T3Only` / `-WithT3` / `-WithT3Native` 支持；`scripts/check.py` 扩展校验 `t3/`、`t3/mcp-policy.mjs` 与 `t3-native/` 源码及文件清单。
- 以 T3 Code 优先视角重构 `README.md` 与全套文档，新增 [docs/FORK_CHANGES.md](docs/FORK_CHANGES.md) 与 [docs/T3CODE.md](docs/T3CODE.md)，并在 `THIRD_PARTY_NOTICES.md` 明确列出上游基线与 LGPL-3.0-only 许可声明。

---

## 上游基线记录（`vv-get-ti/claude-vps-bridge`）

### 0.14.1 · 2026-11-18

- 线路切换时记录归类后的失败原因与时间（例如 `dns-failed`、`cloudflared-error`、`connection-timeout`），`diagnose.mjs` 一并显示；原始 SSH/cloudflared 报错只在内存中归类，不写盘也不输出。

## 0.14.0 · 2026-11-18

适配官方 CodexHost 0.20.0 及以上版本，两端跟随官方最新版（已验证 0.21.0）。插件不修改宿主文件。

**宿主与依赖**

- VPS 依赖跟随官方 `@codexhost/cli` 最新版（最低 0.20.0）。新版本先通过包版本、插件 API 和适配器加载检查才启用，不通过则保留当前版本；升级校验同时比对依赖版本、适配器哈希、插件版本和协议，旧进程不会被误报为已升级。旧依赖保留，可随事务回滚。
- 插件版本只在 `plugin/manifest.json` 中定义，远端 health 读取同一来源。
- 插件不再复刻上游规则：fork 的轮次边界以官方适配器为准（0.21.0 起同一轮任意记录都可作为检查点），附件继承按官方实际保留的轮次授权；委派 CLI 的会话引用按通用规则校验，`thread answer` 等新子命令无需改插件。
- 从 CodexHost 任务中运行安装或停用时，宿主注入的默认 `CODEXHOST_DATA_DIR` 不再被当成自定义目录而阻断；三处检查共用同一判断。
- 删除为 CodexHost 0.16.1 提供的附件修复包和 `compatibility/` 目录；官方自 0.17.0 起已包含该修复。
- 部署按受管文件清单删除不再发布的文件，可随事务回滚；无法确认归属的文件保持原状。曾在本地试验的 VPS 启动预算脚本已撤回并随之移除。

**投递与附件**

- 投递结果区分三种：确定没送出、对端明确拒绝、结果未知。结果未知时向宿主报告异常，宿主暂停队列且不重放，避免同一条指令被执行两次。
- 只发图片、不写文字的消息不再丢图；图片和文档混排时只登记标记为图片的文件，正文中的路径仍不会成为附件。
- 重复读取同一图片或 PDF 时，本机重新核验权限和内容哈希后复用远端缓存，不再重复传输完整内容；缓存丢失或损坏时只补取一次纯读取。
- 大工具响应分块收集后一次拼接，上限仍为 48 MiB。

**会话与委派**

- SSH 连接仍在却长时间收不到数据时，只要待处理的都是只读请求、且没有进行中的轮次或本机操作，就重连原 relay，用原请求编号取回结果，不重新提交。
- 传输改为桥接协议 3：两个方向按小块发送并按字节确认，控制消息和小回复可以插队，大响应不再堵住模型列表、健康检查等请求；超时或取消的请求按原编号通知 VPS 停止发送剩余部分，写操作仍为结果未知。
- 同一会话的并发读取合并；历史未变化时只传“未变化”标记，只追加了新轮次时只传新增部分。
- 新增可选 `sshRoutes`：支持直连、本机 SOCKS5 代理和 cloudflared，按顺序选路，失败或停滞时自动切换；插件自带 SOCKS5 转发。安装、诊断、升级校验共用同一套线路。
- VPS 观测每条 SSH 连接的实际入口，`diagnose.mjs` 显示当前线路、实际入口、两者是否一致和最近一次切换原因。
- 安装后需要执行 `codexhost stop` 再打开 CodexHost 才会生效：插件由共享后台加载，只关闭桌面窗口不会重新加载。`diagnose.mjs` 新增 `plugin-activation`，对比已安装与宿主实际加载的版本；安装器结束时给出启用命令。
- 账号额度查询不再阻塞打开会话、输出、追加指令和取消；查询失败时保留上次可靠数据。
- 委派中的子任务可以用 `thread send --steer true` 实时追加指令，沿用原写入预留；终态读取与追加同时发生时保留写锁。
- `windows-workspace` 字段写错（例如把 `argv` 写成 `args`）时直接报错并列出允许字段，不再静默返回帮助；所有操作的字段由同一份定义校验。
- 使用 `--format text` 启动委派不会再被记成结果未知、导致写锁无法释放；需要读取任务身份和终态的命令改用 JSON 执行，`compact` 照常返回。
- 关闭请求在远端确认后才完成；SSH 字节转发改用有界缓冲的轻量进程；补齐原生后台任务、本机持久任务和浏览器会话的空闲释放保护，状态未知时不回收。

## 0.13.6 · 2026-10-30

- 本机任务启动失败时区分三种情况：请求没送达、被拒绝、送达但没回复。只有最后一种才是结果不确定，并提示先用原编号查询。
- 用同一个编号重新提交时，从未被接收的任务会正常启动；已经接收的任务不会重复执行。

## 0.13.5 · 2026-10-30

- 给 Claude 的使用说明改为中文，默认用简体中文回复；用户规则指定其他语言时按规则执行。

## 0.13.4 · 2026-10-30

- 给 Claude 的使用说明明确语言要求：面向用户的文字（包括进度说明）按用户规则指定的语言书写，没有规则时跟随用户的语言，不受说明和工具输出是英文的影响。

## 0.13.3 · 2026-10-30

- 断线提示：回复进行中，重连超过 8 秒会在对话里显示“连接中断，正在重连”，恢复后提示一次；短暂抖动不提示。
- 多次重连失败时，说明发生了什么以及恢复后怎么继续，而不只显示底层错误。
- 提示由本机插件生成，断线期间也能显示。

## 0.13.2 · 2026-10-30

- 修复网络中断时插件导致整个 CodexHost 宿主退出的问题：所有插件与会话方法在断线时都返回结果或已知值，不再抛出未处理的错误。
- 修复 Windows 上命令已完成却被记为中断的问题：状态文件被其他程序短暂占用时稍后重试，同一文件的写入按顺序进行。
- 断线错误会写明是哪个操作失败；任务编号不合规时说明允许的字符。

## 0.13.1 · 2026-10-30

- 修正给 Claude 的 SSH 远程脚本写法：PowerShell 管道会在末尾补 CRLF，改为在远端用 `tr -d` 去掉。

## 0.13.0 · 2026-10-30

- 文件改动卡片在修改发生时出现在对话中，与原生 Codex 一致；回合结束只保留宿主自带的汇总卡片。
- 源码按运行位置整理为 `plugin/`（本机插件）、`remote/`（VPS 端）和 `installer/`（安装脚本），安装后的目录结构不变，已安装用户直接升级即可。
- 配置说明移至 `docs/CONFIGURATION.md`；附件修复下载链接指向最新版本。

## 0.12.0 · 2026-10-30

- 不再在聊天中插入“Windows 正在执行…”进度提示；短暂断线重连也不再提示，只在连接不可用时报错。
- 插件追加的提示不再占用 Claude 最终回答的位置；停止任务时只在确实停止了本机任务或无法确认时提示。
- 文件改动卡片只显示改动处及上下 3 行，不再把整个文件显示为重写。
- 返回给 Claude 的结果去掉进程号、令牌和日志路径，改动只返回增删行数，减少上下文占用。
- 项目规则每轮只注入一次，不再随每次工具调用重复出现；批量请求的上下文去重。
- Claude Code 保存的超长工具输出可以用 Read 分页读回，仅限当前会话自己的输出。
- 精简给 Claude 的使用说明，补充 JSON 中单引号的写法。
- 安装说明改用 `python`，下载链接指向最新版本。

## 0.11.1 · 2026-10-30

- 精简公开仓库与下载包，测试和性能脚本保留在本地开发目录。
- 清理测试说明与旧链接，保留源码语法、安装文件及公开内容检查。
- 桥接功能和安装流程保持不变。

## 0.11.0 · 2026-10-30

- 提供独立的 CodexHost 0.16.1 附件修复包，支持版本检查、备份与恢复。
- 对齐 CodexHost 0.16.1，受管理的远端 Claude 适配器固定为 0.16.1。

- 修复字面编辑中的特殊字符展开，以及目录搜索绕过文件级权限的问题。
- 搜索结果完整保存并分页读取；终态日志支持原始字节读取，不再卡在残缺字符。
- 结构化附件保留来源，普通正文路径不再自动上传；支持 UNC 路径，大附件交给 Claude 决定处理方法。
- 根目录和子目录共用规则导入解析；修复会话打开/关闭竞态与 relay 空锁恢复。
- 新链路使用单调控制序号去重，持续使用不再累积到固定请求次数上限。

- 命令完整输出保留在本机，不再轮转覆盖；聊天显示末尾预览，支持按任务分页读取全部输出，写入失败明确报错。
- 移除插件内置视频抽帧、FFmpeg 专用配置与诊断；工具和处理方法由 Claude 选择。
- 安装、升级与停用不再修改宿主；附件只消费公开接口输入，文本入口限制明确提示。
- 补齐远端登录 shell 程序发现、Claude 可执行校验、Python 选择与 SSH 路径诊断。
- 委派只使用当前会话的父线程与项目，移除全局最近会话回退和内部 mapping-store 查询。
- 保留原生模型与思考强度选择，实际响应模型仅在后台记录，不向聊天追加标注。
- 修复远端事件的会话身份映射，避免回合完成时出现身份持久化错误。
- 动态转发运行中追加能力；保留上游提示词缓存绝对到期值。
- 增加保留数据的停用/卸载入口与相关隔离测试。
- 插件展示名称改为 Claude VPS Bridge。
- 更新中文首页、文档导航和图标。
- 添加常见问题与中文反馈模板。

## 0.10.1

- 修复恢复会话时重复播报规则、Skills 和配置说明的问题。
- 规则、能力或兼容状态发生变化时才提示。
- 本机认证、接口和模型环境变量单独列出，不再计入兼容问题。

## 0.10.0

- 改进 SSH 连接恢复、队列和日志管理。
- 完善后台任务恢复、进程树取消、项目写入协调与 Git worktree 隔离。
- 合并回合准备请求，减少两端往返。
- 增加可选工具管理、诊断与任务日志维护入口。
