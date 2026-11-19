# 本机整套服务管理

在 Finder 双击项目根目录的 `.command` 文件，或在终端粘贴完整路径。下面的路径对应当前 Mac。

## 1. 启动全部服务

```bash
/Users/starwin/Documents/ChatGPT/codex-harness-remote/start.command
```

依次启动 Portal、配置的公网隧道、微信 relay，等待就绪后报告成功。重复启动会复用正在运行的进程。

## 2. 关闭全部服务

```bash
/Users/starwin/Documents/ChatGPT/codex-harness-remote/stop.command
```

按微信、公网隧道、Portal 的顺序停止，保留项目文件、账号、聊天记录和微信绑定。

## 3. 重启和查看状态

```bash
/Users/starwin/Documents/ChatGPT/codex-harness-remote/restart.command
/Users/starwin/Documents/ChatGPT/codex-harness-remote/status.command
```

`restart.command` 完整执行关闭再启动。状态读取与启停共用的进程记录，并检查本地引擎健康。

## 4. 健康检查

```bash
/Users/starwin/Documents/ChatGPT/codex-harness-remote/health.command
curl --fail-with-body --connect-timeout 3 --max-time 10 http://127.0.0.1:4310/api/health
curl --fail-with-body --connect-timeout 3 --max-time 10 http://127.0.0.1:18767/status
```

Portal 应为 `codex=true`、`codexState=ready`。微信 `bound=true`、`phase=running` 表示已经绑定且 relay 已启动；刚重置时 `waiting_for_wechat_scan` 表示需扫码，不代表故障。健康检查不替代实际账号登录与微信消息收发。

本机使用已有 ChatGPT 登录，模型地址应为项目默认的 `https://chatgpt.com/backend-api/codex`。若消息已到达但模型报 `401 / INVALID_API_KEY`，检查 `.env` 的 `CHATGPT_CODEX_BASE_URL` 是否与认证方式匹配；重新生成微信二维码不能修复模型认证。修改模型地址后重启，并用真实消息验证，不能仅以 `ready` 判断认证成功。

启动脚本会拒绝非官方 Codex provider 或地址，也会拒绝把 `CODEX_HOME` 指回桌面 Codex 的 `~/.codex`（`validate_codex_home`，报“拒绝启动：CODEX_HOME 不能与桌面 Codex 共用 …”）。未显式设置 `CODEX_HOME` 时，Codex 子进程使用项目私有的 `$DATA_DIR/codex-home`，不再读写桌面 Codex 的 `~/.codex`：本项目 pin 的 CLI 版本会按自身 `client_version` 重写 `models_cache.json`，与桌面共用家目录会抹掉桌面正在使用的模型元数据。上游登录凭据仍以符号链接复用当前 macOS 用户的 `~/.codex/auth.json`，仍是同一个 ChatGPT 登录与配额；私有 home 缺少凭据且本机也没有登录时启动失败，不会静默降级。老板/员工普通项目和微信固定项目都走这一本机 ChatGPT 登录；老板 `local_private` 隐私项目当前通过 `LOCAL_QWEN_*` 配置接入本机 Qwen OpenAI-compatible 服务，不会自动切换到云端模型，也不会作为普通项目或微信的备用引擎。

桌面 Codex 的降智监控与自愈由本机 launchd 承担，与本仓库服务无关：`com.starwin.codex-watch` 常驻记录桌面每一次 `POST /responses` 与返回 token（`~/Library/Logs/CodexTraffic/watch.log`），`com.starwin.codex-guard` 每 5 分钟检查 `~/.codex/models_cache.json` 的 `client_version` 是否仍等于桌面 CLI 版本，健康就刷新金本位副本，被旧客户端覆写则自动恢复并弹 macOS 通知（`~/Library/Logs/CodexTraffic/guard.log`）。手工排查用 `~/bin/codex-traffic-watch.py guard --restore`（体检加自愈）、`audit`（降智体检报告）、`watch`（实时流量）；停止监控用 `launchctl bootout gui/$(id -u)/com.starwin.codex-watch`。

## 5. 重置老板微信二维码

```bash
/Users/starwin/Documents/ChatGPT/codex-harness-remote/reset-wechat-qr.command
```

