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

## 快速开始

要求：macOS、Node.js 22.13+，以及已经完成 `codex login` 的 Codex/ChatGPT App。

```bash
cd /Users/zlh1992_home/Documents/ChatGPT/codex-harness-remote
./bin/install-mac.sh
./bin/create-super-admin.sh
./bin/start-public.sh
```

打开 [http://127.0.0.1:4310](http://127.0.0.1:4310)，用刚创建的超级管理员登录。无需安装 npm 依赖。

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

macOS `launchd` 使用独立标签 `com.codex-harness-remote.server` 与 `com.codex-harness-remote.tunnel` 托管进程；退出启动终端不会停止服务。日志位于 `~/Library/Logs/CodexHarnessRemote/`。

首次生产部署推荐 Cloudflare named tunnel，并在 `.env` 设置 `PUBLIC_ORIGIN=https://codex.example.com`、`PUBLIC_TUNNEL_MODE=named`。若仍需从本机 HTTP 登录，保持 `COOKIE_SECURE=false`；公网请求会根据隧道的 HTTPS 转发头自动获得 Secure Cookie。详细步骤见 [公网部署指南](docs/PUBLIC_DEPLOYMENT.md)。

## 已实现

- 用户名/密码登录；scrypt 密码哈希；数据库只保存会话 token 的 SHA-256；HttpOnly、SameSite=Strict Cookie；CSRF、Origin 校验、登录限速与安全响应头。
- 员工只看到自己的项目和老板明确分享的项目。超级账户可以查看全局项目元数据，但不能凭管理员角色读取员工项目内容。
- 老板项目主目录与员工共享 Git worktree 分离；每个老板项目最多授权一名员工，撤权立即关闭 ACL，脏工作树保留、干净工作树自动移除。
- API 拒绝绝对路径、`..`、`.git` 等内部路径和越界符号链接；删除操作移动到 `.data/trash`，便于恢复。
- Codex app-server 只使用 stdio；不向浏览器提供原始 RPC；会话/turn 映射由服务端验证。
- 关闭 Codex 内置 Shell、浏览器、插件、外部 MCP 和电脑控制；保留原生 apply-patch/diff、approval、plan、goal、skills 与子代理。动态 `workspace_*` 工具仍由后端做 ACL 和路径校验。
- 项目命令使用无秘密环境，并套用 macOS Seatbelt：默认不能读这台 Mac 的用户主目录或其他用户工作区；网络权限由超级管理员按用户开关。
- 命令超时、输出上限、进程/文件描述符上限、用户并发、全局并发、项目数和存储配额；员工项目硬上限 100，全局 Codex turn 硬上限 40，Portal 同时运行 11 个 root turn，其中 EXECUTE lease 为 2 个。
- 浏览器内项目/对话管理、跨用户/项目/对话并发、流式 Codex 输出、工具活动、停止 turn、文件树、编辑器、上传、可恢复删除。
- 可拖拽调整项目栏、对话栏、文件栏以及文件树/预览区；支持 SVG/图片、DOT 配套 SVG、PDF、Excel、CSV/TSV、Markdown、JSON 和源代码预览。
- 独立老板驾驶舱：全局指标、员工创建/停用/重置密码、网络与配额、项目授权/worktree 生命周期和审计；原工作台保留给员工及老板自己的项目。
- 员工任务首页：老板 roadmap 拆分的线性任务、EDIT/EXECUTE 模式、浏览器原生审批、plan/diff/goal 展示和最终回复不可变提交快照；完整对话历史继续由 Codex thread 保存。

## 常用命令

```bash
npm test
npm run check
./bin/healthcheck.sh
./bin/status.sh
node src/cli.mjs list-users
node src/cli.mjs reset-password --username=superadmin
```

官方说明：Codex app-server 专用于把 Codex 嵌入富客户端，支持历史、审批和流式事件；其 WebSocket 传输仍为实验性，因此本项目选用稳定的本机 stdio，再由自己的 HTTPS/SSE 应用层对外提供服务。[Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)

更多资料：[架构与安全边界](docs/ARCHITECTURE.md) · [超级管理员指南](docs/SUPER_ADMIN_GUIDE.md) · [公网部署指南](docs/PUBLIC_DEPLOYMENT.md)
