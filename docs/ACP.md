# ACP v1 指南

在支持自定义 ACP v1 stdio Agent 的 Windows 客户端中，可以用 `claude-vps-acp.exe` 接入桥接。包装器复用锁定的 `@agentclientprotocol/claude-agent-acp`，通过共享 Shim 启动远端 Claude Code，并向客户端提供工作区操作的路径和编辑预览。

## 安装

先完成 [SSH 检查和两端准备](SETUP.md#配置-ssh)。在源码根目录：

```powershell
# 仅安装 ACP
python .\installer\configure.py --ssh-host my-linux-host --t3-only
pwsh -NoProfile -File .\install.ps1 -AcpOnly

# 检查状态
node .\acp\manage-acp.mjs status
```

已有 T3 安装并希望同时使用：

```powershell
pwsh -NoProfile -File .\install.ps1 -T3Only -WithAcp
```

## 客户端配置

在客户端的自定义 ACP Agent 设置中：

- **命令**：`claude-vps-acp.exe` 的绝对路径，默认 `%USERPROFILE%\.claude-vps\acp\claude-vps-acp.exe`（配置框不展开环境变量时填完整路径）
- **连接方式**：stdio
- **工作目录**：你的 Windows 项目路径

登录由 VPS 上的 Claude Code 管理，客户端不需要 Claude 登录。

## 能力范围

| 能力 | 状态 |
| --- | --- |
| 新建会话与交互 | ✅ 支持。读取、命令和编辑由 Windows 工作区处理。 |
| 文件读写与命令执行 | ✅ 通过桥接工作区工具在 Windows 执行。ACP 协议的客户端 `fs` 和 `terminal` 能力声明被移除，让客户端不直接操作文件和终端——实际功能由桥接代替，不影响使用。 |
| 权限和编辑预览 | ✅ 取决于客户端自身的展示能力。 |
| 客户端 MCP | ✅ Streamable HTTP 和 Stdio。独立 SSE 和 ACP-over-MCP 会被拒绝。 |
| 跨重启续接 | 支持 `session/resume`。客户端保留原会话 ID，并在重启后传入原 Windows 工作目录。 |
| 会话列表、历史回放、分支 | `session/list`、`session/load`、`session/fork` 暂未开放。 |
| Provider 管理与认证 | — 由 VPS 已有的 Claude Code 登录状态管理，客户端无需登录。 |

## 续接旧会话

客户端先完成 `initialize`，确认 `agentCapabilities.sessionCapabilities.resume` 可用，再用原会话的 `sessionId` 和 `cwd` 发送 `session/resume`。如果会话使用客户端提供的 MCP，续接时一并传入原 `mcpServers`。VPS 会核对会话记录是否属于该 Windows 工作区。续接成功后，客户端就可以用原会话 ID 发送下一轮 `session/prompt`。

Claude Code 会恢复模型所需的对话上下文。客户端要显示旧消息，需要自行保存此前收到的历史。客户端若只通过 `session/list` 和 `session/load` 打开旧聊天，其界面暂时无法使用这条续接路径。

## 验证

安装阶段用本机 stdio 握手验证包装器与上游适配器能协商 ACP v1。`status` 查看包装器、上游入口、自检和共享 Shim 状态。再用目标客户端新建测试会话，验证登录、模型回复、文件读取和权限提示。测试续接时，先完成一轮对话并退出 ACP 进程，再用新进程续接同一个会话，发送一条需要前文才能回答的消息。

## 卸载

```powershell
pwsh -NoProfile -File .\install.ps1 -AcpOnly -Uninstall
```

移除 ACP 包装器并尝试清理 `node_modules`。保留共享 Shim、核心桥接和 T3 接入。自定义目录通过 `-AcpDir`、`-ShimDir` 定位。详见 [运维指南](OPERATIONS.md)。
