# 0009. 后端身份由凭证授予，设备凭证可限定后端范围

- 状态：Accepted
- 日期：2026-10-13

## 背景

当前 v4 的后端身份由后端在 `peer_hello` 里自报：gateway 以 `(tenant 预留, namespace, instanceId, environment)` 为唯一键，首次注册时随机生成一个 UUID 作为 `backendId` 存入 `backend_identities`，之后同键复用（docs/protocol-v4.md §2，ROADMAP §8 第 6 条）。其中 namespace 来自凭证，`instanceId` 与 `environment`（`identity.channel`，默认 `prod`）都是后端自报、不校验的字符串。

实际使用中暴露出几个问题：

- **`instanceId` 名不副实且无约束**。它实际承担的是"逻辑后端名"，真正代表一次运行实例的是 `epoch`/`peerSessionId`。网关只校验它是字符串（空串也接受），SDK 要求必填但不生成、不给默认值，文档只有 `'inst-1'` 这样的示例。用 hostname、pod 名或随机数填它，每次重启都会得到新 `backendId`，客户端缓存失效，`backend_identities` 持续堆积废弃行；反过来两个不同后端照抄同一个值，会被当成同一个后端互相顶替。
- **后端身份可被冒充**。唯一键不含凭证，同 namespace 内任意后端凭证自报相同的 `instanceId`/`channel` 即可接管对方的 `backendId`。
- **客户端无法预知 `backendId`**。它只在后端首次连上后才生成，客户端只能连上网关后从 registry 里挑；后端离线时 registry 里没有它，客户端连"等它上线"都没有明确对象。我们大量场景是"一个后端、多个客户端"，这一步本可以不存在。
- **设备凭证只能按 namespace 授权**。同一 namespace 内无法让某台设备只访问其中部分后端——因为 `backendId` 事先不可知且会漂移，没法写进设备凭证。

规模前提不变（[ADR-0002](0002-identity-issuance.md)）：单运营者、个位数用户、少量应用；每个逻辑后端同一时刻只有一个活跃实例（单活，新连接顶替旧连接）。

## 候选方案

### 后端身份的来源

1. **维持自报，补文档与默认值**：给 `instanceId` 写明约束，SDK 缺省为 `default`，网关拒绝空串。改动最小，但冒充问题和"客户端无法预知 `backendId`"都还在。
2. **身份由凭证授予（后端凭证 ↔ `backendId`）**：签发后端凭证时就确定 `backendId`；持该凭证连接者即该后端。`instanceId`/`channel` 不再参与身份。冒充在结构上不可能，`backendId` 签发即可知。代价是改存储、协议语义、SDK 与管理面，并需要迁移存量后端。
3. **直接用后端凭证 id 当 `backendId`**：最简单，但凭证轮换（吊销旧、签新）必然换 `backendId`，客户端全部失效；存量 `backendId` 是与任何凭证 id 无关的随机 UUID，也无法迁入。

### 设备凭证的访问范围

1. **只按 namespace**（现状）：一张设备凭证访问该 namespace 下所有后端。简单，但无法在 namespace 内区别对待设备。
2. **namespace + 可选后端白名单**：默认仍是整个 namespace；签发时可指定一个或几个 `backendId`。依赖于后端身份方案 2 让 `backendId` 签发即确定且稳定。
3. **允许跨 namespace 的多 scope 凭证**：`peer_hello` 只能声明一个 namespace，registry 与全部访问检查都按单 namespace 过滤，改动大；且模糊了"namespace 即信任分组"的边界。

## 决策

后端身份采用方案 2，设备范围采用方案 2。

### 后端身份由凭证授予

- 后端凭证（`zgb_`）记录新增 `backendId` 字段，**签发时生成**并在签发结果、凭证列表、管理 UI 中展示。一张后端凭证恒定对应一个 `backendId`。
- `backendId` 是凭证上的独立字段而非凭证 id 本身，以支持轮换：签发新凭证时可指定继承一个已有 `backendId`（须属于同一 namespace），然后吊销旧凭证，客户端无感。因此同一 `backendId` 在时间轴上可以对应多张凭证（轮换重叠期内可能同时有效），但任一凭证只对应一个 `backendId`。
- 换发的访问凭证（`zga_`）在换发时复制父凭证的 `backendId`。
- 注册时网关从凭证读取 `backendId`，**不再用 `identity.instanceId`/`identity.channel` 计算身份**。二者对绑定凭证降为描述性字段：`instanceId` 变为可选，原样（缺省为空串）写入 presence；环境隔离改为"每个环境一张凭证"。
- **同一 `backendId` 多处登录时，新连接顶替旧连接**，沿用现有 epoch/lease 机制（`handleBackendOwnerReplaced`）。选"新顶旧"而非"旧者胜出"：后端崩溃重启时旧连接往往尚未被判定断开，旧者胜出会让合法的新进程等到租约超时才能上线。凭证泄露导致的反复互踢由吊销解决；网关对短时间内同一 `backendId` 的反复顶替记审计告警。
- 一台机器跑多个后端即签多张凭证；一张凭证给多个后端共用会让它们互相顶替——这是该模型的本意，文档写明。

