# 配置与安装边界

基础桥接只负责 SSH、远端官方 Claude、本机工作区和本机执行器。Tavily、Playwright、PDF 页面渲染是独立可选能力；目前经过桥接权限验证的 MCP 是 Tavily 与 Playwright，不能据此认为任意 MCP 已自动接通。

## 初次配置

Windows 需要 T3 Code（或 CodexHost 0.20.0+）、Node.js 24+、PowerShell 7、OpenSSH 客户端、Python 3.11+。Linux x64 需要 Node/npm、Python 3 与已安装并登录的官方 Claude Code。使用已有的 SSH 配置与已确认的主机密钥；安装器不关闭主机身份校验。

```powershell
# 纯 T3 Code 独立安装（推荐，无需 CodexHost 桌面端）
python .\installer\configure.py --ssh-host my-linux-host --t3-only
pwsh -NoProfile -File .\install.ps1 -T3Only

# 或与 CodexHost 双宿共存
python .\installer\configure.py --ssh-host my-linux-host --host-root 'D:\Apps\CodexHost'
pwsh -NoProfile -File .\install.ps1 -WithT3
```

`configure.py` 查询远端用户主目录与 Claude 路径，创建 `bridge-config.local.json`，不覆盖已有文件。可显式提供 `--remote-root`、`--remote-workspace-root`、`--remote-claude`。配置文件只保存非敏感连接与路径参数，不保存账号凭据。自动发现的 Claude 路径仍需实际存在；安装健康检查与真实运行验收是独立步骤。

安装器优先读取 `CLAUDE_VPS_CONFIG` 指定的文件，然后是源码目录的 `bridge-config.local.json`，最后是已安装插件的 `bridge-config.json`。运行中的插件读取其安装目录下的配置。修改配置后重新安装，再执行 `codexhost stop`（CodexHost 安装目录下的 `bin\codexhost.exe`）后重新打开 CodexHost，使两端配置一致。

安装器把运行时配置写入插件目录、远端的 `remote-config.json` 与 `claude-path`，由同一代码事务备份和恢复。远端命令安装在桥接目录内，不覆盖 `/usr/local/bin`，不要求 root。主机、路径和代码更新不迁移已有项目映射、机器 ID 或原生历史；不要把更换远端工作区根目录当成自动数据迁移。

## SSH 线路

默认只有一条线路：按 `sshHost` 直连。直连 VPS 的线路不稳定时，可以在桥接配置里写一个有序的线路列表，桥接按顺序使用第一条可用的线路，出问题时自动换下一条。

```json
{
  "sshRoutes": [
    {"name": "cloudflared", "proxy": {"type": "cloudflared", "hostname": "ssh.example.com"}},
    {"name": "local-socks", "proxy": {"type": "socks5", "host": "127.0.0.1", "port": 10808}},
    {"name": "direct", "direct": true}
  ]
}
```

也可以在配置时传入：`python .\installer\configure.py ... --ssh-routes '<JSON 数组>'`。

| 类型 | 说明 |
|---|---|
| `direct` | 按 `sshHost` 直连，不使用代理 |
| `socks5` | 经本机 SOCKS5 代理连接。插件自带转发辅助，Windows 不需要另装 `nc` 或 `connect.exe` |
| `cloudflared` | 用本机 `cloudflared access ssh --hostname` 连接。可用 `executable` 指定 `cloudflared.exe` 的绝对路径；省略时在 PATH、Program Files 和 WinGet 目录中查找，找不到时这条线路视为不可用 |

所有线路仍使用 `sshHost` 对应的 SSH 配置、密钥和已确认的主机密钥；代理只改变到达 VPS 的路径，不改变身份校验。

使用 cloudflared 线路前，VPS 的 cloudflared 隧道需要有一条 SSH 入口，并为它添加 DNS 记录，例如：

```yaml
ingress:
  - hostname: ssh.example.com
    service: ssh://localhost:22
  # ... 其他规则，兜底的 http_status:404 放在最后
```

```bash
cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
cloudflared tunnel route dns <隧道 ID> ssh.example.com
systemctl restart cloudflared
```

切换规则：

- 新连接从第一条线路开始。连接失败、握手超时、连接中断，或读取长时间没有进展且只有只读请求在途时，换到下一条线路。
- 切换后仍接回原来的 VPS 中继，沿用原请求编号与进度，不会重新提交请求。
- 正在使用的备用线路正常时不会定时切回；下次新建连接时重新从第一条开始。
- 安装、诊断、升级校验和可选工具配置使用同一套线路。安装命令只在远端确认就绪后才放行；放行之后连接断开不会换线路重做。

