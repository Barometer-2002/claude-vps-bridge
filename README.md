<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/banner.svg">
    <img src="docs/assets/banner.svg" alt="T3 Claude VPS (t3-claude-vps)" width="100%">
  </picture>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-v1.0.1-1F7A5A?style=flat-square&labelColor=1C1B18" alt="Version: v1.0.1">
  <img src="https://img.shields.io/badge/VPS_Isolation-Official_Claude_CLI-D97757?style=flat-square&labelColor=1C1B18" alt="VPS Isolation: Official Claude CLI">
  <img src="https://img.shields.io/badge/Windows-Native_Local_Experience-3F3D39?style=flat-square&labelColor=1C1B18" alt="Windows: Native Local Experience">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-LGPL--3.0--only-4A4742?style=flat-square&labelColor=1C1B18" alt="License: LGPL-3.0-only"></a>
</p>

<p align="center">
  <a href="#它解决什么问题">核心用处</a> &nbsp;·&nbsp;
  <a href="#快速开始">快速开始</a> &nbsp;·&nbsp;
  <a href="#工作原理与隔离边界">工作原理</a> &nbsp;·&nbsp;
  <a href="docs/T3CODE.md">T3 Code 指南</a> &nbsp;·&nbsp;
  <a href="docs/FORK_CHANGES.md">Fork 说明</a> &nbsp;·&nbsp;
  <a href="docs/FAQ.md">常见问题</a>
</p>

<br>

## 它解决什么问题

一句话概括：**在隔离环境下，达到 Windows 本机原生使用 Claude Code 的效果。**

很多时候你希望把 **Claude Code 的账号登录态和网络出口固定、隔离在一台干净的 Linux VPS 上**（不碰反代、不折腾本机代理环境、不把登录态带回本地），但日常干活的**代码仓库、PowerShell、编译工具、GPU、本地 MCP、图片和 `.claude` 规则**全都在 Windows 电脑上。

**T3 Claude VPS（`t3-claude-vps`）** 用一条免密 SSH 双向通道把两端接起来，直接接入 Windows 端 **[T3 Code](https://github.com/pingdotgg/t3code)**：

- **环境彻底隔离在 VPS**：VPS 上运行未修改的官方原版 `claude` CLI，账号登录态与 Anthropic 请求完全留在 VPS —— **零反代、零逆向、零凭据出境**。
- **使用效果等同 Windows 本机**：不用把代码同步到服务器；Claude 直接读写你的 Windows 项目文件、执行本机 PowerShell / 构建命令、读取本机图片/PDF 并正常预览、加载本机 `CLAUDE.md` / Skills / Hooks，以及调用 T3 和你本机的 HTTP / Stdio MCP（本机 Token 严留 Windows）。
- **零侵入本机环境**：在 T3 Code 注册为独立实例 **`Claude VPS`**，不修改 T3 Code 程序文件，不覆盖默认 `claudeAgent`，也不需要在本机安装或登录 Claude Code。

> **开源分支声明（LGPL-3.0-only）**：本项目基于 [`vv-get-ti/claude-vps-bridge`](https://github.com/vv-get-ti/claude-vps-bridge)（基线 `0.14.1` / `0acd8a0`）扩展，完整保留上游核心桥接与 CodexHost 兼容性，并面向 T3 Code 提供官方 `claudeAgent` 原生接入、本机全量 MCP 隔离代理、读图路径回映射与纯 T3 独立安装模式。详见 [docs/FORK_CHANGES.md](docs/FORK_CHANGES.md)。

---

## 本机使用体验一览

| 你在 Windows 本机做的事 | 实际效果 |
|---|---|
| **打开任意 Windows 本地项目** | 无需同步代码到 VPS，Claude 直接读写、搜索、修改你的本机项目目录与 Git worktree |
| **执行构建、测试与脚本** | 直接调用本机 PowerShell、Node、Python、编译器、GPU 等本地工具链，支持停止即取消长任务与断线查回 |
| **使用本机配置与工作流** | 自动沿用项目 `CLAUDE.md`、`AGENTS.md`、`.claude/rules`、Hooks 与 `.claude/{skills,commands}` |
| **调用 T3 与本机 MCP** | 直接调用 T3 内置 MCP 及你本机配置的 HTTP / Stdio MCP，地址与 Token 严留 Windows；Plan 模式硬拦截写操作 |
| **发图、看图与读 PDF** | 直接拖拽/引用本机图片与 PDF，远端读取路径自动回映射为 Windows 路径，T3 读图预览卡片正常显示 |
| **像原生客户端一样交互** | 独立 `Claude VPS` 入口，保留 T3 原生权限审批、会话续接（`--resume` / `--fork`）与多 SSH 线路自动切换 |

更多技术细节与环境变量配置见 [T3 Code 适配与使用指南](docs/T3CODE.md)。

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
> 部署完成后也可通过 `node .\t3-native\manage-native.mjs install | status | uninstall` 单独管理 T3 原生接入（支持原子热升级，卸载默认保留历史数据）。

### 3. 在 T3 Code 中使用

1. 在 T3 Code 中打开任意 **本机 Windows 项目** 并新建会话。
2. 模型选择器切换到 **`Claude VPS`**（如刚安装完尚未显示，可在 **Settings → Providers** 刷新或重启 T3 Code）。
3. 像本地原生 Claude 一样直接开始对话，可先发一条只读指令验收：

```text
请确认当前 Windows 项目路径、读取 README.md 前 10 行，并调用 t3_environment_read 检查 T3 MCP 连通性，不要修改任何文件。
```

---

## 工作原理与隔离边界

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/architecture.svg">
    <img src="docs/assets/architecture.svg" alt="T3 Claude VPS 隔离架构与信任边界" width="100%">
  </picture>
</p>

- **隔离在 VPS**：原版官方 `claude` CLI、Anthropic OAuth 登录态与所有模型 API 请求全部留在 VPS（单固定出口，零反代、零改包）。
- **留在 Windows**：项目源码、构建环境、PowerShell、T3 `127.0.0.1` HTTP MCP 地址与 Bearer Token、自定义本机 MCP 凭据全部留在 Windows，通过单条免密 SSH 按需回调执行。
- **不破坏原环境**：不改写 T3 Code 程序文件，不碰本机 `~/.claude`，也不需要开启 Windows SSH 服务端或任何反向端口。

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
| [T3 Code 适配与使用指南](docs/T3CODE.md) | 接入原理、能力矩阵、MCP 安全策略、读图回映射与排障 |
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
t3-native/     T3 Code 官方 claudeAgent 原生 Shim（C# 启动器、Node 代理、本机 MCP 中心、策略层与原子热升级）
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
