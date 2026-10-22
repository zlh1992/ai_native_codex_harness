# Codex Harness Remote

把这台 Mac 上已经登录的 Codex 变成一个有账号、权限隔离、项目文件管理和超级管理员驾驶舱的公网 Web 工作台。后端直接使用 `codex app-server` 的 stdio JSON-RPC，不使用 ACP，也不把 app-server 的实验性 WebSocket 暴露到公网。

```text
公网浏览器
  → Cloudflare Tunnel / Tailscale Funnel（HTTPS 出站隧道）
  → 127.0.0.1:4310（登录、RBAC、CSRF、配额、审计、SSE）
  → codex app-server（stdio，仅后端可见）
  → 本机现有 ChatGPT/Codex 登录

Codex 的项目工具
  → 项目 ACL + thread/tree 服务端绑定
  → 路径、保留目录与符号链接校验
  → 仅放行当前 tree + 独立 runtime 的 macOS Seatbelt
  → 自有项目主目录 / 老板共享项目独立 Git worktree
```

## 当前 Mac 一键管理

```bash
/Users/starwin/Documents/ChatGPT/codex-harness-remote/start.command
/Users/starwin/Documents/ChatGPT/codex-harness-remote/stop.command
/Users/starwin/Documents/ChatGPT/codex-harness-remote/restart.command
/Users/starwin/Documents/ChatGPT/codex-harness-remote/status.command
/Users/starwin/Documents/ChatGPT/codex-harness-remote/health.command
/Users/starwin/Documents/ChatGPT/codex-harness-remote/reset-wechat-qr.command
```

以上入口管理 Portal、公网隧道和老板微信 relay。启动会等待就绪；重置二维码后需要重新扫码。[完整操作说明](docs/SERVICE_CONTROL.md)。

## 快速开始

要求：macOS、Node.js 22.13+，以及已经完成 `codex login` 的 Codex/ChatGPT App。

模型边界：老板和员工的普通项目、微信固定项目均使用本机已登录的 ChatGPT 官方 Codex 订阅；项目配置固定为 `openai_http` + `https://chatgpt.com/backend-api/codex`，启动脚本会拒绝其他上游地址。老板新建的 `local_private` 隐私项目当前使用显式开启的本机回环 Qwen OpenAI-compatible 服务（配置统一使用 `LOCAL_QWEN_*`），不会作为普通项目或微信渠道的 fallback。

```bash
cd /Users/starwin/Documents/ChatGPT/codex-harness-remote
./bin/install-mac.sh
./bin/create-super-admin.sh
./bin/start-public.sh
```

