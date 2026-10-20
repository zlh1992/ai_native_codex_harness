# 2026-10-20 项目对话归档

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成 |
| 日期 | 2026-10-20 |
| 负责人 | Codex |
| 关联目标 | 老板与员工均可归档项目对话 |
| 影响范围 | SQLite、HTTP、工作台、测试、发布 |
| 架构规格 | [领域](../architecture/03-domain-model-and-invariants.md)、[持久化](../architecture/06-persistence-events-and-recovery.md)、[发布](../architecture/07-e2e-release-contracts.md) |

## 背景与证据

上一版 73f02c5 已包含浏览器打开/接管、目录折叠及空名称取消修复。本版核查工作台仅有对话选择，缺少归档入口。归档必须保留历史和提交证据。

## 目标与非目标

### 目标

- 双角色私有项目对话提供归档、已归档列表和恢复入口，刷新后保持。
- 保留全部历史、原生线程和任务关联；沿用原会话、CSRF、Origin 与 access 授权。

### 非目标

- 不删除历史、不调用原生线程删除、不改变共享或后台调度规则。
- 不修改账号网络、模型白名单或隐私配置。

## 约束与风险

遵守 PRD-001/003、DAT-001/002、DEV-003。归档只是列表组织状态，不是停止执行或撤权；内部 listChats 必须继续包含全部对话，避免影响分享、恢复和清理。操作时存在运行或待发输入则拒绝归档，用户可先停止/处理队列。旧版本忽略新增列仍可读取历史。

## 实施计划

1. 幂等添加 nullable archived_at；PATCH archived 布尔字段，返回 archivedAt。
2. 共用工作台添加归档/恢复按钮和已归档筛选；不改变内部列表范围。
3. 回归双角色、越权、历史保留、恢复与刷新；运行完整 gate、diff 和链接检查。
4. 检查服务与数据，备份、部署域名 1/2、隔离验收并清理。

## 实际改动

- 数据库幂等添加 archived_at，既有 PATCH 接受严格布尔 archived；归档拒绝运行及未处理输入。
- 双角色共用对话卡片加入“归档/恢复”，增加“已归档”筛选；选中对话仍可阅读，历史和任务关联保持。
- 扩展真实 Chrome gate：双角色 API、非法参数、运行拒绝、跨账号拒绝、原生身份及消息保留、点击/刷新/恢复。
- 当前服务和隧道在实施前已停止；发布时按原配置重新启动，不推测停止原因。
- 停服备份包含数据库、代码、私有配置及 workspaces/trees/trash；迁移在备份副本重复两次通过，18 用户、29 项目、77 对话、15 提交均保留。

- 正式 Portal 已按原配置启动；当前工作树缺少独立 cloudflared，按现有安装契约从原项目复制本机已有 2026.8.2 二进制到忽略目录 .tools，再启动原 named tunnel。未修改域名、凭据或网络策略。

## 数据、接口与安全影响

- 数据迁移：nullable 列，旧数据默认未归档；无删除或历史回填。
- API/协议：既有 PATCH 增加 archived 布尔字段；列表继续兼容返回全部。
- 权限与秘密：原 chat 所有者及当前 access 校验；不增加管理员旁路。
- 回滚：恢复 73f02c5 代码及配置，保留当前业务数据库和新增列。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `npm run gate` | 通过 | 最终 218 单元/集成 + 22 E2E，0 失败、0 跳过；首轮 Chrome 曾出现连接中断，独立重跑及完整重跑均通过 |
| git diff --check | 通过 | 无空白错误 |
| `python3 .tools/check-vpn-links.py` | 通过 | 64 个相对链接，无断链 |
| `node .tools/run-with-system-proxy.mjs .tools/public-chat-archive-smoke.mjs` | 通过 | 双角色公网 API 与真实 Chrome 点击归档、刷新、恢复；越权拒绝 |
| `python3 .tools/verify-chat-archive-retention.py` | 通过 | 原 18 用户、29 项目、77 对话、15 提交原字段逐行哈希一致；新增 nullable 列不参与旧行哈希 |
| `node .tools/run-with-system-proxy.mjs .tools/workbench-health.mjs` | 通过 | 本地及域名 1/2 HTTP 200，ok/codex/initialized=true、codexState=ready |

补充验证：`node --test --test-name-pattern='real isolated Chrome' test/e2e/browser-gate.test.mjs` 原样单独重跑通过；未放宽超时、跳过断言或修改原门控。`node .tools/check-archive-migration.mjs` 在生产备份副本重复迁移通过，quick_check=ok、外键违规 0，副本已删除。

## 发布、清理与回滚证据

- 备份：`~/Library/Application Support/CodexHarnessRemote/backups/2026-10-20-archive-tvcejz82`；原版本 73f02c5，包含数据库、代码、私有配置及项目文件。
- 临时项目通过原 API 删除至可恢复 trash，测试会话撤销、临时员工停用；未保存密码、Cookie 或生产正文。测试账号保留停用记录，原账号不变。
- 最终 active run/input、pending approval、lease、leased workflow job 均为 0；Portal 浏览器 profile 为 0。数据库 quick_check=ok，外键违规 0。
- 既有 3 名禁网员工、6 名联网员工及老板网络权限均保持；四模型目录及 Qwen disabled 已复核。
- 回滚先排空并停服，恢复原代码和配置后启动；保留当前 SQLite 和项目文件，不覆盖上线后的业务记录。新增列与 73f02c5 兼容，旧 UI 会显示所有对话。

## 结论

已部署至域名 1/2。老板及员工均可归档、查看已归档对话并恢复，历史和提交证据保留。此前浏览器打开/接管、目录折叠和空名称取消在本轮完整门控中继续通过。

## 遗留事项

无本次功能遗留。归档不自动取消任务，也不保证第三方网页放行。
