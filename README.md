<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/banner.svg">
    <img src="docs/assets/banner.svg" alt="T3 Claude VPS (t3-claude-vps)" width="100%">
  </picture>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-v1.0.1-1F7A5A?style=flat-square&labelColor=1C1B18" alt="Version: v1.0.1">
  <img src="https://img.shields.io/badge/VPS-Official_Claude_CLI-D97757?style=flat-square&labelColor=1C1B18" alt="VPS: Official Claude CLI">
  <img src="https://img.shields.io/badge/Windows-Local_Tool_Execution-3F3D39?style=flat-square&labelColor=1C1B18" alt="Windows: Local Tool Execution">
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

**Claude Code 在 VPS 运行，项目与工具留在 Windows。** 本项目基于 Claude VPS Bridge，新增 T3 Code 原生接入，并兼容 CodexHost。

桥接器在 Windows 端的 [T3 Code](https://github.com/pingdotgg/t3code) 注册独立的 `Claude VPS` 实例，通过 SSH 启动 VPS 上的官方 Claude Code CLI，并转发 `stream-json` 会话消息。你可以直接打开 Windows 项目，由本机执行文件读写、PowerShell、构建和测试，并调用 T3 或本机配置的 MCP 工具。

> 本项目以 [`vv-get-ti/claude-vps-bridge`](https://github.com/vv-get-ti/claude-vps-bridge) 的 `0.14.1`（`0acd8a0`）为基线，采用 LGPL-3.0-only 许可。T3 接入包含本机 MCP 代理、读图路径回映射和独立安装模式。详见 [Fork 说明](docs/FORK_CHANGES.md)。

---

## 本机使用体验一览

| 你在 Windows 本机做的事 | 实际效果 |
|---|---|
| **打开任意 Windows 本地项目** | 无需同步代码到 VPS，Claude 直接读写、搜索、修改你的本机项目目录与 Git worktree |
| **执行构建、测试与脚本** | 直接调用本机 PowerShell、Node、Python、编译器、GPU 等本地工具链，支持停止即取消长任务与断线查回 |
| **使用本机配置与工作流** | 自动沿用项目 `CLAUDE.md`、`AGENTS.md`、`.claude/rules`、Hooks 与 `.claude/{skills,commands}` |
| **调用 T3 与本机 MCP** | Windows 端代理 T3 内置 MCP 与本机配置的 HTTP / Stdio MCP，按当前权限模式和项目规则处理调用 |
| **发图、看图与读 PDF** | 直接拖拽/引用本机图片与 PDF，远端读取路径自动回映射为 Windows 路径，T3 读图预览卡片正常显示 |
| **像原生客户端一样交互** | 独立 `Claude VPS` 入口，保留 T3 原生权限审批、会话续接（`--resume` / `--fork`）与多 SSH 线路自动切换 |

更多技术细节与环境变量配置见 [T3 Code 适配与使用指南](docs/T3CODE.md)。

### T3 Code 界面美化（可选）

Windows 用户可单独安装 [T3 Code Enhancer](https://github.com/Barometer-2002/t3code-enhancer)，使用明暗主题、工作过程折叠、模型与思考深度面板，以及用量和上下文统计。项目 README 提供安装说明、版本兼容性和[界面预览](https://github.com/Barometer-2002/t3code-enhancer#界面预览)。

<p align="center">
  <img src="docs/assets/t3code-enhancer-demo-redacted.png" alt="启用界面增强后的 T3 Code 会话，展示工作过程和输入框底栏" width="720">
</p>

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
    <img src="docs/assets/architecture.svg" alt="T3 Claude VPS 的运行位置和数据流" width="100%">
  </picture>
</p>

- VPS 上的 Claude Code CLI 使用 VPS 上的登录会话发起模型请求。
- Windows 主动建立 SSH 连接，通过同一连接收发会话消息、工具请求和结果。获准的本机命令按 Windows 执行账户的权限运行，MCP 代理使用 Windows 端的配置访问服务。
- 项目目录可继续放在 Windows。会话中的文字和附件，以及工具读取的文件内容、命令输出和 MCP 返回值，会随请求或工具结果传到 VPS，并可能进入模型请求。

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
