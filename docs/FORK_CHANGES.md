# Fork 说明

本项目从 [`vv-get-ti/claude-vps-bridge`](https://github.com/vv-get-ti/claude-vps-bridge) 的 `0.14.1`（`0acd8a0`）分出。上游为 CodexHost 提供 VPS Claude Code 接入。本 fork 用同一套 Windows 工作区和 SSH 基础设施接入 T3 Code 和 ACP 客户端，并继续维护 CodexHost 入口。

## 代码来源

| 代码 | 来源 |
| --- | --- |
| `plugin/`、`remote/remote-server.mjs` | 继承上游 CodexHost Harness 入口和桥接协议 3。在共享运行时增加独立部署与权限改动。 |
| `shim/`、`t3-native/` | 本 fork 新增。共享 Claude CLI Shim 和 T3 Provider 管理，支持本机 MCP、附件映射和工具卡片。 |
| `acp/` | 本 fork 新增。ACP v1 包装器，通过共享 Shim 接入 VPS。 |
| `remote/claude-stream-relay.mjs` | 本 fork 新增。Claude CLI 中继和初始化提示合并。 |
| `remote/` 共享入口 | 在上游远端守卫和工具传输上增加本机 MCP、任务工具和媒体处理。 |
| `install.ps1`、`installer/` | 在上游事务部署上增加独立和共存模式、共享 Shim 管理和接入层卸载。 |

## 从上游迁移

沿用插件 ID `claude-vps`、连接配置文件名和默认 VPS 桥接目录。迁移前核对 SSH 用户、远端桥接根目录和工作区映射位置。按 [兼容说明](COMPATIBILITY.md#codexhost-插件) 选择客户端组合，保留两端事务以便恢复。

## 同步与归属

同步上游前，先定位共同模块及本 fork 的修改，再验证涉及的客户端和部署模式。上游版权和第三方许可随源码保留。见 [第三方声明](../THIRD_PARTY_NOTICES.md) 和 [LGPL-3.0-only](../LICENSE)。

发行历史见 [更新记录](../CHANGELOG.md)，插件版本见 [manifest.json](../plugin/manifest.json)，协议和适配器最低版本见 [dependency-policy.json](../installer/dependency-policy.json)。
