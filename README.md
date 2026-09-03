# zclaudia-gateway

zclaudia 的中心 Gateway：为 NAT 之后的 Backend 与远程客户端提供注册发现、消息中继和 HTTP 代理。当前实现 Gateway Sync Protocol v3，服务于 zclaudia 的资源同步与远程访问；通用化计划（多应用、Channel 模型、Protocol v4）见 [ROADMAP.md](ROADMAP.md)。

## 架构

```text
zclaudia client ──ws /ws──┐                ┌──ws /ws── zclaudia server (client+backend)
zclaudia client ──ws /ws──┼──► Gateway ◄───┘
mobile ── HTTP /api/proxy ┘      │
                                 ├─ state.ts    内存态：peers / registry / leases / subscriptions
                                 ├─ storage.ts  SQLite：deviceId/instanceId → backendId 映射、epoch 计数
                                 ├─ server.ts   Express + ws：协议路由、HTTP 代理、限流
                                 └─ push-notification.ts  ntfy 推送
```

核心概念：

- **Peer**：一条已认证的 WS 连接，`client-only` 或 `client+backend`。后者同时注册为 Backend，获得租约（lease）和单调递增的 **epoch**（区分同一 Backend 的不同代次，旧代次连接会被替换下线）。
- **Registry**：在线 Backend 的目录，连接时随 `peer_ready` 下发，变更时广播，另每 30 秒兜底推送。
- **订阅**：客户端 `subscribe_backend` 后才能与该 Backend 互发消息；Backend 的资源快照/事件会转发给全部订阅者。
- **HTTP 代理**：`/api/proxy/:backendId/*` 将 HTTP 请求经 WS 转发给 Backend，支持整体响应和 start/chunk/end 流式响应两种模式。

## 协议兼容矩阵

| Gateway 版本 | 协议版本（`peer_hello.protocolVersion`） | 协议包 | 说明 |
| --- | --- | --- | --- |
| 0.1.x（当前） | **3** | `@zclaudia/protocol` ^0.2.0 | 完整支持，行为不变 |
| 0.1.x（当前） | **4** | 规范见 [docs/protocol-v4.md](docs/protocol-v4.md)；首个生产消费者为 zclaudia server（`feature/gateway-v4` 分支） | v3 全部消息 + Channel（控制面协商 + 每 Channel 一条独立 WS 数据连接，[ADR-0003](docs/adr/0003-channel-transport.md)）+ Topic（含 retain）+ 流式 HTTP 代理；与 v3 同实例共存 |
| — | 1 / 2 | — | 已废弃，无兼容层 |

`clientProtocolVersion` / `backendProtocolVersion` 是应用层版本号，Gateway 只透传不解释。

## 认证

两套并行体系（迁移期共存，见 [ADR-0002](docs/adr/0002-identity-issuance.md)）：

### 签发凭证（推荐）

由 Admin API 签发的可撤销凭证，namespace 与能力从服务端记录派生，不信任客户端声明。

- `zgd_*` 设备凭证：仅可作为 client-only 连接与访问本 namespace 的 HTTP 代理；默认 180 天过期。
- `zgb_*` Backend 凭证：可注册 Backend；默认不过期。
- 撤销立即生效：在线连接被断开（close 1008），后续认证被拒。
- 管理端点（需 `GATEWAY_ADMIN_TOKEN`）：`POST/GET /api/admin/credentials`、`DELETE /api/admin/credentials/:id`。

### 共享 secret（legacy 兼容）

`GATEWAY_SECRET` 继续在 WS（`peer_hello.gatewaySecret`）和 HTTP（`Bearer <secret>` 或 `Bearer <clientId>:<secret>`）两侧有效，不受 namespace 限制。待三个应用全部迁移到签发凭证后按 ROADMAP 弃用。

## 本地开发

