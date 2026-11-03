# 2026-11-04 Fast、项目归档与账号密码

| 字段 | 内容 |
| --- | --- |
| 状态 | 已部署并通过公网验证 |
| 日期 | 2026-11-04 |
| 负责人 | Codex |
| 关联目标 | 双角色 Fast、项目归档、老板自有项目释放空间、员工自助改密 |
| 影响范围 | 数据库、API、UI、skill、测试、文档 |
| 架构规格 | [约束](../architecture/02-project-constraints.md)、[领域](../architecture/03-domain-model-and-invariants.md)、[安全](../architecture/04-security-and-trust-boundaries.md)、[执行](../architecture/05-execution-concurrency-and-lifecycle.md) |

## 背景与证据
当前仓库只有老板模型选择和老板重置密码；项目无归档字段。运行服务来自另一工作树，本次先完成当前仓库实现与隔离测试。

## 目标与非目标
### 目标
- 所有人当前私有对话可切换 Luna high + fast，提供 API 和托管 skill。
- 有效项目访问者可归档/恢复项目，老板元数据展示状态。
- 老板可永久删除自己的空闲、无共享项目释放文件空间。
- 创建员工使用用户指定的初始口令；管理员重置和自助改密均双输入明文确认。
### 非目标
- 不变更线上工作树或真实账号密码，不修改协议 pin、共享 ACL 或子代理策略。

## 约束与风险
- PRD-001/002、DAT-004/006、DEV-003：保持 ACL、改密撤销会话和排空、日志脱敏、完整门禁。
- 用户明确要求释放空间：为老板 owner 增加显式永久删除选项，普通删除仍走 trash。保留既有 busy/shared/retained-tree 检查。
- Fast 不保证上游额度和延迟，不静默降级；只影响后续 turn。

## 实施计划
1. 兼容增列，复用 chat/project API 与运行策略；新增自助改密。
2. 工作台和老板界面按钮/表单，托管 Fast skill 与工具。
3. 回归测试、完整 gate、Markdown 链接检查，更新架构与结论。

## 实际改动
- 数据库幂等新增 chats.fast_mode 与 projects.archived；未修改既有历史或密码。
- 服务端新增归档、自助密码接口；chat PATCH 支持 Fast；管理员自定义密码必须双值确认，新建可省略密码使用产品约定值。
- 运行服务固定 Fast 的模型/effort/serviceTier，并提供受 active access 保护的 portal_fast_mode；注册目录中的新 skill 可供双方调用。
- 工作台新增 Fast、改密、归档与归档筛选；老板项目卡展示归档状态、自有项目永久删除弹窗；密码表单双明文输入。
- 永久删除复用原共享/运行/retained-tree 屏障，仅清除本次 trash 目录；管理员元数据权限不扩大。
- 既有管理员改密 E2E 增加确认字段，保留排空与撤销会话全部断言。新增 HTTP ACL/自助运行排空、skill 工具、RPC 参数及旧库幂等迁移验证。
- 第一轮发现原生 confirm 违背既有前端契约，已改用现有站内弹窗；前端测试 mock 增加 DOM 属性方法及 Fast 禁用选择器断言。
- 操作与接入说明见 [操作文档](../../docs/fast-archive-password.md)。

## 数据、接口与安全影响
- 兼容 ADD COLUMN，旧值默认 false；不更改协议 pin。管理员自定义密码 API 现在要求 passwordConfirmation，连接器调用需同步此字段。
- POST /api/me/password、POST /api/projects/:id/archive、PATCH chat fastMode；普通 project DELETE 保持兼容，永久删除是明确 opt-in。
- 密码只存 scrypt，确认值不落日志；用户明确指定的产品初始口令不代表生产凭据导出。
- 回滚：停服并备份 SQLite 与目录后回退代码，附加字段可保留；偏好/归档可正常恢复。永久删除不可通过回退代码恢复，需删除前备份。
- 清理：所有测试使用临时目录及 fake app-server，测试服务由 after hook 结束；未修改线上账号、项目或运行进程。原门禁保留的临时 fixture 及日志位于系统临时目录，未进入仓库。

## 验证
| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `git diff --check` | 通过 | 无空白错误 |
| `npm run gate > /tmp/portal-gate-1104.log 2>&1` | 通过，exit 0 | macOS：79 单元/集成 + 16 E2E；0 失败、0 跳过，含真实 Seatbelt 与 loopback |
| `python3 /tmp/portal-check-links.py` | 通过 | 本次变更 Markdown 的 22 个相对链接均存在 |
| `python3 /Users/zlh1992_home/.codex/skills/.system/skill-creator/scripts/quick_validate.py portal-skills/fast-mode` | 通过 | Skill is valid |

## 结论
三项功能在当前仓库实现并通过完整门禁，可进入部署流程。测试覆盖实际发往 app-server 的 Fast RPC 参数、技能工具 ACL、旧库迁移、双角色项目状态与删除权限、文件清除、自助改密运行排空和多会话失效。没有宣称已部署或已验证真实上游加速。

