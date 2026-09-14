# 2026-09-13 工具明细与异步摘要

| 字段 | 内容 |
| --- | --- |
| 状态 | 2026-09-14 已部署；真实Luna摘要未验通 |
| 日期 | 2026-09-13 |
| 更新 | 2026-09-14 |
| 负责人 | Codex |
| 关联目标 | 工具输入输出可见；普通项目 Luna-low 异步摘要；隐私项目不送云摘要 |
| 影响范围 | 后端、SQLite、API、前端、测试、规格 |
| 架构规格 | [事件恢复](../architecture/06-persistence-events-and-recovery.md)、[安全](../architecture/04-security-and-trust-boundaries.md)、[本地引擎](../architecture/10-local-private-projects.md) |

## 背景与证据

之前只修复真实工具名；journal 省略参数/结果，前端只绘制 name/done。完成勾号未区分失败。

## 目标与非目标

- 目标：独立受 chat ACL 的明细快照、命令/参数/结果/耗时/失败状态、刷新恢复；异步摘要失败不影响执行。
- 非目标：不回填历史缺失正文；不改模型执行权限；不自动部署、重启或提交；不将隐私项目工具数据发送云端。

## 约束与风险

DAT-006/009：正文不进入 journal、审计或日志；明细是独立受 ACL 的业务内容。秘密脱敏不是完整 DLP；显示工具返回的有限结果不等同无限终端录制。摘要仅普通项目、有限上下文，不附带项目历史或额外文件；隐私项目硬禁止。后台队列限量、超时、不重试，避免占用执行生命周期。

## 实施计划

1. 创建独立工具明细表与 ACL 查询，统一两个引擎的开始/完成捕获。
2. 接入隔离、无工具 Luna-low 小批量后台摘要，异常降级原始明细。
3. 可展开可滚动明细、状态/耗时、异步刷新及旧页面兼容。
4. 添加隔离/异步/失败/恢复/前端测试，完整 macOS gate、diff 与链接检查，同步架构。

## 实际改动

- `tool-details.mjs`：幂等明细表、secret/记忆正文省略、输入输出快照、退出码/信号/超时失败语义、重启未完成状态；独立 single-worker、64项上限、同run最多6条的异步摘要队列。
- `codex-service` 在脱敏 journal 之前独立捕获工具与原生操作，明细错误不改变执行；本地 DSH 补入实际参数/结果。正文继续不进入 journal/audit。
- 复用 `CodexSearchService` 的临时目录/凭据副本/Seatbelt/ephemeral 生命周期；摘要模式强制关闭搜索、记忆、代理和工具，固定 Luna-low。每条只取输入1200/输出1800字符，不附带会话历史。25秒超时、不重试；未生成则保留明细。
- `GET /api/chats/:id/tool-calls` 支持最新run/指定run与revision分页；原 chat owner/current access校验，跨chat/user拒绝。
- 前端独立增量面板：工具名、运行/成功/失败/中断、耗时、exit，展开输入输出、独立滚动、摘要就绪后补绘；已展开状态保留，无变化不重绘。切换对话/身份时清理，丢弃迟到响应；最新run变更重置cursor。消息结束后仍可读取晚到摘要。
- 隐私项目在捕获和后台出队双重禁止云端摘要。记忆工具不复制正文，避免删除/失效后的旁路；界面明确省略原因。工具返回自身限制之外，单个输入/输出4Mi字符保护，超长显式标注，非无限终端录像。

## 数据、接口与安全影响

