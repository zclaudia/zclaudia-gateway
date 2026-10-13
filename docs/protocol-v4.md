# Gateway Protocol v4 — Channels（草案）

> 状态：Draft（随实现演进）。承载决策见 [ADR-0003](adr/0003-channel-transport.md)。
> 参考实现：TypeScript（`packages/protocol` / `packages/client` / `packages/backend`）与
> Python（`packages/python`，[ADR-0006](adr/0006-python-backend-sdk.md)）。
> v4 是唯一协议版本：`peer_hello.protocolVersion` 必须为 4，非 v4 握手被拒绝并返回
> `PROTOCOL_VERSION_MISMATCH`。唯一保留的 v3 形态消息是 `backend_server_message`
> 定向回退（见文末）。

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

v4 沿用 `peer_hello`/`peer_ready` 消息形态，`protocolVersion` 必须为 4。
`gatewaySecret` 字段承载 Gateway 签发的凭证（zgd_/zgb_/zga_；字段名为 wire
兼容保留，共享密钥已移除）。namespace 与注册权限由服务端凭证记录决定。

**Backend 身份**（[ADR-0008](adr/0008-credential-bound-backend-identity.md)）：
由后端凭证授予。`zgb_` 签发时即确定 backendId（128-bit UUID），持该凭证（或其换发的
`zga_`）连接者即该 Backend，`identity.instanceId`/`channel` 只作描述。同一 backendId
多处连接时新连接顶替旧连接。尚未绑定的旧版凭证仍按 `(tenant, namespace, instanceId,
environment)` 映射（tenant 预留恒为空；environment 即 `identity.channel`，默认
`prod`），并因此必须携带 `identity.instanceId`。

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
  reason 为 `epoch_changed` / `backend_offline`（失效由 Gateway 铸造并下发，
  客户端无需从 registry diff 推断）。

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

### Retained payload（retain 语义）

`topic_publish` 带 `retain: true` 时，Gateway 保存该 (Backend, Topic) 的最后一份
retained payload，并在新订阅者 `topic_subscribed` 之后立即补发一条
`topic_message`——冷订阅者无需请求往返即可获得当前状态（典型用途：资源快照）。
不带 retain 的发布不覆盖 retained 状态（事件与快照可共用同一 Topic）。
retained 状态随 Backend 下线 / epoch 换代清除（过期 epoch 的状态不得存活）；
每 Backend 最多保留 64 个 retained Topic，超出的 retain 请求被忽略并审计。

## 7. v4 HTTP 流式映射（kind = `http`）

客户端仍用普通 HTTP 访问 `/api/proxy/:backendId/*`；Gateway 自动改走 Channel
桥接：

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

## 9. 与历史 v3 协议的关系

v3 已整体移除（`peer_hello.protocolVersion` 必须为 4）：订阅/快照广播由
Topic（含 retain）取代，`http_proxy_*` 由 Channel 流式桥取代，定向消息走
消息 Channel。唯一保留的 v3 形态消息是 `backend_server_message`（带
`targetPeerSessionId` 的定向回退路径，同 namespace 校验）。历史 v3 类型
仅存于 `@zclaudia/protocol/gateway` 的冻结兼容入口（0.3.0 删除）；
v4 规范类型见 `@zclaudia/gateway-protocol`。

## 10. 附录：Backend wire 参考

字段与数值由两套 SDK（TS/Python）与网关实现共同锁定。新增字段保持向后兼容，
改义或删除需升协议版本；接收侧必须容忍未知消息类型与未知错误码。

### 10.1 握手

`peer_hello`（Backend 实际发送形态）：

| 字段 | 值 |
| --- | --- |
| `type` / `protocolVersion` | `"peer_hello"` / `4` |
| `namespace` | 必须等于服务端凭证记录的 namespace，不一致返回 `UNAUTHORIZED`（不构成授权） |
| `clientProtocolVersion` | 应用层版本号，Backend 自报（默认 1），Gateway 只透传 |
| `peerType` | `"client+backend"`；仅 `zgb_`/`zga_` 凭证可声明（设备凭证被拒） |
| `gatewaySecret` | 凭证 token（`zgd_`/`zgb_`/`zga_`；字段名为 wire 兼容保留） |
| `identity` | 可选 `{deviceId?, instanceId?, name?, channel?}`；均为描述性字段，旧版（未绑定）后端凭证必须带 `instanceId` |
| `backend` | `{visible, capabilities, backendProtocolVersion, minClientProtocolVersion?}` |

