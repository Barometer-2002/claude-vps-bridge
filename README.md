<p align="center">
  <img src="plugin/icon.svg" width="80" height="80" alt="Claude VPS Bridge">
</p>

<h1 align="center">Claude VPS Bridge</h1>

<p align="center">Claude Code 在 VPS 运行，项目、工具与 T3 Code 凭据留在 Windows 本机。</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="docs/T3CODE.md">T3 Code 接入</a> ·
  <a href="docs/SETUP.md">安装指南</a> ·
  <a href="docs/CONFIGURATION.md">配置</a> ·
  <a href="docs/ARCHITECTURE.md">架构</a> ·
  <a href="docs/FAQ.md">常见问题</a>
</p>

Claude VPS Bridge 同时支持 **[T3 Code](https://github.com/pingdotgg/t3code)** 与 **[CodexHost](https://github.com/BytePioneer-AI/codex-host)**。官方 Claude Code 与登录凭据留在 Linux VPS 上（零反代、零逆向、零凭据出境），你在 Windows 本机选择项目、发送消息，直接操作本机文件、开发工具与 T3 Code 原生生态。

---

## 三种接入方式（可独立并存）

| 接入方式 | 适用宿主 | 核心特点 | 文档 |
|---|---|---|---|
| **T3 Code 原生 `claudeAgent` Shim**（`t3-native/`，推荐） | T3 Code | 注册独立实例 **`Claude VPS`**（`driver: claudeAgent`），直通 VPS 官方 Claude Code 的标准 `stream-json` 协议：**顶部 5h/7d 实时额度圆环、单套原生权限、自动标题/Commit/PR（`textGeneration`）、`effort`/`ultracode`/`fastMode`、缓存过期前自动压缩、T3 MCP 全量直通**；不碰默认 `claudeAgent` 与本机 `~/.claude`。 | [T3 Code 适配说明](docs/T3CODE.md) |
| **T3 Code Local ACP 适配器**（`t3/`） | T3 Code | 注册 **`Claude VPS Bridge`**（`acpRegistry`），提供完整模型与按模型 Thinking 切换、`windows-workspace` 原生卡片渲染（Read / Edit 红绿 Diff / Grep / PowerShell）、T3 MCP 透传（Plan 模式 Fail-Closed 只读白名单）、Plan 任务面板、本地 Skills 热刷新与执行、零消耗 `/usage` 与 `/status`。 | [T3 Code 适配说明](docs/T3CODE.md) |
| **CodexHost 桌面端插件**（`plugin/`） | CodexHost | 100% 兼容上游 CodexHost 插件平台，支持本机项目工具、Rules/Skills/Hooks、图片与 PDF、持久后台任务、Git Worktree 隔离、Agent 委派与账号额度面板。 | [安装指南](docs/SETUP.md) |

> **无需安装 CodexHost 桌面端？** 使用 `-T3Only` 独立安装模式即可仅配合 T3 Code 运行（依赖本机 Node.js 24+）。

---

## 核心特性

- **本机项目原地开发**：读取/修改 Windows 本机文件，运行本机程序、测试与构建；切换项目自动绑定目录，无需整份同步源码。
- **官方标准协议，零反代零逆向**：VPS 上始终运行原版官方 `claude` CLI，所有 Anthropic 请求从 VPS 直接发出；本机 T3 MCP 地址与鉴权 Token 严格留在 Windows 进程内存，永不发往 VPS。
- **沿用本机项目配置**：自动加载 `CLAUDE.md`、`AGENTS.md`、`.claude/rules`、Skills/Commands 与支持的 Hooks / 权限策略。
- **完整会话能力**：支持会话恢复（Resume）、历史加载（Load）、原生分支（Fork）、上下文压缩（`/compact`）、图片与 PDF 附件、交互式提问与计划审批。
- **稳定连接与安全部署**：单条免密 SSH 双向复用通道（支持 `direct` / SOCKS5 / `cloudflared` 多线路自动切换），原子事务式部署与一键回滚，不修改宿主任何程序文件。

---

## 快速开始

### 1. 准备环境

| Windows 本机 | Linux x64 VPS |
|---|---|
| T3 Code（或 CodexHost 0.20.0+）、Node.js 24+、PowerShell 7、OpenSSH 客户端、Python 3.11+、npm、ripgrep（`rg`） | Python 3、Bash、Node.js 24/npm、已登录的官方 Claude Code |

先在 VPS 上安装并登录 [Claude Code](https://code.claude.com/docs/en/setup)，并配置好 Windows 到 VPS 的免密 SSH 别名（详细步骤见 [安装指南](docs/SETUP.md#1-先准备两端环境)）。本机无需安装或登录 Claude Code，也无需开启 Windows SSH 服务。

### 2. 一键安装

在仓库根目录打开 **PowerShell 7**：

#### 场景 A：仅使用 T3 Code（推荐原生 `Claude VPS` + ACP 后备）

```powershell
python .\installer\configure.py --ssh-host my-linux-host --t3-only
pwsh -NoProfile -File .\install.ps1 -T3Only -WithT3Native
```

#### 场景 B：T3 Code 与 CodexHost 双宿共存

```powershell
python .\installer\configure.py --ssh-host my-linux-host --host-root 'D:\Apps\CodexHost'
pwsh -NoProfile -File .\install.ps1 -WithT3 -WithT3Native
```

#### 场景 C：仅使用 CodexHost

```powershell
python .\installer\configure.py --ssh-host my-linux-host --host-root 'D:\Apps\CodexHost'
pwsh -NoProfile -File .\install.ps1
```

> 若使用 CodexHost，插件由共享后台加载，安装或升级后需执行 `codexhost stop` 再重新打开 CodexHost，并用 `node .\plugin\diagnose.mjs` 确认 `plugin-activation` 为 `current`。

### 3. 开始使用

- **在 T3 Code 中**：打开任意本机 Windows 项目，新建会话，在模型选择器中选择 **`Claude VPS`**（原生体验，支持顶部 5h/7d 实时额度圆环与单套权限）或 **`Claude VPS Bridge`**（ACP 适配器）。
- **在 CodexHost 中**：打开项目，选择 **Claude VPS Bridge**。

可先发一条只读指令验收：

```text
请确认当前 Windows 项目路径并读取 README.md 前 10 行，不要修改任何文件。
```

---

## 工作原理

![Claude VPS Bridge 架构：Claude Code 在 VPS 运行，通过 SSH 调用 Windows 本机文件与工具](docs/assets/architecture.svg)

1. **项目源码与本机工具留在 Windows**：VPS 上的 Claude 通过 `windows-workspace` 经现有认证 SSH 通道回调 Windows 本机执行文件读写、搜索、命令与 Hooks。
2. **Claude 登录态与会话历史留在 VPS**：不搬运任何 Anthropic 凭据到 Windows。
3. **T3 Code 原生 MCP 凭据留在 Windows**：T3 本地 MCP 接口与 Bearer Token 仅在 Windows 本机使用，VPS 通过 `mcp-local.py --server t3-code` 经同一条 SSH 通道请求本机代理完成工具调用。

详细架构与数据边界见 [架构与数据边界](docs/ARCHITECTURE.md) 与 [T3 Code 适配说明](docs/T3CODE.md)。

---

## 文档导航

| 文档 | 内容说明 |
|---|---|
| [T3 Code 适配说明](docs/T3CODE.md) | 原生 `claudeAgent` Shim 与 Local ACP 对比、架构图、安装、安全策略与排障 |
| [安装指南](docs/SETUP.md) | 准备环境、配置免密 SSH、VPS 登录 Claude、完成部署与验收 |
| [配置说明](docs/CONFIGURATION.md) | `CLAUDE.md`、`.claude` 规则/Skills/Hooks、权限策略、多 SSH 线路与可选 MCP |
| [附件支持](docs/ATTACHMENTS.md) | 图片、PDF 与视频文件的处理方式与大小限制 |
| [架构与数据边界](docs/ARCHITECTURE.md) | 模块职责、传输协议、锁与恢复机制、数据流边界 |
| [运维与排障](docs/OPERATIONS.md) | 统一诊断、日志清理、升级、回滚与停用卸载 |
| [常见问题](docs/FAQ.md) | 高频问题与已知限制 |
| [更新记录](CHANGELOG.md) | 各版本变更日志 |

---

## 项目结构

```text
t3-native/     T3 Code 官方 claudeAgent 原生 Shim（C# 启动器、Node 代理、本地 HTTP MCP 客户端与注册工具）
t3/            T3 Code Local ACP 适配器（v1.3.1，含工具卡片翻译、MCP-over-ACP、Plan 面板与管理工具）
plugin/        Windows 本机核心插件与运行时（SSH 多路传输、工作区执行、项目环境、Hooks、诊断与维护）
remote/        VPS 端桥接（remote-server、claude-stream-relay、tool-bridge、workspace-guard、mcp-local 等）
installer/     配置、依赖准备、事务式部署/回滚与停用脚本
docs/          T3 Code 指南、安装、配置、架构、运维与 FAQ 文档
examples/      配置示例
scripts/       源码语法与公开仓库安全检查
```

---

## 参与贡献

提交改动前请阅读 [贡献指南](CONTRIBUTING.md) 与 [AGENTS.md](AGENTS.md)，并确保以下两项检查全部通过：

```powershell
python .\scripts\check.py
python .\scripts\check-public.py --staged
```

扩展工具可参考 [扩展接口](docs/EXTENDING.md)，安全问题请参见 [安全说明](SECURITY.md)。

---

## 许可证与致谢

采用 [LGPL-3.0-only](LICENSE)（随附 [GPL-3.0 全文](LICENSE-GPL-3.0)）。第三方组件与图形的授权见 [第三方声明](THIRD_PARTY_NOTICES.md)。

感谢上游 [claude-vps-bridge](https://github.com/vv-get-ti/claude-vps-bridge) 与 [CodexHost](https://github.com/BytePioneer-AI/codex-host) 提供核心桥接与 Claude 适配器基础。Clawd 图形来自 [LobeHub Icons](https://github.com/lobehub/lobe-icons)。
