# 超级管理员使用指南

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

登录后点击顶部“驾驶舱”。这里显示：

- 用户总数、活跃用户、项目、对话与正在运行的 Codex turn。
- 每个用户的状态、网络权限、项目数、空间用量、上限和最近登录。
- 所有人的项目。点击“管理文件”会回到工作台并以管理员权限打开该项目，之后可以浏览、上传、创建、编辑或把任何文件移到废纸篓。
- 最近的登录、用户、项目、文件、对话和 turn 审计事件。

## 新建用户

驾驶舱点击“创建用户”，填写用户名、显示名称和至少 12 位的初始密码。建议：

- 默认关闭公网命令；确需 `npm install`、Git fetch 或联网构建时再开启。
- 本机全局并发和新用户默认并发均为 40（系统硬上限 40）。如需控制某个账号的资源占用，可在“管理”中单独调低；同一对话仍按顺序执行，不同对话、项目和用户可以并发。
- 先给 2 GB、10 个项目，观察空间和 Codex 配额后调整。
- 通过独立安全渠道发用户名和初始密码，要求用户首次登录后由管理员重置成约定的新密码。目前没有自助改密入口。

“管理”可停用普通用户、调整网络/配额或重置密码。停用和重置密码都会撤销此用户现有会话。Web 界面不能创建新的超级管理员；需要第二个管理员时在本机运行 `create-admin` CLI。

## 文件管理与恢复

管理员选择任意用户项目后，右侧文件区支持：

- `＋文`：按项目相对路径创建文本文件。
- `＋夹`：创建目录。
- `上传`：上传文本或二进制文件。
- 点击文本文件：在编辑器中修改并保存。
- SVG/图片、DOT 同名 SVG、PDF、Excel、CSV/TSV、Markdown、JSON 和源代码可在右侧直接预览；预览与源码可切换，原文件也可下载。
- 拖动项目栏/对话栏、对话栏/文件栏之间的竖向分隔线，以及文件列表/预览区之间的横向分隔线可调整空间；双击分隔线恢复默认尺寸。
- “移到废纸篓”：可恢复删除。

废纸篓位于：

```text
.data/workspaces/<user-id>/.trash/files/<project-id>/
.data/workspaces/<user-id>/.trash/projects/
```

界面暂不自动恢复，避免误覆盖。停止服务后在 Finder/终端确认目标，再移回原项目目录；所有恢复操作应单独记录。

## 日常运维

```bash
./bin/healthcheck.sh
./bin/status.sh
tail -f "$HOME/Library/Logs/CodexHarnessRemote/server.log"
node src/cli.mjs list-users
npm run check
```

进程管理：`start-public.sh` 启动本地服务和公网隧道；`stop-tunnel.sh` 只关闭公网；`start-tunnel.sh` 恢复公网；`stop.sh` 才会关闭全部。本项目使用自己的 `.tools/cloudflared`，不依赖其他 Harness 项目的进程或工具目录。

修改 `.env` 后重启服务。升级 Codex 后先运行 `npm run check`，再用测试账号完成“创建项目 → 新建对话 → 让 Codex 写文件 → 管理员查看”的验收。

## 事件处理

怀疑账号泄露：在驾驶舱停用用户或重置密码；检查审计；按需关闭隧道。怀疑 Cloudflare token 泄露：在 Cloudflare 控制台旋转 token，重新运行 `save-cloudflare-tunnel-token.sh`。怀疑本机 Codex 登录泄露：先停止 Harness，再在 Codex/ChatGPT 中撤销登录并重新认证。
