# 2026-09-12 老板隐私项目与本地 DeepSeek Harness

| 字段 | 内容 |
| --- | --- |
| 状态 | 代码与自动门控完成；未部署，真实模型/搜索待验收 |
| 日期 | 2026-09-12 |
| 更新日期 | 2026-09-13 |
| 负责人 | Portal 开发 |
| 关联目标 | 老板不可分享的隐私项目，保留现有工作台 |
| 影响范围 | 项目 ACL、数据库、双引擎、工具、记忆、审批、UI、测试、运维 |
| 架构规格 | [约束](../architecture/02-project-constraints.md)、[领域](../architecture/03-domain-model-and-invariants.md)、[安全](../architecture/04-security-and-trust-boundaries.md)、[执行](../architecture/05-execution-concurrency-and-lifecycle.md)、[持久化](../architecture/06-persistence-events-and-recovery.md)、[发布](../architecture/07-e2e-release-contracts.md)、[运维](../architecture/08-operations-protocol-and-evolution.md) |

## 背景与证据

graph 当前普通对话、队列和后台工作均绑定 CodexService。本机 law_harness 安装 DSH 0.1.0-rc.7，但默认配置走 Codex 桥接；规划时未发现本地模型 8000 监听。独立本地模型接口是否实际可用须实测，不把 HTTP 健康检查当作推理验收。

## 目标与非目标

### 目标

- 新建不可分享的老板隐私项目，以本地 DeepSeek + DSH 处理多轮对话、文件与沙箱命令。
- 保留老板公网访问；Cloudflare 是传输信任边界。
- 本项目多对话记忆复用四个 memory 工具，禁止跨项目召回。
- 完全接管/人工确认按对话选择；人工确认覆盖 Agent 文件变更、命令及 Luna-low 搜索词外发。

### 非目标

- 不转换既有项目、不下载模型权重、不接入 law_harness 共享环境，不开放员工协作、工作图或本地子代理。
- 不宣称完全离线：只有搜索词可按所选策略发给专用 Codex 搜索运行，公网传输仍经过 Cloudflare。

## 约束与风险

- 保留现有 graph 未提交导航/看板/审核改动；实现前核对重叠内容。
- 遵守 PRD-001、RUN-006、FS-001/006、DAT-004/006/008/009、CAP-001/002、DEV-001 至 DEV-006。
- 模型地址必须是明确回环地址，无云端 fallback；普通项目不得消费隐私记忆。
- 审批、队列及停止必须绑定具体运行，重启不重放未知副作用。旧代码不理解隐私类型，禁止直接降级运行新数据。

## 实施计划

1. 加入不可变项目类型与不可分享防线、对话控制模式及会话绑定迁移。
2. 引入运行路由、本地 DSH worker，复用 Portal 队列、容量、文件服务与事件。
3. 将记忆按用户/项目作用域分隔，增加项目记忆界面。
4. 增加工具审批、专用 Luna-low 搜索出口及前端控制。
5. 补充隔离/迁移/模型流/工具/审批/恢复测试，运行 macOS gate、diff 与链接检查。

## 实际改动

- `private-projects`、DB 与项目/分享/工作图服务：不可变类型、老板 owner-only access、无 Codex/task 绑定及多层拒绝协作；旧项目迁移为 standard。现有导航、看板和交付修改保留。
- `AgentRuntimeService` 作为兼容路由，普通 CodexService 保持原协议；本地 DSH 复用队列、全局 root、EXECUTE lease、文件工具与受 ACL 的 SSE。Codex 故障不暂停本地队列，本地最多一个活动 worker。
- 独立 `local-dsh-worker` 精确锁定 DSH 0.1.0-rc.7 核心。仅回环 OpenAI-compatible 模型；模型/agent/compaction 均不回退云端。不接入 law_harness 的网页、默认 Codex 桥或既有会话。
- 本地会话 JSONL/checkpoint、流式正文、续聊、停止、下一 step steer、故障保留映射和显式 reset lineage。空白 session 先物化/flush 再提交映射，修正 DSH 惰性空 session 与恢复兼容问题。
- 工具执行前后复验权限。manual 默认对文件变更、EXECUTE 命令和外发搜索建立持久审批；auto 仍遵守 EDIT、路径、配额与禁网。文件审批使用沙箱内递归指纹；等待期间变更拒绝覆盖，停止取消审批且迟到批准不能重放。
- 记忆沿用四个自主 CRUD 工具；SQLite + 派生 memsearch/Milvus 按 user/project namespace 分隔。普通记忆 REST 不能通过已知 ID 访问隐私记忆；前端可选择本项目记忆。更新/删除旧引用继续要求显式上下文 reset。
- 专用 query-only Luna-low 搜索使用独立 app-server、空白目录、临时凭据副本、原生记忆关闭及搜索配置校验；其他工具请求拒绝，失败不切换本地推理引擎。人工批准可编辑实际 query。未观察到 webSearch/成功终态/来源 URL 时拒绝返回“搜索成功”。
- 工作台增加隐私项目入口、本地引擎标识、人工确认/完全接管和搜索词审批；隐藏云模型选择、分享及工作图入口。历史/goal 读取复验当前本地或 Codex 映射，不能错配 reset 前后上下文。
- `.env.example`、健康状态与启动脚本支持可选的本地部分能力 ready；新增 [本地项目架构](../architecture/10-local-private-projects.md) 和 [操作指南](../../docs/LOCAL_PRIVATE_PROJECTS.md)，同步其他相关架构。

