# zclaudia-gateway

payload 无关的安全反向隧道平台：为 NAT 之后的 Backend 与远程客户端提供注册发现、Channel 专线、Topic 广播和流式 HTTP 代理。实现 Gateway Protocol v4（[docs/protocol-v4.md](docs/protocol-v4.md)）；演进历史与后续计划见 [ROADMAP.md](ROADMAP.md)。

## 架构

```text
zclaudia client ──ws /ws──┐                ┌──ws /ws── zclaudia server (client+backend)
zclaudia client ──ws /ws──┼──► Gateway ◄───┘
mobile ── HTTP /api/proxy ┘      │
                                 ├─ state.ts    内存态：peers / registry / leases / channels / topics
                                 ├─ storage.ts  SQLite：backend 身份（UUID）、凭证、epoch 计数
                                 ├─ server.ts   Express + ws：协议路由、HTTP 代理、限流
                                 └─ push-notification.ts  ntfy 推送
```

核心概念：

- **Peer**：一条已认证的 WS 连接，`client-only` 或 `client+backend`。后者同时注册为 Backend，获得租约（lease）和单调递增的 **epoch**（区分同一 Backend 的不同代次，旧代次连接会被替换下线）。
- **Registry**：在线 Backend 的目录，连接时随 `peer_ready` 下发，变更时广播，另每 30 秒兜底推送。
- **Channel**：客户端向 Backend 协商专属数据连接（`channel_open` → ticket 拨号），业务消息、终端流量逐帧双向流动；HTTP 代理内部也走 Channel。
- **Topic**：Backend 发布一份（快照带 retain），Gateway 在自己一侧向订阅者扇出；冷订阅者订阅即得 retained 状态。
- **HTTP 代理**：`/api/proxy/:backendId/*` 经内部 Channel 流式桥接到 Backend——无 base64、双向背压、端到端取消。

## 协议兼容矩阵

| Gateway 版本 | 协议版本（`peer_hello.protocolVersion`） | 协议包 | 说明 |
| --- | --- | --- | --- |
| 0.2.x（当前） | **4**（唯一支持版本） | [`@zclaudia/gateway-protocol`](packages/protocol)；规范见 [docs/protocol-v4.md](docs/protocol-v4.md) | Channel（控制面协商 + 每 Channel 一条独立 WS 数据连接，[ADR-0003](docs/adr/0003-channel-transport.md)）+ Topic（含 retain）+ 流式 HTTP 代理 + 定向 `backend_server_message` 回退路径 |
| — | 1 / 2 / 3 | — | 已移除，无兼容层（v3 于 zclaudia 全量迁移 v4 后拆除——新项目、无遗留对端） |

`clientProtocolVersion` / `backendProtocolVersion` 是应用层版本号，Gateway 只透传不解释。

## 认证

**签发凭证是唯一认证方式**（[ADR-0002](docs/adr/0002-identity-issuance.md)；共享 secret 体系已于 2026-09 整体移除）。由 Admin API 签发的可撤销凭证，namespace 与能力从服务端记录派生，不信任客户端声明：

- `zgd_*` 设备凭证：仅可作为 client-only 连接与访问本 namespace 的 HTTP 代理；默认 180 天过期。
- `zgb_*` Backend 凭证：可注册 Backend；默认不过期；可经 `/api/backend/token` 交换为短期 `zga_*` 访问凭证（Backend SDK 默认行为）。
- 撤销立即生效：在线连接被断开（close 1008），后续认证被拒；撤销 `zgb_*` 级联撤销其交换出的 `zga_*`。
- 凭证在 WS（`peer_hello.gatewaySecret` 字段，名称保留以稳定 wire）与 HTTP（`Bearer <token>`）两侧通用。
- 管理端点（需 `GATEWAY_ADMIN_TOKEN`，必填——它是签发凭证的信任根）：`POST/GET /api/admin/credentials`、`DELETE /api/admin/credentials/:id`；命令行封装见 [scripts/gateway-admin.sh](scripts/gateway-admin.sh)（`issue-backend` / `issue-device` / `list` / `revoke`，自动读取 `.env`）。

## 本地开发

```bash
pnpm install
cp .env.example .env        # 设置 GATEWAY_ADMIN_TOKEN
pnpm dev                    # tsx watch，默认端口 3200
pnpm build && pnpm start    # 编译运行
pnpm test                   # vitest 全量测试
pnpm test:coverage          # 覆盖率（阈值：statements 80 / branches 70 / functions 65 / lines 80）
pnpm lint                   # eslint
docker compose up -d        # 容器部署（读取 .env）
```

环境变量：

