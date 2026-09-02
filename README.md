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
| 0.1.x（当前） | **3** | `@zclaudia/protocol` ^0.2.0 | 唯一支持的版本，其余一律拒绝（`PROTOCOL_VERSION_MISMATCH`） |
| — | 1 / 2 | — | 已废弃，无兼容层 |

`clientProtocolVersion` / `backendProtocolVersion` 是应用层版本号，Gateway 只透传不解释。

## 认证

- **WebSocket**：连接后首条消息必须是 `peer_hello`，`gatewaySecret` 字段随消息体传输（10 秒内未认证即断开）。
- **HTTP**：`Authorization: Bearer <token>`，token 接受两种格式（两处端点行为一致，有回归测试锁定）：
  1. `<gatewaySecret>` —— 所有现有客户端使用的格式；
  2. `<clientId>:<gatewaySecret>` —— 历史遗留的复合格式，clientId 被忽略。

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
| `GATEWAY_TRUST_PROXY` | | `false` | 信任 `X-Forwarded-For`（仅置于可信反代之后时开启） |
| `ZCLAUDIA_DATA_DIR` | | `~/.zclaudia` | SQLite 数据目录（实际路径 `<dir>/gateway/gateway.db`） |
| `NTFY_*` | | 见 [.env.example](.env.example) 与 [src/index.ts](src/index.ts) | ntfy 推送通知配置 |

## 显式约束（当前实现的已知边界）

以下是当前实现的**有意约束**，不是 bug；通用化过程中的演进计划见 ROADMAP 对应阶段。

**单节点与状态易失**

- 仅支持单实例部署。peers、registry、租约、订阅、进行中的代理请求、recovery token 全部在内存中，**进程重启即全部丢失**，客户端需重连并重新订阅（zclaudia 客户端已按此语义实现）。
- SQLite 仅持久化 deviceId/instanceId → backendId 的映射和 epoch 计数器，保证 Backend 重连后 ID 与代次稳定。

**安全模型（Phase 1 重构对象）**

- 全体客户端与 Backend 共享**单一 secret**，无 per-client/per-device 身份，无法单独撤销。
- `peer_hello.namespace` 由客户端自我声明且**未被强制执行**：registry 快照对所有 peer 全量下发，不按 namespace 过滤。因此当前**不能**将多个应用接入同一 Gateway 实例。
- CORS 为 `Access-Control-Allow-Origin: *`。
- WS 认证密钥在消息体中传输（受 TLS 保护的前提下）。

**尺寸与速率限制**

| 限制 | 值 | 位置 |
| --- | --- | ---: |
| WS 最大消息 | 50 MB | `server.ts` maxPayload |
| JSON 请求体 | 15 MB | `express.json` |
| 代理上传体 | 100 MB | `/api/proxy` raw parser |
| 每 IP WS 连接数 | 10 | `MAX_WS_CONNECTIONS_PER_IP` |
| 认证失败限流 | 10 次/分钟/IP | `AUTH_FAIL_LIMIT` |
| 代理请求限流 | 200 次/分钟/IP | `PROXY_RATE_LIMIT` |

**超时与周期**

| 项 | 值 |
| --- | ---: |
| WS 认证超时 | 10 s |
| 代理请求超时（整体响应） | 30 s |
| 代理流式空闲超时（逐 chunk 重置） | 60 s |
| WS ping 周期 | 30 s |
| Backend 租约 TTL / 检查周期 | 30 s / 5 s |
| Registry 兜底广播周期 | 30 s |

**传输语义**

- 代理的二进制内容以 base64 编码经 JSON 消息传输（约 33% 膨胀）；整体响应模式会在内存中完整缓存响应体。真正的流式与二进制帧是 Protocol v4（ROADMAP Phase 2）的目标。
- 资源快照/事件对全部订阅者广播，无定向递送（targeted `backend_server_message` 除外）。

## 设计决策

重要决策以 ADR 记录于 [docs/adr/](docs/adr/)。ROADMAP 第 8 节列出了实施前待定的决策清单。
