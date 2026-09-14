# 2026-09-12 双角色公网端到端验收与修复

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成（公网验收基线与修复已部署） |
| 日期 | 2026-09-12 |
| 负责人 | Codex |
| 关联目标 | 用户授权真实老板/员工入口及各项功能端到端测试，发现问题并修复 |
| 影响范围 | 公网浏览器、Portal、前端、回归测试与规格 |
| 架构规格 | [约束](../architecture/02-project-constraints.md)、[安全](../architecture/04-security-and-trust-boundaries.md)、[恢复](../architecture/06-persistence-events-and-recovery.md)、[发布](../architecture/07-e2e-release-contracts.md)、[运维](../architecture/08-operations-protocol-and-evolution.md)、[工作图](../architecture/09-human-work-graph.md) |

## 背景与证据

前序 [导航与看板报告](2026-09-12-navigation-and-kanban.md) 已完成隔离 HTTP/DOM 测试，但明确未做正式账号浏览器验收。本轮获得两个角色真实账号的测试授权，补齐公网 UI 与实际模型链路，并以新复现问题驱动修复。当前 graph 有前序未提交改动，必须保留。

初查老板公网 health 返回 HTTP 200、TLS 验证成功、Codex ready、原生长期记忆关闭；浏览器工具首次导航/快照超时，尚不能将其归因于项目。

## 目标与非目标

### 目标

- 两角色登录、刷新、返回、跨页导航、退出及未登录/越权路径验收。
- 覆盖项目/对话、文件编辑预览上传、模型运行与队列、记忆 CRUD、任务看板/详情/事件、团队管理与交付审核。
- 普通读写用本轮明确标记的合成测试项目和数据；涉及账号策略、凭据、审批或不可清理工作图的破坏性分支优先隔离夹具。
- 复现问题补回归测试，完整 macOS gate 后安全加载修复，公网再验收。

### 非目标

- 不修改既有业务文件、任务、员工权限/密码或真实记忆；不改 DNS/隧道配置。
- 不把 fake 模型测试当真实模型、HTTP 测试当浏览器视觉测试。
- 不自动提交/push；不承诺穷尽所有输入组合或第三方持续可用性。

## 约束与风险

- PRD-001/003/007、FS-005、DAT-006、DEV-003/006：身份和 ACL 不放宽，秘密不落盘/日志，测试只保存脱敏结果。
- 重启前检查非终态 turn、队列、后台 job 和 lease；不得打断现有工作。
- 生产写测试使用统一 `E2E-20260912` 标记，记录资源标识和清理结果；不可从正常产品恢复的数据不做无确认销毁。

## 实施计划

1. 核对部署与 spec/report，建立角色/功能验收矩阵。
2. 浏览器真实登录，验证核心导航与 UI；同时对同一公网入口做受控 HTTP 诊断。
3. 合成项目测试文件、聊天、队列与记忆，隔离夹具补齐权限/工作图生命周期分支。
4. 复现并修复问题，更新架构及回归测试；执行完整 gate、链接与 diff 检查。
5. 空闲屏障后加载修复并复验公网；清理测试资源与会话，记录未覆盖项。

## 实际改动

- 公网合成文件复现：`bytes=0-3` 返回 206，但合法后缀 `bytes=-4` 和终点超过文件长度的 `bytes=8-999` 返回 416。原因是后缀长度被同时当成结束偏移，且显式结束偏移未截到文件末尾。按 [RFC 9110 14.1.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.1.2) 修复单范围解析，补纯函数与真实 HTTP 回归；保持范围请求先经过 session/项目/路径 ACL。
- 两端浏览器实际登录并可见任务首页；老板工作台、员工记忆页可见。跨标签页与快照操作偶有控制工具超时，恢复后逐项确认可见结果，不把仅已发送的动作记为通过。
- 桌面 1280×900 真实截图复现工作台表头把“搜索记忆/管理记忆/推理强度”挤成逐字竖排；只有一个对话时 CSS grid 自动拉伸卡片，时间被推到很远。窄屏源码同时确认文件面板在 720px 以下被完全隐藏、721–820px 固定覆盖工作区。已让表头/控件整组换行、列表按内容排版，窄屏文件面板进入可滚动文档流，不削弱文件 ACL 或现有移动选择区触控尺寸。公网刷新后桌面截图和 390×844 DOM 几何均验证修复。
- 部署缓存证据：源站 CSS 为 `no-cache`，公网 HEAD 实际变成 `max-age=14400`；普通刷新后浏览器 CSSOM 仍没有新布局规则。不能依赖操作员改 Cloudflare 或每次手动清缓存。新增启动时前端快照与全包内容 hash 路径，HTML 指向版本化 CSS/ESM，相对模块沿同一版本解析，Sortable 绝对导入同步版本化；固定版本内容在进程内不变，源文件变化通过正常安全重启发布。未知版本/路径不回退新版，防止混合模块。
- 公网双方私有项目/对话交叉读取返回 403；员工管理 dashboard 和模型变更返回 403。两个新建合成项目与对话用于真实模型测试，8 轮完成、1 轮按测试要求中断；已通过正常 API 移入可恢复废纸篓。

