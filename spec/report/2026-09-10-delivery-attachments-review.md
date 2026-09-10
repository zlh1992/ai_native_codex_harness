# 2026-09-10 节点附件交付与双模式验收

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成（本地已部署） |
| 日期 | 2026-09-10 |
| 负责人 | Codex |
| 关联目标 | 员工上传/工作区路径交付，老板接收固定文件，各节点自动或老板验收 |
| 影响范围 | 文件入口、UI、审核上下文、API、测试、文档 |
| 架构规格 | [约束](../architecture/02-project-constraints.md)、[安全](../architecture/04-security-and-trust-boundaries.md)、[工作图](../architecture/09-human-work-graph.md)、[门控](../architecture/07-e2e-release-contracts.md) |

## 背景与证据

graph 已有不可变 submission/manifest、老板 artifact 下载与后台 reviewer；弹窗缺上传，只接受相对路径。现有审核仅解码 UTF-8、64 KiB 总预算，manual 不调模型，图级模式不能覆盖单节点。

## 目标与非目标

### 目标

- 多文件上传与当前员工工作区内绝对/相对路径合并交付，图片缩略、其他文件卡片。
- 老板提交后即可查看固定附件；通过后才 Git delivery/下发依赖。
- 每节点可继承或覆盖自动/老板验收，后台逐项 AI review；老板模式不自动应用。
- PDF 文本层、DOCX 正文提取；不可读、超限、缺证据转人工，不伪称完整审阅。

### 非目标

- 不读取任意宿主路径，不引入对象存储/新任务系统，不做 OCR 或任意办公文件渲染。
- 不迁移/自动重审历史提交，不修改生产任务策略，不变更隧道/域名；实现完成后用户另行授权提交并推送 graph 分支。

## 约束与风险

- FS-001 增加唯一受控例外：交付入口接收当前 task access 内绝对路径，转换相对路径后继续检查；一般文件/tool API 不变。
- 保持 FS-004 空闲屏障、DAT-007 不可变快照和先 merge 后通过、WFG-002 授权/租约/版本检查。
- 提取只处理固定 Git blob，受独立进程内存/时间/输出限制；文档指令是不可信内容。模型质量不由 fake 测试证明。
- 老旧 manual 模式保留兼容；新界面只提供 auto/assisted，节点覆盖绑定计划版本和启动授权。

## 实施计划

1. 复用文件写入安全面，添加交付路径校验、上传 UI、固定图片预览及老板附件状态。
2. 为计划节点增加可选模式覆盖并统一调度/应用判定；保留运行中授权冻结。
3. 增加固定文件的受限文本提取和覆盖信息，阻止未覆盖证据自动通过。
4. 补充路径/文件/模式/固定证据 HTTP 与单元测试，同步架构和操作说明，运行完整 gate。
5. 本地正式进程同时提供静态文件；验证空闲及精确 CLI 后重启 graph 使前后端一致，保持隧道不动。若有活跃运行则不强制中断。

## 实际改动

