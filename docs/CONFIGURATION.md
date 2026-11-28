# 配置参考

连接、安装路径和可选工具分别配置。用 `configure.py` 生成连接文件，安装器部署到两端。

## 连接配置

安装器按以下顺序查找配置：

1. `CLAUDE_VPS_CONFIG` 环境变量指定的文件（必须存在）
2. 源码根目录的 `bridge-config.local.json`
3. `%USERPROFILE%\.codexhost\plugins\claude-vps\bridge-config.json`

`configure.py` 默认生成仓库根目录的私有配置，`--output` 可写入其他位置。

| 字段 | 说明 |
| --- | --- |
| `schemaVersion` | 当前为 `1`。 |
| `sshHost` | SSH 别名或 `user@host`。来自 `--ssh-host`。 |
| `sshExecutable` | 本机 SSH 可执行文件的绝对路径。可选 `--ssh-executable`。 |
| `hostRoot` | CodexHost 安装目录。有此字段时为 CodexHost 模式，省略时为独立模式。 |
| `nodeExecutable` | 独立模式使用的 Node.js 24+ 绝对路径。可选 `--node-executable`。 |
| `pwshExecutable` | PowerShell 7 绝对路径，配置器自动发现。 |
| `remoteRoot` | VPS 桥接安装目录，默认 `~/.codexhost/windows-bridge`。 |
| `remoteWorkspaceRoot` | VPS 工作区映射目录，默认 `~/windows-local-work`。更改后需迁移历史。 |
| `remoteClaudeExecutable` | VPS 上 Claude 可执行文件路径。通常自动探测，`--remote-claude` 显式指定。 |
| `remoteNodeExecutable` | VPS 上 Node 路径。`--remote-node` 显式指定。 |
| `legacy.enabled` | 默认 `false`。仅已知需旧隧道脚本的部署保留。 |

配置示例见 [bridge-config.example.json](../examples/bridge-config.example.json)。

## 项目规则与权限

桥接读取项目中适用的 `AGENTS.md`、`CLAUDE.md`、`CLAUDE.local.md`、`.claude/CLAUDE.md` 和 `.claude/rules/`。规则可用 YAML frontmatter 的 `paths` 限定路径。

`.claude/settings.json` 和 `.claude/settings.local.json` 提供 `permissions.allow`、`permissions.ask`、`permissions.deny`。按拒绝 → 审批 → 允许的顺序匹配。MCP 相关限制见 [T3 Code 指南](T3CODE.md#权限与-plan-模式)。

受支持的 Hook 使用同步 `command`，默认在 PowerShell 运行。匹配到桥接无法执行的 Hook 时会阻止相关操作。

## SSH 线路

未配置 `sshRoutes` 时使用普通 SSH。配置后按数组顺序尝试：

```json
{
  "sshRoutes": [
    {"name": "via-tunnel", "proxy": {"type": "cloudflared", "hostname": "ssh.example.com"}},
    {"name": "via-socks", "proxy": {"type": "socks5", "host": "127.0.0.1", "port": 10808}},
    {"name": "direct", "direct": true}
  ]
}
```

- `direct`：普通 SSH，无桥接代理。
- `socks5`：自带的转发辅助，填写可达的代理地址和端口。
- `cloudflared`：使用本机 `cloudflared access ssh`，可在代理对象中用 `executable` 指定路径。

安装、诊断和会话共用选路配置。

## 可选工具

Playwright MCP 在 Windows 启动独立 Chrome，Tavily 在 VPS 发请求。基础部署保留现有 MCP 配置。

```powershell
# 准备浏览器依赖后重新安装
python .\installer\prepare-local.py --with-playwright
pwsh -NoProfile -File .\install.ps1 -T3Only

# 启用/禁用浏览器
python .\installer\prepare-mcp.py --playwright enable
python .\installer\prepare-mcp.py --playwright disable

# 导入/禁用 Tavily
python .\installer\prepare-mcp.py --import-tavily-from-codex 'C:\Users\YOUR_USER\.codex\config.toml'
python .\installer\prepare-mcp.py --disable-tavily
```

Playwright 可配置参数：

| 字段 | 默认值 | 说明 |
| --- | ---: | --- |
| `idleTimeoutMs` | 600000 | 空闲关闭时间，`0` 保留到聊天关闭 |
| `requestTimeoutMs` | 95000 | 单次请求超时 |
| `maxClients` | 8 | 浏览器 MCP 客户端上限 |
| `maxPendingPerClient` | 32 | 单连接待完成调用上限 |
| `maxFrameBytes` | 8388608 | 单条消息字节上限 |

## 本机环境变量

| 变量 | 说明 |
| --- | --- |
| `T3CODE_HOME` | T3 数据目录，默认 `%USERPROFILE%\.t3` |
| `CLAUDE_VPS_SHIM_DIR` | Shim 目录，默认 `%USERPROFILE%\.claude-vps\shim` |
| `CLAUDE_VPS_ACP_DIR` | ACP 目录，默认 `%USERPROFILE%\.claude-vps\acp` |
| `CLAUDE_VPS_PLUGIN_DIR` | 核心桥接目录 |
| `CLAUDE_VPS_CSC` | 编译用的 `csc.exe` |
| `CLAUDE_VPS_NODE` | 启动器用的 `node.exe` |
| `CLAUDE_VPS_ATTACHMENT_DIRS` | 额外附件目录，分号分隔 |
| `T3_MCP_ALLOW_TOOLS` | T3 MCP 工具允许名单，逗号分隔 |
| `T3_MCP_DENY_TOOLS` | T3 MCP 工具拒绝名单 |
| `CLAUDE_VPS_TRUSTED_MCP_SERVERS` | 可信 MCP 服务器，`*` 信任全部 |
| `CLAUDE_VPS_RAW_TOOL_FRAMES` | `1` 禁用卡片转换 |
| `CLAUDE_VPS_PRESENT_WORKSPACE` | `1` 启用卡片转换（ACP 默认关闭） |
| `CLAUDE_VPS_CONSOLE_ENCODING` | 命令输出解码编码 |