## 数据、接口与安全影响

- 数据迁移：无。
- API/协议：修复单范围读取语义，增加内容版本化静态资源路径；不变更业务写接口或 Codex 协议，保留已有发布契约。
- 权限与秘密：真实凭据仅用于用户指定入口认证，不写入仓库或报告。
- 回滚：仅撤回本报告新增改动，不覆盖前序脏树或回滚业务库。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| 公网老板 health/TLS | 通过 | HTTP 200、TLS 校验 0、Codex ready、native memory false |
| 浏览器两角色登录 | 通过 | 两个固定 HTTPS 入口实际登录，身份分别为老板/员工；老板工作台、员工任务和记忆页可见 |
| 公网 HTTP 权限与记忆 | 通过 | 两个私有项目/对话交叉读取 403，员工 dashboard/模型设置 403；记忆新增、更新、旧版本 409、异账号 404、删除均符合契约 |
| 真实 Codex 与队列 | 通过已测分支 | 两角色普通轮完成；workspace_read_file / workspace_exec 和 memory_search/add 实际成功；FIFO 消费编辑后的输入；同一运行纠偏返回 200 并持久化 input_steered。纠偏不保证立即杀死已运行命令 |
| `node --test test/http-utils.test.mjs test/e2e/public-ingress.test.mjs` | 3/3 通过 | 单范围解析与 HTTP ACL/响应字节 |
| `node --test test/navigation.test.mjs test/frontend.test.mjs test/http-utils.test.mjs` | 35/35 通过 | 导航、布局与范围回归 |
| `node --test test/static-assets.test.mjs test/e2e/public-ingress.test.mjs` | 2/2 通过 | 不可变资源快照、版本一致性、未知版本拒绝 |
| `npm run gate` | 通过 | 最新 129/129 单元/集成 + 18/18 HTTP E2E，0 skip，macOS loopback/Seatbelt；未改弱固定发布测试 |
| `git diff --check` | 通过 | 无空白错误；收尾再次执行 |
| 相对 Markdown 链接检查 | 通过 | 收尾检查 spec 下 171 个本地 Markdown 链接，0 失效 |
| `node --check src/static-assets.mjs`、`node --check src/server.mjs`、`node --check public/app.js`、`node --check public/kanban.js` | 通过 | 收尾语法检查退出码均为 0 |
| SQLite 空闲屏障与完整性 | 通过 | 非终态 turn、队列、后台 job、lease、pending approval 均 0；quick_check ok、外键错误 0 |
| 精确 CLI 与安全重启 | 通过 | codex-cli 0.150.0-alpha.8；执行 ./bin/stop-local.sh && ./bin/start-local.sh，仅重启 Portal，保留工作图与隧道 |
| 重启后本地及双公网资源 | 通过 | 三个 origin 的 HTML 为 no-store 且引用相同内容版本；版本 CSS 200/immutable；员工原会话 /api/me 仍为 200 |
| 重启后公网范围读取 | 通过 | 同一合成文件的后缀及超长结束偏移均为 206 |
| 公网桌面视觉与切换 | 通过已测分支 | 1280×900 截图表头文字恢复横向、对话时间紧邻标题；普通刷新使用版本 CSS；员工任务/工作台切换保持登录及未保存编辑内容 |
| 公网浏览器文件操作 | 通过 | 预览/源码切换、编辑、页面切换保留草稿、退出前未保存提示、取消并保存、文件选择/上传确认/Markdown 预览；公网 API 读回保存及上传内容与合成标记一致 |
| 公网手机布局 | 通过 | 390×844 下文件面板为正常文档流、宽 390px、高约 591px；document scrollWidth=clientWidth=390，没有横向溢出，文件区未隐藏 |
| 公网老板团队页 | 通过已测分支 | 工作台→团队管理→任务看板→浏览器返回；员工分列、搜索过滤、详情表单打开/取消；不保存任何账号或权限设置 |
| 公网工作图展示 | 通过 | 任务看板、依赖图、状态列表、事件切换；依赖图截图长标题完整换行；事件读取 8 条，点击刷新后仍 8 条，空状态未覆盖历史 |
| 公网真实中断 | 通过 | API 中断合成执行进入 interrupted 终态，lease 释放为 0；与同轮 steer 语义分别验收 |
| 双角色刷新/退出/返回 | 通过 | 两端刷新保持会话；主动退出后历史返回仍显示登录页；老板退出后员工刷新仍为登录状态 |
| 隔离高影响生命周期 | 通过 | 完整 gate 覆盖改密失效/排空、撤权恢复、共享历史及记忆确认、planner、自动 files-only 分享、manual/原生交付、返工、并行依赖、验收/owner Git delivery、重启恢复；使用临时数据和 fake app-server，不冒充正式模型验收 |