先确保整套服务已启动，再备份旧微信绑定并生成新二维码，自动打开 [微信绑定页面](http://127.0.0.1:18767/)。用手机微信扫码并确认。普通重启不需要重置。备份留在微信私有运行目录，不应上传。

## 登录与文档

- [本地老板登录](http://127.0.0.1:4310/boss/login)
- [本地员工登录](http://127.0.0.1:4310/employee)
- 当前公网地址由 `status.command` 按配置输出；角色域名独立保存登录状态。
- [本项目 README](../README.md)
- 微信仓库 README：`/Users/starwin/Documents/ChatGPT/wx_codex_self/README.md`

## 运行模式

当前 Mac 的 `.env` 显式配置 `HARNESS_PROCESS_MODE=detached`。Portal 与隧道脱离启动终端运行，进程记录保存在私有 `.data`；关闭、重启、状态脚本都会识别，不再需要手动启动 Python/Node。关掉终端窗口不会停服务；Mac 注销/重启或服务崩溃后，重新运行 `start.command`。微信由其既有 LaunchAgent 管理。

其他部署默认 `launchd`，仍可使用原 `bin/start-local.sh` 等分组件命令。微信仓库默认位于同级 `wx_codex_self`，可在 `.env` 用 `WECHAT_BRIDGE_DIR` 指定；本机微信设置端口为 18767。更改设置端口须同步快捷脚本。

## 当前独立部署

2026-11-12 起，Fast 适配版运行于主仓库 `.tools/releases/bench34-fast-7d59a5c`，私有 `.tools/active-runtime` 记录此目录。主目录的 start/stop/restart/status/health.command 通过服务脚本转发到该部署，继续使用原入口即可。数据库和原生历史位于主仓库 `.data`，备份位于 `.tools/backups/2026-11-12-bench34-fast`。恢复旧版本前先排空运行、备份新增数据并检查数据库兼容性，再切换活动目录。

## 老板微信只读查询

在已绑定的老板私聊发送 `/library` 查看命令。以下命令由本机 Portal 直接回复微信；本地隐私项目正文和桌面内容不进入云模型、普通 chat 历史、工具明细或事件回复缓存。

| 操作 | 微信消息 |
| --- | --- |
| 列出老板本人拥有的全部 Portal 项目，含本地隐私项目 | `/projects` |
| 列出已登记并核准的桌面 Codex 项目 | `/desktop` |
| 列出该项目目录，路径可含空格 | `/files 项目ID 子目录`，省略子目录查看根目录 |
| 读取文本文件 | `/file 项目ID 相对路径` |
| 查看项目对话 | `/chats 项目ID` |
| 查看已核实属于老板桌面账号的对话，含归档与无项目对话 | `/chats desktop` |
| 阅读对话中的用户与助手消息 | `/chat 对话ID` |

从列表复制 ID。消息末尾出现下一页时，将页码加在命令后，如 `/chat @2 对话ID`。普通项目文件继续使用 Portal 原有大小和文本限制；桌面文件支持最多 8 MiB 的 UTF-8 文本。桌面目录查询略过隐藏路径、常见凭据和数据库、运行数据、依赖、符号链接与多硬链接文件。对话只返回可识别的用户和助手文本记录；图片、附件、工具执行和内部事件不在正文里。

本机管理员在私有 `DATA_DIR/wechat-owner-library.json`（属主为服务账号，权限 0600）固定 Portal 老板 ID、桌面创建者和账号 ID，以及逐项确认的桌面项目 ID、根路径、目录设备与 inode。项目清单与当前桌面 SQLite 注册表取交集；路径更换后需重新核验。项目 ID 绑定根路径，同一项目的多个根分别查询。只允许签名通过、配置的 sender 与私聊 scope 完全一致、老板账号活动且获准联网、绑定有效的旧固定通道。清单移出该位置立即停用直接查询。历史缺少身份、属于其他账号或关联 Portal 运行目录和原生线程时隐藏。重复查询重新核验权限和当前内容。手机回执与本机接口冒烟分别验收。

## 从老板微信向原任务发送指令

在固定老板私聊发送 `/portal` 可打开本部署的老板工作台。发送 `/chats 项目ID` 或 `/chats desktop` 找到对话，然后发送 `/tell 对话ID 指令`。项目本身可能有多条对话，目标使用列表中的对话 ID。指令可包含空格和换行。

- Portal 对话直接进入原输入队列。该任务的运行模式、容量限制与审批仍然生效；本地隐私项目沿用本机引擎。任务已关闭、版本过期或受工作图调度时会收到拒绝原因。
- 桌面对话 ID 以 `d-` 开头。微信返回老板 Portal 核对链接，在手机登录后查看原任务标题、完整 ID 和待发送文字，点「确认发送到这个任务」。链接预览与打开页面不会发送。确认仅对这条指令有效，桌面任务可使用它在 Codex 中已有的权限。
- 回执报告原队列是否接收。用 `/chat 对话ID` 阅读回复。桌面未载入时会尝试按已有设置恢复任务；若提示尚待恢复，请在 Codex 中打开原任务。遇到结果不确定，先查看原队列和对话再决定是否另发新指令。
- 桌面桥接使用本机 Codex daemon 的受属主保护的 Unix socket。手机使用已有 HTTPS 老板域名、老板会话及 CSRF 校验。微信事件保存带钥摘要；私有待审表只在核对前保留正文。Portal 已接受的消息按原对话队列生命周期处理。

桌面原生队列行为见 [Codex CLI queue 参考](https://learn.chatgpt.com/docs/cli/reference#codex-queue)。
