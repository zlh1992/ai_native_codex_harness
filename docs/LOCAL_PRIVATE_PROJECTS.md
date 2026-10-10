# 老板隐私项目：启用与验收

这是可选功能，默认不启用。保留当前老板工作台，不部署第二套网页。旧项目、员工项目及工作图仍走 Codex；新建“隐私项目”后不可改类型、分享给员工或启动工作图。

## 本机 Qwen 模型前置条件

先由运维启动本机 Qwen OpenAI-compatible 服务，监听明确的回环地址，例如 `127.0.0.1:8000`。不能直接使用 law_harness 默认的 Codex 桥接配置，也不能把云端模型 API 当成本地模型。当前 oMLX 安装使用 `Qwen3.8-Flash-Next-oQ5e-mtp`，配置统一使用 `LOCAL_QWEN_*`。

- `GET /v1/models` 返回实际模型 ID。
- `POST /v1/chat/completions` 支持 OpenAI-compatible SSE、标准 tool_calls 及 tool result 多轮消息。
- 接口不能重定向到其他主机或路径；本版本不支持模型端鉴权配置、图片视觉输入或多个本地模型动态切换。附件可经现有项目文件工具处理，不能把图片上传误称为视觉推理。
- 不会自动下载模型权重，也不会在失败后改走云端。模型身份、实际推理日志、上下文窗口和 token 上限必须由运维核对，不能仅凭 `/models` 声称离线推理已验收。

## 配置与启动

先排空普通与本地运行、备份 DB/项目目录，再安装锁定依赖：

```bash
npm ci --omit=dev --ignore-scripts
```

在本项目本地 `.env` 设置（示例 ID 必须替换成实际服务返回值）：

```dotenv
LOCAL_QWEN_ENABLED=true
LOCAL_QWEN_BASE_URL=http://127.0.0.1:8000/v1
LOCAL_QWEN_MODEL=Qwen3.8-Flash-Next-oQ5e-mtp
LOCAL_QWEN_CONTEXT_WINDOW=262144
LOCAL_QWEN_MAX_TOKENS=8192
LOCAL_QWEN_TIMEOUT_MS=1200000
LOCAL_SEARCH_TIMEOUT_MS=120000
```

如实填写模型支持的窗口与输出上限；当前 oMLX `/v1/models` 报告的上下文上限为 262,144，实际输出上限仍以服务启动配置为准。整轮超时包含等待人工审批的时间。按现有 `stop-local.sh` / `start-local.sh` 流程安全重启，前端资源版本会一起更新；不要重启正在交付的其他任务。无需改域名、Cloudflare 路由或模型公网端口。

`status.sh` 和 `/api/health` 分别显示 Codex、本地引擎状态。默认仍要求 Codex ready；显式启用本地后可仅以本地 ready 提供部分服务，此时员工/普通项目 Codex 不可用。ready 不是完整推理验收。

## 老板使用

1. 工作台 → 新建项目 → “隐私项目 · 本地 Qwen + DSH”。
2. 新建对话，默认“人工确认”。本地读取不用确认，文件变更、EXECUTE 命令和联网搜索逐次批准。EDIT 禁止命令。
3. 需要自动工作时切换“完全接管”，阅读并确认风险；有运行或待处理队列时不能切换。自动模式不放开访问其他项目、宿主机秘密或命令网络权限。
4. “我的记忆”选择该隐私项目。模型也能自主调用 memory_search/add/update/delete；只在同项目不同对话间共享，不使用普通项目/全局记忆。修改已引用的记忆后，需要显式重置受影响对话。
5. 运行中发送消息先进入队列；可用队列中的调整方向在下一 step 生效。需要立即取消当前工具时按“停止”，不是仅发送另一条消息。

## 搜索与公网隐私边界

唯一云端推理例外是独立的 `web_search(query)`：固定 Codex Luna-low，只发该搜索词，返回有来源 URL 的公开检索摘要。本地正文、项目文件、对话历史与记忆不会自动附带。

人工模式可编辑实际搜索词后批准；自动模式模型自行生成并提交，**不能保证搜索词不含敏感内容**。极敏感任务请保持人工确认并拒绝搜索。专用搜索依赖同机 Codex 的有效 auth.json 登录状态和精确版本，失败不影响本地推理引擎选择。不会复制主 Codex 配置，也不会将临时刷新凭据反写到主登录状态。

老板仍可从公网域名访问隐私项目，但 HTTPS 流量经过 Cloudflare。隐私范围是“员工无内容权限、推理/Agent 默认本地”，不是避开所有代理或对 Mac 管理员保密。

## 上线验收

- 跑 macOS `npm run gate`；合成模型自动测试仅证明协议/状态机/隔离，不能证明实际 Qwen 推理能力。
- 使用实际模型完成：流式问答 → 读取文件 → 人工批准写入 → EXECUTE 命令 → 同对话续聊 → 新对话检索本项目记忆。
- 员工应无法发现/读取隐私项目；直接伪造分享、工作图、跨作用域记忆 ID 必须被拒绝。
- 测试人工拒绝、批准前文件变化、停止/超时、两段本地对话排队、模型关闭、Portal 重启、显式会话重置。
- 用无敏感内容的搜索词验收实际 Luna webSearch 事件和来源链接；仅返回一段模型文本不算联网验收。
- 复查服务日志/audit/turn journal 不含测试正文、文件正文或完整工具参数。

## 备份与回滚

一致性备份整个业务数据集，尤其是 SQLite、workspaces/trees/trash、`DATA_DIR/local-sessions` 与本地模型配置。JSONL 保存原始模型上下文，权限须为目录 0700/文件 0600；记忆索引可从 SQLite 重建。删除记忆会停止检索，但不等于擦除旧 JSONL、备份或派生缓存。

需要回退时先停止本地运行，再将 `LOCAL_QWEN_ENABLED=false` 并安全重启。保留项目/记忆/JSONL；不能切回不理解 project_type 的旧版本操作现有 DB，否则可能破坏“永不可分享”约束。
