# 项目执行与对话浏览器

老板和员工在普通项目选择 EXECUTE 后，可以要求 Agent 安装项目工具、读取网页或使用浏览器。Python 使用 `python3 -m venv .venv` 和 `.venv/bin/python -m pip` 安装依赖；全局安装不属于项目执行范围。安装验收应包含可执行程序、版本、依赖和实际功能，只有 skill 文档不能算 CLI 安装完成。

项目 `.venv/bin`、`.tools/bin` 和当前 access 的 `HOME/.local/bin` 自动进入每次命令 PATH；前一条命令安装完成后，下一条可以直接调用 CLI。独立二进制可放 `.tools/bin`。平台不预装 gh 或 Agent-Reach；只有用户提出相应任务才安装并验收。公开仓库可 clone 到当前项目的子目录，平台管理的 Git 元数据仍受保护；私有仓库需要项目授权的认证。

无需先安装工具：在普通项目 EXECUTE 对话点击“浏览器”，输入网址后点击“打开网页”，即可直接操作。也可以直接让 Agent 打开任意 HTTP(S) 网页。网页加载失败会保留浏览器，可手动更换地址或刷新。

网页需要登录或验证时，Agent 会请求接管并打开“浏览器”抽屉。点击“开始接管”，在网页画面中点击/拖动/滚动；选中网页输入框后在下方键盘输入栏输入，支持中文、粘贴、回车和退格。输入栏即时发送并清空，密码不需要发在聊天中。完成后点击“操作完成，交还 Agent”，Agent 会重新检查页面。仍被网站拦截时会返回实际结果；平台不能保证目标网站放行。

标签选择、返回和刷新位于抽屉顶部。“取消本次接管”或“结束会话”会关闭本次浏览器。收起只停止画面轮询；会话两分钟无活动或等待达到十分钟会结束。停止运行、退出相关登录、撤权或服务重启也会清理登录态。刷新工作台可以恢复本次仍活跃的浏览器；跨运行不保留网站登录。

## 管理配置

安装 Chrome 和可直接启动的 Python 3.10+，然后运行 `npm ci`。不下载 Playwright 自带浏览器。可在私有环境中设置：

| 变量 | 默认 |
| --- | --- |
| COMMAND_PYTHON_BIN | 自动发现 Homebrew Python |
| COMMAND_GIT_BIN | 自动发现 Homebrew/Command Line Tools 真实 Git |
| OUTBOUND_PROXY | system；也可设 direct 或无凭据 HTTP(S) 代理地址 |
| DEFAULT_NETWORK_ACCESS | true，仅影响新建账号 |
| PORTAL_BROWSER_ENABLED | true |
| PORTAL_BROWSER_BIN | /Applications/Google Chrome.app/Contents/MacOS/Google Chrome |
| PORTAL_BROWSER_MAX_SESSIONS | 2，可调低 |
| PORTAL_BROWSER_HANDOFF_TIMEOUT_MS | 600000，可调低 |

账号必须已有联网授权；浏览器不自动开启账号网络权限。隐私项目、EDIT、规划审核和子代理不能使用此浏览器。环境错误的 errorCode/recoveryHint 用于定位，不触发命令自动重试。修复资源或联网策略后，由用户或 Agent 核对副作用再重试。

现有禁网员工保持禁网；新建员工默认勾选联网，老板可取消或之后关闭。老板修改权限会安全结束旧运行；员工无需重新登录或新建对话，下一轮即采用新权限。

默认自动跟随 macOS HTTP/HTTPS 系统代理，不需要写死 VPN 端口。每条命令重新读取，浏览器使用 Chrome 原生系统代理监听；无系统代理时使用系统路由，支持 TUN。命令当前不解析 PAC 或仅 SOCKS 入口；此类配置返回明确提示，需由运维提供 HTTP(S) 入口。不会修改宿主 VPN、Git 配置或读取宿主代理账号。配置代理不可达时报告 PROXY_UNAVAILABLE，不自动改为直连；目标超时仍报告 COMMAND_TIMEOUT。节点切换可能打断正在下载的连接，恢复后先核对副作用再重试。

macOS Chrome 的所有进程由外层专用 Seatbelt 限制，内层 Chrome 沙箱因系统禁止嵌套而关闭。技术约束见 [架构规格](../spec/architecture/11-managed-browser.md)。发布前必须在 macOS 安装 Chrome 后执行完整 `npm run gate`，不能跳过浏览器测试。
