# zclaudia-gateway 通用化 Roadmap

> 状态：**Phase 0–3 已完成**（含生产部署；详见各阶段进度注）。2026-09-04 修订四：v3 协议与共享 secret 认证跳过兼容期整体删除（单操作者、零遗留对端）；SDK 三包发布 npm；生产部署实况记入 ADR-0001 备注；下一步为 Phase 3 后检查点裁决（见第 6 节）。
>
> 历史：Draft（2026-09-01 修订一：wire 格式变更集中到 v4、Tenant 机制降级为字段预留、新增 Channel 传输承载 ADR、Go SDK 推迟、时间估算标注为乐观值。修订二：基于 zclaudia 与 comfy-mobile-ui 代码调研补充 Channel 身份四元组、三载体拨号认证（ticket 为客户端主路径）、Topic 升级为一等原语、epoch 失效语义、Comfy 设备凭证 origin 迁移与保活要求。2026-09-02 修订三：Phase 3 后检查点、namespace 共存测试、基于 hermes-client-mobile 调研重写 Phase 4——Hermes 本体为 Python、现有 Go proxy 242 行可移植、per-client 身份为核心增量、媒体签名 URL 为硬需求、事件缺 session_id 需 Hermes 侧协议配合）
>
> 更新日期：2026-09-04
>
> 适用范围：`zclaudia-gateway`（含 `@zclaudia/gateway-protocol`/`-client`/`-backend` SDK），以及 zclaudia、Hermes、ComfyUI 的 Gateway 接入层

## 1. 背景

`zclaudia-gateway` 当前已经具备中心 Gateway 的基本形态：Backend 注册与发现、WebSocket 长连接、消息中继、HTTP 代理、心跳与租约，以及基础的推送通知能力。

当前实现主要服务于 zclaudia 的资源同步和远程访问模型。Hermes 与 ComfyUI 对 Gateway 的要求明显不同：

- Hermes 主要使用 JSON-RPC WebSocket 和 `/api/*` HTTP API，需要 Gateway 在本地安全地注入私有 Session Token，并为不同远程客户端隔离本地会话。
- ComfyUI 需要大文件流式上传和下载、二进制 WebSocket、浏览器 Session、可撤销的原生设备凭证、路由白名单和危险操作控制。
- zclaudia 最初使用 Gateway Protocol v3（已完成 v4 全量迁移，v3 于 2026-09 整体移除）。

因此，通用化的目标不是继续向中心服务添加应用条件分支，而是把 Gateway 建设成一套与业务 payload 无关的安全反向隧道平台。

## 2. 产品目标

通用 Gateway 应当为不同应用提供统一的：

- 用户、设备、Backend 和运维身份认证；
- Namespace 和 Backend 级访问控制（协议预留 Tenant 字段，多租户机制在出现真实需求前不实现）；
- Backend 注册、发现、能力声明、租约和健康状态；
- 定向、隔离、可恢复的逻辑 Channel；
- JSON 与二进制 WebSocket 数据传输；
- 真正流式的 HTTP 请求和响应；
- 取消、超时、背压、配额和审计；
- 通用 Client SDK、Backend SDK 和兼容性策略；
- 单节点部署到多实例部署的清晰演进路径。

### 非目标

中心 Gateway 不应：

- 理解 Hermes JSON-RPC、zclaudia resource event 或 ComfyUI workflow 等业务 payload；
- 保存或向远程客户端暴露本地服务的私有 Token；
- 在核心路由中维护 `if app === ...` 形式的应用分支；
- 成为允许访问任意地址和端口的开放代理；
- 在第一阶段同时承担应用 UI 静态资源托管；
- 为追求多实例而提前引入尚未验证必要性的分布式组件；
- 在出现第二个真实租户之前实现 Workspace/Tenant 管理和 ACL 机制（协议层只预留字段）。

## 3. 目标架构

```text
zclaudia / Hermes / ComfyUI Client
                 │
                 │ Gateway Client SDK
                 ▼
┌──────────────────────────────────────────────┐
│              Central Gateway                 │
│                                              │
│  Control Plane                               │
│  Auth / Tenant / ACL / Registry / Lease      │
│                                              │
│  Data Plane                                  │
│  Channel / Binary / HTTP Stream / Backpressure │
└──────────────────────────────────────────────┘
                 │
                 │ Gateway Backend SDK
                 ▼
┌──────────────────────────────────────────────┐
│ Application Adapter                          │
│ zclaudia / Hermes / Comfy                     │
│                                              │
│ Local auth injection / Route policy /         │
│ Protocol translation / Local connection       │
└──────────────────────────────────────────────┘
                 │
                 ▼
       Local Application Service
```

