# 公网部署指南

## 推荐拓扑

服务始终监听 `127.0.0.1:4310`。Cloudflare Tunnel 或 Tailscale Funnel 从 Mac 主动建立出站连接，不在路由器和 macOS 防火墙开放入站端口。不要把 `HOST` 改成 `0.0.0.0`。

## 临时测试：Cloudflare Quick Tunnel

```bash
./bin/install-mac.sh
```

安装脚本会将 `cloudflared` 放入本项目自己的 `.tools/cloudflared`。隧道启动脚本拒绝使用项目目录以外的副本，避免停止其他项目时误伤本服务。

`.env`：

```dotenv
HOST=127.0.0.1
PORT=4310
COOKIE_SECURE=false
PUBLIC_TUNNEL_MODE=quick
```

`COOKIE_SECURE=false` 仅用于允许同一实例从本机 HTTP 登录；经隧道到达的 HTTPS 请求仍会自动收到带 `Secure` 的 Cookie。

运行 `./bin/start-public.sh`，终端会打印一次性的 `https://*.trycloudflare.com`。Quick Tunnel 重启后换地址，只适合短期验收。脚本启动后即可退出终端；本地服务和隧道由独立 PID 文件管理。

```bash
./bin/status.sh
./bin/stop-tunnel.sh   # 只停公网；本地 4310 不受影响
./bin/start-tunnel.sh
./bin/stop.sh          # 全部停止
```

## 固定域名：Cloudflare Named Tunnel

1. 在 Cloudflare Zero Trust 创建 remotely-managed tunnel。
2. 添加 Published application，把 `codex.example.com` 映射到 `http://localhost:4310`。
3. 从 “Add a replica” 获取 token，并运行 `./bin/save-cloudflare-tunnel-token.sh` 隐藏输入保存。
4. 配置 `.env`：

```dotenv
HOST=127.0.0.1
PORT=4310
PUBLIC_ORIGIN=https://codex.example.com
COOKIE_SECURE=false
PUBLIC_TUNNEL_MODE=named
PUBLIC_URL=https://codex.example.com
PUBLIC_TUNNEL_TOKEN_FILE=.data/cloudflare-tunnel.token
```

5. 运行 `./bin/start-public.sh`。

Cloudflare Access 可以作为额外的一层身份门禁，但不能替代 Harness 自己的用户/RBAC。不要在 Cloudflare 配置绕过源站登录的缓存规则。

## Tailscale Funnel

安装并登录 Tailscale 后：

```dotenv
COOKIE_SECURE=false
PUBLIC_TUNNEL_MODE=tailscale
```

运行 `./bin/start-public.sh`，地址为稳定的 `https://<device>.<tailnet>.ts.net`。

## 上线检查表

- 已创建一个强密码超级管理员；`.env` 不保留 `ADMIN_PASSWORD`。
- `HOST=127.0.0.1`，公网只有 HTTPS 隧道。
- 同时使用本机 HTTP 和公网 HTTPS 时保持 `COOKIE_SECURE=false`；服务会依据可信代理的 `X-Forwarded-Proto` 为公网会话自动添加 `Secure`。若禁用本机 HTTP 登录，可改为 `true`。固定域名时 `PUBLIC_ORIGIN` 完全匹配外部地址。
- 普通用户默认 `networkAccess=false`，按需单独开放。
- `.env` 与 tunnel token 权限为 `600`；`.data` 权限为 `700`。
- 已运行 `npm run check` 和测试账号端到端验收。
- 已明确告知用户：输入与项目片段会通过管理员的本机 Codex 登录发送给 OpenAI，且共享同一配额。
- Mac 禁止自动睡眠，ChatGPT/Codex 登录有效，服务有可靠的备份与日志轮转计划。
