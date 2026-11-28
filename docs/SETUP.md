# 安装指南

把 VPS 上已登录的 Claude Code 和 Windows 上的开发环境连起来。下面以 T3 Code 独立模式为例。CodexHost 入口见 [兼容说明](COMPATIBILITY.md)。

## 两端依赖

| 位置 | 需要什么 |
| --- | --- |
| **Windows** | Node.js 24+、npm、PowerShell 7、OpenSSH 客户端、Python 3.11+。项目搜索需要 ripgrep（`rg`）。T3 启动器编译使用 .NET Framework 的 `csc.exe`。 |
| **Linux VPS** | Bash、Python 3、Node.js 24、官方 Claude Code，使用可写主目录的普通用户。PDF 渲染按需使用 `pdftoppm`。 |
| **T3 Code** | 安装并启动一次以生成用户设置。默认数据目录 `%USERPROFILE%\.t3`。 |

Claude Code 的安装与登录在 VPS 上完成，参阅 [官方安装](https://code.claude.com/docs/en/setup) 和 [认证说明](https://code.claude.com/docs/en/authentication)。

## 获取源码

```powershell
git clone https://github.com/Barometer-2002/t3-claude-vps.git
cd t3-claude-vps
```

已有源码目录的直接进入。

## 配置 SSH

在 Windows `~/.ssh/config` 中定义 SSH 别名，把主机、用户和密钥换成自己的：

```sshconfig
Host my-linux-host
    HostName vps.example.com
    User YOUR_LINUX_USER
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

以 VPS 控制台提供的指纹为准完成首次连接，然后测试免密登录：

```powershell
# 测试非交互连接
ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes my-linux-host 'printf "SSH_READY\n"'

# 进入 VPS 交互终端，检查依赖并登录 Claude
ssh -t my-linux-host
```

在 VPS 终端中：

```bash
command -v python3 node claude
claude --version
claude auth login          # 若已登录可跳过
```

非交互 shell 找不到 Node 或 Claude 时，可传 `--remote-node`、`--remote-claude` 的绝对路径给配置器，见 [配置参考](CONFIGURATION.md)。

## 安装

在源码根目录用 PowerShell 7 执行，把 `my-linux-host` 换成上面验证过的 SSH 别名：

```powershell
python .\installer\configure.py --ssh-host my-linux-host --t3-only
pwsh -NoProfile -File .\install.ps1 -T3Only
node .\t3-native\manage-native.mjs status
```

> **已有配置？** 配置器会保留已有文件。用过其他接入方式时，核对 [配置读取顺序](CONFIGURATION.md#连接配置)。自定义 T3 数据目录或 Shim 目录时传入 `-T3Home` 或 `-ShimDir`。

## 验证

1. 运行 `node .\plugin\diagnose.mjs --json` 检查核心桥接，再用 `node .\t3-native\manage-native.mjs status` 查看 Provider 注册和远端探针。
2. 在 T3 Code 中重新加载 Provider，选择 **Claude VPS** 并打开一个 Windows 测试项目。
3. 先验证模型回复和已知文件读取，再按需测试权限提示、MCP、图片预览和会话续接。写入测试只用可丢弃的文件。

故障定位和回滚见 [运维与排障](OPERATIONS.md)。
