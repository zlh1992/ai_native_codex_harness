# 2026-09-10 老板与员工固定域名

| 字段 | 内容 |
| --- | --- |
| 状态 | 已部署（2026-09-11 固定入口验收通过） |
| 日期 | 2026-09-10 |
| 负责人 | Codex |
| 关联目标 | graph 通过 Named Tunnel 提供两个固定角色入口 |
| 影响范围 | HTTP 入口、配置、启动脚本、运维、测试 |
| 架构规格 | [约束](../architecture/02-project-constraints.md)、[安全](../architecture/04-security-and-trust-boundaries.md)、[运维](../architecture/08-operations-protocol-and-evolution.md)、[门控](../architecture/07-e2e-release-contracts.md) |

## 背景与证据

用户授权将老板入口部署到 workbench1.winy.cc/boss/login，员工入口部署到 workbench2.winy.cc/employee。两个 hostname 当前均为家庭出口 A 记录，Portal 仍通过 Quick Tunnel 在线。本机未发现 Cloudflare certificate 或 named tunnel token；控制台访问暂未成功，云端配置仍待实际账号访问。

## 目标与非目标

### 目标

- 同一 Portal 支持两个明确的 HTTPS origin，各自提供角色地址与根路径跳转。
- 固定 Host/Origin 校验、Cloudflare 客户端 IP 校验；继续允许本机回环访问。
- named 模式校验全部入口，防止旧 quick 进程被误认为新部署成功。
- 凭据和 DNS 就绪后切换、验证真实公网链路。

### 非目标

- 不购买服务、不迁移整个 DNS zone、不开放家庭入站端口、不变更模型、账号或记忆边界。
- 此次不扩展到无人登录启动和整机电源管理。

## 约束与风险

- RUN-002、RUN-003、RUN-006 与 PRD-001/003/007 保持有效。
- DNS 与 token 未就绪不得撤下旧公网隧道；双域名配置预装时须暂时保留旧域名白名单并验证旧入口，新入口不可用不得宣称上线。
- DEV-003 要求 macOS 完整 gate；所有凭据保持本机私有文件且不输出。

## 实施计划

2026-09-11 收尾：两域名权威 DNS 已返回 Cloudflare 地址，真实 HTTPS 登录页面及 ready health 均通过。切换正式 named 管理，移除并行 connector 与旧 quick 白名单；修正启动脚本末尾 quick-only 判断导致 named 成功却返回非零的问题，再运行 gate 并复查公网。

1. 增加可验证的多 origin/角色配置及 ingress 校验，兼容未配置的 quick 模式。
2. 补充角色地址输出、named 前置检查与双域名健康检查。
3. 更新架构及操作指南，运行针对性测试和完整 gate。
4. 取得 Cloudflare 账号或现成隧道配置后备份这两条 DNS，配置同一隧道、保存 token，排空后切换并验收。

## 实际改动

- 2026-09-11：权威 DNS 的两个域名均已返回 Cloudflare 地址。真实 HTTPS 的老板/员工登录页返回 200、`/api/health` 为 ready、未登录 `/api/me` 返回 401、根路径按角色返回 302。
- 已把本机 `.env` 切换为 named、主地址为老板域名，移除旧 Quick hostname 白名单；检查无活跃运行后重启 Portal。正式 `com.codex-harness-remote.tunnel` 建立四条连接后移除 `named-preflight`，停止旧 Quick Tunnel。清理后两固定域名再次通过实际 HTTPS 验证。
- 修正 `start-tunnel.sh` 最后的 quick-only 判断，避免 named 成功后返回 1。实际 named 启动已退出 0；角色地址输出正确。

- 2026-09-10 用户提供 connector 凭据并授权继续部署：先以私有 token 文件启动并核验远程路由；云端路由齐备后备份配置、检查活跃运行、切换 Portal 与隧道并核验两角色地址。凭据不写入 tracked 文件或日志。
- 部署续跑基线为 graph `3a07d13`。已保存 Git 忽略目录下的 token 文件（0600、父目录 0700），用项目独立 cloudflared 与 `--token-file` 启动并行 connector，launchd label 为 `com.codex-harness-remote.named-preflight`。未使用 sudo 或全局 Homebrew 服务，不影响其他项目。
- Connector 建立四条 HTTP/2 连接；收到云端配置 version 2，两个 hostname 均指向 `http://127.0.0.1:4310`，fallback 为 404。这证明隧道凭据及应用路由有效。
- 权威 DNS 和经代理的 Cloudflare DNS-over-HTTPS 查询仍返回旧家庭出口 A 记录；普通 HTTPS 连接未通过。Connector 凭据不提供 DNS 管理权限，已请求同事替换为该隧道的代理 CNAME 并确认 zone Active。
- 用户回复 DNS 已操作后复查权威 DNS/公共 DoH 仍为旧 A。已使用 SQLite backup API 与私有 `.env` 备份（`.data/deployment-backups/before-named-20260910.*`），然后预装双域名与 Cloudflare 代理校验配置并重启 graph Portal。临时将旧 Quick hostname 保留在 `PUBLIC_ORIGINS`，实际健康检查确认旧入口仍可用；两角色模拟 Host 的页面均返回 200，但不能替代真实公网验收。
- Quick Tunnel 未停止，正式模式仍为 quick。并行 named connector 保留等待 DNS；正式切换成功时应移除临时 label 与旧 Quick hostname 白名单，避免重复 connector/残留入口。

