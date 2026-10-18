# 2026-10-17 Portal 模型目录对齐与公网角色任务验证

| 字段 | 内容 |
| --- | --- |
| 状态 | 阻塞（目录对齐与 GPT-6 推理已完成；员工登录和联网执行未通过） |
| 日期 | 2026-10-17 |
| 负责人 | Codex |
| 关联目标 | 对齐 Portal 与当前桌面 Codex 可选模型，并验证老板/员工公网工作流 |
| 影响范围 | 模型目录、默认配置、角色 API、E2E 契约、操作文档、公网运行验证 |
| 架构规格 | [03 领域模型与不变量](../architecture/03-domain-model-and-invariants.md)、[04 安全与信任边界](../architecture/04-security-and-trust-boundaries.md)、[07 端到端发布契约](../architecture/07-e2e-release-contracts.md)、[08 运维、协议升级与演进](../architecture/08-operations-protocol-and-evolution.md) |

## 背景与证据

- 已验证老板入口 [workbench3.winy.cc](https://workbench3.winy.cc/boss/login) 与员工入口 [workbench4.winy.cc](https://workbench4.winy.cc/employee) 均可公网加载；重启后两端 health 均为 HTTP 200，Codex/Qwen 报 ready；匿名 `/api/me` 返回 401。
- 老板公网 UI 的模型下拉目录已直接确认只列出 `GPT-6 Luna`、`GPT-5.6 Terra`、`GPT-5.6 Luna`，默认项为 `gpt-6-luna`。
- 老板账号已从公网入口登录。员工入口显示“本机 Codex 在线”，但使用用户提供的现有 `jl` 账号凭据提交两次，均返回“用户名或密码错误，或账号已停用”。本轮没有重置密码。此前老板团队列表显示该账号启用且允许联网；不能据此判断登录失败的具体原因。
- 桌面 Codex `~/.codex/models_cache.json` 的 `visibility=list` 当前列出 `gpt-6-luna`、`gpt-5.6-terra`、`gpt-5.6-luna`；隐藏的 reserve/自动审核项不属于可选根模型。桌面模型元数据支持 `gpt-6-luna` 的 `high` 强度。
- Portal 私有 Codex HOME 使用的 pin 0.150.0 模型缓存不含 GPT-6 Luna，因此目录和 health 本身不能证明该模型可推理。公网老板入口实际选择 `gpt-6-luna`、`high` 后得到真实回答，确认这条上游推理路径可用。
- 用户明确授权将模型目录与当前桌面 Codex 对齐并重启服务；变更使符合权限的员工也能选择该目录中的模型，共用既有上游配额。

## 目标与非目标

### 目标

- 让 Portal 普通 chat 的根模型目录与当前桌面 Codex 可见目录一致，并将 `gpt-6-luna` 设为默认模型，默认推理强度为 high。
- 更新角色/API、微信目录、测试契约、架构与操作说明，明确隐藏内部模型不会作为用户可选模型。
- 从公网老板和员工入口检查登录、实际推理，以及隔离项目中的文件、命令、网页和公开 GitHub 任务能力。
- 记录重启、验证、测试残留及回滚方法。

### 非目标

- 不升级 Codex CLI/protocol pin，不新增员工或扩展项目授权，不修改员工网络权限。
- 不使用现有工作图或用户既有项目执行任务，不把密码、Cookie、完整 prompt 或生产文件内容写入报告。

## 约束与风险

- `RUN-002`、`RUN-003`、`RUN-004`：公网仍经 HTTPS 隧道进入回环服务；App Server 保持后端 stdio；模型目录不等于完整任务能力验收。
- `PRD-001`、`PRD-003`、`FS-006`：试验项目独立于现有项目并绑定老板 ACL；外网任务沿用既有网络授权边界。
- `DEV-003`、`DEV-004`：不削弱发布契约；在 macOS 主机执行 `npm run gate`。
- 模型目录会影响老板及有权限员工的选择范围。默认模型虽成功推理，但 shell 沙箱和工具启动限制仍可能让实际任务失败。

## 实施计划

1. 先建立报告与索引，再调整 Portal 白名单、默认值、角色契约、微信目录和操作说明。
2. 运行针对性测试、完整 `npm run gate`、`git diff --check` 与文档相对链接检查。
3. 重启服务并检查双公网入口、health、匿名认证边界；使用老板入口登录并尝试员工入口现有账号。
4. 在独立临时项目实测 GPT-6 Luna high、文件/命令、网页与公开 GitHub 下载。
5. 完成本报告结论、测试残留、回滚步骤和索引状态。

## 实际改动

- `src/models.mjs` 将可选根模型目录改为桌面 Codex 当前可见的三个模型；历史 chat 若保存了已退役模型偏好，执行时回退到当前默认模型，新 API 选择仍严格校验白名单。
- `src/config.mjs` 和 `.env.example` 的默认模型改为 `gpt-6-luna`；本机忽略文件 `.env` 同步为该默认值以重启当前运行实例。
- 同步角色模型目录、token 用量和会话模型、前端模型选择、恢复流程与 E2E 门控测试。
- 更新架构规格 `03`、`04`、`07`、`08`，员工与超级管理员操作说明，以及本报告索引。
- 重启当前 Portal 服务与公网隧道；老板临时建了独立测试项目和一条测试 chat。测试 `smoke.txt` 仍在该项目文件列表中，内容是单行无敏感占位文本。当前已查看的工作台页面没有显示项目/文件删除或回收站控件，本轮未通过文件系统绕过应用清理流程。

## 数据、接口与安全影响

- 数据迁移：无；已有 chat 中已移出目录的 `preferred_model` 不重写，仅在运行时回退到默认模型。
- API/协议：角色 API 返回新的三个模型目录；不修改 Codex JSON-RPC 协议或 CLI pin。
- 权限与秘密：ACL、员工联网授权和分享规则不变。测试账号信息未写入代码、规格、报告或日志；员工登录表单已清空。
- 回滚：恢复 `src/models.mjs`、默认模型配置、受影响测试、架构/操作文档和报告索引至部署前版本；本机忽略 `.env` 还原原模型值；按 `docs/SERVICE_CONTROL.md` 重启。测试项目仅含其初始说明文件和测试占位文件，若需移除，应通过 Portal 支持的项目回收/删除流程处理。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| 相关 Node 测试 | 通过，67 项 | `node --test --test-concurrency=1 test/config.test.mjs test/token-usage.test.mjs test/channel.test.mjs test/chat-mode.test.mjs test/frontend.test.mjs test/recovery.test.mjs test/e2e/portal-gate.test.mjs` |
| `npm run gate` | 通过 | macOS loopback/Seatbelt；203 项单元/集成、19 项 E2E 均通过 |
| `git diff --check` | 通过 | 无空白错误 |
| 相对 Markdown 链接检查 | 通过 | 本报告和相关修改文档的相对链接均有效 |
| 公网双入口和未登录边界 | 通过 | 两个登录页 HTTP 200，health HTTP 200/ready，匿名 `/api/me` 为 401 |
| 老板公网模型目录 | 通过 | 下拉菜单直接显示 GPT-6 Luna、GPT-5.6 Terra、GPT-5.6 Luna；默认 gpt-6-luna |
| 老板公网 GPT-6 Luna high 推理 | 通过 | UI 显示模型 `gpt-6-luna`、推理强度 `high`；真实 turn 成功返回 |
| 隔离项目文件和命令 | 部分通过 | `workspace_write_file` 创建 `smoke.txt` 成功；`pwd` 与 `cat smoke.txt` 成功；`ls -la` 退出码 1，沙箱拒绝访问父目录；最初 shell fork 失败，分开运行后 `cat` 成功 |
| 网页访问 | 未通过 | 模型称当前 turn 无网页浏览工具；workspace 外网请求未能启动，工具链返回权限错误 |
| GitHub 下载 | 未通过 | `git clone --depth 1 https://github.com/octocat/Hello-World.git github-smoke` 退出码 255；`git-remote-https` helper 启动失败，报告 `Resource temporarily unavailable`，未下载仓库 |
| 员工公网登录 | 未通过 | `jl` 现有凭据连续两次被登录页拒绝；未重置密码，表单已清空 |

公网任务仅在老板新建的独立临时项目中运行，没有更改现有项目。员工没有成功登录，所以未能从员工角色读取其当前模型目录或运行模型任务。测试项目和无敏感 `smoke.txt` 仍保留在 Portal；没有把用户账号凭据写入仓库或报告。

## 结论

模型目录变更、服务重启、发布门控和老板公网 `gpt-6-luna` / `high` 推理均已完成。模型能够在隔离项目中写文件，`pwd`、`cat` 可用。当前不能确认员工模型选择与真实任务路径，因为员工登录被拒；网页浏览工具不可用，GitHub clone 因 `git-remote-https` 启动失败，项目目录列表还受父目录沙箱限制。因此，用户要求的老板/员工全链路及联网/GitHub 操作尚未达成，报告状态为阻塞；目前仅能确认两个公网入口可达且匿名访问受认证保护。

## 遗留事项

- P1：由管理员在不重置密码的前提下核对 `jl` 账号登录名、账号状态与实际认证凭据，再复测员工角色模型目录和任务能力。
- P1：检查远端执行器的网络浏览工具注册、shell fork 与 `git-remote-https` 可执行环境/沙箱配置，随后重测公开网页和 GitHub clone。
- P2：通过 Portal 可恢复删除流程清理隔离测试项目及 `smoke.txt`；本轮已查看的工作台界面未暴露对应操作。
