# 2026-11-12 本地 Qwen Uncensored oQ5e 替换

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成（2026-11-13 已替换并验证） |
| 日期 | 2026-11-12 |
| 负责人 | Codex |
| 关联目标 | 下载同档位 Uncensored 模型，替换老板隐私模式的本地模型，优先直连 |
| 影响范围 | 本机模型文件、oMLX 服务配置、Portal 私有运行配置、文档与验收 |
| 架构规格 | [隐私引擎](../architecture/10-local-private-projects.md)、[运维](../architecture/08-operations-protocol-and-evolution.md)、[约束](../architecture/02-project-constraints.md) |

## 背景与证据

当前运行 GBP-DE/Qwen3.8-Flash-Next-oQ5e-mtp，MLX affine，默认 5-bit/group64，混合 5/6/8-bit。候选 mlx-community/Qwen3.8-Flash-Next-Uncensored-oQ5e-mtp，固定 revision c7d915c693e37fa11810d600b617adb4c36ff596，38 个仓库文件约 128.57 GB。发布者报告有效 5.72 bpw、MTP 6-bit、保留视觉塔及 262144 上下文。二者量化档位相同，位宽分配与权重有差异，不能视为质量等价。

## 目标与非目标

### 目标

- en0 物理接口直连镜像，断点续传并按官方元数据校验，完成下载。
- 备份当前服务配置后加载候选，保留旧权重作为回退。
- 检验本地 API 实际推理及老板隐私项目 Portal 路由，记录门控与结果。

### 非目标

- 本次范围为本地模型替换，量化质量大规模基准不在范围。

## 约束与风险

遵守 RUN-002/006、PRD-009、DEV-003/006，服务继续监听回环。第三方变体改变权重及行为，须实际检查加载、模板、工具调用和隐私路径。旧模型需保留，下载完成及验证前持续由现有服务提供推理。安装目录位于同级 deepseek-local，写入使用针对用户授权操作的沙箱升级。

## 实施计划

1. 固定版本、核对量化及格式，物理接口直连下载并逐文件校验。
2. 备份 serve.py、模型设置和 Portal 环境，空闲时切换模型、校验 API。
3. 合成隐私项目实际请求，清理临时项目与会话，运行 gate。
4. 更新模型运维说明、报告索引、验证、回滚及剩余事项。

## 实际改动

- 已完成发布源、当前模型和直连镜像检查，准备下载。

## 数据、接口与安全影响

- 数据迁移为无，模型 ID 会改变，旧原生隐私 session 需核对恢复兼容。
- API 继续回环 OpenAI-compatible，Portal 使用运维固定模型 ID。
- 回滚恢复旧服务脚本、模型设置与私有环境，排空后重启。原账号与项目数据保留。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| curl --interface en0 --noproxy '*' 镜像元数据 | 通过 | 物理网卡直连 HTTP 200 |
| 模型下载与校验 | 通过 | 37 文件，26 个 LFS SHA-256（25 权重及 tokenizer）和 11 元数据 Git blob，固定 revision |
| `npm run gate > /private/tmp/qwen-uncensored-portal-gate.log 2>&1` | 通过 | 实际部署目录，macOS loopback/Seatbelt，254 单元/集成 + 24 E2E，0 失败/跳过；PATH 与 Python/Git 配置见下节 |
| `git diff --check`、修改 Markdown 相对链接检查 | 通过 | 主目录与实际部署目录分别执行 |

## 结论

模型替换与老板隐私模式实际推理已完成。API、Portal 和双公网 health 均显示新模型 ready，原业务数据保留。

## 遗留事项

本次使用合成算术和隐私文件读取验收，完整能力基准及量化质量评分尚未测量。

## 下载实施进展（2026-11-13）

直连可用但端到端吞吐约 2–3 MB/s。现使用 8 MiB 分块、32 线程、固定 en0/no-proxy/HTTPS，并按完整权重分片 SHA-256 验证。与旧模型清单比较发现 6 个权重分片与 tokenizer 的 SHA-256 完全一致，复用 APFS 克隆共 30.613 GB，减少相同网络下载。其余文件继续下载。