新增业务明细表（级联删除）；只经原 chat owner + 当前 access 读取，不随项目分享复制。摘要文本同样是受 ACL 内容。SQLite备份现在包含明细，增加存储量；当前没有时间保留策略，删除chat/run级联清理，旧备份不追溯擦除。回滚可撤回本次功能但保留新增表，不降级隐私 ACL；不删除用户数据。没有修改实际.env、生产库、服务或公网配置，也没有commit/push。已有其他工作树修改均保留。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| 最终 `npm run gate` | exit 0；157项单元/集成 + 19项HTTP E2E，0失败/跳过 | macOS真实Seatbelt与回环；包括signal失败状态最终代码 |
| `git diff --check` | 通过 | 最终文档与代码无空白错误 |
| `node --test test/tool-details.test.mjs test/local-search.test.mjs test/frontend.test.mjs` | 24/24通过 | 合成夹具，包含隔离摘要协议及前端行为 |
| 第一次 `npm run gate` | 157 + 19通过，0失败/跳过 | 随后补充signal终止状态与面板高度保护，最终门控另记 |
| 合成浏览器验收 | 通过 | 使用真实styles/portal-ui及工具组件，验证展开失败项、输入输出滚动、摘要标签、输入框保持可用；不代表完整生产登录/模型验收 |
| 真实 pinned CLI + 合成工具数据摘要 | 未通过 | 仅发送echo synthetic-ok的合成输入/结果；返回LOCAL_SEARCH_UNAVAILABLE，未收到可用摘要，不声称真实Luna可用 |
| 相对Markdown链接扫描 | 49文件/220链接，0缺失 | README、docs、spec；外链与锚点不作文件存在检查 |

复现链接检查：`node --input-type=module` 递归收集 README.md、docs、spec 下 Markdown，用 `/\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g` 提取目标，忽略协议/绝对路径/纯锚点，移除fragment、decodeURIComponent后按文档目录解析并用fs.existsSync校验。

隔离测试的临时数据库/工作区由夹具清理；合成浏览器页已关闭、临时回环HTTP服务器已停止。真实摘要进程复用既有本机登录的临时副本，未读取或打印凭据正文，finally关闭子进程并清理精确临时目录，未改变原登录。初次合成HTML缺少charset导致静态中文乱码，补齐UTF-8后重新验收；产品HTML原本已声明charset，不是产品回归。

OpenAI Docs 用于核对独立 ephemeral thread 与 turn 事件协议：[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)。

## 结论

代码与自动发布门控完成，工具明细及不阻塞执行的异步摘要/降级契约已由合成上游和HTTP测试验证；OpenAI Docs指导了固定模型、ephemeral与隔离协议复用。真实Luna摘要冒烟未验通，不把模拟通过当作云端上线成功。生产服务未重启，当前公网旧版本不会仅靠浏览器刷新自动获得本次后端功能；实际部署需另行确认安全重启窗口。未commit/push。

## 遗留事项

## 2026-09-14 联合部署

用户授权重启graph，并上线隔壁任务的手机聊天布局修复。已核对其最终记录与同工作树的mobile-chat报告；上一轮157+19门控覆盖两项改动。计划：核对实际生产数据库（不同于graph测试默认.data）、空闲检查、一致性备份、仅重启Portal、验证本地与双固定公网入口及新版本资源。保持隧道/DNS/.env不变，隐私引擎仍按既有默认关闭。部署失败优先保留数据库和备份，不用旧代码强行降级隐私schema。

部署前实际生产库quick_check=ok；active run、queued/steering input、pending approval均为0。

实际执行：Node `node:sqlite` 的 `backup()` 对实际生产库做一致性备份，保存于生产.data/backups/pre-tool-mobile-t5J9yU/harness.sqlite（目录0700、文件0600）；运行 `./bin/stop-local.sh`、`./bin/start-local.sh`，均成功。既有隧道/DNS/.env未改。此轮仅部署与报告更新，复用同工作树上轮最终157+19完整gate证据，不声称重新运行了完整测试。

上线验收：本地双角色入口及 `https://workbench1.winy.cc/boss/login`、`https://workbench2.winy.cc/employee` 均HTTP200，TLS按默认受信任验证。三个入口资源版本均为680130fadd97afc330b6；双公网的同版本tool-details.js、portal-ui.css均200且字节与本地文件相同。health为codex=true/ready、memory index ready、nativeCodexMemory=false；本地DeepSeek保持disabled。生产quick_check=ok、foreign_key_check无错误，tool_details迁移已存在、active run=0；未登录明细API返回401。没有创建账号/任务或读取业务正文，没有重置登录凭据，没有commit/push。此次不包含真实账号登录聊天或手机软键盘验收；真实Luna摘要仍保留上轮未验通的限制。

真实Luna上游可用性仍待解决；不可用时明细正常、摘要显示未生成。生产服务需要在确认现有运行可安全停止后另行重启并验收。历史未记录的明细不回填，面板默认只展示最新一轮。
