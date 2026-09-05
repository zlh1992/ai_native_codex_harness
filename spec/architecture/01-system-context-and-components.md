# 01 系统上下文与组件

## 系统上下文

| 参与者或系统 | 能力 | 不可信输入 |
| --- | --- | --- |
| 老板浏览器 | 管理普通账号、配额、自己拥有的项目、授权、roadmap 和审核 | Cookie 之外的所有请求参数、项目 id、用户 id、路径、approval id |
| 员工浏览器 | 访问自己的项目和当前有效共享项目，创建私有 chat，运行任务 | 路径、chat id、turn 参数、上传内容、SSE cursor |
| HTTPS 隧道 | 把公网 HTTPS 转发到回环 HTTP | 转发头只有在受信代理配置下才能用于来源 IP/协议判断 |
| Portal | 唯一业务授权点与编排者 | 不信任浏览器传入的 owner、cwd、tree、thread 或 RPC method |
| Codex app-server | 原生 thread/turn/approval/skills/subagent 能力 | 共享本机身份，不是租户授权来源 |
| 本机文件系统/Git | 项目主目录、共享 worktree、runtime、trash | 符号链接、`.git` 指针、项目自定义 agent 配置 |
| SQLite | 业务事实、运行 journal、审计 | 是 Portal 的业务事实源，不包含原生完整 transcript |

## 请求链路

```text
Browser request
  -> session / status / role / CSRF / Origin
  -> projectFor or chatFor ACL lookup
  -> re-fetch policy after relevant await boundary
  -> workspace lifecycle lock or capacity lease
  -> canonical server-bound path/thread/cwd
  -> Workspace API, sandboxed command, or Codex JSON-RPC
  -> durable state/event first
  -> HTTP JSON or SSE projection
```

授权不能只在路由入口检查。建立 worktree、发现 skill、恢复 thread、等待排队或启动 native turn 都可能跨越异步窗口；真正触碰文件或开始 turn 前必须重新读取用户状态、项目 access 和网络策略。

## 组件职责

| 组件 | 当前职责 | 明确禁止承担的职责 |
| --- | --- | --- |
| `src/server.mjs` | HTTP 路由、认证入口、请求体限制、ACL、CSRF、Origin、响应/SSE、生命周期路由 | 不直接信任客户端路径、tree 或 thread；不直接调用任意 RPC |
| `src/db.mjs` | schema/migration、业务实体、不变量事务、运行状态、事件、审计 | 不保存明文会话 token；不把 native thread id 当授权凭据 |
| `src/fs-service.mjs` | canonical path、保留路径、符号链接和文件大小检查 | 不允许绝对路径、`..`、`.git`、越界链接 |
| `src/worktree-service.mjs` | 初始化 Git、创建/恢复/移除员工独立 worktree | 不决定谁有权限；不在脏 tree 上静默销毁数据 |
| `src/capacity-service.mjs` | root turn、用户并发、workspace 单写者、EXECUTE lease 排队 | 不替代数据库生命周期检查 |
| `src/sandbox.mjs` | 最小环境、Seatbelt profile、命令超时和输出限制 | 不继承 Portal/Codex/Cloudflare 秘密；不提供跨项目读取 |
| `src/codex-client.mjs` | 启停 app-server、JSONL RPC、精确协议版本验证 | 不向浏览器暴露；不做业务 ACL |
| `src/codex-service.mjs` | thread/turn、事件、审批、动态工具、恢复、子代理政策、运行清理 | 不允许客户端指定原生 thread/cwd；不自动跨 chat 共享历史 |
| `public/app.js` | 员工工作台、事件重放、文件与任务交互 | 不作为安全边界；所有限制必须由服务端重复执行 |
| `public/boss.js` | 老板元数据与授权工作流 | 不获得员工项目内容旁路 |
| `bin/*.sh` | 本机 launchd 生命周期、健康检查和隧道 | 不把服务直接监听到非回环地址 |

## 数据存放

```text
.data/harness.sqlite                         业务元数据与 journal
.data/workspaces/<owner-id>/<project-slug>/ owner 项目主目录
.data/trees/<project-access-id>/            每个 shared access 的独立 worktree
.data/runtime/<user-id>/                    命令 HOME/TMP 与运行数据
.data/trash/<actor-id>/                     可恢复删除
CODEX_HOME                                  原生 Codex thread/登录；由所有 Portal 用户共享
```

`tree_path`、`project_access_id` 和 `codex_thread_id` 只由服务端数据库绑定产生。对外 payload 必须移除物理 `treePath`、branch 内部细节及其他绝对路径。

## UI 分工

- `/` 是统一登录与工作台入口。登录后普通用户进入员工工作台，管理员可以进入自己的工作台。
- `/boss.html` 是老板驾驶舱，提供账号、授权、roadmap、审核和审计元数据能力。
- 两个页面可以共享同一登录会话，但 UI 导航不改变服务端内容 ACL。
