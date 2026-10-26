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

## 一个 Named Tunnel、两个角色域名

在管理目标域名的同一个 Cloudflare 账号中建立 remotely-managed tunnel，两条 Published application 都指向 `http://127.0.0.1:4310`。源站地址指运行 cloudflared 的 Mac，不能填写家庭公网 IP。备份这两个 hostname 的旧 DNS 记录后，将冲突 A 记录替换为指向该 tunnel UUID 的代理 CNAME；其余 DNS 记录不动。

```dotenv
PUBLIC_TUNNEL_MODE=named
PUBLIC_URL=https://workbench1.winy.cc
PUBLIC_ORIGIN=https://workbench1.winy.cc
BOSS_PUBLIC_ORIGIN=https://workbench1.winy.cc
EMPLOYEE_PUBLIC_ORIGIN=https://workbench2.winy.cc
TRUST_PROXY=true
TRUST_PROXY_PROVIDER=cloudflare
COOKIE_SECURE=false
```

操作顺序：先在控制台准备隧道/域名和证书，将 connector token 用 `./bin/save-cloudflare-tunnel-token.sh` 隐藏输入保存；完成门控并排空运行后重启本地服务，再显式停止旧 quick 隧道并启动 named 隧道。缺 token 或配置不同不会自动停止旧隧道。主域名与两角色域名都通过 ready 健康检查才算隧道启动通过。

老板入口为 `https://workbench1.winy.cc/boss/login`，员工入口为 `https://workbench2.winy.cc/employee`。根路径分别跳到对应登录入口；两个域名独立 Cookie/登录，但后端 ACL 决定权限。通过 `127.0.0.1:4310` 的本机入口仍可用。仅修改 `.env` 不会更新已经运行的 Portal。

此配置无需购买 ECS、家庭公网 IP、DDNS 或路由器入站映射。不要向聊天或日志粘贴 token；交接时将 token 保存到本机私有文件。固定地址只保证名称不随隧道重启变化，不承诺断电、未登录 macOS 或网络故障时在线。

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

## 角色入口与分享历史

老板本地入口为 [老板登录](http://127.0.0.1:4310/boss/login)，员工为 [员工登录](http://127.0.0.1:4310/employee)。公网在同一 HTTPS 域名后分别加 `/boss/login`、`/employee`；`PUBLIC_ORIGIN` 仍只配置 origin，不含这些路径。老板登录后进入 `/boss`，自己的项目工作台位于 `/boss/workbench`。

新 share 会把老板在该项目已有的所有对话与文件一并分享。每名员工获得独立 Git worktree 与独立 Codex 对话副本，可以直接从历史继续；后续员工和老板的聊天相互独立，文件也不会自动写回，任务验收交付仍通过 submission。分享要求老板工作区空闲；任何对话 fork 失败则整次授权失败，可排查后重试。恢复保留的旧授权会继续使用员工原有对话，不重新复制或覆盖；升级前已有的 active 授权不会被自动补发历史。

## 固定 Codex 二进制

本项目协议固定为 `0.164.0-alpha.11.1`。ChatGPT App 自动更新可能替换其内置二进制；运行中的旧进程继续在线不代表下一次重启仍兼容。若 `--version` 或 initialize 版本不同，应准备官方同一精确版本的完整独立运行包，把本机 `.env` 的 `CODEX_BIN` 指向该版本的可执行文件，再运行完整 gate 与隔离真实冒烟。不要只修改 pin 字符串绕过检查。

独立运行包可来自相同精确版本的官方 npm 架构包，或本机官方 App 的完整 `codex-cli` 包；保留 app bundle、资源与辅助二进制，不能只复制入口 shell 脚本。当前验证包保存在 `.tools/codex-0.164.0-alpha.11.1/`，`CODEX_BIN` 指向其中 `CodexCLI.app/Contents/MacOS/codex`；`.tools` 与 `.env` 不提交 Git，旧版本留作回滚。升级协议仍按 [协议升级流程](../spec/architecture/08-operations-protocol-and-evolution.md) 执行。

## 无本地 Qwen 的部署

设置 `LOCAL_QWEN_ENABLED=false`，保留隐私项目数据和 ACL；隐私执行会明确拒绝，不会回退云端。普通项目默认 `CODEX_MODEL=gpt-5.6-sol`，老板和员工可选择 GPT-5.6 Sol/Terra/Luna 与 GPT-6.1 Sol，Astra 不在允许名单。必须分别通过真实推理验收，目录或健康状态不代表账号可用。复用已有数据库时先做一致性备份和副本迁移验证；使用 Portal 启停脚本切换，避免统一 services 脚本启动尚未配置的微信绑定。
