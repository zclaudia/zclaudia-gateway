# Gateway Protocol v4 — Channels（草案）

> 状态：Draft（随实现演进）。承载决策见 [ADR-0003](adr/0003-channel-transport.md)。
> v4 与 v3 在同一 Gateway 实例上共存：`peer_hello.protocolVersion` 决定会话协议版本，v3 行为完全不变。

## 1. 概念

**Channel**：某一客户端 Peer 与某一 Backend 之间的逻辑专线。逻辑身份为四元组
`(namespace, sourcePeerSessionId, (backendId, epoch), channelSeq)`；wire 上唯一键为
Gateway 铸造的 128-bit 不可猜测 `channelId`，四元组是服务端绑定的授权属性，
两端不在数据帧中声明身份。

**两个平面**：

- 控制面：既有 `/ws` 连接，跑 `peer_hello`、registry、channel 协商与生命周期通知。
- 数据面：每 Channel 一条独立 WS 连接（`/channel/:channelId?ticket=...`），
  经一次性 ticket 认证后成为 Gateway 不解析的纯字节管道（文本与二进制帧均透传，
  背压由 socket pipe 天然提供）。

## 2. 握手

v4 复用 v3 的 `peer_hello`/`peer_ready`，仅 `protocolVersion: 4`。
v4 会话额外获得 channel 控制消息；registry、订阅等 v3 消息在 v4 会话中继续可用。

**Backend 身份（v4）**：唯一键为 `(tenant, namespace, instanceId, environment)`
（tenant 预留恒为空；environment 即 `identity.channel`，默认 `prod`），backendId 为
稳定的 128-bit UUID。v3 Backend 保持 legacy 的 instance 键与短 ID，wire 不变。

## 3. Channel 生命周期

```text
client                     Gateway                      backend
  │ ①channel_open             │                            │
  │   {target, kind}          │                            │
  │──────────────────────────►│ ②ACL：namespace 一致、      │
  │                           │   backend 在线、配额未超     │
  │                           │ ③铸造 channelId + 两张      │
  │                           │   一次性 ticket             │
  │ ④channel_ready            │ ⑤channel_offer             │
  │   {channelId, ticket,     │───────────────────────────►│
  │    dataPath}              │    {channelId, kind,        │
  │◄──────────────────────────│     sourcePeerSessionId,    │
  │                           │     ticket, dataPath}       │
  │ ⑥拨 /channel/:id?ticket   │        ⑦拨号即接受；         │
  │═══════════════════════════│◄═══════ 拒绝则发            │
  │                           │   channel_reject{channelId} │
  │                           │ ⑧双方到齐 → 对接 pipe        │
  │◄═════════ 透明双向字节管道 ═════════════════════════════►│
```

- **拨号即接受**：Backend 不需要先回 accept 再拨号，拨通数据连接就是接受；
  显式拒绝发 `channel_reject`，Gateway 随即拆除并通知客户端。
- **配对超时**：ticket TTL（默认 30 s）内未双方到齐，Gateway 拆除 channel。
- **关闭**：任一端关闭数据连接即关闭整个 channel（另一端连接同步关闭）；
  Gateway 在两端控制连接上发 `channel_closed {channelId, reason}`。
- **epoch 失效**：Backend 租约换代次或下线时，Gateway 主动关闭其全部 channel，
  reason 为 `epoch_changed` / `backend_offline`（v3 的"客户端从 registry diff
  推断失效"不再适用于 channel）。

## 4. 控制面消息（v4 新增）

| 消息 | 方向 | 字段 |
| --- | --- | --- |
| `channel_open` | client → GW | `target`（backendId）、`kind?`（应用自定义，GW 透传） |
| `channel_ready` | GW → client | `channelId`、`ticket`、`dataPath` |
| `channel_offer` | GW → backend | `channelId`、`kind?`、`sourcePeerSessionId`、`ticket`、`dataPath` |
| `channel_reject` | backend → GW | `channelId`、`reason?` |
| `channel_close` | 任一端 → GW | `channelId`（等价于关闭数据连接，供未拨号阶段使用） |
| `channel_closed` | GW → 两端 | `channelId`、`reason`（`closed` / `rejected` / `timeout` / `epoch_changed` / `backend_offline`） |

