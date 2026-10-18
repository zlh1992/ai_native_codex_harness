# 11 Portal 交互浏览器与命令环境

## 能力与边界

普通项目 EXECUTE root 可调用 Portal 的 `browser_open`、`browser_snapshot`、`browser_action` 和 `browser_handoff`。每次操作复验活动用户、联网策略、私有 chat、当前 access 和运行身份。用户也可从当前普通 EXECUTE 对话直接输入网址启动人工会话；该上下文由后端构造，不接受客户端运行身份。人工会话使用同一容量和隔离规则，不占模型运行席位。下一轮 Agent 调用浏览器时绑定该运行，并保留页面和人类控制权直到明确交还。EDIT、local_private、planner/reviewer、子代理和跨 chat 调用均拒绝。Codex 内置浏览器、电脑控制和原始 CDP 仍不开放。

每个 chat 最多一个浏览器，全局默认且最多两个（可调低）。浏览器由 playwright-core 启动本机 Chrome 的独立临时 profile，不连接日常 Chrome，不复用宿主 Cookie、扩展、密码库或配置。仅接受无 URL 用户名/密码的 HTTP(S) 导航，禁止任意 file 导航、文件上传接口及下载落盘。网络能力沿用账号联网授权，未额外声明公网地址或域名白名单。

## macOS 沙箱

Chrome 主进程及所有 helper 继承外层专用 Seatbelt。该 profile 开放浏览器 app、系统运行库、TLS/解析配置和必要系统 Mach 服务，写权限只限本次会话临时目录；不开放项目文件、宿主主目录、Keychain、剪贴板、其他 runtime 或其他浏览器会话。Chrome rendezvous Mach 名精确绑定启动 PID。

macOS 拒绝已有 Seatbelt 进程再次初始化沙箱（`forbidden-sandbox-reinit`）。因此 Chrome 内层沙箱关闭，外层 profile 始终保留，启动失败不能回退到无外层隔离。该实现提供会话文件边界，不宣称 Chrome 原生每 renderer 隔离或敌对租户容器。临时 HOME、CFFIXED_USER_HOME、TMPDIR、MAC_CHROMIUM_TMPDIR 均指向同一会话目录。

## HTTP 和前端

| 接口 | 行为 |
| --- | --- |
| POST /api/chats/:chatId/browser | 打开 HTTP(S) 地址并由当前 Web session 接管；允许空闲普通 EXECUTE chat |
| GET /api/chats/:chatId/browser | 当前状态和标签页；已结束返回 closed |
| GET /api/chats/:chatId/browser/frame | 当前页 JPEG，no-store |
| POST /api/chats/:chatId/browser/actions | 持有人类控制权的 Web session 输入、鼠标、滚轮、导航或标签切换 |
| POST /api/chats/:chatId/browser/control | takeover / continue / cancel |
| DELETE /api/chats/:chatId/browser | 结束当前会话 |

所有接口沿用员工 session selector、Origin、chat/access 校验；写接口要求 session-bound CSRF。异步返回前复验，客户端不能传 thread、cwd、profile 或 CDP 地址。JPEG 仅在抽屉打开且页面可见时轮询；远端 HTML 不进入 Portal DOM。人工输入从前端内存即时清空，不进入工具明细、事件或服务日志。

## 控制权和生命周期

Agent 请求 handoff 后暂停等待。用户接管绑定当前 Web session，其他登录会话不能输入。用户点击继续后重新读取真实页面；仍是验证页时必须如实返回，不能把点击继续当作验证通过。控制权切换与网页操作共享串行队列；前端交还前排空已发送输入并丢弃旧轮询响应，避免过期状态再次启用输入。主动接管也暂停后续浏览器工具；归还后先返回新页面，旧元素动作不自动重放。取消、关闭、拒绝和最长十分钟超时明确结束等待。

浏览器在关联运行终态、停止、撤权、停用、chat/project 删除、相关 Web session 注销、服务退出时关闭；空闲人工会话同样受停止/删除/撤权及超时清理。完成关闭和临时 profile 清理后才释放 root/EXECUTE 容量。两分钟无工具或前端活动视为断线，关闭会话。浏览器进程退出也关闭会话。关闭有定时 TERM/KILL 兜底，只信号 PID 与本会话 profile 参数同时匹配的进程组。

人工空闲会话仅保留内存状态；绑定运行后只用既有 turn_events 保存 browser_state 的 id/state/control/handoff，不新增业务表；不保存画面、URL、原因、Cookie 或输入。页面文本按模型工具请求返回，只属于受 chat ACL 保护的原生上下文；浏览器调用整体跳过 tool_details 和 Luna 摘要。重启不恢复登录态，清理遗留临时 profile，旧接口状态为 closed。

首次页面导航与 Chrome 进程启动分别处理：启动失败返回 BROWSER_UNAVAILABLE 并清理；导航失败返回 BROWSER_NAVIGATION_FAILED，保留当前会话用于检查、手动刷新或更换网址。快照失败也不冒充启动失败。所有操作不自动重放。

## 命令运行环境

命令使用可取消队列，同一 run 串行，全平台同时启动命令不超过 EXECUTE 容量；出队前再次验证运行和授权。取消排队不会启动命令。固定 `ulimit -u` 删除，因为它限制整个 OS 账号，不能表示每个任务的进程配额。保留墙钟、CPU、FD、输出字节限制及进程组取消，不承诺硬磁盘或进程数隔离。

可信只读工具目录将 python/python3 绑定到可直接启动的 Python 3.10+，git 绑定到真实 Git 并显式设置该安装的 HTTP helper 和模板路径，避免开发工具启动器及重定位失败。用户 HOME、临时目录、pip/npm 缓存按 access 隔离。每条命令 PATH 优先包含当前项目 .venv/bin、.tools/bin，再包含只读工具及 access HOME/.local/bin；项目入口仍经过路径检查与 Seatbelt。pip 默认要求虚拟环境，Agent 应建立项目 .venv 并核对真实 CLI、依赖、版本和功能。TLS/证书/解析配置只读开放；宿主凭据、其他项目和 runtime 仍拒绝。结构化错误区别环境资源故障、禁网、代理连接失败、工具未安装、超时和人工操作；任何失败均不自动重放。

## 系统 VPN 与账号网络

OUTBOUND_PROXY 默认为 system：每条获准联网的普通命令在实际启动前读取 macOS HTTP/HTTPS 系统代理，注入 curl/Git/pip/npm/gh 使用的有限代理变量，localhost/127.0.0.1/::1 绕过代理。没有代理时使用 OS 路由（含 TUN）；读取失败、配置无效或只有 PAC/SOCKS 时明确失败，不静默猜测端口或回退直连。显式无凭据 HTTP(S) 地址和 direct 为运维覆盖选项；不导入宿主认证、用户环境或全局 Git 配置。

system 浏览器不固定启动代理，沿用 Chrome 对 SystemConfiguration 的监听，系统代理更新影响后续网络连接且不重建登录 profile；显式/direct 则只作用于新启动浏览器。节点切换保持本地代理入口时由外部 VPN 路由新连接。已建立连接可能中断，平台不保证续传，也不自动重放网页动作或安装命令。

账号权限优先于代理。默认值只用于新账号，员工显式 false 和既有禁网保持；管理看板返回 defaults.networkAccess 供创建表单使用，编辑表单始终显示账号实际值。权限切换排空旧运行，现有 Web session 和 chat 的下一轮读取新权限，无需重登或重启。

操作步骤见 [执行与浏览器指南](../../docs/EXECUTION_BROWSER.md)，发布验收见 [发布契约](07-e2e-release-contracts.md)。