### 存量迁移

存量 `backend_identities` 没有记录是哪张凭证创建的，存量 `zgb_` 也可能被多个后端共用，因此**不做"首次连接自动绑定"**（会把共用一张凭证的多个后端坍缩成同一个 `backendId`）。迁移分三步，全程由运营者确认，`backendId` 始终不变、客户端无需改动：

1. **Schema 迁移（启动时自动、幂等，沿用现有 `ALTER TABLE ... ADD COLUMN` 做法）**：`credentials` 增加 `backend_id`、`allowed_backends`（JSON）两个可空列；`backend_identities` 增加 `last_credential_id`、`last_seen_at` 可空列。存量行全部为 NULL：后端凭证 NULL＝"旧版"，设备凭证 NULL＝整个 namespace，即现有行为——设备凭证无需任何迁移。
2. **观测**：从该版本起，每次旧版凭证注册都把"根凭证 id（`zga_` 取其 `parentId`）"与时间写入命中的 `backend_identities` 行。旧版凭证（及其换发的 `zga_`）在此期间**保留旧规则**：按 `(namespace, instanceId, environment)` 查 `backend_identities`。`zga_` 存量只有 24h 寿命，不单独迁移：从已绑定父凭证新换发的 `zga_` 复制 `backendId`，从旧版父凭证换发的仍按旧规则。
3. **绑定**：管理 UI 按观测结果给每张旧版凭证给出迁移建议：
   - 只观测到一个后端身份 → **原地绑定**：把该 `backendId` 写到这张凭证上，token 不变、无需重新部署。
   - 观测到多个后端身份（凭证被共用）→ 原凭证绑定其中一个，其余每个后端签发一张继承其 `backendId` 的新凭证并替换部署。
   - 未观测到（后端长期离线）→ 暂不处理，或签发继承某个已知 `backendId` 的新凭证。

   观测窗口可能漏掉很久没连过的共用方，因此绑定后若该凭证注册时自报的 `instanceId` 与绑定身份记录的 `instanceId` 不一致，网关记审计告警（仍按绑定身份放行，即"新顶旧"），供运营者发现并拆分。

全部未吊销的后端凭证都已绑定后，在一个后续版本移除旧规则；`backend_identities` 届时只保留为历史记录或删除（另行在 CHANGELOG/协议文档注明）。

回滚：新增列均可空，旧版网关会忽略它们；已原地绑定的凭证在旧版网关上退回 instanceId 规则，只要后端配置未改，仍得到同一个 `backendId`。只有新签发的（非继承）后端身份不在 `backend_identities` 中，回滚后会得到新 id——这是可接受的代价。

### 管理 UI

- **签发对话框**：
  - 后端凭证增加"后端身份"选项：新建（签发时生成）或继承已有（从本 namespace 的后端身份列表中选，用于轮换与迁移）。
  - 设备凭证增加"访问范围"选项：全部后端（默认，写明"包括以后新增的后端"）或指定后端（多选，只列有未吊销后端凭证的身份）。
  - 一次性 token 弹窗对后端凭证同时展示 `backendId` 并可复制，便于写进客户端配置。
- **凭证列表**：后端凭证显示 `backendId`（短格式 + 复制），未绑定的标"旧版"徽标，并提供"迁移"操作，按上面第 3 步的建议原地绑定或预填签发对话框；设备凭证显示范围（"全部"或"N 个后端"，悬停显示名称，失效项标"已失效"），并提供"编辑范围"操作（提示保存后在线连接会被断开）。
- **新增"后端"页**：按 namespace 列出后端身份——名称、`backendId`、在线状态（`epoch`、上线时间）、绑定的有效凭证数、最近一次使用的凭证、最近在线时间、是否旧版。操作：为该身份签发（继承）凭证；对已离线、且没有任何有效凭证绑定的旧版身份行提供删除，用于清理 `instanceId` 漂移遗留的废弃行。
- **概览页**：增加"已知后端/在线后端"计数；存在旧版后端凭证时显示"N 张后端凭证待迁移"，作为迁移进度提示。
- 对应的管理 API：列出后端身份（`GET /api/admin/backends`）、原地绑定（`POST /api/admin/credentials/:id/bind`，仅限旧版后端凭证，且 `backendId` 必须同 namespace）、修改设备范围（`PATCH /api/admin/credentials/:id`）、删除废弃后端身份（`DELETE /api/admin/backends/:backendId`，仅限离线且无有效凭证绑定）。`gateway-admin.sh` 同步增加对应子命令。

