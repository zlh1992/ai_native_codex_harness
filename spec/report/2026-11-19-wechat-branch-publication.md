# 老板微信任务控制分支提交

| 字段 | 内容 |
| --- | --- |
| 状态 | 本地发布门控通过，远端分支已建立 |
| 日期 | 2026-11-19 |
| 负责人 | Codex |
| 关联目标 | 将当前工作区的产品代码提交到新的远端分支 |
| 影响范围 | Git 分支、运行时、微信入口、测试与随附文档 |
| 架构规格 | [架构索引](../architecture/index.md)、[项目约束](../architecture/02-project-constraints.md)、[发布契约](../architecture/07-e2e-release-contracts.md) |

## 背景与目标

主工作树以 `graph` 的 `060b52b` 为起点。创建 `codex/wechat-owner-task-control`，分别保存运行时与微信功能修改。线上服务另有工作树，分支提交不涉及切换线上版本。

## 非目标与约束

产品说明书的编辑、渲染缓存与本机私有配置保留在本地。分支使用普通推送，遵守 DEV-001、DEV-003、DEV-006。提交范围以暂存树为准。

## 实施计划

1. 从当前提交切出分支，按功能归集代码、测试、操作文档与实施报告。
2. 核验提交范围、相对文档链接、空白差异和 macOS 发布门控。
3. 推送到同名远端分支，核对本地和远端提交 ID。

## 实际改动与影响

运行时部分包括 Codex 缓存目录隔离、启动检查及活动部署入口。微信部分包括老板项目与对话查询、原任务文本入队和桌面任务手机核对页。既有数据库和安全边界变更详见[任务指令报告](2026-11-19-wechat-task-instructions.md)。本次归档不执行生产迁移或重启。

## 验证

| 命令 | 结果 |
| --- | --- |
| `npm run gate` | macOS、回环与 Seatbelt 实测，退出 0。204 项单元/集成及 19 项 E2E 全通过，无跳过。 |
| `git diff --check`、`git diff --cached --check` | 通过。 |
| `python3 /private/tmp/check-wechat-publish-1119.py` | 对分支变更中的 Markdown 相对链接逐一检查暂存树；检查新增产品文件和凭据特征。 |
| `git push --set-upstream origin codex/wechat-owner-task-control` | 创建远端分支并建立本地跟踪。 |
| `git ls-remote --exit-code origin refs/heads/codex/wechat-owner-task-control` | 首个运行时提交核对为 `9c48a23`；微信功能提交推送后用同一命令与本地 HEAD 再作比对。 |

门控使用[任务指令报告](2026-11-19-wechat-task-instructions.md)所列主工作树环境。分支基线、代码和依赖均来自当前主工作树，生产独立工作树的基线另见[部署记录](2026-11-12-team-member-bench34-deployment.md)。

## 清理与回滚

保留文档生成源稿、中间渲染文件、竞品说明的本地修改，以及旧报告中与应用无关的宿主网络调试附录。私有运行数据、认证材料和部署目录不纳入提交。回滚可在新分支 revert 对应提交；原 `graph` 引用仍指向原基线。

## 结论与遗留事项

运行时隔离和老板微信项目查询、任务投递分别提交，可独立追溯。真实手机扫码收发仍按功能报告单独验收。
