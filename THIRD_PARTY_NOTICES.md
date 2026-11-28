# 上游来源、第三方组件与许可声明

本项目 **T3 Claude VPS（`t3-claude-vps`）** 采用 **LGPL-3.0-only**。`LICENSE` 为 LGPL v3 正文，`LICENSE-GPL-3.0` 包含其引用的 GPL v3 正文。

## 上游项目与第三方依赖

| 项目 | 用途 | 声明的许可证 / 来源 |
|---|---|---|
| **claude-vps-bridge**（`0.14.1` / `0acd8a0`） | 本 Fork 的上游基线项目：提供 SSH 协议 3 多路复用传输、Windows 本机工作区运行时、项目环境与 Hooks、事务部署及 CodexHost 插件核心 | LGPL-3.0-only；[上游仓库](https://github.com/vv-get-ti/claude-vps-bridge) |
| CodexHost（0.20.0 及以上，安装时取最新正式版） | Host 插件接口、受管理的远端 Claude 适配器 | LGPL-3.0-only；[源码](https://github.com/BytePioneer-AI/codex-host) |
| picomatch 4.0.3 | 路径匹配 | MIT |
| yaml 2.8.1 | 本机规则与能力元数据 | ISC |
| @playwright/mcp 0.0.80（可选） | 本机浏览器 MCP | Apache-2.0 |
| Playwright / playwright-core（可选传递依赖） | 浏览器执行 | Apache-2.0 |
| @agentclientprotocol/claude-agent-acp 0.113.0 | 标准 ACP 包装器 `acp/` 调用的官方 ACP 适配器 | Apache-2.0；[npm](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) |
| @agentclientprotocol/sdk 2.12.0 | ACP 协议 SDK（上一项的依赖） | Apache-2.0 |
| @anthropic-ai/claude-agent-sdk 0.3.331 及其按平台的原生子包 | 上一项的依赖 | 包内声明 `SEE LICENSE IN README.md` / `LICENSE.md`，条款由 Anthropic 提供，不是开源许可证；本仓库不分发，由使用者安装时从 npm 下载 |
| 其余传递依赖（MCP SDK、express、zod 等约 100 个包） | 上述包的依赖 | 锁文件中声明为 MIT、ISC、BSD-2-Clause、BSD-3-Clause、Apache-2.0 或 Unlicense |

第三方 npm 包由使用者安装时按锁文件下载，不以 `node_modules` 形式提交。精确版本、完整性哈希与包来源见 `plugin/runtime/package-lock.json`，ACP 包装器的见 `acp/package-lock.json`。依赖自身的许可文本应随相应软件包保留。

CodexHost 适配器通过独立依赖目录安装；本仓库不复制其完整构建产物。插件与 T3 Code 接入均仅使用公开协议/配置接口，不包含任何宿主二进制补丁。

官方 Claude Code、T3 Code 和 CodexHost 由各自权利方提供，本仓库不分发它们的二进制、账号或凭据。它们自身的条款不因本仓库许可证而改变。

## 原创矢量图形

`plugin/icon.svg` 与 `docs/assets/` 下的 `banner`、`architecture`、`features` 三组 SVG（各含浅色和深色版）均为本仓库原创绘制的几何矢量图形，随本仓库采用 LGPL-3.0-only 许可。
