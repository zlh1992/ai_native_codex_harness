# 项目执行与对话浏览器

老板和员工在普通项目选择 EXECUTE 后，可以要求 Agent 安装项目工具、读取网页或使用浏览器。Python 使用 `python3 -m venv .venv` 和 `.venv/bin/python -m pip` 安装依赖；全局安装不属于项目执行范围。安装验收应包含可执行程序、版本、依赖和实际功能，只有 skill 文档不能算 CLI 安装完成。

网页需要登录或验证时，Agent 会请求接管并打开“浏览器”抽屉。点击“接管”，在网页画面中点击/拖动/滚动；选中网页输入框后在下方键盘输入栏输入，支持中文、粘贴、回车和退格。输入栏即时发送并清空，密码不需要发在聊天中。完成后点击“完成，继续”，Agent 会重新检查页面。仍被网站拦截时会返回实际结果；平台不能保证目标网站放行。

标签选择、返回和刷新位于抽屉顶部。“取消等待”或“结束会话”会关闭本次浏览器。收起只停止画面轮询；会话两分钟无活动或等待达到十分钟会结束。停止运行、退出相关登录、撤权或服务重启也会清理登录态。刷新工作台可以恢复本次仍活跃的浏览器；跨运行不保留网站登录。

## 管理配置

安装 Chrome 和可直接启动的 Python 3.10+，然后运行 `npm ci`。不下载 Playwright 自带浏览器。可在私有环境中设置：

| 变量 | 默认 |
| --- | --- |
| COMMAND_PYTHON_BIN | 自动发现 Homebrew Python |
| PORTAL_BROWSER_ENABLED | true |
| PORTAL_BROWSER_BIN | /Applications/Google Chrome.app/Contents/MacOS/Google Chrome |
| PORTAL_BROWSER_MAX_SESSIONS | 2，可调低 |
| PORTAL_BROWSER_HANDOFF_TIMEOUT_MS | 600000，可调低 |

账号必须已有联网授权；浏览器不自动开启账号网络权限。隐私项目、EDIT、规划审核和子代理不能使用此浏览器。环境错误的 errorCode/recoveryHint 用于定位，不触发命令自动重试。修复资源或联网策略后，由用户或 Agent 核对副作用再重试。

macOS Chrome 的所有进程由外层专用 Seatbelt 限制，内层 Chrome 沙箱因系统禁止嵌套而关闭。技术约束见 [架构规格](../spec/architecture/11-managed-browser.md)。发布前必须在 macOS 安装 Chrome 后执行完整 `npm run gate`，不能跳过浏览器测试。