## 遗留事项
- 正在运行的服务来自另一个工作树，本次没有部署或重启；将本变更合入实际运行版本后再执行该版本门禁和受控上线验证。
- 真实上游 gpt-6-luna / fast 的账号可用性及速度未做推理验证；已验证 Portal RPC 参数传递，没有降级或可用性保证。
- 微信业务连接器未在当前仓库中接入，已提供认证 HTTP API 和托管 skill/tool；不授予跨用户调用权限。
- 没有新增生产数据或保存生产凭据；测试临时文件遵循原门禁的系统临时目录策略。

## 公网部署续作计划
用户已授权部署 bench1/bench2。以当前生产工作树为基线，保留新版隐私项目、微信、工作图、会话及模型限制。三方合入前一轮补丁，解决兼容冲突，运行此基线完整 gate。一致性备份数据库，确认空闲后用原受管脚本重启，隔离测试会话验证两域入口及新增功能，记录回滚和结论。

### 生产基线适配
- 保留 GPT-6.1 Sol 和既有 GPT-5.6 模型，按本次明确请求只新增 GPT-6 Luna；Astra 等禁用契约保持。目录测试扩展为新增 Luna 的正向验证，原其他负向断言保留。
- 保留隐私项目、工作图历史保护、双角色选模、标签会话和记忆失效逻辑；隐私/后台管理 chat 拒绝 Fast，改密同时失效微信代次并排空工作图成员。
- 生产依赖原先省略 dev，补装锁定开发依赖以运行已有 DOM 门禁，不修改依赖版本。
- API 自定义密码确认要求同步到现有 E2E 的合成建号请求，保留原断言。

### 部署前门禁
`npm run gate > /tmp/portal-production-gate.log 2>&1` exit 0：252 单元/集成、24 E2E，0 失败、0 跳过，含真实 Chrome、Seatbelt、微信和工作图回归。`git diff --cached --check` 通过；相对 Markdown 链接 93 个通过；skill validator 通过。

## 公网部署结果（2026-11-04）
- 实际生产目录：`/Users/zlh1992_home/.codex/worktrees/portal-browser-runtime/codex-harness-remote`；部署代码提交 `c5bec0a`，此前 `b152171`。原开发目录是旧基线，不能覆盖生产树。
- 用户本轮明确授权上线；保留原 launchd 服务和 Cloudflare tunnel，通过 `./bin/stop-local.sh && ./bin/start-local.sh` 重启 Portal。重启前没有非终态 run、待发输入或工作图 job；既有待处理业务状态保持。
- [老板入口](https://workbench1.winy.cc/boss/login) 和 [员工入口](https://workbench2.winy.cc/employee) 均完成验收；两个域名 health 均 ready，原生记忆关闭，Portal 记忆索引 ready。未改 DNS、隧道配置或微信绑定。
- `node /tmp/portal-live-release.mjs` exit 0；通过两个域名的角色 API 和独立真实 Chrome 页面验证。老板使用临时随机会话，未更改原密码；一次性员工由 API 创建并用约定初始口令实际网页登录。
- 两角色 Fast 设置、项目归档及老板状态展示验证通过；公网浏览器显示已开启，改密双输入均为 text；实际两次模型请求均 completed，用量账本 model=gpt-6-luna、effort=high，代码与门禁确认 serviceTier=fast。没有宣称速度提升幅度。
- 一次性员工自助改密成功、旧会话 401、新密码重新登录成功。老板临时项目通过永久删除接口清理，员工临时项目通过普通删除后定向清理本次 trash；临时账号停用，所有验证会话撤销。用量与脱敏审计保留。
- 收尾 quick_check=ok、foreign_key_check=0、非终态 run=0；原 users/projects/chats/submissions ID 无缺失，原密码哈希变更数 0；临时项目与活动临时账号均为 0。既有微信 uncertain 发件保持 12 条，未重发。
- Python urllib 经宿主代理的初始域名探测失败，独立 curl/Chrome 经公网隧道成功；未因此更改健康隧道。

### 备份与回滚
一致性 SQLite、旧代码归档及私有环境备份位于生产 DATA_DIR/backups 的本次 release-fast 目录（目录 0700，DB/配置 0600），不进入仓库。需要回滚时先排空并停服，回退本次代码到此前已验证基线并使用原环境启动；保留上线后的数据库和业务文件，附加字段可保留，不能拿备份库覆盖上线新业务。此次未永久删除任何既有用户项目。

### 最终结论
三项功能已部署到原公网服务，老板 workbench1、员工 workbench2 的真实验收完成。原首轮尚未部署、未验证上游的限制已由本节覆盖。微信端提供 skill/tool 与认证 API，本次没有额外发送微信消息或新增微信菜单。