## 数据、接口与安全影响

- 数据迁移：幂等新增项目类型、对话本地运行字段、记忆作用域及搜索审批类型；保留既有记录。
- 迁移只在隔离测试 DB 运行；本轮未启动生产新版本、未迁移正在使用的生产数据库。
- API：既有项目/chat/审批 API 兼容扩展，增加受项目 ACL 保护的记忆入口与引擎状态。
- 日志：正文仅在受 ACL 的业务数据内，不能进入全局审计、事件 journal 或运行日志。
- 回滚：关闭本地引擎功能并保留项目/会话/记忆；必须使用仍理解隐私类型的版本。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `npm run gate` | 通过 | macOS + Seatbelt；语法/shell 检查、150/150 单元集成测试、19/19 HTTP E2E，0 fail/skip；最终执行退出码 0 |
| `git diff --check` | 通过 | 完工前复跑，无空白/补丁格式错误 |
| 下方 `node --input-type=module` 链接检查 | 通过 | 47 个 Markdown 文件、212 条相对链接，无断链 |
| `node --test --test-name-pattern='stale file' test/local-private.test.mjs` | 通过 | 真实 DSH step 收到 steer；外部修改后的文件未被批准操作覆盖 |
| 真实本地模型接口 `curl --max-time 5 http://127.0.0.1:8000/v1/models` | 未接通 | 本机没有该模型监听；未下载权重、未启动未知模型，真实推理/工具验收未完成 |
| 真实固定 CLI + `CodexSearchService.search` 公共无敏感查询探针 | 未通过 | initialize、config/read、thread/start、turn/start 成功；上游连接失败/超时，返回 LOCAL_SEARCH_UNAVAILABLE，没有伪称检索成功 |
| `/usr/bin/curl --head --silent --show-error --max-time 8 https://chatgpt.com/backend-api/codex/models` | 连接超时 | 宿主直接请求及独立 Seatbelt 请求均超时；不是凭据或实际模型质量验收 |

搜索协议参照官方 [App Server](https://learn.chatgpt.com/docs/app-server) 与 [权限/安全](https://learn.chatgpt.com/docs/agent-approvals-security)，并以项目固定 CLI 0.150.0-alpha.8 的实际握手校验。OpenAI Docs 指引用于确认搜索配置及事件，不把公开文档当作当前账号/网络可用性证据。

相对链接检查命令（在 graph 仓库根目录执行）：

```bash
node --input-type=module <<'NODE'
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
const files=execFileSync('rg',['--files','spec','docs','-g','*.md'],{encoding:'utf8'}).trim().split('\n').concat('README.md');let count=0;const bad=[];
for(const file of files){for(const match of fs.readFileSync(file,'utf8').matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){let target=match[1].replace(/^<|>$/g,'').split(/\s+"/)[0].split('#')[0];if(!target||/^[a-z]+:|^\//i.test(target))continue;target=decodeURIComponent(target);count++;if(!fs.existsSync(path.resolve(path.dirname(file),target)))bad.push({file,target});}}
console.log(JSON.stringify({files:files.length,relativeLinks:count,broken:bad}));if(bad.length)process.exitCode=1;
NODE
```

## 清理与回滚

- 合成测试使用独立临时 DB、项目目录、会话与回环服务，结束后排空并清理。专用搜索的临时凭据副本/状态目录在 finally 中销毁，未改写主登录状态。
- 没有改实际 `.env`、域名、隧道、模型配置或已有项目数据；没有重启正式服务、commit 或 push。`node_modules` 安装了锁文件对应依赖，源代码保持未提交供 review。
- 回滚可关闭本地功能；仍须保留识别 private 类型的 ACL。禁止将生产 DB 交给旧版代码；上线前做一致性备份，不能把删除记忆等同于擦除旧 JSONL/备份。

## 结论

实现已落在 graph 工作树，最终 macOS 门控 150 + 19 全部通过，spec/report/操作指南已同步。新增前端测试曾误用不存在的控件 ID，已改为验证真实表单 selector 并完成全量复跑，未削弱既有用例。由于本机 DeepSeek 尚未提供接口、真实 Luna 搜索未接通，不宣称端到端生产验收完成，也不自动开启功能。

## 遗留事项

- 运维启动/确认真实回环 DeepSeek（模型 ID、SSE/tool_calls、实际推理日志），使用操作指南完成真实多轮/文件/命令/项目记忆验收。
- 网络恢复后复验真实 Luna-low 的 webSearch 与来源链接；不得以纯文本回答替代搜索验收。
- 部署前排空运行、备份数据、明确启用开关并重启，再通过老板真实界面验收。当前不自动部署。
