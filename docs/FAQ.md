# 常见问题

## 已经在用上游插件，怎么换到这个 fork？

保留现有 `bridge-config.local.json`、插件目录和 VPS 工作区根目录。按 [兼容说明](COMPATIBILITY.md#codexhost-插件) 选择安装组合。安装后检查远端映射，恢复一个已有聊天。改了根目录或 SSH 用户需要单独处理历史。

## 只用 T3 Code 或 ACP，需要 CodexHost 吗？

不需要。用 `configure.py --t3-only` 生成独立配置即可。见 [安装指南](SETUP.md)。

## 官方 Claude Code、本机 Claude 和 Claude VPS Provider 什么关系？

- **VPS 上的官方 Claude Code**：决定账号、认证和服务连接。
- **T3 的 Claude VPS Provider**：独立配置和 `claude-home`，启动 Shim 连接 VPS。
- **本机 Claude**：原有设置不变，仍供默认 Provider 使用。

## 额度和模型为什么与 VPS 终端有差别？

T3 的额度和模型显示取决于 T3 版本、远端 CLI 返回值和账号能力。`Default`、`Auto` 是宿主的选择策略。CodexHost 额度查询失败时可能沿用上次快照。

## 文件为什么显示成 Read、Edit、Bash 卡片？

T3 Shim 把 `windows-workspace` 事件转换成客户端能呈现的工具卡片。实际执行仍在 Windows。设 `CLAUDE_VPS_RAW_TOOL_FRAMES=1` 可看原始帧。

## 拖入的附件不可用？

检查宿主是否提供了可读路径、文件是否还在、图片/PDF 是否超 5 MiB。把小图保存到项目后重新读取。见 [附件指南](ATTACHMENTS.md)。

## ACP 客户端重启后，怎么继续旧对话？

客户端用原会话 ID 和原 Windows 工作目录调用 `session/resume`。旧消息由客户端自行保存和显示，ACP 的会话列表、历史回放和分支接口暂未开放。见 [ACP 续接说明](ACP.md#续接旧会话)。

## T3 Code 的聊天分支会复制项目吗？断线后能重做任务吗？

分支继承会话状态，共用同一 Windows 项目。需要文件隔离时手动创建 Git worktree。断线后用原 `requestId` 查状态，确认是否已执行再决定下一步。见 [连接中断说明](ARCHITECTURE.md#连接中断与恢复)。

## 如何卸载？

| 目标 | 命令 |
| --- | --- |
| T3 | `pwsh -NoProfile -File .\uninstall.ps1` |
| ACP | `pwsh -NoProfile -File .\install.ps1 -AcpOnly -Uninstall` |
| CodexHost | `pwsh -NoProfile -File .\install.ps1 -Disable` |

各入口影响范围见 [卸载说明](OPERATIONS.md#卸载)。

## 问题报给谁？

记录接入方式、版本、失败阶段和最小复现。T3/ACP/Shim 的问题提交到本仓库。能在上游独立复现的可同时反馈 [上游仓库](https://github.com/vv-get-ti/claude-vps-bridge)。安全问题按 [安全说明](../SECURITY.md) 处理。
