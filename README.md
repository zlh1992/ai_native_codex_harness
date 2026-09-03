# Codex Harness Remote

把这台 Mac 上已经登录的 Codex 变成一个有账号、权限隔离、项目文件管理和超级管理员驾驶舱的公网 Web 工作台。后端直接使用 `codex app-server` 的 stdio JSON-RPC，不使用 ACP，也不把 app-server 的实验性 WebSocket 暴露到公网。

```text
公网浏览器
  → Cloudflare Tunnel / Tailscale Funnel（HTTPS 出站隧道）
  → 127.0.0.1:4310（登录、RBAC、CSRF、配额、审计、SSE）
  → codex app-server（stdio，仅后端可见）
  → 本机现有 ChatGPT/Codex 登录

Codex 的项目工具
  → 路径与符号链接校验
  → macOS Seatbelt 命令沙箱
  → .data/workspaces/<user-id>/<project-slug>
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
- 普通用户只能看到自己的项目和对话；超级管理员可查看所有用户、项目、用量和审计，并对任意项目文件增删改查。
- 用户根目录物理分开；API 拒绝绝对路径、`..` 和越界符号链接；删除操作移动到每个用户的 `.trash`，便于管理员恢复。
- Codex app-server 只使用 stdio；不向浏览器提供原始 RPC；会话/turn 映射由服务端验证。
- 关闭 Codex 内置 Shell、patch、浏览器、插件、MCP、电脑控制和多智能体。模型只得到后端托管的 `workspace_*` 动态工具。
- 项目命令使用无秘密环境，并套用 macOS Seatbelt：默认不能读这台 Mac 的用户主目录或其他用户工作区；网络权限由超级管理员按用户开关。
- 命令超时、输出上限、进程/文件描述符上限、用户并发、全局并发、项目数和存储配额；全局和单用户 Codex turn 上限均可配置，硬上限为 40。
- 浏览器内项目/对话管理、跨用户/项目/对话并发、流式 Codex 输出、工具活动、停止 turn、文件树、编辑器、上传、可恢复删除。
- 可拖拽调整项目栏、对话栏、文件栏以及文件树/预览区；支持 SVG/图片、DOT 配套 SVG、PDF、Excel、CSV/TSV、Markdown、JSON 和源代码预览。
- 超级管理员驾驶舱：全局指标、用户创建/停用/重置密码、网络权限、配额、全部项目文件和审计记录。

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
