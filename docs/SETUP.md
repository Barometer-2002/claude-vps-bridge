# 安装与 VPS 登录

本指南以 **T3 Code 优先** 的流程介绍如何完成 **T3 Claude VPS（`t3-claude-vps`）** 的双端准备、SSH 配置、VPS Claude 登录与部署；文末附与上游 CodexHost 共存或单独安装 CodexHost 的方法。

---

## 1. 先准备两端环境

### Windows 本机

- **[T3 Code](https://github.com/pingdotgg/t3code)**（安装并至少打开一次，以生成 `%USERPROFILE%\.t3\userdata\settings.json`）
- **Node.js 24+** 与 **npm**
- **PowerShell 7**（`pwsh`）
- **OpenSSH 客户端**（无需开启 Windows SSH 服务端）
- **Python 3.11+**（安装与本机配置脚本使用标准库 `tomllib`）
- **[ripgrep](https://github.com/BurntSushi/ripgrep#installation)**（`rg --version` 应正常输出，项目搜索依赖该程序）
- **Windows 内置 .NET Framework 4**（`csc.exe`，用于编译原生 Shim 轻量启动器 `claude-vps-shim.exe`，Windows 10/11 默认自带）
- *可选*：如需同时兼容 CodexHost 桌面端，准备 CodexHost 0.20.0+（[发布页](https://github.com/BytePioneer-AI/codex-host/releases)）；如需本机浏览器 MCP，准备本机 Chrome。

### Linux x64 VPS

- Python 3、Bash、Node.js 24 / npm
- 已安装的官方 [Claude Code](https://code.claude.com/docs/en/setup)
- 使用有权写入自身主目录的普通用户即可，**不要求 root**
- *可选*：PDF 按页读取需要 `pdftoppm`（通常来自 `poppler-utils`），不影响基础聊天。

---

## 2. 配置免密 SSH

在 Windows 的 `~/.ssh/config` 中建立指向 VPS 的别名，例如：

```sshconfig
Host my-linux-host
    HostName YOUR_VPS_HOST
    User YOUR_LINUX_USER
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

首次使用 `ssh my-linux-host` 时，核对 VPS 控制台或管理员提供的主机指纹。完成公钥授权后再检查非交互连接与远端程序路径：

```powershell
ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes my-linux-host 'echo SSH_READY'
ssh my-linux-host 'command -v python3 node npm claude'
```

连接由 Windows 主动发起，无需开启 Windows SSH 服务或开放任何本机端口。

自检应输出四个程序的路径。非交互 SSH 不一定加载交互终端中的 nvm/fnm 配置；安装器会用登录 shell 探测并尝试常见用户安装位置。若仍找不到，可在配置时显式传入 `--remote-claude /绝对路径/claude` 或 `--remote-node /绝对路径/node`。

默认使用 PATH 中的 SSH；需要指定客户端时可给 `configure.py` 加 `--ssh-executable 'C:\Windows\System32\OpenSSH\ssh.exe'`（示例路径）。输出会显示实际路径与版本，诊断也使用同一客户端。

---

## 3. 在 VPS 登录官方 Claude Code

打开交互式远端终端：

```powershell
ssh -t my-linux-host
```

确认提示符位于你的 VPS 后执行：

```bash
claude --version
claude auth login
```

按终端提示完成浏览器授权（浏览器可在本机打开，授权命令与凭据均留在 VPS，切勿将授权码粘贴进聊天或公开 Issue）。完成后可启动一次 `claude` 确认能正常对话。登录问题请参考[官方认证文档](https://code.claude.com/docs/en/authentication)。

---

## 4. 回到 Windows 部署 T3 Claude VPS

在仓库根目录打开 **PowerShell 7**：

### 场景 A：纯 T3 Code 独立安装（推荐，无需 CodexHost 桌面端）

```powershell
# 1. 生成连接配置（将 my-linux-host 替换为你的 SSH 别名）
python .\installer\configure.py --ssh-host my-linux-host --t3-only

# 2. 部署两端桥接 + 注册官方原生实例 Claude VPS
pwsh -NoProfile -File .\install.ps1 -T3Only
```

### 场景 B：T3 Code 与 CodexHost 双宿共存

```powershell
python .\installer\configure.py --ssh-host my-linux-host --host-root 'D:\Apps\CodexHost'
pwsh -NoProfile -File .\install.ps1 -WithT3
```

### 场景 C：仅安装 CodexHost 插件（上游兼容模式）

```powershell
python .\installer\configure.py --ssh-host my-linux-host --host-root 'D:\Apps\CodexHost'
pwsh -NoProfile -File .\install.ps1
```

### 配置与部署细节说明

- `configure.py` 会通过 SSH 验证远端可执行文件并生成 `bridge-config.local.json`（保留已有配置，不进入 Git）。安装脚本优先选择 `py -3` 或真实 Python 3.11+（自动排除 WindowsApps 占位程序）。
- 两端部署采用事务式备份与文件哈希校验，保留既有会话和用户数据，不修改 T3 Code 或 CodexHost 任何程序文件。
- 为保持与上游配置及数据目录兼容，核心桥接仍安装到 `%USERPROFILE%\.codexhost\plugins\claude-vps`，T3 原生 Shim 独立安装到 `%USERPROFILE%\.t3\integrations\claude-vps-native`（可通过 `-T3Home` 或 `T3CODE_HOME` 指定自定义 T3 数据目录）。
- 使用 CodexHost 模式时，`codexhost` 在 PATH 且能定位目录可省略 `--host-root`；安装脚本仅支持默认 `%USERPROFILE%\.codexhost`（遇到自定义 `CODEXHOST_DATA_DIR` / `CODEXHOST_PLUGIN_DIRECTORY` 会安全停止）。旧版曾打过宿主补丁的用户请重装或升级 CodexHost 清除旧补丁。

---

## 5. 验收与试用

### 在 T3 Code 中验收

1. 打开任意本机 Windows 测试项目，新建会话。
2. 在模型选择器中选择 **`Claude VPS`**（原生 `claudeAgent` Shim）。如刚安装完未立即出现，可在 **Settings → Providers** 刷新或重启 T3 Code。
3. 依次验证：
   - **本机读写与 T3 MCP**：让它读取本机文件、查看当前 Windows 项目路径并调用 `t3_environment_read`。
   - **实时额度与任务进度**：查看顶部 / 账号页 5h & 7d 实时额度圆环是否亮起，并测试 `TaskCreate` / `TaskUpdate` 进度面板。
   - **图片预览渲染**：让它读取项目中的一张本地 PNG/JPG，确认 T3 Code 读图卡片正常渲染预览。

同时可在终端执行快速健康检查（不提交模型请求）：

```powershell
node .\t3-native\manage-native.mjs status
node .\plugin\diagnose.mjs --json
```

### 在 CodexHost 中验收（如已安装双宿/CodexHost 模式）

执行 `codexhost stop` 后重新打开 CodexHost（仅关闭桌面窗口不会重启共享后台），选择测试目录与 **Claude VPS Bridge**，验证本机文件读写、命令执行与重开续接。

---

## 6. 配置可选工具与多 SSH 线路

如需启用 Tavily 搜索、Playwright 浏览器或配置 `direct` / SOCKS5 / `cloudflared` 多线路故障切换，见 [配置说明](CONFIGURATION.md)。日常排障与独立卸载见 [运维与排障](OPERATIONS.md) 与 [T3 Code 适配指南](T3CODE.md)。
