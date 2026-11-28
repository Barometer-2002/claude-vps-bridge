# 运维与排障

先判断故障在哪一层，再决定重载客户端、修复接入还是恢复事务。诊断命令从源码根目录执行，自定义目录时沿用原来的参数或环境变量。

## 检查状态

```powershell
node .\plugin\diagnose.mjs --json          # 核心桥接，默认含远端检查
node .\plugin\diagnose.mjs --local --json  # 只检查本机
node .\t3-native\manage-native.mjs status  # T3 Provider
node .\shim\manage-shim.mjs status         # 共享 Shim
node .\acp\manage-acp.mjs status           # ACP 包装器
```

- `diagnose.mjs` 覆盖依赖、远端协议、任务和锁状态。退出码 `0` 无必需项失败，`1` 有必需项失败。
- T3/Shim 状态区分离线自检、版本缓存和远端探针。ACP 状态含包装器自检和上游入口检查。管理器支持 `--offline`。
- `plugin-activation` 对比已安装与宿主加载的版本：`current` 一致，`stale` 需重载，`not-loaded` 需检查插件实例。
- **状态检查不提交模型请求**。桌面渲染、权限提示和真实账号需在客户端单独验证。

## SSH 线路

`ssh-route` 显示已观测会话线路，`diagnostic-route` 反映诊断新建连接的结果。VPS 看到外部对端时记为 `direct`，看到本机代理时记为 `local-proxy`。

失败时先看阶段和原因（主机密钥不匹配、认证失败、握手超时、找不到代理）。隔离 SSH 问题时按 [安装指南](SETUP.md#配置-ssh) 用相同别名检查。

## 升级

1. 结束正在运行的任务，保留源码目录的 `transactions`。读 [更新记录](../CHANGELOG.md) 确认改动。
2. 重新运行原安装命令。安装器验证依赖版本和哈希，桥接事务完成后才注册客户端。
3. 核心已验证而客户端注册失败时，用相应管理器的 `install` 修复。
4. 重开客户端，用原测试项目核对模型回复、文件读取和续接。

## 事务恢复

桥接部署记录备份、并发检查和哈希。跨机器中断可能留下待恢复事务。查看 `installation-workspace.json` 的 `transaction` 字段：

```powershell
python .\installer\deploy-transaction.py --rollback .\transactions\TRANSACTION_ID
```

回滚核对备份与当前文件，遇到冲突停止。它只处理该事务记录的文件。T3/ACP 注册需分别核对。

## 卸载

先结束使用相关组件的会话。

| 目标 | 命令 | 影响 |
| --- | --- | --- |
| T3 接入 | `pwsh -NoProfile -File .\uninstall.ps1` | 删除 Provider 注册。保留 `claude-home`、Shim 和核心。 |
| ACP 接入 | `pwsh -NoProfile -File .\install.ps1 -AcpOnly -Uninstall` | 移除 ACP 文件。保留 Shim 和核心。 |
| CodexHost | `pwsh -NoProfile -File .\install.ps1 -Disable` | 从启用列表移除插件，重载宿主生效。 |

保留 VPS 的 `~/.claude`、工作区映射和两端事务，才能继续使用相应历史和恢复记录。

## 日志清理

从已安装的插件目录运行 `maintenance.mjs`：

```powershell
node .\maintenance.mjs --dry-run --age-days 30
node .\maintenance.mjs --apply --age-days 30 --max-bytes 268435456
```

按完成时间和状态挑选旧任务日志和搜索快照。活动任务、媒体缓存和事务数据继续保留。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 远端 Claude 或 Node 路径失效 | 在 VPS 核对可执行文件，更新 [配置](CONFIGURATION.md) 并重新部署。 |
| 账号要求重新授权 | 在 VPS 终端执行 `claude auth login`，然后重新打开会话。 |
| 任务结果未知或锁仍在 | 用原 `requestId` 查询状态，确认终态前不要重新执行。 |
| 能聊天但某个工具不可用 | 检查工具启用状态、权限和客户端是否刷新了目录。 |
| 执行器显示 `stopped` / `unavailable` | 任务是否完成以自身终态为准。 |

报告问题时附上脱敏版本、安装模式、失败阶段和最小复现步骤。
