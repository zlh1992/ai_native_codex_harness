# 2026-10-22 微信多用户与带资料任务派发

| 字段 | 内容 |
| --- | --- |
| 状态 | 已首批上线，待真实手机验收 |
| 日期 | 2026-10-22 |
| 负责人 | Codex |
| 关联目标 | 微信及老板普通对话派发带资料任务，员工直接接单 |
| 影响范围 | 渠道、附件、任务、skill、导航、SQLite、运维、测试 |
| 架构规格 | [索引](../architecture/index.md)、[强制约束](../architecture/02-project-constraints.md)、[工作图](../architecture/09-human-work-graph.md)及 03–08 章 |

## 背景与证据

现有老板固定微信入口只接收文本；本机该入口关闭且绑定为空。已有 Work Graph、files_only 分享和固定交付证据可以复用。当前生产基线 285c8e32d5f99e060a9abd168f144ab6b9858509 已推送到 origin/codex/browser-execution，并经 ls-remote 核对。开发在独立 codex/weixin-task-dispatch 工作树进行，生产目录保持不变。

## 目标与非目标

### 目标

- 按用户扫码、按当前授权项目/任务路由；接收文件不自动派发。
- 同一派发服务支持老板微信、普通对话、工作图输入附件；默认新批次独立协作项目。
- 员工直接打开任务、资料和对话；未绑定微信仍有网页待办。
- 资料固定、追加有版本、通知可追溯、重试不重复建单。

### 非目标

- 不接管现有 wechat-people-graph 服务或凭据，不开放隐私项目、员工私有项目或宿主目录给老板。
- 不自动解压 ZIP、不自动执行员工任务，不更改模型白名单、禁网策略或审核含义。

## 约束与风险

遵守 PRD-001/003/004/009、FS-001/003/004/006、DAT-001/003/004/006、PRO-001 与 DEV-001 至 DEV-006。PRD-010 从单老板渠道扩展到显式用户绑定与受控派发，旧入口兼容保留。账号上下文与附件 ID 不是 bearer capability。微信发送成功不等于已读；不确定投递不得自动重发。CLI pin 不变，旧 native thread 不能靠 resume 安装新工具；仅空闲时按版本迁移并保留历史查询与 lineage。

## 实施计划

1. 固定并远端保存基线；独立分支及本报告先于实现。
2. 增加资料/派发持久服务，复用工作图、共享、空闲屏障和配额；输入资料独立于上游 inputManifest。
3. 接入派发 skill 和同对话历史查询；补前端资料清单、回执、任务详情、深链接及通知。
4. 增加用户独立微信连接、受控 relay、文件接收、顺序消息和投递状态；保持已有独立桥接不变。
5. 补异常/权限/恢复/真实浏览器回归，完整 macOS gate、diff 与链接检查，更新架构和报告。
6. 通过后排空、备份并部署域名 1/2；真实扫码和手机链路按实际完成度记录，不以合成测试冒充。
7. 首批真实收发发现发送响应可省略 ret/errcode；依据固定上游 send.ts 的缺省零契约修正状态判断，保留传输异常的不确定状态与不重发边界。补回归并重新执行完整门控后部署，保留已建立的连接。
8. 手机反馈补修：普通图片 type=2 被原始文件分支拒绝；dispatch_context 未返回登录用户名，无法将 zlh 与不同的显示名对应。支持固定 transport 的图片密钥/原图下载，按真实位图格式保存到现有不可变资料；员工列表同时返回用户名和显示名。图片仅接收不自动派发。受当前项目 ACL 约束的图片读取返回原生 inputImage，图片 bytes 不写工具明细或事件；补收件、用户名解析、位图读取及越权回归后重新门控。

## 实际改动

