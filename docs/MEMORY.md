# 用户记忆运维

Portal 不使用 Codex app-server 自带的长期记忆。进程启动参数、每个 thread 的 start/resume/fork 配置和初始化后的 `config/read` 会共同固定并验证：

```text
features.memories=false
memories.generate_memories=false
memories.use_memories=false
```

任一值未明确为 `false`，Codex 状态进入 failed，Portal 不会报告 ready。`PORTAL_MEMORY_ENABLED=false` 只关闭 Portal 自己的记忆召回与形成，不能重新启用 Codex 原生记忆。

## 安装与状态

`./bin/install-mac.sh` 会寻找 Python 3.10+，必要时通过 Homebrew 安装 Python 3.12，然后在 `.tools/memory-venv` 安装 `requirements-memory.txt`。默认还会预热固定 revision 的本地 ONNX embedding 模型；设置 `MEMORY_MODEL_WARMUP=0` 可跳过下载。

复用 `memsearch[onnx]==0.4.19`、Milvus Lite 和本地 `gpahal/bge-m3-onnx-int8` embedding，不新增云端记忆服务。索引不可用或搜索超过 2 秒时，Portal 保持运行并退回 SQLite 关键词搜索。“索引进程已启动”只表示进程状态，不证明每条记忆的向量已就绪；`/api/me` 与 `/api/health` 返回不含正文的 memory 状态。

常用配置见 `.env.example`：

- `PORTAL_MEMORY_ENABLED`：Portal 记忆总开关，默认 true。
- `MEMORY_INDEX_ROOT`、`MEMORY_MODEL_CACHE_ROOT`、`MEMORY_PYTHON`：本地派生索引、模型缓存和 Python 环境。
- `MEMORY_RECALL_LIMIT`：每次搜索最多返回条数，代码硬上限 8（正文总计最多 12000 字符）。
- `MEMORY_RECALL_TIMEOUT_MS`、`MEMORY_INDEX_TIMEOUT_MS`：搜索和重建超时。

## 数据与恢复

SQLite 是记忆正文、版本、来源、引用和分享确认的事实源。`.data/memory-index` 中的 Markdown、Milvus Lite 数据和 embedding 都是可重建派生物；索引损坏时可停服后删除该目录，再启动 Portal 重建。模型缓存也可重新下载。

不要在日志、审计导出或工单中复制记忆正文、召回 query、embedding 输入、密码或 token。备份/回滚前按架构运维流程备份 SQLite 主文件及 WAL/SHM。

## 用户行为

- “我的记忆”支持手动添加、编辑和删除；删除会立即清空权威正文并使旧引用失效。
- 普通/task chat 可分别关闭“搜索记忆”和“管理记忆”（增改删）；planner/reviewer 和子代理不能调用记忆工具。
- Codex 自行决定调用 `memory_search({query})`、`memory_add({body})`、`memory_update({id,version,body})`、`memory_delete({id,version})`。身份和项目来源由 Portal 绑定，模型不能选择老板/员工账号。
- 没有每轮前自动搜索、没有成功后按“请记住/以后”关键词提取。比如用户说“以后报告用中文”，模型判断为长期偏好后可以先 search 再 add；没有调用工具就不会保存。需要时可明确要求它调用工具并报告结果。
- 搜索结果作为不可信参考数据进入工具结果，并记录引用；空 query 列出最近可用记忆。新增返回 id/version，更新删除要求最新版本。写入工具成功即持久化，即使后续任务失败也保留；疑似密码、token 或私钥拒绝保存。
- 更新或删除自己刚搜索到的记忆会返回 `resetRequired`，本轮只确认结果，不继续工作；用户显式重置上下文后再开始下一轮。其他已引用该记忆的活跃对话也会中断并要求重置。
- 编辑、删除或来源授权失效后，已经注入旧值的 native chat 会要求用户确认 reset，避免旧 transcript 继续携带失效上下文。
- 若待分享历史引用过另一项目的记忆，`files_and_history` 分享要求按接收者和当前快照再次确认；`files_only` 不复制 chat 历史。

## 升级与回滚

升级保留现有记忆和历史提取表，将遗留 queued/running 提取任务标记为 failed，不重放。删除了旧 `PORTAL_MEMORY_AUTO_EXTRACT_ENABLED` 配置；旧环境变量不再生效。部署需重启 Portal，让 start/resume 注册四个新工具；先排空运行并用 SQLite backup 备份。回滚仍须保留原生记忆关闭，不能重新消费旧提取任务。删除会清空 SQLite 权威正文，但不会追溯擦除已经进入原生聊天历史或既有备份的内容；失效与 reset 阻止旧上下文继续使用。
