# 兼容说明

默认按 [安装指南](SETUP.md) 配置 T3 Code 独立模式。已有 CodexHost 部署或需要 ACP 客户端时，使用对应入口。

## CodexHost 插件

CodexHost 从插件列表打开 **Claude VPS Bridge**。最低适配器版本 0.20.0，实际兼容以安装探针和会话验证为准。两端基础环境和 SSH 准备见 [安装指南](SETUP.md#两端依赖)，VPS 还需要 npm。

```powershell
python .\installer\configure.py --ssh-host my-linux-host --host-root 'D:\Apps\CodexHost'
```

| 安装组合 | 命令 |
| --- | --- |
| 仅 CodexHost | `pwsh -NoProfile -File .\install.ps1` |
| CodexHost + T3 | `pwsh -NoProfile -File .\install.ps1 -WithT3` |
| CodexHost + T3 + ACP | `pwsh -NoProfile -File .\install.ps1 -WithT3 -WithAcp` |

配置中有 `hostRoot` 时部署包含 CodexHost 适配器。遇到自定义 `CODEXHOST_DATA_DIR` 或 `CODEXHOST_PLUGIN_DIRECTORY` 会停止。

安装后：结束当前任务 → `codexhost stop` → 重新打开宿主 → 选择 **Claude VPS Bridge** → 验证。诊断和停用见 [运维指南](OPERATIONS.md)。

## ACP v1

通过 stdio 启动 `claude-vps-acp.exe`，可单独部署或用 `-T3Only -WithAcp` 与 T3 共享 Shim。客户端需要支持 `session/resume` 并保留原会话 ID 与工作目录，才能在重启后继续旧对话。接口范围与验证步骤见 [ACP v1 指南](ACP.md#续接旧会话)。