### 3.1 中心 Gateway

中心 Gateway 只处理通用能力：

- 验证身份并从凭证生成服务端可信的角色和 scopes；
- 管理 Tenant、Namespace、Backend、Peer 和 Channel；
- 根据 ACL 建立或拒绝 Channel；
- 路由控制帧、JSON 数据帧和二进制数据帧；
- 管理流控、配额、超时、取消、日志和指标；
- 不解析应用业务 payload。

### 3.2 Application Adapter

Application Adapter 运行在业务服务旁边，通常作为进程内模块或同机 Sidecar：

| Adapter | 推荐部署形态 | 主要职责 |
| --- | --- | --- |
| `gateway-adapter-zclaudia` | zclaudia server 进程内模块（已落地） | resource snapshot/event（Topic）、消息 channel、流式 HTTP |
| `gateway-adapter-hermes` | Hermes 主机上的 Node Sidecar（Go SDK 推迟，见 Phase 4） | JSON-RPC、本地 WS 会话隔离、Session Token 注入、`/api/*` 转发 |
| `gateway-adapter-comfy` | ComfyUI 主机上的 Node Sidecar | 大文件流、二进制 WS、路由白名单、危险操作策略、Header 清洗 |

Adapter 使用统一 Backend SDK 连接中心 Gateway。本地服务的私有 Token 只存在于 Adapter 所在设备。

### 3.3 Client Transport

客户端使用统一 Client SDK 处理认证、注册表、Channel、HTTP、重连和恢复；各项目只保留轻量业务封装：

- `ZclaudiaGatewayTransport`
- `HermesGatewayTransport`
- `ComfyGatewayTransport`

这些 Transport 可以向现有业务代码暴露应用熟悉的 API，例如 Virtual WebSocket、JSON-RPC Client 或 HTTP Client。

## 4. 核心设计原则

1. **身份由凭证决定**：不能信任 Peer 自行声明的角色、Tenant、Namespace 或 scopes。
2. **默认拒绝**：Backend、Channel、HTTP 路由和广播均需显式授权。
3. **定向优先**：默认消息具有明确 source、target 和 owner；广播必须使用显式 Topic。
4. **端到端流式传输**：文件不能整体缓存在 Express、WebSocket 消息或 Adapter 内存中。
5. **二进制不经过 Base64**：控制帧使用 JSON，字节流使用二进制帧。
6. **核心与业务解耦**：应用协议、私有认证和危险操作策略属于 Adapter。
7. ~~**兼容迁移**~~（已完成使命：迁移期 v3/v4 曾共存；zclaudia 全量切 v4 后 v3 整体删除，新对端从 v4 起步）。
8. **先可观测再扩容**：先获得真实连接、流量、延迟和内存指标，再确定多实例方案。
9. **优先复用传输层能力**：能由独立 TCP/WS 连接天然提供的背压、隔离和取消，不在应用层重新实现多路复用（见 Phase 2 的 ADR）。

## 5. 分阶段计划

### Phase 0：建立基线 ✅（2026-09-02 完成）

目标：让后续重构拥有稳定、可验证的工程基线。

工作项：

- 补充项目 README、架构说明、协议兼容矩阵和本地开发说明；
- 清理或升级仍使用旧协议的手工测试脚本；
- 恢复可运行的 lint，并统一 build、test、coverage 命令；
- 修复并行测试中的偶发超时；
- 对认证、订阅、路由、HTTP proxy、断线和恢复建立测试基线；
- 澄清并统一 HTTP Bearer token 的解析规则：当前 `requireGatewayAuth` 取冒号后段作为 secret，而 `/api/proxy` 路由取冒号前段，两处逻辑相反，需确认预期格式并补回归测试；
- 将当前单节点、内存状态和消息大小限制记录为显式约束；
- 为重要设计决策建立 ADR 目录。

验收标准：

- CI 中 lint、build 和 test 稳定通过；
- 测试不依赖一秒级脆弱超时；
- 当前 v3 行为和已知限制有文档及回归测试覆盖。

### Phase 1：安全与隔离基础 ✅（2026-09-03 完成）

