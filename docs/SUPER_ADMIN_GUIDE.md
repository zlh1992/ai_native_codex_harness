# 超级管理员使用指南

## 模型与 Token 用量

老板和员工均可在普通对话顶部选择现有七种 GPT。模型与推理强度按对话保存，刷新继续使用；默认模型 Sol，员工默认 medium，老板默认 high（可由运行配置调整）。对话正在运行、恢复或存在待处理消息时，先等待或处理队列再修改。子代理固定 Luna，搜索和工具摘要固定 Luna-low。隐私项目仍使用运维固定的本地模型。

驾驶舱“模型用量”提供 GPT 总量、老板 GPT、员工 GPT 和本地 DeepSeek 四项。默认近 7 天、北京时间，可按用户、引擎和模型筛选，查看每日趋势、员工、模型强度与调用类别。包含本网站主对话、子代理、搜索、工具摘要及本地压缩，不含桌面或其他 CLI 调用，也不表示订阅剩余额度或费用。

输入包含缓存、输出包含上游报告的推理 Token，细项不能再加到总量。界面显示采集起点与更新时间，不回填旧账。“数据不完整”代表存在未上报、基线不确定或仍在执行的调用，数值只是已上报量；全无 usage 时总量为“—”。“引擎未启用”是 DeepSeek 运行状态。页面可见时每 30 秒更新，也可点击刷新。

## 首次建立账号

```bash
cd /Users/zlh1992_home/Documents/ChatGPT/codex-harness-remote
./bin/install-mac.sh
./bin/create-super-admin.sh
```

密码在终端隐藏输入，不会进入 shell history。忘记密码时：

```bash
node src/cli.mjs reset-password --username=superadmin
```

重置密码会立即撤销该账号的全部 Web 会话。

## 驾驶舱

超级管理员登录后会直接进入独立的老板驾驶舱；右上角“我的工作台”只打开老板自己拥有的项目。这里显示：

- 用户总数、活跃用户、项目、对话与正在运行的 Codex turn。
- 每个用户的状态、网络权限、项目数、空间用量、上限和最近登录。
- 所有项目的所有者、说明和授权状态。员工自有项目只显示元数据，超级管理员身份不会获得其文件或对话权限。
- 老板自己的项目可同时授权多名启用员工，每人得到独立 worktree。系统复制 owner 当前 HEAD、已跟踪修改和未跟踪文件；撤权先禁止新访问并等待 turn/approval/subagent/lease 排空，干净 tree 自动移除，脏 tree 原地保留，再次授权同一员工会恢复原 tree。
- 最近的登录、用户、项目、文件、对话和 turn 审计事件。

## 新建用户

驾驶舱点击“创建用户”，填写用户名、显示名称和至少 12 位的初始密码。建议：

- 默认关闭公网命令；确需 `npm install`、Git fetch 或联网构建时再开启。
- App Server 全局 turn 硬上限为 40，Portal 同时运行的 root turn 硬上限为 11，默认 EXECUTE 可占用全部 11 个 lease；如需控制某个账号的资源占用，可在“管理”中单独调低。
- 默认给 2 GB、100 个项目，观察空间和 Codex 配额后调整。
- 通过独立安全渠道发用户名和初始密码，要求用户首次登录后由管理员重置成约定的新密码。目前没有自助改密入口。

“管理”可停用员工、调整网络/配额或重置密码。停用和重置密码都会撤销此用户现有会话。系统只允许一个超级账户；Web 和 CLI 都不会创建第二个老板账号。

## 项目授权与文件恢复

老板在驾驶舱只能打开自己的项目；员工项目不能因管理员身份打开。老板自己的工作台和员工获授权后的工作台仍支持：

- `＋文`：按项目相对路径创建文本文件。
- `＋夹`：创建目录。
- `上传`：上传文本或二进制文件。
- 点击文本文件：在编辑器中修改并保存。
- SVG/图片、DOT 同名 SVG、PDF、Excel、CSV/TSV、Markdown、JSON 和源代码可在右侧直接预览；预览与源码可切换，原文件也可下载。
- 拖动项目栏/对话栏、对话栏/文件栏之间的竖向分隔线，以及文件列表/预览区之间的横向分隔线可调整空间；双击分隔线恢复默认尺寸。
- “移到废纸篓”：可恢复删除。

废纸篓位于：

```text
.data/trash/<actor-user-id>/files/<project-access-id>/
.data/trash/<owner-user-id>/projects/
```

界面暂不自动恢复，避免误覆盖。停止服务后在 Finder/终端确认目标，再移回原项目目录；所有恢复操作应单独记录。

## 日常运维

```bash
./bin/healthcheck.sh
./bin/status.sh
tail -f "$HOME/Library/Logs/CodexHarnessRemote/server.log"
node src/cli.mjs list-users
npm run check
npm run gate
```

进程管理：`start-public.sh` 启动本地服务和公网隧道；`stop-tunnel.sh` 只关闭公网；`start-tunnel.sh` 恢复公网；`stop.sh` 才会关闭全部。本项目使用自己的 `.tools/cloudflared`，不依赖其他 Harness 项目的进程或工具目录。

修改 `.env` 后重启服务。升级 Codex 或修改权限、任务、事件代码后必须运行 `npm run gate`。它固定执行“老板项目 → 双员工独立授权 → 同 access 多 chat 并发/浏览器文件锁 → 运行中项目禁止删除 → 员工任务提交 → 老板审核推进 → SSE 游标重放及跨边界拒绝 → 运行中撤权排空 → 脏树恢复 → resume 失败显式恢复”的隔离端到端验收。

请从 macOS 主机终端或具备 loopback 监听及 Seatbelt 权限的 CI 执行完整门控。受限代理沙箱通常禁止监听临时端口及嵌套 `sandbox-exec`；遇到这类环境错误应切换到主机执行，不能跳过安全和 HTTP 端到端用例后宣称门控通过。

## 事件处理

怀疑账号泄露：在驾驶舱停用用户或重置密码；检查审计；按需关闭隧道。怀疑 Cloudflare token 泄露：在 Cloudflare 控制台旋转 token，重新运行 `save-cloudflare-tunnel-token.sh`。怀疑本机 Codex 登录泄露：先停止 Harness，再在 Codex/ChatGPT 中撤销登录并重新认证。

## 角色入口与分享历史

老板本地入口为 [老板登录](http://127.0.0.1:4310/boss/login)，员工为 [员工登录](http://127.0.0.1:4310/employee)。公网在同一 HTTPS 域名后分别加 `/boss/login`、`/employee`；`PUBLIC_ORIGIN` 仍只配置 origin，不含这些路径。老板登录后进入 `/boss`，自己的项目工作台位于 `/boss/workbench`。

新 share 会把老板在该项目已有的所有对话与文件一并分享。每名员工获得独立 Git worktree 与独立 Codex 对话副本，可以直接从历史继续；后续员工和老板的聊天相互独立，文件也不会自动写回，任务验收交付仍通过 submission。分享要求老板工作区空闲；任何对话 fork 失败则整次授权失败，可排查后重试。恢复保留的旧授权会继续使用员工原有对话，不重新复制或覆盖；升级前已有的 active 授权不会被自动补发历史。