### 设备凭证可限定后端范围

- 设备凭证（`zgd_`）记录新增可选 `allowedBackends: string[] | null`：
  - `null`（默认）＝整个 namespace，**包括以后新增的后端**（现行为）；
  - 非空数组＝只能访问列出的 `backendId`，以后新增的后端不自动纳入。
- 签发校验：数组非空；每个 id 必须是同一 namespace 内、至少有一张未吊销后端凭证的 `backendId`。白名单写 `backendId` 而非后端凭证 id，后端凭证轮换不影响设备范围。
- 白名单中的后端之后被吊销/删除时不级联修改设备凭证，该项自然失效（连不上）；管理 UI 标为"已失效"。
- 范围**签发后可修改**（重签设备凭证需要把新 token 重新配到设备上，成本高于后端）。修改后网关断开该凭证所有在线连接，按新范围重连生效——与吊销时断开连接的做法一致，不需要改写在线会话已下发的 registry。
- 执行点（全部位于现有 namespace 校验旁）：registry 下发与广播（`peer_ready.registrySync`、`registry_snapshot`、`GET /sync/registry`）过滤掉范围外后端；`channel_open`、`/api/proxy/:backendId`、`topic_subscribe` 对范围外后端返回与"不存在/离线"相同的 `BACKEND_OFFLINE`，不暴露其存在；后端发往范围外设备的定向 `backend_server_message` 同样拒绝。
- **不支持跨 namespace**：需要一起访问的后端放进同一 namespace；namespace 仍是信任分组边界。

### 接口与协议面（不改 wire 形态，协议版本仍为 4）

- `POST /api/admin/credentials`：后端凭证可选 `backendId`（继承已有身份，用于轮换与迁移）；设备凭证可选 `allowedBackends`。响应与列表的 `GatewayCredentialInfo` 增加 `backendId`（后端/访问凭证）与 `allowedBackends`（设备凭证）。
- 新增的管理接口见上文"管理 UI"一节。
- `PeerIdentity.instanceId` 对后端变为可选；`BackendPresenceV4` 字段不变（`instanceId`、`channel` 保留为描述性字段）。
- TS 与 Python 后端 SDK 的 `identity` 参数整体可选；客户端 SDK 不变（`deviceId`/`instanceId` 本就只用于展示）。

## 后果

- 正面：
  - 后端身份不可冒充；`backendId` 签发即确定、轮换不变，客户端可直接配置，"一个后端、多个客户端"无需从 registry 里挑选。
  - 后端部署只需一个 token，`instanceId`/`channel` 填错导致 `backendId` 漂移的问题消失，`backend_identities` 不再增长。
  - 设备授权可细化到具体后端，且默认行为不变；授权全部由服务端凭证记录决定，延续 ADR-0002 "不信任客户端声明"的原则。
- 负面/需要承担的：
  - 存储（凭证表新增 `backend_id`、`allowed_backends` 列）、注册路径、四类访问执行点、管理 API/UI、两个后端 SDK 都要改，且迁移期内新旧两套后端身份规则并存。
  - 存量迁移需要运营者逐张确认绑定，无法全自动完成；被共用的旧凭证仍需拆分并重新部署。观测窗口可能漏掉长期离线的共用方，只能靠绑定后的审计告警兜底。
  - `allowedBackends` 是"签发时快照"，新增后端不会自动进入白名单，需要运营者理解 `null` 与列表的语义差别。
  - 被取代的约定：docs/protocol-v4.md §2/§10.1 与 ROADMAP §8 第 6 条的后端唯一键规则在实现落地后改为"由凭证授予"，届时同步更新。
- 触发重新评估的条件：
  - 出现一个逻辑后端需要**多实例同时在线**（多活/负载均衡）的需求——届时逻辑后端与实例变为 1:N，需要重新引入独立的实例维度与路由策略，"新顶旧"语义也要改；
  - 出现必须跨 namespace 授权设备的真实需求；
  - 用户规模超出 ADR-0002 的前提，需要对接外部身份体系。