目标：在接入第二个业务之前，建立可用于多应用和多用户的安全边界。

范围约束：本阶段只做**不改变 v3 wire 格式**的服务端加固；所有需要变更消息格式或标识规则的安全项（Backend 唯一键、UUID 标识等）随 Protocol v4 在 Phase 2 落地，避免产生非正式的"v3.5"。

工作项：

- 拆分管理员、Backend、用户、浏览器和设备凭证；
- Backend 使用 enrollment credential 换取短期访问凭证，后续可选 mTLS；
- 角色、Namespace 和 scopes 只能从服务端验证后的凭证生成；
- 引入 Namespace 和 Backend ACL；凭证与数据模型预留 Tenant 字段但不实现 Tenant/Workspace 管理机制；
- 对所有入站协议消息执行 runtime schema validation；
- 将 pending request 与 authenticated Backend、source Peer 和 Channel 绑定；
- 默认禁止 Backend 向未订阅 Peer 发送消息；
- 资源快照改为明确的请求方定向响应；
- 实现统一的请求与响应 Header allowlist/denylist；
- 将 CORS 从 `Access-Control-Allow-Origin: *` 收紧为可配置的 Origin allowlist（后续浏览器 HttpOnly Session 需要 credentials，与通配符不兼容）；
- 对认证、注册、订阅、代理和通知增加审计事件；
- 修正 HTTP 状态映射，例如超时使用 504、Backend 不可用使用 502/503。

验收标准：

- 客户端凭证不能注册、替换或冒充 Backend；
- 不同 Namespace 之间的 registry、消息和 HTTP 请求完全隔离；
- 显式集成测试：同一 Gateway 实例上注册两个不同 namespace 的 Backend，双方的客户端在 registry 中互相不可见、订阅互相被拒（这是三个应用共用同一实例的前提条件）；
- 伪造 request ID、target peer 或 Backend 响应不能跨 Channel 生效；
- 本地 Session Token、Cookie 和内部认证 Header 不会泄漏到远程客户端；
- 现有 v3 客户端无需修改即可通过本阶段的全部变更；
- 关键越权场景具有自动化负向测试。

### Phase 2：Protocol v4 与通用数据面 ✅（2026-09-03 完成；Hermes 原型项顺延至 Phase 4，见下）

目标：提供 Hermes 和 ComfyUI 都能使用的通用传输能力。

**前置 ADR：Channel 的传输承载方式。** 两个候选：

1. **每个 Channel 一条独立 WebSocket 连接**（倾向此方案）：背压由各连接的 `bufferedAmount` 天然隔离，取消即关闭连接，二进制直接用原生 binary frame；`window.update`/`ack`、per-channel framing 和大部分流控状态机可以整体删除。代价是连接数增加，在当前规模（个人/小团队、三个应用）下可接受。
2. **单连接上自研多路复用**：本质是在 WebSocket 上重新实现 HTTP/2 子集（多路复用、流控窗口、取消传播），实现和跨语言移植成本高，历史上此类协议普遍超期 2–3 倍。仅当连接数被证实成为瓶颈时再考虑。

**Channel 身份与认证载体**（依据对 zclaudia 和 comfy-mobile-ui 的实际代码调研）：

- Channel 逻辑上由四元组 `(namespace, sourcePeerSessionId, (backendId, epoch), channelSeq)` 唯一确定；wire 上使用 Gateway 铸造的不可猜测 128-bit `channelId` 作为唯一查找键，四元组是服务端绑定的授权属性，两端不得在数据帧中自行声明身份（这是 v3 靠消息字段路由导致可伪造的教训）。
- 拨号认证按客户端能力分三条路径：**一次性短 TTL ticket（URL 携带）是客户端主路径**——zclaudia desktop（Tauri WebView，`GatewayTransport` 使用无 headers 的 WHATWG WebSocket）和 comfy-mobile-ui 浏览器模式都无法设置 WS header；`Authorization` header 供 Backend SDK 和原生客户端（如 comfy 的 Tauri socket）使用；Cookie Session 供 ComfyUI 浏览器客户端使用（升级请求自动携带）。控制连接用完整凭证认证，数据连接只认控制面预授权的 ticket。
- **epoch 失效由 Gateway 在 Channel 层主动执行**：Backend 租约换代次时，Gateway 关闭所有绑定旧 epoch 的 Channel 并携带 `epoch_changed` 原因。不能沿用 v3 的做法（zclaudia 客户端目前从 `registry_snapshot` diff 中自行推断 epoch 变化）。
- **Topic 广播是 Gateway 的一等原语，不是可选项**：zclaudia backend 的资源快照/事件是一对多分发（流 demand 激活期间每 30 秒推全量快照）。若按"每订阅者一条 Channel、Adapter 各发一份"，Backend 上行带宽随订阅者数线性放大，家庭宽带上行不可接受。正确模型：定向流量走 Channel；一对多流量 Backend 向 Topic 发一份，由 Gateway 在带宽充裕侧复制给各订阅者。

