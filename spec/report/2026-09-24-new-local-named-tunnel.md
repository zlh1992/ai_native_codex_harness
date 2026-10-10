# 2026-09-24 本机新 Named Tunnel 公网准备

| 字段 | 内容 |
| --- | --- |
| 状态 | 阻塞 |
| 日期 | 2026-09-24 |
| 负责人 | Codex |
| 关联目标 | 在当前 Mac 为 graph 服务准备新的二级域名公网入口 |
| 影响范围 | 运维、文档、运行环境；不改业务代码和数据库 |
| 架构规格 | [02 项目强制约束](../architecture/02-project-constraints.md)、[04 安全与信任边界](../architecture/04-security-and-trust-boundaries.md)、[08 运维与协议升级](../architecture/08-operations-protocol-and-evolution.md) |

## 背景与证据

当前工作树为 `graph` 分支，目标是使用本机 `127.0.0.1:4310` 的 Portal，通过 Cloudflare Named Tunnel 和一个新的二级域名提供 HTTPS 公网访问。域名、Cloudflare Tunnel 和 Connector Token 尚未由同事提供。本机尚无 `.env`、`.data`、`.tools` 或生产依赖目录。

## 目标与非目标

### 目标

- 完成本机依赖和运行目录准备。
- 在获得新域名、路由和 token 后可直接切换为 named 模式。

### 非目标

- 本轮不停止或修改其他 Mac 的现有公网入口。
- 本轮不猜测或写入新域名，不保存占位 token。
- 本轮不声明公网服务已经上线。

## 约束与风险

- `RUN-001`、`RUN-002`、`RUN-005`：仅支持 macOS、回环监听和 launchd 管理。
- `DEV-006`：不把 tunnel token 或其他凭据写入报告。
- Node.js 需要 >=22.13；本机终端 PATH 未包含系统 Node，使用 ChatGPT App 内置 Node 完成本轮安装。
- 记忆模型预热可单独进行，本轮跳过以避免不必要下载。

## 实施计划

1. 使用可用 Node 完成本机依赖安装和目录权限准备。
2. 核对本机服务、cloudflared 和配置缺口。
3. 在缺少同事提供的域名、Cloudflare 路由和 token 处暂停，并输出大白话交接清单。

## 实际改动

已完成本机依赖安装、Python 3.12 记忆环境创建（未预热模型）、`.env` 模板初始化和项目专用 `cloudflared` 安装。`.env` 仍保持 quick 默认值，没有写入未知域名或 token。

## 数据、接口与安全影响

- 数据迁移：无。
- API/协议：无。
- 权限与秘密：仅创建本机私有运行目录；不写入 token。
- 回滚：删除本轮创建的 `.data`、`.tools`、`.env` 和依赖目录即可；不影响远端或其他 Mac。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `git diff --check` | 通过 | 本次报告改动无空白错误 |
| 本机依赖安装 | 通过 | npm 依赖、Python 3.12 venv 和项目专用 cloudflared 2026.9.1 已就绪 |
| 本地 health | 未执行 | 还未启动服务，避免在域名配置前创建运行实例 |
| Named Tunnel 公网 health | 阻塞 | 需要新域名、Cloudflare 路由和 Connector Token |

## 结论

本机准备完成，公网发布被 Cloudflare 侧信息阻塞。需要同事创建独立 Named Tunnel、配置新 hostname 到 `http://127.0.0.1:4310` 并安全提供 token；收到后继续配置、启动和验收。

## 遗留事项

- 等待同事提供新二级域名、Cloudflare Named Tunnel 路由及 Connector Token。
- 获得信息后配置 `.env`、保存 token、启动 Portal/tunnel，并完成公网健康和登录验收。
