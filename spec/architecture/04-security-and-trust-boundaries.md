# 04 安全与信任边界

## 威胁模型

当前防护目标是阻止普通 Portal 用户：

- 读取或写入其他用户/其他 access 的项目内容；
- 猜测 project/chat/run/approval id 后越权；
- 用路径穿越、符号链接、`.git` 或 `.codex` 访问宿主敏感数据；
- 自选 Codex thread、cwd、sandbox policy、白名单之外的模型或任意 JSON-RPC method；
- 在 EDIT 模式执行命令，或让 EXECUTE 命令逃逸当前项目、独立 runtime 与账号网络策略；
- 从命令环境读取 Portal、隧道或 Codex 凭据；
- 利用 SSE cursor 或 submission 引用跨 chat、跨用户读取信息。

当前不防御共享 app-server、共享 OS 账号或共享上游 Codex 实现本身对敌对租户造成的侧信道与故障域问题。因此只能用于被组织授权、具有基本互信的员工。

共享 app-server 不得承担 Portal 用户记忆。Portal 在进程参数、thread config 和初始化后的有效配置检查三层固定关闭 Codex 原生记忆；任何一层漂移都 fail closed。业务记忆由模型调用 memory 工具，Portal 按 active root 的 `user_id` 和来源项目当前 ACL 授权，搜索异步返回前再次复验。模型不得指定 owner/source，子代理不得代 root 调用。搜索文本标记为不可信参考数据，不能升级为指令、权限或授权依据；文档或工具结果中的指令不构成记忆写入授权。新增与更新同时使用秘密规则拒绝明显敏感内容，但该规则不承诺完整 DLP。

## 认证

- 密码使用独立随机 salt 的 scrypt：`N=32768, r=8, p=1`。
- 浏览器持有 256-bit 随机 session token；SQLite 只保存 token SHA-256 digest。
- Cookie 使用 `HttpOnly`、`SameSite=Strict`，经 HTTPS 隧道时设置 `Secure`。
- 写请求必须同时通过 session、active user、Origin 与 session-bound CSRF 校验。
- 登录按来源 IP 做进程内滑动窗口限速，成功与失败均进入审计。

登录限速目前不是跨进程持久化安全控制；可信代理必须清洗 `X-Forwarded-For` 与 `X-Forwarded-Proto`。直接把 Portal 暴露到不可信反向代理会破坏来源与 Secure Cookie 判断。

## 授权

授权链必须是：

```text
session user
  -> active user
  -> requested chat belongs to user
  -> active project access belongs to user
  -> chat.project_access_id equals current access.id
  -> server-bound tree/thread/run/approval
```

管理员驾驶舱读取跨用户项目时只拿元数据。任何文件、chat 或 turn 路由仍通过 `projectFor(session, projectId)`，不能因为 `role=admin` 绕过内容 ACL。

### 超级管理员账号接管与宿主机边界

当前产品信任唯一超级管理员处理员工账号恢复。管理员可在受认证、CSRF/Origin 保护的管理更新流程中为员工设置新密码；该流程撤销员工已有 Web 会话并排空运行。管理员随后若以员工账号和新密码登录，内容路由会像处理任何该员工会话一样，根据员工既有 `project_access` 放行。这是账号接管，不是破解员工原密码，也不是管理员会话存在文件、chat 或 turn 的直接 ACL 旁路。

因此，Portal 的内容 ACL 保证“老板以自己的账号不能直接打开员工未分享项目”，但不保证“超级管理员主动操作后仍无法读取员工内容”。密码、session token 与内容不得写入审计；审计只记录脱敏的账号更新与排空结果。

Web ACL 也不约束运行 Portal 的 Mac 操作系统账号或其他宿主机管理者：控制该主机的人可以直接读取项目主目录、worktree、trash 或数据库附近的文件，而无需通过 Portal。若需要对超级管理员或宿主机管理者保密，必须采用不同的账号恢复信任模型，以及独立 OS 身份、存储和执行环境。

敏感异步操作在 await 后必须重新校验授权，尤其是：上传/解析请求体、创建/恢复 worktree、thread resume/start、skill discovery、排队转运行、批准处理、动态工具执行、显式 thread reset，以及返回 chat history、goal 或 spreadsheet preview 等受 ACL 内容之前。复验同时检查原 session 仍存在，并要求重新解析出的 `project_access.id` 与操作开始时一致；撤权后即使同一用户获得新 access，旧请求也不能改写新 tree。