```bash
pnpm install
cp .env.example .env        # 设置 GATEWAY_SECRET
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
| `GATEWAY_SECRET` | ✅ | — | 共享认证密钥 |
| `GATEWAY_PORT` | | `3200` | 监听端口 |
| `GATEWAY_TRUST_PROXY` | | `false` | 信任 `X-Forwarded-For`（仅置于可信反代之后时开启，见 ADR-0001） |
| `GATEWAY_ALLOWED_ORIGINS` | | 无（通配符） | 逗号分隔的 CORS Origin allowlist，设置后仅列表内 Origin 可跨域（带 credentials） |
| `GATEWAY_ADMIN_TOKEN` | | 无（Admin API 禁用） | 凭证管理 API 的管理员 token，必须不同于 `GATEWAY_SECRET` |
| `ZCLAUDIA_DATA_DIR` | | `~/.zclaudia` | SQLite 数据目录（实际路径 `<dir>/gateway/gateway.db`） |
| `NTFY_*` | | 见 [.env.example](.env.example) 与 [src/index.ts](src/index.ts) | ntfy 推送通知配置 |

## 显式约束（当前实现的已知边界）

以下是当前实现的**有意约束**，不是 bug；通用化过程中的演进计划见 ROADMAP 对应阶段。

### 单节点与状态易失

- 仅支持单实例部署。peers、registry、租约、订阅、进行中的代理请求、recovery token 全部在内存中，**进程重启即全部丢失**，客户端需重连并重新订阅（zclaudia 客户端已按此语义实现）。
- SQLite 仅持久化 deviceId/instanceId → backendId 的映射和 epoch 计数器，保证 Backend 重连后 ID 与代次稳定。

### 安全模型（Phase 1 重构对象）

- 可撤销的设备/Backend 凭证已可用（见"认证"一节），凭证认证下 namespace 从服务端记录派生；但**共享 secret 仍在兼容期内有效**且不受 namespace 限制——在三个应用迁移完成、legacy 路径关闭之前，安全边界以持有 secret 者为上限。
- namespace 隔离已在 registry 下发、订阅、定向消息和 HTTP 代理（凭证认证时）层面强制执行，同实例上不同 namespace 互不可见，有集成测试覆盖。
- 浏览器 Cookie Session 与 Backend enrollment→短期访问凭证的交换流程尚未实现（前者随 Phase 5、后者在 Phase 1 内后续补齐）。
- CORS 默认 `Access-Control-Allow-Origin: *`；设置 `GATEWAY_ALLOWED_ORIGINS` 后收紧为 Origin allowlist（带 credentials）。
- WS 认证密钥在消息体中传输（受 TLS 保护的前提下）。

### 尺寸与速率限制

| 限制 | 值 | 位置 |
| --- | --- | ---: |
| WS 最大消息 | 50 MB | `server.ts` maxPayload |
| JSON 请求体 | 15 MB | `express.json` |
| 代理上传体 | 100 MB | `/api/proxy` raw parser |
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

- **仅限 v3 Backend**：代理的二进制内容以 base64 编码经 JSON 消息传输（约 33% 膨胀）、整体响应模式在内存中完整缓存响应体。v4 Backend 的 `/api/proxy` 自动改走 Channel 流式桥接（无 base64、双向背压、端到端取消），客户端零改动。
- 代理 Header 为默认拒绝的 allowlist（见 [src/validation.ts](src/validation.ts)）：请求侧仅转发 content-type/accept/range/条件请求头等；响应侧仅转发内容类头（`Set-Cookie` 与服务器指纹头永不透传）。
- 所有入站协议消息经 runtime 校验，只校验 Gateway 路由所需字段——协议 .d.ts 与真实 v3 流量存在偏差（如快照实际携带 `sessions`/`projects`），完整 schema 收紧推迟到 v4。
- 认证、连接、订阅、代理与凭证生命周期输出结构化 `[audit]` 日志行。
- 资源快照/事件默认对全部订阅者广播；消息携带 `targetPeerSessionId`（可选的加法字段）时仅递送给该订阅者，zclaudia backend 尚未采用。

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
