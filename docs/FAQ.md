# 常见问题

## 这个项目到底是做什么的？

让你在 Windows 的 T3 Code 里使用 VPS 上的官方 Claude Code。模型会话、登录状态在 VPS；项目文件、命令和 MCP 工具在 Windows 执行。T3 里会多出一个名为 `Claude VPS` 的 Provider，选中即可使用。

## T3 Claude VPS 与上游 `claude-vps-bridge` 是什么关系？

本项目 fork 自 [`vv-get-ti/claude-vps-bridge`](https://github.com/vv-get-ti/claude-vps-bridge)，基线 `0.14.1`，许可证同为 LGPL-3.0-only。

上游是 CodexHost 插件；本 fork 沿用它的核心桥接（SSH 传输、Windows 工作区运行时、事务部署），新增 T3 Code 接入（`t3-native/`）、Windows 端 MCP 代理、读图路径映射和只装 T3 的安装模式，并保留 CodexHost 插件。差异清单见 [Fork 说明](FORK_CHANGES.md)。

## 我已经在用上游，能直接换过来吗？

可以。插件 ID、配置文件名（`bridge-config.local.json`）和 VPS 目录都没有改，用本仓库重新运行安装脚本即可。不加参数时只装 CodexHost 插件，行为与上游一致；加 `-WithT3` 会同时注册 T3 的 `Claude VPS`。

## 问题应该报给上游还是这里？

T3 接入相关的问题（`Claude VPS` 实例、`t3-native/`、`claude-stream-relay.mjs`、MCP 代理、读图预览）请在本仓库反馈。如果问题在 CodexHost 模式下也能复现，且与 T3 无关，通常来自上游代码，也可以向上游反馈。

## 接入 T3 Code 会影响本机原生 Claude 或破坏 VPS 环境稳定性吗？

不会。原生 Shim 在 T3 Code 中注册为独立的 `claude-vps` 实例并使用隔离的 `claude-home`，不改动默认 `claudeAgent` 实例、不碰本机 `~/.claude`，也不修改 T3 Code 任何程序文件。

VPS 上始终运行官方原版 `claude` CLI 并由 VPS 直接访问 Anthropic，不使用反代、不注入或逆向官方二进制，对 VPS 账号环境来说与你在 VPS 终端里直接使用官方 Claude Code 一致。

## 只用 T3 Code，必须安装 CodexHost 桌面端吗？

不需要。使用 `python .\installer\configure.py --ssh-host <host> --t3-only` 与 `pwsh -NoProfile -File .\install.ps1 -T3Only` 即可独立部署运行。

## 为什么把 Claude Code 放在 VPS？

当 Claude Code 的运行环境放在 VPS，而项目和开发工具在自己的电脑上时，可以用这个工具把两端连接起来。凭据集中保存在 VPS，本机继续负责项目文件、终端和工具，VPS 无需承担构建、浏览器或视频处理的负载。

## 需要另外打开一个客户端吗？

不需要。在 **T3 Code** 中直接选择 **`Claude VPS`** 即可；若使用兼容的 **CodexHost** 桌面端，选择 **Claude VPS Bridge**（旧版入口名称为 Claude Code · VPS）。

## 工作区会同步到 VPS 吗？

不会整份同步。桥接为选中的 Windows 项目建立远端映射，同名但路径不同的项目会分别管理。

Claude 读取的文本、工具结果和传入的附件会发送到远端与模型服务；T3 Code 本地 HTTP MCP 地址与 Token 留在 Windows 本机。文件和数据的存放位置见[架构说明](ARCHITECTURE.md)与[T3 Code 适配说明](T3CODE.md)。

## 重开后怎么继续之前的聊天？

打开原来的聊天即可续接对应的 VPS Claude 会话。新建聊天会建立独立会话。

fork 会创建聊天分支，但仍共用项目文件。需要并行修改文件时，可以使用 Git worktree。

## 本机规则和 Skills 会生效吗？

桥接会读取当前项目适用的规则（`CLAUDE.md`、`AGENTS.md`、`.claude/rules`）、Skills 和支持的 `.claude` 配置。在 T3 Code 中发送 `/skill`、`$skill` 或 `/command` 时，原生 Shim 会自动识别并展开 Windows 本机 `.claude/{skills,commands}`（替换 `$ARGUMENTS`，不劫持内置命令）。

本机的认证、模型和接口环境变量不会覆盖 VPS 配置。可通过工具的 `info` 操作查看配置详情。

## 必须安装 Tavily、Playwright 或 Windows SSH 服务吗？

都不需要。Windows 使用 SSH 客户端连接 VPS。Tavily、Playwright 可按[配置说明](CONFIGURATION.md)分别启用。

Playwright 使用独立浏览器环境，网站需要单独登录。

## 额度为什么有时不更新？

在 T3 Code 原生 `Claude VPS` 模式下，额度通过官方 `get_usage` 与 `rate_limit_event` 实时同步；在 CodexHost 模式下，刷新失败时会保留上次数据。重置时间不是订阅到期时间。

## 宿主升级后怎么办？

本工具不修改 T3 Code 或 CodexHost 任何程序文件。若使用 CodexHost（最低 0.20.0），宿主自动更新后重新运行安装脚本即可让 VPS 端跟上官方最新版；新版本未通过兼容检查时保留当前版本并说明原因。见[升级说明](OPERATIONS.md#升级)。

## 网络很差时会不会又卡住？

桥接协议 3 将大响应拆成小块发送，同时只有少量数据交给 SSH；模型列表、健康检查等小请求可以插队，不再排在整份历史后面等。超时或放弃的请求会通知 VPS 停止发送剩余部分；历史没有变化时只传一个“未变化”标记。直连线路不稳定时，可以配置多条线路自动切换，见[配置说明](CONFIGURATION.md#ssh-线路)。

这些措施让卡顿不再被放大，但不能让一条完全不通的线路恢复。所有线路都不可用时，桥接会明确报告不可用。

## 怎么知道 SSH 走的是哪条线路？

运行 `node .\plugin\diagnose.mjs`，查看 `ssh-route`（聊天实际在用的连接）和 `diagnostic-route`（诊断时新开的连接）。入口信息由 VPS 根据实际连接观测，不是从配置推断的。含义见[维护说明](OPERATIONS.md#线路与入口)。

## 怎么反馈问题？

提供组件版本、复现步骤和相关错误片段。提交前去掉凭据、服务器地址及私人项目内容。安全问题见[安全说明](../SECURITY.md)。

## 为什么拖入的附件不可用？

桥接支持宿主提供的结构化本机附件和内联图片，在 T3 Code 下会自动授权 T3 附件目录中的图片/PDF 路径供 `windows-workspace media` 导出，并将远端 `.bridge-media` 读取路径回映射为 Windows 原始路径以支持读图预览。只有明确附加的文件会被登记；正文中的代码示例、Markdown 链接或路径不会自动上传。项目外附件只登记精确文件，不开放整个目录。

如果宿主没有提供本机路径、文件已被删除或格式不受支持，插件无法恢复图片。可以先把文件保存到项目，再让 Claude 查看；它会调用 `windows-workspace media`，无需手动输入工具命令。

大于 5 MiB 的本机图片或 PDF 会以路径和大小交给 Claude，由它决定是否调用工具处理，不会自动压缩或截取。内联图片的本机接收上限为 32 MiB；更大的图片可先保存为本机文件再附加。

## Default、Auto 与实际模型是什么关系？

Default 是 Claude 适配器的模型选择策略，Auto 是思考策略。指定模型或思考强度时，直接使用宿主原有的选择控件。

在 CodexHost 模式下，桥接在后台记录远端本轮返回的模型，可通过 `node .\plugin\diagnose.mjs --json` 的 `actual-models` 查看；在 T3 Code 原生 `Claude VPS` 模式下，直接使用 T3 Code 原生的模型选择与统计显示。

## 子会话为什么可能出现在其他项目？

在 CodexHost 委派路径中，旧插件缺少父线程时会回退到全局最近会话，现已移除。委派使用当前会话绑定的父线程与项目，缺失时要求显式 `--parent-thread`，不同项目的 `--cwd` 被拒绝，受管理 worktree 单独验证。在 T3 Code 路径中，`delegate_task` 直接走 T3 原生 MCP 工具并绑定当前线程上下文。

## 如何停用或卸载？

- **卸载 T3 Code 接入**（不影响默认 `claudeAgent`，保留 `claude-home` 会话数据和共享桥接）：先结束正在运行的 Claude VPS 会话，再运行 `pwsh -NoProfile -File .\uninstall.ps1`，等同于 `node .\t3-native\manage-native.mjs uninstall`。
- **停用或卸载 CodexHost 插件**：运行 `pwsh -NoProfile -File .\install.ps1 -Disable`（或 `-Uninstall`），仅移除启用条目并保留插件代码、会话与数据。详情见[维护说明](OPERATIONS.md)。

## 运行中可以追加指令吗？

支持。在 T3 Code 原生 `Claude VPS` 模式下直通官方 `stream-json` 交互；在 CodexHost 模式下，桥接通过公开 `readCapabilities()` 动态读取远端会话能力，确认可接收时走 `turn.steer` 保留当前轮次并继续执行本机规则、提交 Hook 与工具权限检查。

## 提示词缓存倒计时表示什么？

这是上游 Claude 适配器提供的提示词缓存估算，不是额度更新时间，也不是服务端精确 TTL。桥接仅保存和透传上游给出的绝对到期时间，刷新、断线恢复和重开不会重置计时；在 T3 Code 原生 `Claude VPS` 模式下还支持 T3 自带的 `beforeCacheExpires` 缓存过期前自动压缩策略。

## 能按原生会话 ID 查找 CodexHost 聊天吗？

当前 CodexHost 公开 CLI 不提供这项查询，插件不再读取内部 `mapping-store`。请使用明确的聊天链接或原生客户端的历史入口；这是能力缺口，不表示原生聊天丢失。
