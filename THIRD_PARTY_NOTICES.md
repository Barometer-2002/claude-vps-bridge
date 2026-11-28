# 上游与第三方许可

T3 Claude VPS 采用 [LGPL-3.0-only](LICENSE)，随附该许可引用的 [GPL v3 全文](LICENSE-GPL-3.0)。上游来源为 [claude-vps-bridge](https://github.com/vv-get-ti/claude-vps-bridge) 的 `0.14.1`（`0acd8a0`）。本项目对上游的主要改动见 [Fork 说明](docs/FORK_CHANGES.md)。

| 组件 | 用途 | 源码或包内许可 |
| --- | --- | --- |
| claude-vps-bridge | SSH 桥接、Windows 工作区运行时、事务部署、CodexHost 插件 | LGPL-3.0-only |
| [CodexHost](https://github.com/BytePioneer-AI/codex-host) | CodexHost 宿主和远端适配器依赖 | LGPL-3.0-only，按 [依赖策略](installer/dependency-policy.json) 安装 CLI |
| picomatch 4.0.3 | 路径匹配 | MIT |
| yaml 2.8.1 | 解析规则与能力元数据 | ISC |
| @playwright/mcp 0.0.80、Playwright 与 playwright-core | 可选浏览器 MCP 与浏览器执行库 | Apache-2.0 |
| @agentclientprotocol/claude-agent-acp 0.113.0、@agentclientprotocol/sdk 2.12.0 | ACP 包装器调用的适配器和协议 SDK | Apache-2.0 |
| @anthropic-ai/claude-agent-sdk 0.3.331 及平台子包 | ACP 适配器依赖 | 主包标记 `SEE LICENSE IN README.md`，平台子包见各自许可文件 |

精确版本、来源、完整性摘要及传递依赖的声明见 [运行时锁文件](plugin/runtime/package-lock.json) 和 [ACP 锁文件](acp/package-lock.json)。安装时下载 npm 包，需保留各包随附的许可文本。Claude Code、T3 Code 和 CodexHost 由各自权利方提供，仓库源码包内只有桥接实现、构建脚本及相关资料。

`plugin/icon.svg` 和 `docs/assets/t3-architecture.svg` 采用本仓库许可。
