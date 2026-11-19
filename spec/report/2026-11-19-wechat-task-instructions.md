# 老板微信向已有任务下达指令

| 字段 | 内容 |
| --- | --- |
| 状态 | 已部署，微信手机扫码收发待验 |
| 日期 | 2026-11-19 |
| 负责人 | Codex |
| 关联目标 | 从固定老板私聊向可见的本人原任务发送后续指令 |
| 影响范围 | 微信命令、目标输入队列、桌面交付、测试与运维 |
| 架构规格 | [项目约束](../architecture/02-project-constraints.md)、[安全边界](../architecture/04-security-and-trust-boundaries.md)、[执行队列](../architecture/05-execution-concurrency-and-lifecycle.md)、[发布契约](../architecture/07-e2e-release-contracts.md)、[本地隐私项目](../architecture/10-local-private-projects.md) |

## 背景与证据

此前固定入口的直接命令只查询资料。Portal 已有按原任务策略执行的输入队列；桌面对话由不同运行时管理。线上存在关闭沙箱并可读取宿主的桌面对话。

## 目标与非目标

按微信列表里的对话 ID 提交自然语言指令。老板自有普通及隐私 Portal 项目复用原运行时。桌面目标须重复验证创建者、账号、任务及本机目录的归属。员工项目、后台受调度任务、绕过任务生命周期或直接执行微信提供的命令行不在范围。

## 约束与风险

沿用 PRD-001/002/003、FS-001/006、DAT-004/006 和 E2E-018。区别受理、排队、执行和失败。事件重投或应答丢失不得重复产生任务。正文只交给目标任务的业务输入；不能写入审计、收件项目历史或普通模型。

## 实施计划

1. 将显式目标命令接入既有固定身份与授权检查。
2. 原子提交 Portal 输入和微信回执，复用原任务队列、模型路由和审批。
3. 检查桌面对话支持的交付接口及隔离条件，按老板选择实现交付方式。
4. 验证越权拒绝、重投、私有运行时和目标选择，执行 macOS 门控并在空闲时更新线上服务。

## 实际改动与影响

老板希望微信与老板 Portal 连通。增加 /portal 和 /tell。Portal 原队列直接受理，桌面权限可超出 Portal 项目边界，因此手机上的老板 Portal 逐条显示目标和待发内容，确认后投递，无需接触这台 Mac。项目列表和原对话的归属核验沿用前次部署。

server、wechat-owner-library、wechat-task-instructions、desktop-task-queue、桌面只读 helper 与导航/核对页完成接入。直接声明现有锁文件中的 ws 版本。SQLite 增加可重复创建的 wechat_desktop_instructions，绑定事件、老板和来源绑定。桌面提交前用 CAS 保留不确定状态并清空待审正文。重复确认和重启均不会自动再次投递。回滚保留增量表、原任务队列与微信回执。

## 验证

| 命令或场景 | 结果 |
| --- | --- |
| `node --test test/wechat-owner-library.test.mjs` | 通过。覆盖原队列、员工与其他桌面身份拒绝、目标复核、并发确认和回执丢失不重投。Unix socket 夹具目录使用短的系统临时路径，符合 macOS 的路径长度限制。 |
| 主工作树 `npm run gate` | 204 项单元/集成与 19 项 E2E 通过，零失败、零跳过。 |
| 发布工作树 `npm run gate` | 255 项单元/集成与 24 项 E2E 通过，零失败、零跳过。两次门控使用[前次微信部署](2026-11-19-wechat-owner-visibility.md)记录的本机 Node、Python 和 Git 路径。 |
| 发布目录 `node /private/tmp/wechat-task-mobile-1119.mjs` | 独立配置、临时库和合成桌面服务。390px 宽度的真实 Chrome 验证签名收件、重投、登录返回核对页、只读预览、拒绝缺少 CSRF 的 POST、确认与刷新。原任务只收到一条文本。 |
| 发布目录 `node /private/tmp/wechat-native-inbox-1119.mjs` | 独立临时 home、禁止外联网、真实已安装桌面 CLI。原生 thread/queue/add 确认合成消息 ID 和正文；空闲测试任务出现 turn/started 通知且待发队列清空。 |
| 发布目录 `bash bin/stop-local.sh && bash bin/start-local.sh` | 通过。停机前普通运行、待发输入、微信在途记录均为零，重启后 Portal 就绪。 |
| `node --env-file="$rt/.env" /private/tmp/wechat-instruction-production-1119.mjs` | 正式签名接口为实际人物图谱对话生成待确认链接，匿名详情请求返回 401，重复签名事件复用同一回执。/portal 返回正式老板地址。未确认生产测试草稿，未向真实桌面任务发送消息。 |
| 两个工作树的 `git diff --check` 及相对 Markdown 链接检查 | 通过。 |
| `curl -fsS http://127.0.0.1:18767/status` | waiting_for_wechat_scan，实际手机收发尚待扫码。 |

## 清理与回滚

临时服务、浏览器、原生测试 daemon 和账户数据均在验收后清理。生产验证只按本次唯一事件 ID 清除合成回执和待审草稿。回滚可恢复此前的固定入口代码并保留新增表；不能覆盖上线后生成的业务输入、任务或回执。

## 结论与遗留事项

正式 Portal 可接收已绑定老板私聊的目标任务指令，支持原 Portal 对话入队与手机确认后进入原桌面队列。访问范围继承原老板身份；后台专用任务等生命周期限制沿用 Portal。手机扫码和真实收发待验。真实人物图谱对话仅验证目标路由和待确认链接，执行验证使用独立任务。
