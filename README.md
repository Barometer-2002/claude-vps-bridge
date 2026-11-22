<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/banner.svg">
    <img src="docs/assets/banner.svg" alt="T3 Claude VPS (t3-claude-vps)" width="100%">
  </picture>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-v1.0.0-1F7A5A?style=flat-square&labelColor=1C1B18" alt="Version: v1.0.0">
  <img src="https://img.shields.io/badge/T3_Code-Native_claudeAgent-D97757?style=flat-square&labelColor=1C1B18" alt="T3 Code: Native claudeAgent">
  <img src="https://img.shields.io/badge/Claude_Code-Official_CLI-3F3D39?style=flat-square&labelColor=1C1B18" alt="Claude Code: Official CLI">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-LGPL--3.0--only-4A4742?style=flat-square&labelColor=1C1B18" alt="License: LGPL-3.0-only"></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> &nbsp;·&nbsp;
  <a href="#核心能力">核心能力</a> &nbsp;·&nbsp;
  <a href="#工作原理与安全边界">工作原理</a> &nbsp;·&nbsp;
  <a href="docs/T3CODE.md">T3 Code 使用指南</a> &nbsp;·&nbsp;
  <a href="docs/FORK_CHANGES.md">Fork 改进说明</a> &nbsp;·&nbsp;
  <a href="docs/FAQ.md">常见问题</a>
</p>

<br>

