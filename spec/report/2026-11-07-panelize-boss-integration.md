# 2026-11-07 老板 Panelize 多模型接入

| 字段 | 内容 |
| --- | --- |
| 状态 | 实施中 |
| 日期 | 2026-11-07 |
| 负责人 | Codex |
| 关联目标 | 提交既有上线成果；老板微信与工作台调用五家文本分析 |
| 影响范围 | 托管 skill、服务端工具、供应商执行与结果存储、测试 |
| 架构规格 | [安全](../architecture/04-security-and-trust-boundaries.md)、[浏览器](../architecture/11-managed-browser.md)、[微信](../architecture/12-weixin-task-dispatch.md) |

## 背景与证据
已读取用户指定聊天 01a1b1e3-bdc7-7e61-8095-7c203de775dd。成果为固定 Panelize 2.0.1 快照、文本任务记录/看板、Codex worker；网页发送依赖交互浏览器，不包含自动答案收集桥。原账号均为空；11 项离线测试不代表真实五家联调。用户明确选用 Kimi/豆包/DeepSeek 网页版，Claude 席位要求本机 MiniMax 驱动。
既有上线代码已推送 origin/codex/browser-execution，远端由 285c8e3 前进至 7d59a5c。当前 Claude settings 的 provider 为 Brioi，用户已明确 MiniMax 配置先留空；不保存凭据正文。

## 目标与非目标
### 目标
- 复用上游发送适配与分屏，当前 Codex root 与三个网页供应商并行回答；按用户最新指令保留 Claude Code/MiniMax 空配置席位。
- 老板普通项目私有对话的托管 skill，经同一后端工具供微信和工作台调用。
- 记录真实供应商、模型、来源、完成/失败/待登录状态；保留原始答案和汇总。
### 非目标
- 不把 MiniMax 回答标成 Anthropic Claude，不把发送回执标成回答完成。
- 不开放员工、隐私项目、任意宿主命令、日常浏览器 profile 或跨用户项目。

## 约束与风险
PRD-001/002/009/010、DAT-004/006、DEV-003。此功能是显式授权的额外多供应商文本通道，不能改变普通 Codex 官方上游限制。网页登录、验证码和不确定发送不得自动重放。会话凭据由私有运行目录承载，不能在项目可读目录配置。

## 实施计划
1. MiniMax 按用户最新指令留空。复用固定快照中的原生文本适配器及许可证，不搬运无关扩展资源。
2. 增加老板 root 工具与托管 skill，绑定当前用户/chat/access；统一状态、取消和隔离存储。
3. 使用 Panelize 原生填入/发送，页面完成状态由当前 Codex root 阅读核验；三网页发送后与当前 Codex 的独立分析并行，Claude Code/MiniMax 明确 not_configured。沿用 Portal 临时浏览器 profile 与接管，避免新增宿主账号权限或后台 worker。
4. 完整 gate、双通道权限回归、真实供应商验收，明确待登录者；更新本报告。

## 实际改动
已新增老板 browser_panelize 工具、共用托管 skill、固定原生适配器（仅清理上游行尾空白并更新完整性摘要）、旧对话版本迁移、架构/操作文档及测试；尚未发布到运行服务。

## 数据、接口与安全影响
幂等新增 chats.panelize_tools_version，browser_panelize 为受控 dynamic tool；保持原用户、项目、会话 ACL 与微信绑定。新功能沿用浏览器开关，只有老板显式请求才调用。回滚代码并保留结果记录。

## 验证
| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| git push origin HEAD:codex/browser-execution（使用本机代理） | 通过 | 285c8e3 → 7d59a5c |
| `npm run gate > /tmp/portal-panelize-gate.log 2>&1` | 通过，exit 0 | macOS 256 单元/集成 + 25 E2E；0 失败、0 跳过，真实 Chrome/Seatbelt |
| `node --test test/panelize.test.mjs test/recovery.test.mjs test/e2e/panelize-gate.test.mjs` | 27 通过 | 最新桥接/升级改动针对性复验 |
| `python3 /tmp/portal-check-links.py` | 通过 | 94 个相对链接 |
| `python3 .../skill-creator/scripts/quick_validate.py portal-skills/panelize-multi-agent` | 通过 | Skill is valid |
| `git diff --check` | 通过 | 无空白错误 |
| `node /tmp/portal-panelize-web-probe.mjs` | 三站可观察，未登录 | Kimi 显示登录入口，豆包未找到就绪编辑器，DeepSeek 登录页；未发送问题、未宣称完整回答 |

## 结论
既有成果已提交远端；多模型代码与完整门控通过，可进行受控部署。真实五家实答不成立：MiniMax 按用户指令未配置，三个网页尚未登录。

## 遗留事项
- MiniMax 按用户指令留空，不启动 Claude Code 或借用 Brioi。
- 完成门控与公网工具实际调用；网页登录/完整答复须与离线/受控浏览器证据分别记录。

## 最小实现取舍
复用上游纯文本填入/发送函数，不另写三家 DOM 发送选择器。Portal 用已有标签页和接管抽屉代替扩展分屏；不安装拥有 cookies 权限的完整扩展。当前 Codex root 是 Codex 席位，不再另起有宿主凭据的 worker。原始网页文本返回私有模型上下文，完整答案/来源与缺口由 root 在最终私有回复记录；不新增自动模型判定完成或后台自动重发。临时 profile 随运行结束清理，不能承诺跨轮免登录。新旧对话工具版本由单一幂等列跟踪，显式多模型请求才升级旧线程并保留 lineage/Portal 历史。

## 部署准备
已核对生产工作树与 4310 监听归属，原服务 root runs、待发 chat_inputs、排队/租约/重试 workflow jobs 均为 0。一致性 SQLite、旧 HEAD 代码和私有环境备份位于 DATA_DIR/backups/release-panelize-*，目录 0700，文件 0600；不记录内容。一次备份快照统计的表名拼写错误发生在备份复制后，随后使用 task_submissions 正确重做完整备份；不影响生产库。回滚排空后回退到 7d59a5c，保留新数据库字段与业务记录，不还原旧库覆盖新消息。

补充微信合成 transport 测试 `node --test test/task-dispatch.test.mjs`：17 通过；Panelize 消息按当前老板/owner/EXECUTE 传到同一浏览器工具边界，重复收件只执行一次，空 MiniMax 不启动浏览器。没有给真实微信联系人发送测试消息。首次 staged diff 检测到上游脚本行尾空白，仅做格式规范化，原始/规范化摘要均已记录，不豁免 diff 检查。

## 微信接管补充计划
链路审查发现 Weixin 原本只在 root 完成后发最终文字，网页 handoff 等待期间手机无法获知登录入口。仅对老板本轮显式 Panelize 请求，在 browser_state.handoff 时用既有 outbox 建立一次固定接管通知，带当前工作台 chat 深链；发送前复验连接 generation、inbox processing、当前 chat/run 和 handoff 尚有效。过期取消，不复用最终 response_text，不记录页面或原因，不重发 uncertain。增加合成 transport 的等待中通知/去重/过期验证后重跑最终 gate。

微信接管补充已实现：`node --test test/task-dispatch.test.mjs > /tmp/portal-panelize-weixin-final.log 2>&1` 18 通过，涵盖等待期间深链、去重和过期取消。规范化 vendor 后第二次 `npm run gate > /tmp/portal-panelize-final-gate.log 2>&1` 的单元阶段 257 通过；其后新增 handoff 用例由上述完整文件复验，E2E 25 通过，完整 gate exit 0、0 失败、0 跳过。全变更相对 Markdown 链接 94 个通过，`git diff 7d59a5c --check` 通过。
