# 12 微信渠道与带资料任务派发

## 身份与入口

`TASK_DISPATCH_ENABLED` 控制资料和派发服务；`WEIXIN_ENABLED` 控制新增微信连接，默认均关闭。`WEIXIN_PILOT_USER_IDS` 非空时只向列出的用户开放微信，用于先完成一组真实验收。旧单老板 HMAC 渠道继续兼容，但不作为新增身份的入口。

每个用户最多一个活动连接，必须经自己的 Web session、Origin/CSRF 校验选择当前获准的普通项目。老板收件项目必须自有且尚未共享，并禁止直接整体共享；派发通过独立协作项目完成。员工可选择自己的普通项目或当前共享项目。二维码确认的 sender/account 固定到该用户，消息不能指定 user、cwd、native thread 或替代老板身份。

Portal 为每人创建独立 transport 子进程，通过私有 IPC 通信，不新增监听端口。relay 不运行 Agent、不连接宿主日常浏览器、不复用 `wechat-people-graph` 的服务、环境或凭据。固定 upstream commit 及构建说明见 [微信操作指南](../../docs/WEIXIN_TASK_DISPATCH.md)。用户目录为 0700、凭据文件为 0600；模型、文件沙箱和普通项目 API 不可读取。只接受绑定 sender 的私聊消息，先验证身份再下载文件。

每次下载、执行和发送前复验用户状态、联网位、原 access 和连接 generation；异步下载及模型响应返回后再次复验。禁网不启用 relay，也不能借本地代理绕过。策略变更终止旧 relay/运行并废弃旧排队消息；新连接轮询和后续消息使用当前权限。联网请求按次读取现有 OUTBOUND_PROXY，失败不直连降级。

## 收件与派发

文件到达只建立资料回执，不启动模型或员工任务。文字消息按同一连接顺序处理；未完成下载的消息阻挡后续消息，处理过的外部 ID 不再执行。仅支持文字与原始文件附件；普通图片/语音给出转换为文件的提示。资料包含来源 user/project/access/chat、名称、大小和 SHA-256，原始内容保存为独立不可变 blob。每批最多 30 份、50 MiB，另受账号总配额限制。

老板微信和普通对话使用 `task-dispatch` skill 及 root-only `dispatch_*` 工具。文件中的文字不是派发授权。明确的人类指令、收件人和资料清单足够时直接受理；歧义由 Agent 澄清。新批次只复制选定资料到一个老板协作项目，再复用 Work Graph 和 files_only 批量分享。一个 DAG 的多个节点、同批文件不各建项目；已有协作项目从工作图发布时继续使用本项目。简单派发固定人工验收，模型不能通过节点字段增加自动审核权限。

持久步骤为 accepted → preparing → published；`published` 必须来自共享授权全部成功和 workflow.running 事实，不能根据模型文本推断。捕获/打包仅从获准文件读取固定 bytes，可在整理该资料的模型轮内使用；不写项目工作树。后台准备等待来源和目标工作区空闲，复核捕获来源文件哈希；幂等键及已创建项目/run 标识保证恢复不重复建单。源文件变化或授权失效明确停止，不自动选择新资料或重放命令。

工作图“生成草稿”仅保存规划；“生成并派发”或“发布任务”完成授权后通知。规划工具只能引用本次输入清单中的附件 ID。节点附件描述输入分配，**整个项目仍是共享边界**，不是节点文件权限隔离。

## 任务资料与员工动线

任务输入使用 `task_input_revisions`，与上游成果 `inputManifest` 分开。项目副本位置固定为 `inputs/<material-id>/<name>`；不覆盖同路径不同内容。ZIP 保留原包、不自动解压，也不把未解析内容视为已分析背景。员工打开任务详情即可预览或下载；进入任务对话前在空闲工作树导入缺少的资料，无需重复上传。

未提交且未结束的任务可追加新版本，原附件和原 ZIP 保留。当前模型运行的资料版本由 `task_input_usage` 固定；补充只在下一轮使用。提交保存 `task_submission_inputs`，人工提交要求核对当前 revision，Codex 提交使用原运行 revision。审核读取固定提交采用的资料，不读取未来补充；自动通过必须具备完整所需输入内容，否则交老板判断。

`task` URL 参数贯通角色登录返回、刷新和前进/后退。打开详情只标记网页通知已读，不启动模型或改变任务状态。依赖未满足不提供进入任务对话按钮。微信通知附项目名、任务摘要和登录后可直达的链接，不主动发送 ZIP。网页打开任务不改变微信当前项目；明确“处理任务 <ID>”或 `/task <ID>` 经受派人、版本和状态检查后切换，先回执确认，再处理后续文字。

未绑定微信不影响网页待办。`task_notifications.read_at` 与 `weixin_outbox.status` 独立；sent 仅代表服务端发送确认，不代表员工已读。失败不撤销任务，不确定发送不自动重发。

## 数据、升级与恢复

增量迁移建立 task_materials、task_dispatches、task_input_revisions、task_input_usage、task_submission_inputs、task_notifications、weixin_connections、weixin_inbox、weixin_outbox 和旧 chat 工具版本字段；不重建历史任务。消息正文和附件载荷属于受 ACL 的业务数据，绝不写审计、事件或服务日志。dispatch 工具明细不复制正文，也不提交 Luna 摘要。

CLI pin 不变。旧普通老板 chat 在下一次派发相关请求且已经空闲时启动带新工具的 native thread，CAS 保存旧/新 thread lineage，原 Portal 页面与历史保留。只读 `dispatch_history` 限本对话并检查历史记忆来源当前 ACL；历史不是新指令，不重放命令。新普通对话直接带能力。

重启将 processing inbox 和 sending outbox 标为 uncertain，不重放；已排队、未开始的消息按原连接代次和当前权限继续。未确认二维码过期，活动凭据可恢复轮询。撤权、禁网、停用、解绑即时停止 relay；Web 退出取消尚未确认的扫码授权，已建立的微信入口独立于 Web 登录会话。

发布/回滚必须备份 SQLite、资料 blobs 和私有连接目录。回滚先关闭新入口、排空运行，再恢复代码/配置，保留上线后的任务、资料及数据库；禁止拿旧库覆盖新业务。完整 macOS gate 和真实微信手机收发分别记录，不能互相替代。