### 清理与范围

链接检查的复现命令（从仓库根执行）：

```sh
node --input-type=module <<'JS'
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const files = execFileSync('rg', ['--files', 'spec', '-g', '*.md'], { encoding: 'utf8' }).trim().split('\n');
const broken = []; let checked = 0;
for (const file of files) for (const match of fs.readFileSync(file, 'utf8').matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
  let link = match[1].trim().replace(/^<|>$/g, '').split(/\s+"/)[0];
  if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(link)) continue;
  link = decodeURIComponent(link.split('#')[0]); if (!link) continue;
  checked++; if (!fs.existsSync(path.resolve(path.dirname(file), link))) broken.push({ file, link });
}
console.log({ checked, broken }); if (broken.length) process.exit(1);
JS
```

- 本轮仅创建两个 `E2E-20260912` 项目、两个私有对话及合成文件。9 个真实模型测试轮均终态后，两个项目 DELETE 均返回 `recoverable=true`，角色项目列表均不再包含测试项目；相关文件可从配置的项目 trash 恢复。没有删除既有业务项目、工作图或交付证据。
- 两条测试记忆均为 deleted；未修改原有记忆。UI 两个会话和 API 两个会话均退出，API 再读 `/api/me` 为 401。临时客户端仅在进程内保存 cookie/CSRF，进程退出并移除无凭据辅助文件。
- 清理后 quick_check=ok、外键错误=0；turn 数量恢复原有 28 completed/1 failed/5 interrupted，执行 lease 与 pending approval 均为 0，原有 4 个工作图 job 均 succeeded。真实业务工作图继续保留，不做取消或审核。
- 还原浏览器 viewport 覆盖，保留两角色已退出的登录页。本机与双公网最终 health 均为 200/ready，原生记忆 false；未改变 DNS、隧道 token 或第三方账号。
- 截图和 DOM 用于桌面/手机及主要动线抽样验收；没有用真实员工账号试写改密、权限调整、自动交付。触控拖动手感、断网组合及全部表单输入排列未逐一人工穷尽，不把 DOM/HTTP 夹具等同于真实浏览器视觉测试。

## 结论

本轮双角色公网验收基线及问题修复完成：确认并修复合法 Range 读取失败、工作台文字/窄屏文件区布局，以及 CDN 固定资源地址导致旧版混用三类问题。完整 macOS gate 通过，空闲屏障后已发布至 graph 本地服务和双固定域名，随后完成公网复验与合成资源清理。导航/看板前序改动保持，未 commit/push。

## 遗留事项

- 无已复现未修复的发布阻断项。未覆盖的人工组合见“清理与范围”；这是一轮可复现基线验收，不承诺所有设备/网络/第三方模型永久无故障。
- 前端启动快照使后续 UI 修改也需要空闲屏障后的 Portal 重启；部署说明已经同步到架构运维文档。回滚仅撤回本报告对应代码并重启，不覆盖原有脏树、不回滚业务库、不改隧道。