传输参数一般不需要改：`transportChunkBytes`（默认 32768，大消息的分块大小）和 `transportWindowBytes`（默认 65536，已发出但未确认的字节上限）。两端在连接时核对这两个值。

## 可选工具

基础安装和升级不读取本机 Codex 的 MCP 凭据，也不创建或改写远端私有 MCP 配置。没有该配置时，Claude 会使用空的可选 MCP 列表。

```powershell
# 查询并保留既有配置；首次执行会创建空目录表。
python .\installer\prepare-mcp.py

# 分别启用或禁用本机浏览器。
# 首次启用而尚未安装浏览器依赖时，先执行下面两行：
python .\installer\prepare-local.py --with-playwright
pwsh -NoProfile -File .\install.ps1
python .\installer\prepare-mcp.py --playwright enable
python .\installer\prepare-mcp.py --playwright disable

# 只有这一显式操作会读取指定文件中的 Tavily 授权，并通过 SSH stdin 传到 VPS。
python .\installer\prepare-mcp.py --import-tavily-from-codex 'C:\Users\YOUR_USER\.codex\config.toml'
python .\installer\prepare-mcp.py --disable-tavily
```

每次只改变选中的工具，其余条目和顶层配置保持不变。工具配置仍保存于 VPS `mcp-config.private.json`，权限 0600；无变化时不重写文件。有变化时保存私有备份，凭据不进入参数、输出或代码回滚。现有原生 Claude 进程保留启动时的工具目录，工具启停后应关闭并恢复对应聊天或新开聊天。

基础安装使用锁文件准备 YAML 与路径规则依赖，省略可选的 Playwright 下载；已有浏览器依赖保持原样。首次准备依赖需要 Windows Node.js/npm，实际运行使用配置的 Host Node。可选浏览器启动使用本机已安装的 Chrome，不下载或搬运日常浏览器登录资料。

暂不提供“任意 MCP 都能透明转发”的承诺。新工具需要在自己的接入模块说明执行位置、权限映射与生命周期，不能靠修改搜索工具的配置绕过这些检查。

### 本机浏览器生命周期

可在自己的桥接配置中添加 `optionalTools.playwright`。这些选项只约束已启用的本机浏览器，不会自动安装或启用 MCP：

```json
{
  "optionalTools": {
    "playwright": {
      "idleTimeoutMs": 600000,
      "requestTimeoutMs": 95000,
      "maxClients": 8,
      "maxPendingPerClient": 32,
      "maxFrameBytes": 8388608
    }
  }
}
```

默认空闲 10 分钟且没有待完成调用时关闭浏览器连接；`idleTimeoutMs: 0` 保留到聊天关闭。其他选项分别限制请求等待时间、进程数、单连接待完成请求数和单条消息字节数。所有值必须是有界整数；无效配置只阻止浏览器接入。

空闲关闭、进程崩溃或请求超时后，需要 MCP 重新初始化连接。桥接不会自动重放工具调用，也不会声称已恢复之前的页面状态。活动请求不会被空闲计时器中止；超时属于结果未知，会关闭该连接并明确返回错误。

## 本机程序与文件传输

Claude 按任务需要调用本机程序。工具路径、命令参数和处理方法由 Claude 根据本机环境选择，插件不再提供 FFmpeg 专用配置或抽帧入口。旧配置中的 `media.ffmpegExecutable` 已不使用，可自行移除。

图片/PDF 按原始字节传输，单个文件最多 5 MiB；超限会明确报错，由 Claude 决定是否转换。视频只返回本机文件信息，不自动处理。生成的图片通过 `media` 传输，文本通过文件读取或任务日志读取。

## 旧环境兼容

新配置默认 `legacy.enabled=false`，现代路径使用本机主动发起的双向 SSH，不自动安装 Windows SSH 服务。缺少现代通道时明确报错。

已有部署只有显式启用 `legacy.enabled` 时才会使用所配置的旧隧道脚本。安装器保留使用者明确选择的兼容设置，不重新分发、改写或删除旧全局命令、隧道服务和脚本。兼容脚本可能仍包含个人环境路径，不属于可移植核心。关闭兼容设置不等于卸载系统 SSH 服务；确认现代通道覆盖所需流程后，再单独处理不再需要的旧组件。

## 验证范围

安装后按[安装指南](SETUP.md#5-试用)确认工作目录、文件读写与命令执行。

本机配置示例见 [bridge-config.example.json](../examples/bridge-config.example.json)，其中全部是占位值。优先通过配置命令发现自己的实际路径，不应直接把示例当成可运行配置。