## 文件路径与 Git

- 所有客户端路径先转成受控项目相对路径，再在服务端解析 canonical target。
- 一般文件/tool 接口拒绝绝对路径、空目标的危险操作、`..`、NUL、保留目录和越界符号链接；保留目录在 Unicode 规范化和大小写折叠后比较。任务交付入口仅把当前 task assignee/access 根内的绝对路径转换为相对路径，随后用同一 Seatbelt metadata 检查并绑定固定 Git 普通 blob；不接受其他项目或宿主路径。
- 主进程的 `lstat`/`realpath` 只做早期拒绝，不能作为最终竞态防线。树遍历、读取、写入、建目录和文件回收必须由独立 helper 在 Seatbelt 中执行；profile 只读当前 canonical project，写操作只额外开放当前 project 与本次 actor/access 的回收站目录。helper 再检查每个已存在路径分量，最终文件使用 `O_NOFOLLOW`，写入使用同目录临时文件加原子 rename。
- 共享 worktree 的 `.git` 是指向 owner 仓库内部的 indirection，必须同时被文件 API 和 Seatbelt 隐藏。
- 项目中的 `.codex` 和自定义 agent 配置不能改变 Portal 固定的工具、角色、模型或子代理策略。
- 项目配置、浏览器字段和记忆正文不能覆盖 Portal 固定的 native-memory-off 配置；记忆候选中的命令或提示注入文本不获得系统/开发者优先级。
- 文件删除使用可恢复 trash；恢复必须由管理员在停服和核对 ACL 后执行。

## HTML 主动内容预览

`.html`/`.htm` 是不可信主动内容，不能像 Markdown 一样插入 Portal DOM，也不能以普通同源 iframe 运行。工作台默认用带 `sandbox="allow-scripts"` 且不含 `allow-same-origin` 的 iframe 打开经 `projectFor` 和 Workspace 边界读取的原始文件；原始 HTML 响应同时携带 CSP `sandbox allow-scripts`，使直接打开 URL 也不会恢复 Portal 同源身份。

HTML 专用 CSP 允许自包含产物的内联脚本和样式，以及 `data:`/`blob:` 图片、字体和媒体；它拒绝 connect、form、frame、worker、object 与 base。预览脚本因此不能读取父页面、以 Portal 身份读取 API、提交表单或把自身变成同源应用。下载和源码编辑继续使用既有文件路由与版本控制，不新增管理员内容旁路。跨文件相对资源、外网依赖和完整浏览器导航不是当前预览契约。

## Codex 工具面

App Server 启动时关闭内置 Shell、unified exec、浏览器、插件、外部 MCP、computer use、image generation、workspace dependencies、skill search 和 web search 等不受 Portal ACL 控制的能力。

允许的写入面分两类：

1. `workspace_*` dynamic tools：每次调用都通过 Portal 上下文、ACL、路径和 turn mode 校验。
2. 原生 apply-patch/file-change：Codex thread/turn 默认使用 `readOnly` sandbox，由原生 approval 请求触发单次写入。Portal 从 legacy `fileChanges` 或 v2 item/patch notification 得到完整目标集合，转为脱敏项目相对路径后逐项校验；active user/access 复验成功后自动记录 accepted 并响应，目标缺失、越界、命中保留目录或请求持久 `grantRoot` 时 fail closed。这样无需用户逐次点击，也不把 workspace 扩成绕过 Portal 路径校验的宽泛可写根；动态 `workspace_*` 写入仍由 Portal 自身执行。

原生 subagent 只能位于当前 root tree 内，数量最多 3，模型固定 Luna。Portal 检查可见的 collab item 与 thread settings；这降低误配置风险，但不等于证明共享 app-server 对恶意跨 root 行为具有进程级隔离。

## 命令沙箱

- `workspace_exec` 只允许 EXECUTE turn。
- 命令在当前用户、chat、run、active access、cwd 和模式校验后自动记录 accepted approval；不创建等待浏览器处理的 pending approval。
- 子进程环境只保留最小 `PATH/HOME/TMPDIR/LANG/TERM/CI`；不展开继承整个 `process.env`。
- `HOME` 与 `TMPDIR` 位于 `runtime/<user-id>/<project-access-id>/`；同一用户不同项目/access 不能读写彼此的 shell 启动文件、配置或临时缓存。
- Seatbelt 只允许当前 tree 与该 access runtime 的必要访问；默认禁网。
- 命令具有 wall timeout、CPU、进程、文件描述符和输出字节限制。