| 变量 | 必需 | 默认 | 说明 |
| --- | --- | --- | --- |
| `GATEWAY_ADMIN_TOKEN` | ✅ | — | 凭证管理 API 的管理员 token（凭证体系的信任根） |
| `GATEWAY_PORT` | | `3200` | 监听端口 |
| `GATEWAY_TRUST_PROXY` | | `false` | 信任 `X-Forwarded-For`（仅置于可信反代之后时开启，见 ADR-0001） |
| `GATEWAY_ALLOWED_ORIGINS` | | 无（通配符） | 逗号分隔的 CORS Origin allowlist，设置后仅列表内 Origin 可跨域（带 credentials） |
| `ZCLAUDIA_DATA_DIR` | | `~/.zclaudia` | SQLite 数据目录（实际路径 `<dir>/gateway/gateway.db`） |
| `NTFY_*` | | 见 [.env.example](.env.example) 与 [src/index.ts](src/index.ts) | ntfy 推送通知配置 |

## 显式约束（当前实现的已知边界）

以下是当前实现的**有意约束**，不是 bug；通用化过程中的演进计划见 ROADMAP 对应阶段。

### 单节点与状态易失

- 仅支持单实例部署。peers、registry、租约、channel、topic 订阅与 retained payload、recovery token 全部在内存中，**进程重启即全部丢失**，客户端需重连并重新订阅（zclaudia 客户端已按此语义实现）。
- SQLite 持久化 backend 身份（UUID）、签发凭证（仅摘要）和 epoch 计数器，保证 Backend 重连后 ID 与代次稳定、凭证跨重启有效。

### 安全模型（Phase 1 重构对象）

- 认证只有可撤销的设备/Backend 凭证（见"认证"一节），namespace 一律从服务端记录派生；共享 secret 路径已整体删除，不存在不受 namespace 限制的通道。
- namespace 隔离在 registry 下发、Topic、Channel、定向消息和 HTTP 代理层面强制执行，同实例上不同 namespace 互不可见，有集成测试覆盖。
- 浏览器 Cookie Session 尚未实现（随 Phase 5）。
- CORS 默认 `Access-Control-Allow-Origin: *`；设置 `GATEWAY_ALLOWED_ORIGINS` 后收紧为 Origin allowlist（带 credentials）。
- WS 认证密钥在消息体中传输（受 TLS 保护的前提下）。

### 尺寸与速率限制

| 限制 | 值 | 位置 |
| --- | --- | ---: |
| WS 最大消息 | 50 MB | `server.ts` maxPayload |
| JSON 请求体 | 15 MB | `express.json` |
| 每 IP WS 连接数 | 10 | `MAX_WS_CONNECTIONS_PER_IP` |
| 认证失败限流 | 10 次/分钟/IP | `AUTH_FAIL_LIMIT` |
| 代理请求限流 | 200 次/分钟/IP | `PROXY_RATE_LIMIT` |

### 超时与周期

| 项 | 值 |
| --- | ---: |
| WS 认证超时 | 10 s |
| 代理请求超时（整体响应） | 30 s |
| 代理流式空闲超时（逐 chunk 重置） | 60 s |
| WS ping 周期 | 30 s |
| Backend 租约 TTL / 检查周期 | 30 s / 5 s |
| Registry 兜底广播周期 | 30 s |

### 传输语义

- 代理 Header 为默认拒绝的 allowlist（见 [src/validation.ts](src/validation.ts)）：请求侧仅转发 content-type/accept/range/条件请求头等；响应侧仅转发内容类头（`Set-Cookie` 与服务器指纹头永不透传）。
- 所有入站协议消息经 runtime 校验，只校验 Gateway 路由所需字段；payload（topic、channel 帧、`backend_server_message`）一律不解析。
- 认证、连接、channel/topic、代理与凭证生命周期输出结构化 `[audit]` 日志行。

## SDK（Protocol v4）

本仓库为 pnpm workspace（[ADR-0004](docs/adr/0004-sdk-packaging.md)），`packages/` 下为 v4 SDK：

| 包 | 内容 |
| --- | --- |
| `@zclaudia/gateway-protocol` | v4 wire 类型与常量，零依赖 |
| `@zclaudia/gateway-client` | 控制连接、Channel、Topic、指数退避重连（快速重开模型）；面向 WHATWG WebSocket，可注入 socketFactory |
| `@zclaudia/gateway-backend` | Backend 注册与心跳、channel offer 处理（拨号即接受）、Topic 发布、`serveHttp` HTTP channel 服务 |

契约测试位于 [`src/__tests__/phase3-sdk-contract.test.ts`](src/__tests__/phase3-sdk-contract.test.ts)：两个 SDK 经真实 Gateway 实例互通（channel 双向收发、Topic、HTTP、断线重连恢复订阅），使用 Node 原生 WHATWG WebSocket——与 WebView 客户端相同的 API 面。

## 设计决策

重要决策以 ADR 记录于 [docs/adr/](docs/adr/)。ROADMAP 第 8 节列出了实施前待定的决策清单。