建议的协议原语（按方案 1；`window.update`/`ack` 仅在选择方案 2 时需要）：

```text
channel.open
channel.accept / channel.reject
channel.data
channel.close

request.start
request.chunk
request.end
request.cancel

response.start
response.chunk
response.end
```

工作项：

- 完成上述传输承载 ADR，并据此定稿 v4 envelope、状态机、错误码和能力协商；
- 将 Backend 唯一键调整为 Namespace、Instance 和 Environment 的组合（预留 Tenant 位）；
- 使用 UUID 或等价的 128-bit 标识替换短 Backend ID；
- 支持 JSON/Text 和 Binary 两类 Channel 数据；
- 实现请求和响应的 start/chunk/end 流式协议；
- 实现 client disconnect、deadline 和主动 cancel 的端到端传播；
- 基于每 Channel 连接的 `bufferedAmount` 实现背压；
- 限制 Peer、Channel、并发请求、消息速率和字节速率；
- 支持 `Range`、缓存验证、内容类型、下载文件名等受控 Header；
- 实现 Topic 广播原语（Backend 上行发一份、Gateway 侧 fan-out），并为定向消息和 Topic 广播定义不同的授权模型；
- 实现基于一次性 ticket / header / Cookie 三种载体的 Channel 拨号认证；
- 实现 epoch 换代时 Gateway 主动关闭旧 Channel（`epoch_changed`）；
- 评估 WebSocket、HTTP/2 和 QUIC 作为长期 Backend Tunnel 的取舍，并记录 ADR；
- ~~保持 v3 endpoint，增加 v3 到 v4 的兼容层~~（曾实现共存；zclaudia 全量迁移后 v3 整体删除）；
- 用一个最小 Hermes JSON-RPC Channel 原型验证协议设计——**顺延至 Phase 4**（hermes-agent 仓库当时不可用，用户决定先忽略 Hermes；协议返工风险由此后移，Phase 4 开工时优先验证）。

验收标准：

- 二进制 WebSocket payload 不经过 JSON 或 Base64；
- 大文件上传和下载过程中内存占用保持有界，不随文件大小线性增长；
- 慢消费者不会导致 Gateway 无界缓存；
- 客户端取消或断开能够释放 Gateway 与 Adapter 两端资源；
- 最小 Hermes JSON-RPC 原型可以通过 v4 Channel 端到端工作；
- v3 zclaudia 客户端在兼容期内无需同步升级即可继续工作。

### Phase 3：公共 SDK 与 zclaudia 迁移 ✅（2026-09-04 完成并生产部署）

目标：把协议细节从应用代码中移出，并用现有 zclaudia 流量验证新核心。

> **进度（2026-09-03）**：SDK 三包（protocol/client/backend）与契约测试已落地（ADR-0004，
> workspace 同仓）；zclaudia server 侧迁移在 `feature/gateway-v4` 分支完成四个切片：
> ① v4 注册（UUID backendId）+ channel 流式 HTTP 代理（`/api/proxy` 去 base64），
> ② 快照/事件双发 `resources` Topic（快照带 retain），
> ③ multipart 上传经 gateway 全程流式（`streamingUpload` 能力协商，desktop 已切换），
> ④ per-client 消息 channel（kind `zclaudia`，复用虚拟客户端机制，v3 路径共存）。
> 每个切片均有跨仓 e2e 验证。
>
> **收官（2026-09-04）**：desktop 消费端（Topic + 消息 channel）完成并合并回 zclaudia
> main；生产部署上线（gateway.zhvala.space，容器化 Caddy 前置）并经真浏览器网页模式
> e2e 验证；凭证切换完成后**跳过兼容期直接终局**——v3 协议与共享 secret 认证均整体
> 删除（单操作者、零遗留对端，"版本兼容矩阵与 v3 弃用条件"随之作废）。
> 剩余小项：`gateway-testing` 抽包（等 Hermes/Comfy Adapter 需要时）。
> SDK 已发布至 npm（`@zclaudia/gateway-protocol` / `-client` / `-backend` 0.1.0，2026-09-04）；zclaudia 已从 `link:` 切换到正式版本。
> 注：zclaudia server 保留了自有传输层（握手驱动的 backoff 重置、SOCKS agent 等
> 四处语义与 SDK 生命周期不匹配），SDK 在 zclaudia 中当前仅贡献 wire 类型；
> 传输层是否换 SDK 留待消费端迁移完成后单独评估。

