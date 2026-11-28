# T3 Code 使用指南

安装后，T3 Code 中出现独立的 **Claude VPS** Provider（实例 ID `claude-vps`，驱动 `claudeAgent`），有自己的 `claude-home`。它和默认 Claude Provider 并存，不修改原有配置。

## 第一次使用

1. 按 [安装指南](SETUP.md) 部署，确认 `node .\t3-native\manage-native.mjs status` 正常。
2. 打开有已知测试文件的 Windows 项目，选择 **Claude VPS**，让 Claude 读取该文件并核对内容。
3. 按需测试：权限提示、MCP 工具、图片预览、会话续接。编辑测试用可丢弃的文件。

## 会话与工具

| 功能 | 说明 |
| --- | --- |
| **模型和额度** | Shim 转发 Claude 的 `stream-json` 流。可见的模型、Fast 模式和额度取决于 T3 版本、Claude CLI 和账号能力。 |
| **续接和分支** | 用原聊天及远端会话 ID 续接。`--resume` 和 `--fork-session` 走 Claude CLI。分支共用项目目录。 |
| **文件和命令** | 通过 `windows-workspace` 在 Windows 执行。操作显示为 Read、Grep、Glob、Bash、Edit、Write 卡片，编辑可附带差异。设 `CLAUDE_VPS_RAW_TOOL_FRAMES=1` 看原始帧。 |
| **规则和 Hooks** | 读取 Windows 项目中受支持的 `AGENTS.md`、`CLAUDE.md` 等规则。Shim 展开本机 `/skill` 和 `/command`，运行受支持的 `UserPromptSubmit` Hook。 |
| **本机 MCP** | 拦截 `--mcp-config` 和动态 `mcp_set_servers`。Windows 建立 HTTP 连接或启动 Stdio 子进程，工具结果经桥接返回。 |
| **图片和 PDF** | 把远端媒体缓存路径映射回 Windows 文件，预览依赖本机源文件。见 [附件指南](ATTACHMENTS.md)。 |

## 权限与 Plan 模式

宿主的权限交互和桥接执行检查都参与判断。Windows 命令和 MCP 子进程获准后，以当前 Windows 用户的系统权限运行。

每次 MCP `tools/call` 都经过策略检查：
- `permissions.deny` 优先匹配
- `permissions.ask` 匹配的调用需要审批
- T3 内置 MCP 受 `T3_MCP_ALLOW_TOOLS` / `T3_MCP_DENY_TOOLS` 约束
- Plan 模式下，自定义 MCP 工具还要求已被发现、声明 `readOnlyHint: true` 且 `destructiveHint: false`，并由项目规则或可信名单允许

## 常见问题排查

| 现象 | 检查 |
| --- | --- |
| Provider 缺失或不可用 | 确认 T3 数据目录、注册路径和 `status` 的 `liveCheck`。更新后重启 T3。 |
| `usesLegacyLocation` 为真 | 仍指向旧 Shim 位置，需迁移到共享 Shim。 |
| MCP 工具没有出现 | 确认宿主提供了配置、两端桥接版本对应，核对权限规则和工具发现结果。 |
| 命令输出乱码 | 设置 `CLAUDE_VPS_CONSOLE_ENCODING`。 |

更多环境变量和配置见 [配置参考](CONFIGURATION.md#本机环境变量)。