`peer_ready`（Gateway → Backend，握手成功）：

| 字段 | 值 |
| --- | --- |
| `type` / `protocolVersion` | `"peer_ready"` / `4` |
| `peerSessionId` | 本次连接的会话 id |
| `recoveryToken` | 预留字段（v4 不做无缝恢复） |
| `backend` | `{backendId, epoch, leaseTtlMs}`——Backend 必须以此为准 |
| `registrySync` | `{items: BackendPresenceV4[]}`（同 namespace 的在线 Backend 目录；设备凭证限定了后端范围时只含范围内的 Backend） |

`BackendPresenceV4`（registry 项）：`namespace`、`backendId`、`instanceId`、
`deviceId`、`name`、`channel`、`visible`、`capabilities`、
`backendProtocolVersion`、`minClientProtocolVersion?`、`epoch`、`connectedAt`、
`lastSeenAt`、`gatewayProtocolVersion?`。

**Backend 身份**：见 §2——由后端凭证授予，旧版凭证仍按 `(namespace, instanceId,
environment)` 映射。`backendId` 跨重连与凭证轮换稳定；`epoch` 每次连接递增，旧代次的
channel/topic 订阅/retained 状态全部失效。

**设备后端范围**：设备凭证可限定为若干 backendId（缺省为整个 namespace）。范围外的
Backend 不出现在 registry 中，`channel_open`、`topic_subscribe` 与 HTTP 代理对其返回
与"不存在/离线"相同的 `BACKEND_OFFLINE`；Backend 发往范围外设备的定向
`backend_server_message` 被丢弃。

### 10.2 心跳与租约

- `backend_heartbeat {epoch, observedAt?}`：建议间隔 10s（SDK 默认）；`observedAt`
  为 Backend 侧墙钟，Gateway 忽略。
- 租约 TTL 由 `peer_ready.backend.leaseTtlMs` 下发（默认 30s）。超时未心跳 →
  租约失效：registry 移除、全部 channel 以 `epoch_changed`/`backend_offline` 关闭、
  retained topic 清除。
- Gateway 回 `heartbeat_ack {epoch, streamDemand: false}`；`streamDemand` 恒为
  `false`（v3 的流需求协商已移除，字段为 ack 形状稳定保留）。

### 10.3 错误模型

`gateway_error {code, message, recovery?}`，`code` ∈ `INVALID_MESSAGE` /
`PROTOCOL_VERSION_MISMATCH` / `UNAUTHORIZED` / `BACKEND_OFFLINE` /
`RATE_LIMITED`；`recovery` 当前不发送，未知值按"无恢复动作"处理。

### 10.4 数值与配额（当前实现）

| 项 | 值 | 位置 |
| --- | ---: | --- |
| 租约 TTL | 30 s（`leaseTtlMs` 下发） | `state.ts` |
| SDK 心跳间隔 | 10 s | SDK 默认 |
| channel ticket TTL（= 配对超时） | 30 s | `server.ts` |
| 单 Peer 并发 channel | 32（超限 `channel_open` 返回 `RATE_LIMITED`） | `server.ts` |
| Backend access token TTL | 24 h（`POST /api/backend/token` 换出） | `server.ts` |
| WS maxPayload（控制面与数据面） | 50 MB | `server.ts` |
| JSON 请求体上限 | 15 MB | `server.ts` |
| 每 IP WS 连接数 | 10 | `server.ts` |
| 认证失败限流 / 代理限流 | 10 次/min/IP / 200 次/min/IP | `server.ts` |
| retained topic 上限 | 64 个/Backend | `server.ts` |
| per-channel 字节速率 | 默认不限（`channelByteRateLimit` 可配） | `server.ts` |

### 10.5 定向回退

`backend_server_message {backendId, targetPeerSessionId?, message}`：Backend →
Gateway → 目标 peer 的单向回退路径（消息 Channel 重建期间的过渡手段）。缺
`targetPeerSessionId` 的消息被 Gateway 丢弃，不再广播。