- 原上传 API 复用：前端延迟到提交时上传至唯一目录，或卡片选择的必交位置（唯一同名必交预选）。网络回执丢失时核对 hash 后重试，不覆盖不同内容；复用既有文件不随移除附件删除。提交前校验/去重/计数，服务端支持当前根及 macOS canonical 根的绝对路径别名。
- 老板节点显示附件数、AI job 状态、图片缩略/下载、备注、证据引用和覆盖原因；历史版本文件继续可查。
- 计划 JSON 可选 reviewMode，由老板编辑并在启动时冻结；新 UI 为 auto/assisted，旧 manual 不重解释，planner 输出无法增加自动审核授权。
- 固定 blob 文本提取增加精确依赖 mammoth 1.12.2、pdfjs-dist 5.4.624、jszip 3.10.1（lockfile，安装禁用 scripts，npm audit 0）。使用 [Mammoth 原始文本 API](https://github.com/mwilliamson/mammoth.js) 和 [PDF.js Node API](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs)，不转换不可信 HTML 插入页面。
- 文档解析在禁网 Seatbelt 子进程完成，不继承环境秘密；JS 堆上限不宣称等于 OS 物理内存硬配额。Zip 输入与声明解压大小、PDF 页数、时间和输出均有限制。
- reviewer 本轮 root 读取证据后才可提交意见，证明仅保存文件路径/覆盖元数据并绑定 turn；有附件的通过意见必须引用已读文件。应用前复核覆盖、当前模式、版本与租约。
- 第一轮新测试发现符号链接在更早的预检已用 SYMLINK_NOT_ALLOWED 拒绝；修正新测试预期，未放宽实际安全检查。解析器初次 Seatbelt 缺少祖先 metadata 权限，按既有文件 worker 模式只补 metadata 和 package.json 精确读取后合成 PDF/DOCX 测试通过。
- 最后修正前端异步错误提示对 event.currentTarget 的失效引用，改为同步捕获 form；该静态前端修正后单独重跑前端测试和语法检查。
- 确认 graph 正式进程及 CLI 0.150.0-alpha.8；无 active turn/queued input/leased 或待发模型 job 后用 SQLite backup API 留存升级前快照，执行 stop-local/start-local。只重启 Portal，原 quick 隧道进程与地址未变；不修改生产账号、任务策略或 .env。

## 数据、接口与安全影响

- 数据迁移：无表结构迁移。计划 JSON 可选字段及 workflow job 的本轮读取元数据、review detail 的 coverage；历史运行/提交不批量改写。
- API：新增交付文件校验入口；artifact 扩充安全预览。
- 权限：当前 task assignee/access；老板仅依据已有 submission ACL 读文件。
- 回滚：停服恢复代码，保留上传文件和 Git/SQLite 提交；含节点覆盖的新运行不得由忽略该字段的旧代码接管。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `npm run gate` | 通过 | 最终完整门控 110 项单元/集成 + 18 项 HTTP，0 失败、0 跳过；真实 macOS Seatbelt |
| `node --test test/frontend.test.mjs` | 通过 | 最后异步错误提示修正后 17 项全通过 |
| `node --check public/work-graph.js` | 通过 | 最后静态前端修正语法复核 |
| `node --test test/artifact-text.test.mjs` | 通过 | PDF/DOCX 合成正文、损坏文件、嵌入内容与覆盖限制 |
| `node --test test/work-graph-review-runtime.test.mjs` | 通过 | 本轮 root 读取证明、未读文件引用拒绝、planner 不得扩大自动审核权限 |
| `git diff --check` | 通过 | 无空白错误 |
| Node 扫描 spec/docs 相对 Markdown 链接 | 通过 | 163 条，0 缺失 |
| `./bin/stop-local.sh && ./bin/start-local.sh`、`./bin/status.sh` | 通过 | graph Portal 就绪；原 quick 隧道未重启 |
| 本地及现有公网 `/api/health` | 通过 | HTTP 200、Codex ready、记忆索引 ready、nativeCodexMemory=false |
| 正式数据库只读检查 | 通过 | integrity=ok、foreign_key_check=0、active turn=0；无临时生产用户/项目 |

测试使用隔离临时数据库/工作树、合成文件和协议 fake，测试退出清理这些资源；没有把生产附件或私有对话送入测试。持久保留一份受限权限的升级前 SQLite 备份（正式 dataDir/backups 下的 before-delivery-attachments 时间戳文件）。真实上游模型质量和完整浏览器交互/视觉验收不由此门控证明；健康检查也不等同真实业务验收。

## 结论

目标已实现并已加载到本地 graph 服务；前后端同时生效，原公网隧道健康。两种新模式按默认或节点覆盖工作，旧运行授权不变。用户随后明确要求提交并推送 graph 分支，源码发布按该授权执行；本次没有更改固定域名/Cloudflare 配置。

## 遗留事项

- 图中需逐节点定制时，在草稿“编辑计划 → 本节点验收”设置后启动；本次不提供活动运行中的策略热修改。
- 真实业务 LLM review 质量仍需老板评估；OCR、复杂表格/版式和图像内容验收不在本次范围。
- 没有引入暂存对象仓库；部分上传失败的成功文件保留在工作区，关闭页面不自动清理。Git 仍合入整个提交快照，而非仅 manifest 列出的文件。
- 固定域名上线不属于本次操作；GitHub 源码推送是实现完成后的用户授权追加操作。