可行性依据（2026-09 代码调研）：zclaudia 与 Channel 模型天然对齐——客户端全部状态已按 backendId 分键，无任何跨 backend 全局消息顺序依赖；重连语义已是"清空订阅、按 `desiredOpenBackends` 集合全量重订阅"（recoveryToken 存而未用），该集合可 1:1 映射为"应持有的 Channel 集合"；registry 消费独立于订阅，与控制面拆分吻合。同时开启的 Channel 数为"侧边栏展开 ∪ 前台"，典型 2–5 条。

计划拆分：

- `@zclaudia/gateway-protocol`：类型、runtime schema、framing 和版本协商；
- `@zclaudia/gateway-client`：认证、registry、channel、HTTP、重连与恢复；
- `@zclaudia/gateway-backend`：注册、租约、channel 生命周期、本地 HTTP/WS bridge；
- `@zclaudia/gateway-testing`：协议一致性测试、fake peer 和 Adapter contract tests。

工作项：

- 从 zclaudia desktop/server 中提取重复的连接、重试、请求关联和流式处理代码；
- 实现 `gateway-adapter-zclaudia`；
- 将 resource snapshot/event 迁移到 Topic 广播（Backend 上行发一份，Gateway fan-out），定向消息（terminal、run、targeted heartbeat）迁移到 Channel；
- 客户端消息发送 API 改为 channel-scoped，顺带修复现有的 terminal 路由缺陷（`terminal_input`/`resize`/`close` 不带 backendId，按"回退到前台 backend"路由，多 backend 下存在串线隐患）；
- 文件上传从"base64 编码进 JSON body 经 HTTP proxy"（当前 10 MB 文件约 13 MB JSON）迁移到 v4 流式 HTTP；
- 新客户端优先使用 v4，旧客户端继续通过 v3 compatibility layer；
- 建立 SDK 与 Gateway 的版本兼容矩阵；
- 定义 v3 的弃用条件，不提前承诺固定删除日期。

验收标准：

- zclaudia 的现有远程访问能力在 v4 上功能等价；
- 中心 Gateway 不再直接理解 zclaudia resource payload；
- Client/Backend SDK 能通过独立 contract test 验证；
- v3 和 v4 客户端可以在同一 Gateway 实例上共存。

### Phase 4：Hermes 试点

目标：通过一个 JSON-RPC 应用验证通用 Channel 与本地 Adapter 模型。

可行性依据（2026-09 对 hermes-client-mobile 的代码调研）：

- Hermes 本体是 **Python 进程**（`hermes_cli.main serve`，监听 `127.0.0.1:9119`），客户端是 Tauri Android 应用（bearer-on-handshake 已在用，Hermes 客户端是三个应用中唯一可直接走 header 主路径的）；
- 现有 Hermes Gateway 是 242 行零依赖的 Go 无状态反向代理：路径 allowlist、REST 注入 `X-Hermes-Session-Token` header、WS 注入 `?token=` query、响应侧清洗 `Set-Cookie`/session header、macOS 上 session token 从进程环境动态抓取且永不落盘——安全策略可整体继承，且逻辑量小到可低成本移植进 Node Adapter；
- **单一静态 access token、零 per-client 身份**：两台设备是同一个 principal，Hermes 无法区分调用方——per-client 凭证是本阶段的核心增量；
- 64 MB base64 附件限制确认（`attachments.ts` 客户端限制，服务端无对应限制），实际为约 85 MB 的单帧 JSON 文本经 WS 传输；
- **协议缺口**：Hermes 事件流不带 session_id，客户端用启发式把无归属事件钉到活跃会话上（`stream-model.ts`）——这层串线风险 Gateway/Adapter 无法单方修复，需要 Hermes 侧在事件上补 session_id，Gateway 层能保证的上限是 per-client 隔离；
- 媒体加载是裸 `<img src>` 指向 `/api/*`，WebView 不会带 Authorization，现状会 401（客户端已有"图片已失效"兜底掩盖此问题）——签名 URL/带 token 路径是硬需求而非可选项；
- 无任何心跳（Tauri WS adapter 未建模 Ping/Pong 帧）；断线恢复 = `session.resume` 全量重拉，无 replay，与 v4"快速重开不做无缝恢复"的决策一致；
- 客户端另有约 27 个 `/api/*` REST 管理路由，与 WS 同源同凭证——HTTP Channel 映射需求确认；
- ⚠️ JSON-RPC wire framing（id 格式、错误形状、超时）位于 `@hermes/shared`（`~/.hermes/hermes-agent`，调研机器上不存在）——**Phase 2 Hermes 原型开工前需 checkout 该仓库验证**。

