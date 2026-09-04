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

超级管理员登录后会直接进入独立的老板驾驶舱；右上角“我的工作台”只打开老板自己拥有的项目。这里显示：

- 用户总数、活跃用户、项目、对话与正在运行的 Codex turn。
- 每个用户的状态、网络权限、项目数、空间用量、上限和最近登录。
- 所有项目的所有者、说明和授权状态。员工自有项目只显示元数据，超级管理员身份不会获得其文件或对话权限。
- 老板自己的项目可授权给一名启用中的员工。系统从当前 Git 快照创建独立 worktree；撤权后 ACL 立即失效，干净 worktree 自动移除，存在未提交修改时原地保留。
- 最近的登录、用户、项目、文件、对话和 turn 审计事件。

## 新建用户

驾驶舱点击“创建用户”，填写用户名、显示名称和至少 12 位的初始密码。建议：

- 默认关闭公网命令；确需 `npm install`、Git fetch 或联网构建时再开启。
- App Server 全局 turn 硬上限为 40，Portal 同时运行的 root turn 硬上限为 11，其中 EXECUTE 最多占 2 个 lease；如需控制某个账号的资源占用，可在“管理”中单独调低。
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
```

进程管理：`start-public.sh` 启动本地服务和公网隧道；`stop-tunnel.sh` 只关闭公网；`start-tunnel.sh` 恢复公网；`stop.sh` 才会关闭全部。本项目使用自己的 `.tools/cloudflared`，不依赖其他 Harness 项目的进程或工具目录。

修改 `.env` 后重启服务。升级 Codex 后先运行 `npm run check`，再用老板与员工测试账号完成“创建老板项目 → 授权 → 员工修改只落共享 worktree → 撤权后拒绝访问”的验收。

## 事件处理

怀疑账号泄露：在驾驶舱停用用户或重置密码；检查审计；按需关闭隧道。怀疑 Cloudflare token 泄露：在 Cloudflare 控制台旋转 token，重新运行 `save-cloudflare-tunnel-token.sh`。怀疑本机 Codex 登录泄露：先停止 Harness，再在 Codex/ChatGPT 中撤销登录并重新认证。
