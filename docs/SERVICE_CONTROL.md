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

启动脚本会拒绝非官方 Codex provider 或地址。未显式设置 `CODEX_HOME` 时，Codex 子进程读取当前 macOS 用户的 `~/.codex` 登录目录。老板/员工普通项目和微信固定项目都走这一本机 ChatGPT 登录；老板 `local_private` 隐私项目当前通过 `LOCAL_QWEN_*` 配置接入本机 Qwen OpenAI-compatible 服务，不会自动切换到云端模型，也不会作为普通项目或微信的备用引擎。

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