错误沿用 `gateway_error`；`channel_open` 被拒（目标不存在/跨 namespace/配额超限）
返回 `BACKEND_OFFLINE` 或 `RATE_LIMITED`，与 v3 语义一致，不做存在性探测器。

## 5. 数据面认证（ticket）

- ticket 为一次性、默认 30 s TTL、绑定 `(channelId, role)`（client/backend 各一张）；
  用过即废，泄漏进日志也无法复用。
- 放在 URL query（`?ticket=`）：WebView 的 WHATWG WebSocket 无法设置 header，
  ticket 是客户端主路径；Backend SDK 同样使用 ticket 以保持对称。
- 控制连接用完整凭证认证（Phase 1 凭证体系），数据面只认控制面预授权的 ticket——
  两个平面使用不同强度的凭证。

## 6. Topic 广播原语

一对多分发不走 Channel（否则 Backend 上行带宽随订阅者数放大），走 Topic：
Backend 向 Topic 发一份，Gateway 在带宽充裕侧复制给各订阅者。

| 消息 | 方向 | 字段 |
| --- | --- | --- |
| `topic_subscribe` | client → GW | `backendId`、`topic` |
| `topic_subscribed` / `topic_unsubscribed` | GW → client | `backendId`、`topic` |
| `topic_unsubscribe` | client → GW | `backendId`、`topic` |
| `topic_publish` | backend → GW | `topic`、`payload`（GW 不解析） |
| `topic_message` | GW → 订阅者 | `backendId`、`topic`、`payload` |

授权模型（与定向 Channel 不同）：订阅要求与目标 Backend 同 namespace（跨界响应与
不存在的 Backend 一致）；发布仅限 Backend 当前租约持有者。Backend 下线/换代次时其
全部 Topic 订阅被清除，订阅者从 registry 感知重建。

## 7. v4 HTTP 流式映射（kind = `http`）

客户端仍用普通 HTTP 访问 `/api/proxy/:backendId/*`；当目标 Backend 是 v4 会话时，
Gateway 自动改走 Channel 桥接（客户端与 v3 Backend 完全不感知）：

1. Gateway 为该请求创建一条 **internal channel**（客户端端点是 HTTP 请求/响应流本身，
   不经拨号），向 Backend 发 `channel_offer {kind: 'http'}`；Backend 照常拨数据连接。
2. 请求方向：Gateway 先发一个文本帧 `{"type":"http_request", method, path, headers}`
   （headers 经 allowlist 过滤），随后请求体以二进制帧流式发送，
   结束时发文本帧 `{"type":"http_request_end"}`。
3. 响应方向：Backend 先回一个文本帧 `{"type":"http_response", status, headers}`，
   随后响应体以二进制帧流式发送，**关闭数据连接即响应结束**。
4. 取消与超时端到端传播：客户端断开 → channel 拆除 → Backend 数据连接关闭；
   响应元数据超时 → 504；Backend 离线/拒绝 → 502。
5. 全程无 JSON/base64 编码的响应体，两侧背压生效，Gateway 内存有界。

## 8. 限制与配额

- 单 Peer 并发 channel 上限（默认 32，可配置；internal http channel 计入 Backend 侧配额）。
- 数据帧大小上限沿用 WS maxPayload（大文件由 SDK 分帧流式发送）。
- per-channel 字节速率限制（`channelByteRateLimit`，字节/秒/方向，默认不限）：
  1 秒窗口令牌桶，超发暂停发送端 socket，超发量结转下一窗口；帧不拆分，
  单窗口最多超发一帧。

## 7. 与 v3 的关系

- v3 会话完全不变，两版本客户端可同时在线。
- v4 会话可以继续使用 v3 的订阅/快照消息（迁移期），最终由 Topic 原语替代广播语义。