工作项：

- 以 Node Sidecar 形式实现 `gateway-adapter-hermes`（复用 `@zclaudia/gateway-backend`，移植现有 Go proxy 的 allowlist 与凭证替换逻辑）；Go 版 Backend SDK 推迟到协议稳定且确有需要时再实现，本阶段只输出语言无关的协议规范文档；
- 将现有 Hermes Gateway 的职责迁移到 `gateway-adapter-hermes`；
- 每个远程 source Peer 使用独立本地 Hermes WebSocket（现有 Go proxy 已按连接对接上游，语义保持）；
- Adapter 在本地注入 `X-Hermes-Session-Token`（REST header）与 `?token=`（WS query），并保持响应侧清洗；
- 以 Gateway 凭证体系替换单一静态 access token，实现 per-client 身份；
- 提供 Hermes Virtual WebSocket，使现有 `JsonRpcGatewayClient` 尽量无需修改；
- 将 `/api/*` 管理路由映射到受控的 HTTP Channel；
- 重新设计大附件传输，避免约 85 MB 的 base64 单帧消息（迁移到 v4 流式上传通道）；
- 为媒体资源实现短期签名 URL 或带 token 路径（`<img>` 无法携带 Authorization，现状 401）；
- Gateway 对 Hermes 长连接主动心跳（客户端栈完全无保活）；
- 支持断线重连、Channel 恢复和重复请求保护；
- 向 Hermes 侧提出事件补 session_id 的协议变更（会话级串线的根治依赖此项）。

验收标准：

- Hermes 私有 Session Token 只存在于 Hermes 主机；
- 两个远程客户端各自持有独立凭证，可单独撤销；本地 WebSocket 会话和响应不会跨客户端串线；
- JSON-RPC、HTTP、上传、下载和媒体访问通过端到端测试；
- Hermes 可以在保留旧 Gateway 回退路径的情况下灰度迁移。

### Phase 5：ComfyUI 迁移

目标：验证通用 Gateway 的二进制、高吞吐、浏览器和设备认证能力。

可行性依据（2026-09 代码调研）：comfy-mobile-ui 是严格单 backend（全局单个 `url` 配置，无服务器列表），常态 2 条 WS 连接（全局 `/ws` + chain progress），Channel 模型退化为少量长命连接。其自建 gateway（约 1000 行：allowlist、危险路由开关、Header 清洗、token 替换、Cookie + 设备 token 双认证）即 `gateway-adapter-comfy` 的现成雏形。

工作项：

- 实现 `gateway-adapter-comfy`，复用当前 Comfy Gateway 的安全策略；
- 支持 `/ws`、`/comfymobile/ws` 和其他允许的 WebSocket 路径；
- 保留 ComfyUI 的 `clientId` 等 query 语义；
- 透传文本与二进制 WebSocket 帧（预览帧最大 32 MB，type 1/type 4 framing，保留 binary flag）；
- 支持大型模型、图片和视频的流式上传与下载（现状：multi-GB 单请求 POST、1 小时超时、浏览器侧依赖 Range 透传）；
- 保留浏览器 HttpOnly、SameSite Session；
- 保留可撤销的 Native Device Credential，并设计**origin 迁移流程**：现有设备 token 按注册时 origin 精确绑定（origin 不匹配时静默不携带认证），切换到中心 Gateway 的新 origin 会导致全部已注册设备静默掉登录，需要显式重新注册或迁移机制；
- Gateway 对 `/ws` 类长连接主动发送协议层 ping 保活：comfy-mobile-ui 的全局 `/ws` 无应用层心跳，且重连最多尝试 5 次即永久放弃，中间层的空闲超时或抖动会直接杀死其连接；
- 执行 Origin 校验、路由白名单、方法限制和危险操作 scopes；
- 支持 Range、ETag、缓存和 authenticated media；
- 建立弱网、慢消费者、多文件、取消和断线压力测试。

