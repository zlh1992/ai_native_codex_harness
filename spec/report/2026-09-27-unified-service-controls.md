# 2026-09-27 统一服务启停与备忘录命令

| 字段 | 内容 |
| --- | --- |
| 状态 | 阻塞（启停与四入口登录已验收；完整发布门控尚未通过） |
| 日期 | 2026-09-27 |
| 负责人 | Codex |
| 关联目标 | 一条启动命令完整启动 Portal、公网隧道和微信 relay，关闭/重启/状态一致，并重新生成二维码 |
| 影响范围 | 生命周期脚本、运维文档、运行配置、本机备忘录 |
| 架构规格 | [约束](../architecture/02-project-constraints.md)、[生命周期](../architecture/05-execution-concurrency-and-lifecycle.md)、[发布契约](../architecture/07-e2e-release-contracts.md)、[运维](../architecture/08-operations-protocol-and-evolution.md) |

## 背景与证据

Portal 当前由手动后台进程启动，原脚本仅识别 launchd，因此误报停止，且不能完整接管启停。用户已授权先关闭全部项目服务，再启动并重置微信绑定。本机没有活动 turn/channel event。

## 目标与非目标

- 提供 start/stop/restart/status/health/reset-wechat-qr.command 入口，复用当前业务服务、项目数据和角色域名。
- 保留 launchd 默认模式；为 Documents 后台访问受限的当前部署增加显式 detached 模式，由同一套脚本通过 PID、启动时间、完整进程命令记录管理。该模式不承诺登录自动启动或崩溃自动拉起。
- 不更改模型、项目权限、数据库业务逻辑及其他已有未提交改动。

## 约束与风险

- RUN-005 扩展允许明确配置的 detached 运维模式，所有模式须验证进程归属；不使用 killall、不杀占用端口的未知程序。
- 用户已授权服务短暂停机和重置绑定；重置使用现有备份流程，重新扫码必须由用户完成。
- 日志/说明不包含 token 或其他凭据。DATA 和 SQLite 保持原位。

## 实施计划

1. 增加带锁和进程身份校验的 detached 进程控制器，接入现有 start/stop/status。
2. 增加整套快捷入口，启动顺序 Portal→公网→微信，关闭顺序微信→公网→Portal，健康检查验证引擎就绪。
3. 验证旧进程归属后关闭旧部署；用相同快捷脚本启动、检查重复启动、重启，再生成二维码。
4. 重启后验证本地/公网的老板/员工登录与受保护页面；老板密码不可用时由用户在页面输入，员工可使用隔离临时测试账号，不改已有密码。
5. 更新 README、架构、备忘录；执行针对性测试、npm run gate、diff 与相对链接检查。

## 实际改动

- 新增 `bin/background-process.py`，使用文件锁和 PID/UID/启动时间/完整命令身份管理 detached 进程，拒绝 PID 复用后的误杀。
- `_common.sh` 将两种模式统一到同一启动、停止和状态接口；本机 `.env` 设置 detached。修正 start-tunnel 使用已解析的 NODE_BIN，极简 PATH 下也可运行。
- `bin/services.sh` 及项目根目录 6 个 `.command` 串联 Portal、公网、微信服务和二维码重置。
- 更新 README、SERVICE_CONTROL 操作文档、RUN-005、运维与测试契约，并替换本机既有备忘录。
- 一次性核对旧手动 Portal 的命令/cwd，先关闭旧 relay/隧道和该进程，确认 4310/18767 都无监听，再用统一命令启动。随后实际执行重复 start 和完整 restart。


## 数据、接口与安全影响

无业务 schema/API 变化；新增私有进程记录。回滚先用新脚本停服，再恢复代码和原运行模式；微信旧绑定在运行目录备份，不自动恢复。

## 验证

| 命令/场景 | 结果 | 证据 |
| --- | --- | --- |
| `node --test test/background-process.test.mjs` | 通过 | 重复启动同 PID；身份不匹配拒绝 stop；正确停止 |
| `./stop.command` + 旧进程核验清理 | 通过 | 4310、18767 均无监听；未使用 killall |
| `./start.command`、再次 `./start.command` | 通过 | Portal Codex ready、公网双域名健康、relay running；重复启动复用 PID |
| `./restart.command` | 通过 | 全部关闭后重新启动，新的受管理 PID 及正确状态 |
| 极简 PATH `/usr/bin:/bin:/usr/sbin:/sbin` 下 status/health | 通过 | Python 子进程执行两脚本 exit 0；Node 使用桌面 App 后备路径 |
| `./reset-wechat-qr.command` | 通过 | 旧绑定已备份，新二维码生成后用户确认已连接；随后 status/health 返回 bound=true、phase=running |
| 扫码后 `./status.command && ./health.command` | 通过 | Portal Codex ready、受管理隧道运行、relay bound=true/running；verified=false，因此不将健康状态当作新绑定后的消息往返验收 |
| 本地老板实际登录 | 通过 | 用户在页面输入密码，浏览器进入老板工作台并加载受保护项目/任务 |
| 公网老板实际登录 | 用户确认通过 | 用户明确确认登录成功，当前浏览器地址为公网 /boss/workbench?view=tasks；自动化读取超时，未取得页面内容的独立复核 |
| 本地/公网员工实际登录 | 通过 | 随机密码临时员工登录 200，/api/me 身份匹配，项目接口 200，管理员接口 403，注销 200 |
| `npm run gate` | 未通过 | 154 项，145 通过、9 失败；仍为既有 linkedom 缺失及提取/搜索环境失败，未进入 E2E |
| `bash -n bin/*.sh *.command`、`git diff --check`、相对 Markdown 链接 | 通过 | 无语法/空白/断链错误 |
| 备忘录与六个根目录快捷脚本核对 | 通过 | 本机备忘录中六条绝对路径与实际可执行文件一致；均转发至 bin/services.sh 对应动作，状态显示 Portal/隧道/relay 正常 |


## 清理与结论

启停、重启、状态与二维码重置均已经实测，备忘录和 README 使用相同入口。Portal 数据/项目/历史保持原位。员工验收只创建一个无项目无网络权限的临时 user，验证后停用并撤销全部 session；随机密码只存验证进程内存。未修改任何已有账号密码。原绑定备份只保留在本机微信私有运行目录。

微信扫码绑定已由用户确认且后台核实。公网老板随后由用户明确确认登录成功，浏览器当前地址已进入公网老板工作台；自动化读取仍超时，因此公网老板验收依据为用户操作确认及当前地址，不声称已独立读取受保护页面内容。整套启停入口、四入口登录及备忘录对齐已完成，完整 gate 的 9 项环境/依赖失败仍未解决，不能声称完整发布门控通过。detached 不承诺开机自启或崩溃自动拉起，已写入备忘录。

## 遗留事项与恢复入口

- 公网老板的自动化页面内容复核受浏览器工具超时限制；用户实际登录已确认。
- 新绑定后的微信消息往返尚未实测；当前确认的是绑定及 relay 运行状态。
- 完整发布门控：补齐既有测试依赖、定位提取/搜索环境失败后重跑 `npm run gate`；保留原有测试与契约，未跳过或弱化。