**T3 Claude VPS（`t3-claude-vps`）** 让运行在 Linux x64 VPS 上的原版官方 **Claude Code CLI**，通过单条免密 SSH 通道原生接入 Windows 本机 **[T3 Code](https://github.com/pingdotgg/t3code)**。

Anthropic 登录态与模型请求始终留在 VPS，项目源码、构建工具与 T3 / 本机 MCP 凭据严格留在 Windows —— **零反代、零逆向、零宿主文件修改**。

> **开源分支声明（LGPL-3.0-only）**：本项目基于 [`vv-get-ti/claude-vps-bridge`](https://github.com/vv-get-ti/claude-vps-bridge)（基线 `0.14.1` / `0acd8a0`）扩展，完整保留上游协议 3 多路复用传输与 CodexHost 兼容性，并面向 T3 Code 提供官方 `claudeAgent` 原生 Shim（`t3-native/`）、本机 MCP 代理与安全策略层、远端读图路径回映射与纯 T3 独立安装模式。详见 [docs/FORK_CHANGES.md](docs/FORK_CHANGES.md)。

---

## 核心能力

以独立实例 **`Claude VPS`**（`driver: claudeAgent`）注册至 T3 Code，**不改动 T3 Code 默认 `claudeAgent`、不触碰本机 `~/.claude`**，可与本机原生账号并行共存：

| 维度 | 说明 |
|---|---|
| **原生官方 `stream-json` 直通** | 完整支持 T3 顶部 **5h / 7d 实时额度圆环**（`get_usage` + `rate_limit_event`）、单套原生权限（`can_use_tool`）、自动标题 / Commit / PR（`textGeneration`）、`--resume` / `--fork-session`、`effort` / `ultracode` / `fastMode` 与缓存过期自动压缩 |
| **本机全量 MCP 与安全边界** | 内置 `LocalMcpHub` + `mcp-policy`：统一代理 T3 内置 `127.0.0.1` HTTP MCP（流式逐事件 SSE）与本机自定义 HTTP / Stdio MCP，Token / 环境变量严留 Windows；Plan 模式 Fail-Closed 硬拦截有副作用或未知工具，并尊重项目 `permissions.deny` |
| **原生图片 / PDF 预览与传输** | 自动授权 T3 附件路径供 `windows-workspace media` 导出，并将 VPS `.bridge-media` 读取路径实时回映射为 Windows 原始路径（含分块 `stream_event`、审批弹窗双向还原与 `--resume` 持久化），确保 T3 Code 读图预览卡片正常渲染 |
| **本机工程环境与多线路容错** | 自动加载 `CLAUDE.md`、`AGENTS.md`、`.claude/rules`、Hooks 与本机 `.claude/{skills,commands}` 展开（替换 `$ARGUMENTS`）；支持 `direct` / SOCKS5 / `cloudflared` 多线路自动切换 |
| **异常阻断、停止取消与热升级** | `UserPromptSubmit` Hook 阻断清晰报错不锁死会话；停止即取消本机长任务，SSH 意外断线自动保留原 `requestId` 防重放；`manage-native.mjs` 支持暂存编译自检与 `.exe` 原子热替换 |

完整能力矩阵与环境变量配置见 [T3 Code 适配与使用指南](docs/T3CODE.md)。

---

## 快速开始

### 1. 环境准备

- **Windows 本机**：T3 Code、Node.js 24+、PowerShell 7、OpenSSH 客户端、Python 3.11+、npm、ripgrep（`rg`）、内置 .NET Framework 4（`csc.exe`）。*无需在本机安装或登录 Claude Code。*
- **Linux x64 VPS**：Python 3、Bash、Node.js 24 / npm、已登录的官方 [Claude Code](https://code.claude.com/docs/en/setup)，并配好 Windows → VPS 免密 SSH 别名（详见 [安装指南](docs/SETUP.md)）。

### 2. 一键部署（纯 T3 模式，无需 CodexHost）

在仓库根目录打开 **PowerShell 7**：

```powershell
# 1. 生成配置（将 my-linux-host 替换为你的 SSH 别名）
python .\installer\configure.py --ssh-host my-linux-host --t3-only

# 2. 部署两端桥接并注册 T3 Code 原生实例 Claude VPS
pwsh -NoProfile -File .\install.ps1 -T3Only
```

> [!TIP]
> 部署完成后也可通过 `node .\t3-native\manage-native.mjs install | status | uninstall` 单独管理 T3 原生接入（卸载默认保留 `claude-home` 历史）。

### 3. 在 T3 Code 中验收

1. 在 T3 Code 中打开任意 **本机 Windows 项目** 并新建会话。
2. 模型选择器切换到 **`Claude VPS`**（如刚安装完尚未显示，可在 **Settings → Providers** 刷新或重启 T3 Code）。
3. 发送一条只读指令验收连通性：

```text
请确认当前 Windows 项目路径、读取 README.md 前 10 行，并调用 t3_environment_read 检查 T3 MCP 连通性，不要修改任何文件。
```

---

## 工作原理与安全边界

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/architecture.svg">
    <img src="docs/assets/architecture.svg" alt="T3 Claude VPS 架构与信任边界" width="100%">
  </picture>
</p>

- **原版运行，凭据留远端**：VPS 上运行未修改的官方 `claude` CLI，所有 Anthropic 请求由 VPS 直发；OAuth 凭据与原生会话历史不导出到 Windows。
- **按需回调，Token 留本机**：项目目录留在 Windows，通过既有认证 SSH 双向通道按需读写与执行构建；T3 `127.0.0.1` HTTP MCP 地址、Bearer Token 及自定义本机 MCP 配置严禁出境。
- **沿用本机工程配置**：自动加载 `CLAUDE.md`、`AGENTS.md`、`.claude/rules`、Skills / Commands 与 Hooks，支持 `direct` / SOCKS5 / `cloudflared` 多线路自动切线。

深入设计详见 [架构与数据边界](docs/ARCHITECTURE.md)。

---

<details>
<summary><b>上游兼容：CodexHost 桌面端共存或独立安装</b></summary>

<br>

本 Fork 完整保留了上游 `vv-get-ti/claude-vps-bridge` 的 CodexHost 0.20.0+ 插件能力；底层插件 ID（`claude-vps`）、配置文件名（`bridge-config.local.json`）与远端目录结构保持完全兼容。

```powershell
# T3 Code + CodexHost 共存
python .\installer\configure.py --ssh-host my-linux-host --host-root 'D:\Apps\CodexHost'
pwsh -NoProfile -File .\install.ps1 -WithT3

# 仅安装 CodexHost 插件
pwsh -NoProfile -File .\install.ps1
```

安装或升级 CodexHost 插件后，请执行 `codexhost stop` 并重新启动 CodexHost，随后运行 `node .\plugin\diagnose.mjs` 确认 `plugin-activation` 为 `current`。

</details>

---

## 文档导航

| 文档 | 说明 |
|---|---|
| [T3 Code 适配与使用指南](docs/T3CODE.md) | 原生 `claudeAgent` Shim 数据流、能力矩阵、MCP 安全策略、读图回映射与排障 |
| [Fork 起源与改进说明](docs/FORK_CHANGES.md) | 上游基线、LGPL-3.0 合规声明与完整变更文件清单 |
| [安装指南](docs/SETUP.md) | 环境准备、免密 SSH、VPS 登录与独立 / 共存部署步骤 |
| [配置说明](docs/CONFIGURATION.md) | `CLAUDE.md`、规则、Skills、Hooks、权限策略与多 SSH 线路 |
| [架构与数据边界](docs/ARCHITECTURE.md) | 模块职责、传输协议 3、锁与恢复机制、数据边界 |
| [运维与排障](docs/OPERATIONS.md) | 统一诊断、独立卸载、日志清理、升级与回滚 |
| [附件支持](docs/ATTACHMENTS.md) | 图片、PDF 与视频文件的处理机制与体积限制 |
| [常见问题](docs/FAQ.md) | 安全性、Fork 关系与高频排障问答 |
| [更新记录](CHANGELOG.md) | 本项目正式发布记录与上游基线历史 |

---

## 项目结构

```text
t3-native/     T3 Code 官方 claudeAgent 原生 Shim（C# 启动器、Node 代理、流式 MCP 中心、策略层与原子热升级）
remote/        VPS 端运行时（claude-stream-relay、remote-server、tool-bridge、workspace-guard、mcp-local）
plugin/        Windows 本机核心桥接与 CodexHost 插件运行时（协议 3 多路传输、工作区执行、Hooks、诊断）
installer/     配置器（支持 --t3-only）、依赖准备、事务式部署与回滚脚本
docs/          使用指南、架构与安全文档及矢量图示
examples/      配置示例
scripts/       源码语法与公开仓库安全检查
```

---

## 贡献与许可

提交改动前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [AGENTS.md](AGENTS.md)，并确保检查通过：

```powershell
python .\scripts\check.py
python .\scripts\check-public.py --staged
```

扩展接口见 [docs/EXTENDING.md](docs/EXTENDING.md)，安全披露见 [SECURITY.md](SECURITY.md)。

- 本项目采用 **[LGPL-3.0-only](LICENSE)**（随附 [GPL-3.0 全文](LICENSE-GPL-3.0)），第三方依赖与上游来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 致谢上游项目 **[vv-get-ti/claude-vps-bridge](https://github.com/vv-get-ti/claude-vps-bridge)**（`0.14.1`）、**[T3 Code](https://github.com/pingdotgg/t3code)** 与 **[CodexHost](https://github.com/BytePioneer-AI/codex-host)**。