验收标准：

- ComfyUI 当前 Gateway 的认证和安全能力没有退化；
- 文本与二进制预览消息均可透明传输；
- 至少 1 GiB 文件可以在配置允许时完成端到端流式传输，且 Gateway 内存有界；
- 设备撤销后，现有连接和后续请求按照策略及时失效；
- 未在 allowlist 中的路径和危险操作默认被拒绝。

### Phase 6：生产化与多实例

目标：使 Gateway 具备可运维、可扩展、可审计的生产能力。

工作项：

- 增加结构化日志，统一 namespace、backend、peer、channel 和 request correlation ID；
- 增加连接数、Channel 数、吞吐、延迟、错误、拒绝、背压和内存指标；
- 增加 readiness、liveness、优雅退出和连接 drain；
- 建立单 Backend、Namespace、用户和设备级限流及配额；
- 对敏感字段实施日志脱敏，默认不记录业务 payload；
- 增加密钥轮换、Backend 凭证撤销和审计查询；
- 为 notification 建立 Namespace、用户、设备、事件类型、去重和配额模型；
- 基于生产指标决定是否引入 PostgreSQL/Redis；
- 多实例时实现连接 ownership、跨节点路由或明确的 sticky-session 约束；
- 开展负载测试、故障注入、安全测试和升级/回滚演练。

验收标准：

- 部署和重启不会接收新流量后立即切断全部活跃请求；
- 运维人员可以从指标和日志定位到具体 Namespace、Backend 和 Channel；
- 凭证泄漏或 Backend 异常可以被单独撤销和隔离；
- 多实例部署具备经过测试的连接路由、故障恢复和回滚方案。

## 6. 迁移顺序与依赖

```text
Phase 0 基线
    │
    ▼
Phase 1 安全隔离
    │
    ▼
Phase 2 Protocol v4 / Data Plane
    │
    ▼
Phase 3 SDK + zclaudia v4
    │
    ├──────────────┐
    ▼              ▼
Phase 4 Hermes   Phase 5 ComfyUI
    │              │
    └──────┬───────┘
           ▼
    Phase 6 生产化/多实例
```

推荐 Hermes 先于 ComfyUI：Hermes 可以先验证通用 Adapter 和 JSON-RPC Channel；ComfyUI 对二进制、流式传输和认证的要求更高，适合作为数据面成熟后的完整验证项目。

**Phase 3 后检查点**：Phase 0–3 是确定要做的核心（安全 + 流式数据面 + zclaudia 迁移，硬收益全部在此兑现）；Phase 4 和 Phase 5 是两个独立裁决的迁移项目，各自按"迁移成本 vs 退役一套自建 Gateway 的维护节省"评估。Phase 3 完成时用真实数据重新决策：新核心的稳定性表现、zclaudia 迁移的实际耗时与估算偏差、Hermes 痛点的紧急程度。ComfyUI 现有 Gateway 是三者中最完善的，Phase 5 可以无限期推迟而没有任何东西损坏。

## 7. 初步时间估算

以下为**乐观估算**，用于规划，不作为交付承诺。协议与 SDK 类工作历史上普遍超期 1.5–2 倍，需要在 Phase 0 完成后根据测试基线重新校准，并在每个阶段结束时复盘剩余阶段的估算。

| 阶段 | 单工程师乐观估算 |
| --- | ---: |
| Phase 0：基线 | 约 1 周 |
| Phase 1：安全与隔离 | 约 2–3 周 |
| Phase 2：Protocol v4 与数据面 | 约 3–5 周（含 Hermes 原型；若 ADR 选择自研多路复用则显著增加） |
| Phase 3：SDK 与 zclaudia 迁移 | 约 2–3 周 |
| Phase 4：Hermes 试点 | 约 1–2 周 |
| Phase 5：ComfyUI 迁移 | 约 2–4 周 |
| Phase 6：生产化与多实例 | 约 2–4 周 |

