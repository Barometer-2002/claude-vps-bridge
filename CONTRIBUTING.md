# 贡献指南

在源码仓库中开发和验证。提交时逐文件挑选源码、公开示例和文档。个人安装目录里的配置和运行数据只供本地验证。

## 修改从哪里开始

- **客户端接入**（`shim/`、`t3-native/`、`acp/`）：改动宿主协议或权限时，核对其他入口依赖的公共行为。
- **共享核心**（`plugin/`、`installer/`、`remote/`）：更新上游来源的实现时，检查插件 ID、目录和旧数据兼容性。见 [Fork 说明](docs/FORK_CHANGES.md)。
- **扩展工具**：按 [扩展接口](docs/EXTENDING.md) 说明执行位置、权限和失败语义。

## 验证

在隔离项目中验证实际变动路径。优先运行对应的定向测试，再运行相关隔离测试。记录测试所用宿主、模式和版本。

```powershell
python .\scripts\check.py
git diff --check
```

暂存后检查要公开的内容：

```powershell
python .\scripts\check-public.py --staged
git diff --cached --check
git diff --cached
```

CI 在 Windows 和 Linux 跑源码与公开内容检查，覆盖 Shim 与 ACP 离线自检，Windows 上还编译启动器并试跑。

## 公开材料

发布前审查私有路径、账号、授权、聊天、任务日志和备份。测试脚本留在本地开发目录。截图由检查器绑定固定路径和内容哈希，新增截图需单独检查。提交使用可公开的作者身份。

将本地验证脚本放在 `tests/` 或 `_checks/`，将临时渲染和导出放在 `output/`。文档正式引用的图片放在 `docs/assets/`。清理开发产物时，保留安装配置、运行状态和 `transactions/` 中用于回滚的记录。部署数据的清理方法见 [运维与排障](docs/OPERATIONS.md#日志清理)。