Seatbelt 不是容器。完全不可信用户需要独立 OS 用户、VM/容器、独立磁盘 quota、独立 Codex 身份和独立 worker。

## 持久化与日志脱敏

不得进入 `audit_log` 或 `turn_events`：

- 密码、session/CSRF/tunnel/Codex token；
- 用户记忆正文、召回 query 和 embedding 输入；
- 用户 prompt 与模型逐 token 正文；
- 命令正文、环境变量和文件内容；
- raw diff 与完整工具参数/返回值；
- 宿主绝对路径。

允许记录 actor、资源 id、动作、状态、字节数、工具名称、自动审批类型、模型策略违规、final item id 和脱敏错误码。完整 final reply/diff 只作为 task submission/turn 的受 ACL 业务快照保存，不进入全局审计。

## 公网边界

- Portal 必须保持 loopback 监听，Cloudflare/Tailscale 只建立出站隧道。
- Quick Tunnel 地址是临时运行事实，不是稳定身份或长期访问控制。
- 固定部署应设置明确 `PUBLIC_ORIGIN`、受管 tunnel token 文件和正确代理信任。
- 固定多域名可配置 `PUBLIC_ORIGINS`（逗号分隔）、`BOSS_PUBLIC_ORIGIN` 与 `EMPLOYEE_PUBLIC_ORIGIN`；所有值必须是无路径/凭据的 HTTPS origin。配置后只接受这些 Host 及当前端口的回环 Host，写请求 Origin 必须与当前请求 origin 完全匹配，不因另一角色域名已登记而允许跨 origin 写入。Cookie 保持 host-only，两个域名独立登录。
- `TRUST_PROXY_PROVIDER=cloudflare` 要求固定域名与 `TRUST_PROXY=true`；公网请求须来自回环 peer、声明 HTTPS 并包含有效单个 `CF-Connecting-IP`，否则拒绝。Cloudflare 模式不使用 XFF 第一项，回环 Host 的直接访问不信任转发头。本机可信进程与 Cloudflare 账号管理员仍属于宿主/代理信任边界。
- app-server stdio 永远只对 Portal 可见；浏览器不得直接获得 app-server 凭据或 capability token。

角色专用登录 API 必须在创建 session 前检查账号角色；旧通用登录 API 保留兼容。角色入口分离不替代 API 的角色与内容 ACL。显式 owner share 允许把授权时已有完整对话复制给接收员工；副本仍严格属于接收者，不开放原 owner chat、run、SSE 或任务提交权限。

分享历史前若检测到跨项目记忆引用，Portal 只向 owner 返回条数、接收者和短期确认挑战，不返回记忆正文；确认必须单次、限时且绑定快照。失效引用不得通过确认绕过来源 ACL。

老板可经既有 chat PATCH 接口修改 `preferredModel`（白名单 id 或 null）；此操作要求 admin、原 chat ACL、CSRF/Origin 且 chat 无运行/恢复/排队输入。员工无该权限，运行服务也强制员工使用默认模型。`/api/me` 的 `models` 仅向老板返回受控目录，目录不表示上游账号保证可用。

## 后台业务工具边界

planner/reviewer 仅暴露受限 work_graph_* 工具，禁止原生写入与命令。后台授权采用 owner/member 策略 epoch、access、job lease 与 generation；自动 files_only 分享不复制 transcript。 详细契约见 [多人 Work Graph](09-human-work-graph.md)，操作见 [工作图指南](../../docs/WORK_GRAPH.md)。

交付文档提取只接收固定 Git blob 的字节，不向解析器提供项目路径。PDF/DOCX 在独立 Seatbelt 子进程中提取文本：仅开放解析器源码/依赖及系统运行库读取，不开放项目、凭据或网络；清空继承环境，限制输入、解压预算、JS 堆、墙钟和输出。解析错误不返回底层异常或文档正文至日志。提取异步返回后复验 owner/access、员工策略、任务版本和 pending 状态；tool 返回前额外复验原 job lease/generation。

reviewer root 必须在当前 turn 读取固定上下文，方可提交审核意见；read proof 只保存本轮标识、文件路径和覆盖元数据。有附件的通过意见须引用已提供的文件内容。解析覆盖不足时不得自动应用，模型生成的计划不能自行指定节点自动验收授权。