- 已完成基线推送与 SHA 核对，创建独立功能工作树。实现提交 `740e5aba5f166765027a85dd228aa1aa46239789` 已推送 origin/codex/weixin-task-dispatch；2026-10-23 已将生产工作树 fast-forward 至该提交并重启 Portal。
- 增量迁移保存资料、派发、输入版本、提交采用版本、通知、微信连接及 inbox/outbox；复用 workflow_jobs 和 files_only 分享，不新增另一套任务系统。
- TaskMaterials 固定文件大小及 SHA-256，限制 30 份/50 MiB，安全打包选定项目文件；原 ZIP 不解压，导入不覆盖已有内容。只读捕获/打包允许在老板整理资料的本轮使用，准备派发与文件导入仍等待空闲，避免 Agent 因自己的运行锁无法打包。工作图规划只允许引用选定资料，提交/审核固定本次输入版本。
- TaskDispatchService 在来源空闲后准备独立协作项目，所有共享就绪后才发布并生成回执。简单派发人工验收；任务和通知状态分别持久化。
- 新增 task-dispatch skill/root 工具；旧老板对话仅在首次相关任务时 CAS 升级 native thread，保留 lineage、页面历史与受当前记忆权限约束的只读查询。
- 前端新增微信连接、派发资料与回执；任务详情展示输入版本、下载和预览，主按钮进入任务对话。任务 URL 贯通登录、刷新、返回；打开详情只读通知，不启动 Agent。
- 每用户独立 IPC relay 使用固定 CodexBridge transport commit `92166e02f4c7c8fcc0d223e894dd33664db754ea`。从独立干净 checkout 构建并验证 commit/SHA；不运行上游 Agent，不复用本机既有微信凭据。undici/qrcode/esbuild 均精确版本锁定。
- 消息先持久化再提交游标、按连接顺序处理；纯附件不启动模型。发送前复验权限；不确定执行或发送不重放。禁网/撤权立即停止 relay；每次联网读取当前系统代理。
- 增加 TASK_DISPATCH_ENABLED、WEIXIN_ENABLED 和首批用户 allowlist。首批为老板和 zlh；两边均实际扫码绑定，用户确认各自手机收到 /models 回复。
- 按固定上游缺省零协议修正发送状态；显式拒绝记 failed，响应无法解释或传输异常记 uncertain。已发送历史记录不自动重发，也不据此改写网页已读状态。
- 手机反馈修复：dispatch_context 增加 username，指引优先精确匹配；普通图片以原图下载、解密、识别位图并保存为不可变资料，不自动派发。任务图片增加受 ACL 保护的预览，老板及员工的图片读取返回原生 inputImage；像素通过私有 Symbol 附带，不进入 JSON 明细、事件或摘要。未改变 CLI pin 或启用内置浏览器/宿主 view_image。

## 数据、接口与安全影响

- 增量表保存附件、派发、连接和投递状态；旧计划附件缺省为空。
- 新接口复用会话、CSRF、Origin、项目/任务 ACL；relay 改用 Portal 创建的每人独立子进程和私有 IPC，不增加 HTTP 监听/回调面；连接代次、原始消息 ID 和持久队列负责身份与重放保护。此实现替代原先设想的回环 HMAC，可减少凭据和额外 API，用户能力不变。
- 凭据、文件正文和 prompt 不进入审计/事件/日志；仅业务 ACL 内保存必要内容。
- 回滚先关闭新入口并排空，恢复原代码和配置；保留新增业务数据，不用旧库覆盖新任务。

## 验证