> **实际复盘（2026-09-04）**：Phase 0–3 实际历时约 4 天（AI 辅助开发，含生产部署与两次超范围的终局拆除），远低于乐观估算——「协议类工作超期 1.5–2 倍」的历史规律在本项目未成立。Phase 4–6 估算仍保留原值作参考，实际排期以检查点裁决为准。

单节点、可信用户范围的 MVP 预计约 6–10 周；三个项目可使用的生产级版本乐观估算约 13–22 周，规划时应按此区间的偏高端预留。两到三名工程师并行时，安全/协议、SDK/Adapter、测试/运维可以拆分推进。

## 8. 必须先确认的技术决策

实施前应通过 ADR 明确以下事项：

1. ✅ Channel 传输承载：每 Channel 一条独立 WebSocket 连接（[ADR-0003](docs/adr/0003-channel-transport.md)）；
2. ✅ v4 Backend Tunnel 基于 WebSocket（QUIC/HTTP3 列为 ADR-0001 的重评估触发条件）；
3. ✅ 前置反向代理终止 TLS（[ADR-0001](docs/adr/0001-deployment-and-tls-termination.md)；实际部署备注：origin 带端口、Caddy 容器化）；
4. ✅ Gateway 提供最小认证服务，不接 IdP（[ADR-0002](docs/adr/0002-identity-issuance.md)）；
5. ✅ Device/Backend/Backend-access 凭证签发与级联撤销已实现（ADR-0002）；浏览器 Session 留待 Phase 5；
6. ✅ Backend 唯一键 =（tenant 预留, namespace, instanceId, environment），UUID 标识（docs/protocol-v4.md §2）；
7. ✅ 不需要：选择了每 Channel 一连接，无自研 framing/flow-control window；
8. ✅ 已作废：v3 兼容层曾内置于 Gateway，随 v3 删除一并移除；
9. ✅ 同仓 pnpm workspace、`@zclaudia/gateway-*` 已发 npm（[ADR-0004](docs/adr/0004-sdk-packaging.md)）；Go SDK 推迟；
10. ⏳ 未决（Phase 6）：PostgreSQL/Redis 与多实例路由，待真实指标驱动。

## 9. 风险与控制措施

| 风险 | 控制措施 |
| --- | --- |
| v4 改造影响现有 zclaudia | v3/v4 双栈、contract tests、按客户端灰度 |
| 通用协议过度设计 | 以 Hermes 和 ComfyUI 的真实用例驱动，每阶段提供可运行 vertical slice；Phase 2 内即用 Hermes 原型验证协议；倾向每 Channel 一连接以避免自研多路复用 |
| 大文件导致内存或连接耗尽 | chunk streaming、背压、配额、取消和压力测试 |
| Adapter 与中心职责重新耦合 | 公共 SDK 只暴露通用 Channel/HTTP API，业务 policy 保留在 Adapter |
| 多应用/多用户越权 | 服务端派生身份、默认拒绝、负向测试和审计 |
| 多语言 SDK 行为不一致 | 推迟 Go SDK，先只维护 TS 实现和语言无关协议规范；未来扩展时使用共享 schema、golden fixtures 和跨语言 contract suite |
| ~~迁移期维护成本增加~~ | 已消解：双栈期结束后 v3 整体删除，无长期兼容负担 |

## 10. 完成定义

> 现状（2026-09-04）：平台侧条件（业务无关核心、安全边界、流式数据面、SDK）已满足且经 zclaudia 生产验证；"三个应用接入"目前为 1/3——按第 6 节检查点，Hermes/Comfy 是否接入为独立裁决项，通用化的完成定义在其裁决后重估。

当满足以下条件时，可以认为 `zclaudia-gateway` 已完成通用化：

- 中心 Gateway 不包含任何 zclaudia、Hermes 或 ComfyUI 的业务分支；
- 三个应用通过公共 SDK 和各自 Adapter 接入；
- 身份、Namespace、Backend 和 Channel 均有可测试的安全边界（Tenant 字段已预留，机制按需启用）；
- 支持有背压的 JSON、Binary WebSocket 和双向 HTTP Streaming；
- v3 zclaudia 已完成受控兼容或达到正式弃用条件；
- Hermes 与 ComfyUI 的关键端到端用例、负向安全用例和压力测试进入 CI；
- 单节点生产运行具备日志、指标、审计、限流、优雅退出和回滚方案；
- 多实例需求有基于真实指标的明确决策，而不是隐含假设。