一次性完成流程等待全量校验及 Portal 空闲，随后备份配置与数据库、切换 oMLX、合成算术测试、更新 Portal 私有模型 ID 并验收老板隐私文件读取与员工 403，失败恢复原模型。该流程由本次任务启动，caffeinate 在执行期间防止休眠。

完整 Portal gate 已通过 254 单元/集成及 24 E2E，0 失败/跳过。下载期间现有模型继续运行，生产尚未切换。

## 最终实施与验证（2026-11-13）

- 下载通过 curl 固定 en0、禁用代理、HTTPS 与固定 revision，采用 8 MiB 分段和 32 并发。选择公开 DNS 返回且已测试的 CDN 节点只作用于下载器。复用 SHA-256 一致的 6 个权重分片与 tokenizer，共 30.613 GB；候选总字节为 128567785624。旧清单也约 128.568 GB。
- 全量下载完成后合并分段，25 个权重及 tokenizer 的 LFS SHA-256 全通过。11 个其他文件的 Git blob SHA-1 与固定版本元数据一致。下载分段已清除，旧权重保留。
- 同级 deepseek-local 的 scripts/serve.py 修改模型名称、清单与下载状态路径；新增固定版本清单，oMLX model_settings.json 复制原运行参数给新模型并设置默认/pinned。Portal 活动目录私有 LOCAL_QWEN_MODEL 更新为新 ID。
- 首次 launchd bootstrap 返回 5，原脚本的即时回滚同样遇到注册错误，Portal 与模型短暂中断。随后显式 enable/bootstrap 恢复服务，加入注销后的等待与有界重试，第二次切换成功。记录为已修复的运维时序问题。
- `caffeinate -i .../finish-replacement.py` 一次性任务已完成，replacement-status.json 的 phase=complete。切换前检查空闲并备份 serve.py、model_settings.json、Portal 私有环境、launchd plist 和 SQLite。备份目录为主仓库 .tools/qwen-uncensored/before-replacement（0700，文件0600）。
- 新模型回环 chat/completions 算术请求 HTTP 200，正确返回 5，耗时 13.73 秒。该单次请求耗时用于记录可用性。
- `node .tools/uncensored-private-smoke.mjs` 成功，真实 DSH/Qwen 经 workspace_read_file 读取独立项目随机标记，run=completed、local_session_id 存在、codex_thread_id=null；员工访问返回403。合成项目经正常DELETE移入可恢复trash，临时会话撤销。
- 本地及 workbench3/workbench4 两个公网 health 均 codexState=ready、memory ready、localQwen ready，模型 ID 为新 Uncensored oQ5e。Qwen API继续监听127.0.0.1:8000，模型列表中保留旧模型供回退。
- 最终 quick_check=ok、外键错误0、active run=0、临时会话0。备份中8用户、13项目、22 access、17 chats、14 tasks、8 roadmaps、20 inputs全部原值保留。

门控在 .tools/releases/bench34-fast-7d59a5c 运行。PATH=/Users/starwin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/starwin/.codex/worktrees/unattended-graph-deploy/codex-harness-remote/.tools/bin:/usr/bin:/bin:/usr/sbin:/sbin，COMMAND_PYTHON_BIN=/Users/starwin/.local/share/uv/python/cpython-3.12.14-macos-aarch64-none/bin/python3.12，COMMAND_GIT_BIN=/Library/Developer/CommandLineTools/usr/bin/git。

## 来源

- [固定版本模型发布页](https://huggingface.co/mlx-community/Qwen3.8-Flash-Next-Uncensored-oQ5e-mtp/tree/c7d915c693e37fa11810d600b617adb4c36ff596)
- [原安装模型发布页](https://huggingface.co/GBP-DE/Qwen3.8-Flash-Next-oQ5e-mtp)