老板打开 [老板登录](http://127.0.0.1:4310/boss/login)，员工打开 [员工登录](http://127.0.0.1:4310/employee)。`install-mac.sh` 会按 `package-lock.json` 自动安装锁定的 npm 运行依赖，并建立本地 memsearch/ONNX 环境，无需另行执行安装命令。

`install-mac.sh` 会把 `cloudflared` 安装或复制到本项目的 `.tools/cloudflared`；运行时拒绝引用其他项目的可执行文件。公网临时地址：

```bash
./bin/start-public.sh
```

本地服务与公网隧道使用独立 PID 和生命周期。关闭隧道不会关闭本地服务：

```bash
./bin/status.sh          # 查看本地与公网状态、当前公网地址
./bin/stop-tunnel.sh     # 只关闭公网，本地 4310 继续运行
./bin/start-tunnel.sh    # 只启动公网隧道
./bin/stop.sh            # 按顺序停止公网和本地服务
```

默认 macOS `launchd` 使用独立标签 `com.codex-harness-remote.server` 与 `com.codex-harness-remote.tunnel` 托管进程；退出启动终端不会停止服务。当前 Mac 使用显式 detached 模式，由相同脚本记录和核验进程身份；退出启动终端不停止，系统重启后需重新启动。日志位于 `~/Library/Logs/CodexHarnessRemote/`。

公网同样分为 `<公网地址>/boss/login` 与 `<公网地址>/employee`；老板登录后进入驾驶舱，并可打开 `/boss/workbench`。

首次生产部署推荐 Cloudflare named tunnel，并在 `.env` 设置 `PUBLIC_ORIGIN=https://codex.example.com`、`PUBLIC_TUNNEL_MODE=named`。若仍需从本机 HTTP 登录，保持 `COOKIE_SECURE=false`；公网请求会根据隧道的 HTTPS 转发头自动获得 Secure Cookie。详细步骤见 [公网部署指南](docs/PUBLIC_DEPLOYMENT.md)。

## 已实现

- 用户名/密码登录；scrypt 密码哈希；数据库只保存会话 token 的 SHA-256；HttpOnly、SameSite=Strict Cookie；CSRF、Origin 校验、登录限速与安全响应头。
- 员工只看到自己的项目和老板明确分享的项目。超级账户可以查看全局项目元数据，但不能凭管理员角色读取员工项目内容。
- 老板项目可同时授权多名员工；每名员工绑定独立 Git worktree。新授权会复制 owner 当前 HEAD、已跟踪修改和未跟踪文件，同时将老板在该项目已有的全部对话一次性 fork 为员工私有副本。双方后续对话互不影响；撤权先排空运行再关闭工作树，脏树保留且同一员工可恢复原授权。
- API 拒绝绝对路径、`..`、`.git` 等内部路径和越界符号链接；删除操作移动到 `.data/trash`，便于恢复。
- Codex app-server 只使用 stdio；不向浏览器提供原始 RPC；会话/turn 映射由服务端验证。
- Portal 启动的 Codex app-server 永久关闭原生长期记忆，并在 ready 前读取有效配置验证；业务长期记忆由 Portal 按用户隔离，Codex 自主调用 `memory_search/add/update/delete`（非关键词自动保存），复用 memsearch/Milvus，支持当前来源授权、引用、chat 开关、人工管理和分享确认。
- 关闭 Codex 内置 Shell、浏览器、插件、外部 MCP 和电脑控制；保留原生 apply-patch/diff、approval、plan、goal、skills 与子代理。动态 `workspace_*` 工具仍由后端做 ACL 和路径校验；通过校验的项目内文件变更会自动接受。
- 项目命令使用无秘密环境，并套用 macOS Seatbelt：默认不能读这台 Mac 的用户主目录或其他用户工作区；网络权限由超级管理员按用户开关。
- 命令超时、CPU/输出/文件描述符上限、可取消串行队列、用户并发、全局并发、项目数和存储配额；员工项目硬上限 100，全局 Codex turn 硬上限 40，Portal 同时运行 11 个 root turn，默认 EXECUTE 可使用全部 11 席。
- [对话浏览器与项目执行](docs/EXECUTION_BROWSER.md)：隔离 Chrome、真实画面与中文输入、登录/验证人工接管；运行结束清理登录态，Codex 内置浏览器保持关闭。
- 浏览器内项目/对话管理、同项目不同对话并发、流式 Codex 输出、可游标重放的语义事件、工具活动、停止 turn、文件树、编辑器、上传、可恢复删除。浏览器写入、任务快照和交付仍等待整个 access 空闲。
- 可拖拽调整项目栏、对话栏、文件栏以及文件树/预览区；支持 SVG/图片、DOT 配套 SVG、PDF、Excel、CSV/TSV、Markdown、JSON 和源代码预览。
- 独立老板驾驶舱：全局指标、员工创建/停用/重置密码、网络与配额、项目授权/worktree 生命周期和审计；原工作台保留给员工及老板自己的项目。
- 员工任务首页：老板 roadmap 拆分的线性任务、每个 chat 独立且默认 EXECUTE 的模式、项目内自动 approval、plan/diff/goal 展示和最终回复不可变提交快照；提交证据不随 chat/turn 删除，完整对话优先从 Codex thread 读取并由本地确定性消息快照兜底。

## 常用命令

```bash
npm test
npm run check
npm run gate
./bin/healthcheck.sh
./bin/status.sh
node src/cli.mjs list-users
node src/cli.mjs reset-password --username=superadmin
```

`npm run gate` 是合并前门控：先运行全部静态检查与单元测试，再用隔离数据库和协议兼容的假 App Server 完成老板/双员工授权、worktree 隔离、同 access 多 chat 并发与浏览器写锁、运行中项目删除阻断、任务提交审核、SSE 游标重放与跨对话/跨用户拒绝、撤权排空/恢复和 thread 故障恢复的真实 HTTP 端到端流程。

完整门控需要在 macOS 主机终端或等价 CI 中运行，因为它会监听临时 loopback 端口并启动嵌套 Seatbelt 来验证真实命令隔离；受限代理沙箱内不能用跳过这些用例来代替发布门控。

官方说明：Codex app-server 专用于把 Codex 嵌入富客户端，支持历史、审批和流式事件；其 WebSocket 传输仍为实验性，因此本项目选用稳定的本机 stdio，再由自己的 HTTPS/SSE 应用层对外提供服务。[Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)

规范入口：[项目规格](spec/index.md) · [架构规格与强制约束](spec/architecture/index.md) · [实施报告](spec/report/index.md)

操作资料：[架构与安全边界（简版）](docs/ARCHITECTURE.md) · [用户记忆运维](docs/MEMORY.md) · [本地隐私项目](docs/LOCAL_PRIVATE_PROJECTS.md) · [超级管理员指南](docs/SUPER_ADMIN_GUIDE.md) · [公网部署指南](docs/PUBLIC_DEPLOYMENT.md)

## 多人 Work Graph

老板可由项目资料与员工能力生成工作图，自动分享项目、下发清单，按人工/辅助/自动方式验收与返工，完成后继续下发依赖任务。使用方式与运行开关见 [工作图操作指南](docs/WORK_GRAPH.md)，设计约束见 [多人工作图架构](spec/architecture/09-human-work-graph.md)。

微信连接、资料派发、员工接单及分批上线操作见 [微信任务派发指南](docs/WEIXIN_TASK_DISPATCH.md)。
