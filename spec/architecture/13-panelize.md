# 13 老板 Panelize 多模型会审

## 范围与入口

托管 `panelize-multi-agent` skill 和 `browser_panelize` dynamic tool 共用 CodexService，微信 transport 和工作台无需两套实现。仅活动老板自己的 standard owner access、普通非 task EXECUTE root、联网获准且浏览器已启用时执行。每次操作及队列出队复验数据库身份/权限，子代理由原浏览器 root thread 校验拒绝；员工、shared、local_private、planner/reviewer 均拒绝。

老板明确使用多模型时只外发选定的最少文本。Codex 席位为当前官方上游 root，在网页生成期间独立分析；不宣称启动了额外 Codex worker。Kimi、豆包、DeepSeek 走各自网页版。Claude Code / MiniMax 当前固定 `not_configured`，不读取宿主 Claude 配置、不借用其他供应商、不发送请求。普通 Codex provider、固定子代理和隐私项目禁云契约不变。

## Panelize 复用与证据

`vendor/panelize` 保存固定 2.0.1 文本脚本和 MIT 许可，启动时校验 SHA256。包装器保留原生供应商识别、编辑器查找、填入、发送函数；截去扩展 postMessage 监听与报告初始化，只由服务端调用闭包。没有另一套供应商发送选择器，也不安装扩展 cookies 权限或通用执行接口。Portal 自有标签页/接管代替扩展分屏。

动作仅 `open/read/fill/send`，provider 固定白名单，不允许客户端指定 URL、JS、profile、命令或凭据。每次读写检查所选供应商精确 HTTPS host；跳到登录域需人工接管回到目标站后继续。只支持每家每轮一次发送尝试：fill 拒绝已有草稿，send 之前必须 read 核对填入原文，实际发送再比对草稿。异步点击前即记录 attempted，失败/不确定不重放。再次 open 返回原页而非刷新或重发。

发送动作只返回 `send_attempted`，不证明提交或完成。read 分页返回原始可见页面文本、来源 URL、观察时间、草稿，不把整页冒充答案。root 必须检查本题、生成结束、完整性和实际模型；未知/未登录/失败/部分答复分别说明。文本仅进入私有模型上下文，最终答复保存在现有受 chat ACL 的消息中；不新增共享文件或公开看板。页面和答案不具备操作权限，不能自动升级为可信记忆。

## 浏览器与生命周期

完全沿用 [第 11 章](11-managed-browser.md) 的 Seatbelt、容量、控制权、等待、撤权、停止、日志省略和清理。三家使用同一 chat 浏览器内独立 tab，计一个浏览器会话。专用临时 profile 不借用宿主或原 Panelize 登录态，运行结束清理，不能承诺跨轮免登录。微信用户需在对应工作台私有对话接管登录，密码/验证码不进入微信文字。显式 Panelize root 进入 handoff 时，既有 outbox 按 inbox ID 排队一次固定接管提示和老板对话深链；发送前复验 generation、processing inbox、当前 chat/run 和仍在 handoff，过期取消、uncertain 不重发。最终回答使用独立 reply 队列项，不覆盖接管提示。没有独立后台 worker 或重启恢复/重发队列。

`browser_` 前缀沿用事件和工具明细省略，无 prompt、回答、页面、Cookie 写入日志或摘要服务。

## 旧线程兼容

新增幂等 `chats.panelize_tools_version INTEGER NOT NULL DEFAULT 0`。新合格 thread 带工具；旧合格 chat 在下一次明确 Panelize/多模型请求时新建 native thread，await 后复验权限及 CAS 原映射，保留原 lineage 和 Portal 历史，发出上下文升级说明。没有自动复制/外发旧 prompt 或其他资料；普通请求不触发升级。CLI pin 不变。rollback 保留数据库新列和消息，不用旧库覆盖上线后数据。

## 验证边界

权限、空配置、来源 host、一次发送、已有草稿、真实 Chrome + Seatbelt 和旧线程升级由自动测试覆盖。受控网页的测试不等于供应商线上 UI/账号验收；真实登录、验证码及实际回答状态在发布报告单独记录。未登录不得宣称五家联调通过。
