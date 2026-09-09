# 2026-09-10 老板与员工固定域名

| 字段 | 内容 |
| --- | --- |
| 状态 | 阻塞（本地适配通过门控，云端待同事） |
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
- DNS 与 token 未就绪不得停掉现有公网服务；新入口不可用不得宣称上线。
- DEV-003 要求 macOS 完整 gate；所有凭据保持本机私有文件且不输出。

## 实施计划

1. 增加可验证的多 origin/角色配置及 ingress 校验，兼容未配置的 quick 模式。
2. 补充角色地址输出、named 前置检查与双域名健康检查。
3. 更新架构及操作指南，运行针对性测试和完整 gate。
4. 取得 Cloudflare 账号或现成隧道配置后备份这两条 DNS，配置同一隧道、保存 token，排空后切换并验收。

## 实际改动

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
| 相对 Markdown 链接检查 | 通过 | Node 扫描 git tracked/untracked Markdown 链接，168 项，0 缺失 |
| 本地和既有 Quick Tunnel `/api/health` | 通过 | 都为 ok、codex ready、nativeCodexMemory=false |
| 两个固定公网入口 | 未执行 | 缺少同事云端隧道配置/凭据；本机 Host 模拟不冒充公网验收 |

## 结论

graph 本机适配已完成并通过完整门控；固定域名上线目标尚未完成。运行中的旧服务和 Quick Tunnel 已复核在线，未影响生产运行。无数据迁移与生产测试数据残留。用户随后要求将本次代码和文档提交并推送到远端 graph；源码发布不代表固定域名已经部署。

## 遗留事项

- 同事在管理 winy.cc 的 Cloudflare 账号创建 remotely-managed tunnel，将两个工作台域名都配置到 `http://127.0.0.1:4310`，并备份/替换这两条旧 A 记录为该隧道代理 CNAME。
- Connector token 通过本机 `./bin/save-cloudflare-tunnel-token.sh` 隐藏输入保存，不粘贴到聊天或日志。收到已配置确认后更新部署 `.env`，检查活跃运行并排空，重启 Portal，显式切换到 named，完成 HTTPS、登录、上传、真实 Codex 与 SSE 外网验收。
- 云端身份由同事管理；不能用原阿里云账号假定具有该域名的 Cloudflare 管理权。