- `public-ingress` 统一解析多 origin/角色 origin 并校验 Host、写请求 Origin 与 Cloudflare 代理身份；服务端 Cookie 与审计 IP 使用该入口上下文。
- 两个固定域名根路径分别跳转角色入口；本机仍支持回环 HTTP，Cookie 不设置父域 Domain。
- 启动脚本先校验 named token 与 origin，再检查已运行模式，配置不符不停止旧隧道也不伪报切换成功；新启动时检查主域名和两个角色域名的 ready JSON。
- 增加三项 ingress 单元场景与真实 HTTP/fake Codex 的隔离端到端场景；既有 E2E 显式清空新环境字段，避免未来部署 `.env` 污染测试。
- 更新安全、运维、门控架构及公网操作指南。现有临时 launchd 生命周期保留，无人登录启动不在此次范围。
- 未改本机 `.env`、未保存凭据、未修改 DNS、未重启运行中的 Portal/Quick Tunnel。用户确认 Cloudflare 必须由同事操作。

## 数据、接口与安全影响

- 数据迁移：无。
- API/协议：业务接口与 Codex pin 不变；增加多 origin 配置。
- 权限与秘密：不改 ACL，token 不进入源码、日志或报告。
- 回滚：恢复原配置与隧道，保留业务数据；云端修改前保存原 DNS 可恢复信息。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `node --test test/public-ingress.test.mjs test/config.test.mjs` | 通过 | 4 项，覆盖配置、Host、Origin、CF IP 与本机兼容 |
| `node --test test/e2e/public-ingress.test.mjs` | 通过 | 隔离临时库和 fake Codex 的真实 HTTP；测试账号与临时目录已删除 |
| `git diff --check` | 通过 | 无空白错误 |
| `npm run gate` | 通过 | macOS：102 单元/集成 + 18 E2E，0 失败/跳过；包括 Seatbelt 与原有 release gate |
| `npm run gate`（部署续跑 `3a07d13`） | 通过 | macOS：110 单元/集成 + 18 E2E，0 失败/跳过 |
| 私有 token 文件与并行 connector | 通过 | 0600，Git ignored；四条连接，云端双 hostname 路由正确 |
| 当前活跃运行与后台任务 | 通过 | 只读汇总无非终态 turn，无运行中的 workflow job；未改业务数据 |
| 相对 Markdown 链接检查 | 通过 | Node 扫描 git tracked/untracked Markdown 链接，168 项，0 缺失 |
| 本地和既有 Quick Tunnel `/api/health` | 通过 | 都为 ok、codex ready、nativeCodexMemory=false |
| 两个固定公网入口（2026-09-11） | 通过 | 真实 HTTPS GET 登录页 200，ready health，未登录 API 401，角色根路径 302；未提交真实账号密码 |
| 双域名配置预装后本地与旧公网 `/api/health` | 通过 | graph 重启后均 ok、codex ready，原生记忆关闭 |
| 权威 DNS TCP 与两家公共 DoH（2026-09-10 历史） | 当时未通过 | 当时仍为旧家庭 A；2026-09-11 已解析到 Cloudflare 地址 |
| `./bin/stop-local.sh && ./bin/start-local.sh && ./bin/stop-tunnel.sh && ./bin/start-tunnel.sh` | 通过 | 空闲时切换；named 启动返回 0，两个域名 ready |
| `npm run gate`（2026-09-11 收尾） | 通过 | 110 单元/集成 + 18 E2E，0 失败/跳过 |

## 结论

2026-09-11 固定域名已部署到 graph，真实 HTTPS 入口、角色跳转、健康检查与未登录保护通过。正式 named connector 接管，临时 connector 和旧 Quick 入口已撤下，本机地址保留。未向生产写入测试账号/项目，也没有改用户密码；本轮未执行真实密码登录、上传或模型长对话，因此不宣称这些业务冒烟已完成。

回滚时保留业务数据与 token，可停公网并继续使用回环入口；若重新开启 Quick Tunnel，会产生新的临时 URL，必须同步临时 origin 白名单，不能承诺原 Quick 地址恢复。

## 遗留事项

- DNS 和正式隧道切换已完成；用户可用现有账号继续进行实际登录和长对话验证，结果不包含在本轮入口验收结论中。
- 云端身份由同事管理；不能用原阿里云账号假定具有该域名的 Cloudflare 管理权。