首轮完整门控捕获导航回归：初始化工作图时关闭一个尚未打开的详情误写 URL，丢掉原有 project/chat 深链接，导致浏览器抽屉未恢复。已将无任务的关闭回调改为不修改导航；原 Chrome 门控不变。首批真实发送暴露状态误判：固定上游 send.ts 对缺省 ret/errcode 按零处理，Portal 原先要求显式 ret=0，导致正常回复记为 uncertain。用户已确认老板及 zlh 手机都收到 /models 回复；按协议修正服务端接受状态，手机收取仍单独确认，历史不确定消息不重发。

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `git ls-remote --heads origin refs/heads/codex/browser-execution` | 通过 | 与基线完整 SHA 一致 |
| `git diff 285c8e32d5f99e060a9abd168f144ab6b9858509 HEAD --check` | 通过 | 源码和文档无空白错误 |
| `npm run gate`（冻结提交 `740e5ab` 复验） | 通过 | macOS：230/230 普通测试、23/23 E2E，0 skip；含真实 Chrome 和 Seatbelt |
| `node --test test/task-dispatch.test.mjs`（发送协议修正后） | 通过 | 13 项：增加缺省零接受、显式拒绝、无法解释响应及不重发验证 |
| `node --test --test-name-pattern='real isolated Chrome' test/e2e/browser-gate.test.mjs` | 通过 | 原接管/双角色/隔离/清理测试不变 |
| `node --check bin/build-weixin-transport.mjs`、skill-creator `quick_validate.py portal-skills/task-dispatch` | 通过 | 构建脚本语法、skill 格式有效 |
| `npm ci --omit=dev --ignore-scripts --offline` | 通过 | 独立目录预备生产依赖，264 个包 |
| Python 检查本次修改 Markdown 的相对链接 | 通过 | 119 个文件目标均存在 |
| 真实 `gpt-6.1-sol` 调用新 skill 派发 | 通过 | 持久回执 published，仅一项测试任务；zlh 附件下载 SHA-256 匹配；没有启动员工模型 |
| 域名 1/2 带认证 `/api/me` 与前端文件 SHA | 通过 | 两角色均见新入口及原四模型；Astra 不在白名单，Qwen 仍关闭 |
| 两角色真实微信扫码及 /models 手机回复 | 通过 | 两个独立连接 active；用户明确确认两边手机都收到模型列表 |
| 微信来件 SHA、手机任务通知 | 待用户测试文件 | 已给出老板发送文件并自然语言派发给 zlh 的验收步骤 |
| `node --test --test-concurrency=1 test/weixin-media.test.mjs test/task-dispatch.test.mjs test/approval-security.test.mjs test/e2e/task-dispatch.test.mjs` | 通过 | 图片修正后 21/21，含真实 Chrome 任务图片预览、越权、用户名与非像素日志验证 |
| 手机实际图片 CDN 解密探测 | 通过 | 用户已发送图片读取 458652 字节 JPEG，计算 SHA-256；不打印或保存下载凭据 |
| 发送修正中间版 `npm run gate` | 未通过 | 231 单元通过；Chrome 接管测试在重启场景收到 UND_ERR_SOCKET。保留契约，图片修正冻结后重新完整运行，不将中间版作为发布依据 |
| 图片/用户名/发送修正冻结后 `npm run gate` | 通过 | macOS 235/235 普通测试、23/23 E2E，0 skip；完整保留原有浏览器接管与生命周期门控 |

## 清理与回滚

- 自动测试使用独立临时数据库、工作区和 Chrome，会在结束后清理。
- 构建 checkout 为独立 `/tmp/portal-weixin-pinned`；上线需保留 ignored `.tools/weixin-transport.mjs` 及校验 manifest。
- 发布前运行、输入队列、工作图待办、审批和执行租约计数均为 0；停服后备份完成，SQLite quick_check=ok。
- 备份位于 `~/Library/Application Support/CodexHarnessRemote/backups/2026-10-23-weixin-003125/`，权限 0700；包括原提交源码、私有配置、SQLite、业务文件的 APFS 副本及原 node_modules。没有将私有备份提交远端。
- 仅重启 Portal，既有隧道和其他微信服务保持。部署后原 19 用户、29 项目、45 access、77 对话、331 消息、24 任务、15 提交数量一致；角色/状态/联网位逐条一致。
- 首批为 superadmin 与 zlh；新建专用“微信收件箱”和“微信工作台”。首批真实模型产生的明确标注测试任务保留，等待手机通知验收后清理。扫码验收会话有时限，完成扫码后注销，不更改账号密码。
- 前端老板连接面板真实 Chrome 检查通过；员工验收使用独立标签页 session selector，不借用默认 cookie。
- 回滚恢复基线代码/配置，并关闭新增入口；保留当前业务库、任务资料和项目。不得以旧数据库覆盖上线后业务。

## 结论

已通过完整 macOS 门控并发布首版域名 1/2，公网双角色与真实模型带资料派发通过；老板与 zlh 真实扫码及 /models 手机收取已确认。图片、用户名与发送状态修正已通过新一轮完整门控，准备部署并复测。真实微信图片已成功解密，任务通知仍待手机确认。目前只开放老板与 zlh 的微信连接，未扩大至其他账号。

## 遗留事项

- 等待老板微信发送测试文件并明确派发，验证来件 SHA、员工手机任务通知与任务进入；通过后清理受控测试任务、资料和验收会话，再开放其他用户。
