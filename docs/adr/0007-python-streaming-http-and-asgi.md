# 0007. Python SDK：流式 HTTP、ASGI 适配与后台首连

- 状态：Accepted
- 日期：2026-10-11

## 背景

0.1.0 的 `serve_http` 是整包缓冲的：读完整个请求体才调用 handler，返回完整响应后一次性发送。网关侧其实早已支持流式（每 Channel 一条 WS 数据连接、逐帧转发、背压与取消端到端传播，见 [ADR-0003](0003-channel-transport.md) 与 `docs/protocol-v4.md` §7），只是 SDK 没有暴露。下游 zcharlie（Python + FastAPI）联调时在自己仓库里实现了三件事来绕过：`streaming.py`（复用 kind=`http` 的流式 handler）、`asgi.py`（进程内 ASGI 适配，`extra_headers` 注入自持凭证）、`link.py`（首连在后台持续重试）。这三块能力应当回到 SDK 里，但有三条硬约束：

- **不能改协议**：wire（帧序、`http_request`/`http_response` 形态、关闭即响应结束）完全不变。
- **不能新增运行时依赖**：`websockets>=15` 仍是唯一依赖；FastAPI/Starlette 是下游的选择，不能成为 SDK 的门槛。
- **0.1.0 的公共 API 行为不变**：0.2.0 是向后兼容的 minor 发布。

另外两条来自网关实现（`src/server.ts`）的限制直接决定了 API 语义：响应首帧必须在 30 s 内发出，相邻 chunk 间隔超过 60 s 的流会被当空闲拆掉。

## 候选方案

### 流式 handler 的落点

1. **只新增流式 API，`serve_http` 保留原实现**：改动面最小，但两份帧解析/异常处理代码并存——取消、保序、粘性结束标记这些容易写错的语义会有两处实现，未来必然漂移。
2. **`serve_http` 重建在新的流式层上**：单一通道层，缓冲式只是流式之上的一个薄包装（收齐请求体 → 调用 handler → 一次写响应）。代价是必须证明可观察行为不变。
3. **独立子包/额外发布流**：对一个 0.x、单维护者的 SDK 是纯摩擦（与 [ADR-0004](0004-sdk-packaging.md)、[ADR-0006](0006-python-backend-sdk.md) 的结论相悖）。

### ASGI 适配的形态

1. **纯 ASGI 薄适配器，零依赖**：只依赖 ASGI 规范本身，FastAPI/Starlette/裸 ASGI 都能用；适配器职责仅限 scope 翻译、`receive()`/`send()` 桥接。
2. **依赖 starlette 或 fastapi**：省去自己翻译 scope，但把下游框架版本变成 SDK 的依赖，且与约束"不新增运行时依赖"冲突。
3. **不提供，只写文档示例**：下游仍需各自实现一遍（zcharlie 已经写了一遍），同类代码重复且各自的取消语义各不相同。

### 首连重试的位置

1. **`GatewayBackend.start()` + `wait_connected()`**：能力落在既有对象上，状态仍走 `on_state`；与 `connect()` 互斥即可避免两套 supervisor。
2. **独立的 `GatewayLink` 包装类**（zcharlie 做法）：SDK 内部零改动，但包装类需要重新暴露状态、重试参数、关闭语义，等于在 SDK 外面再造一层生命周期。
3. **改 `connect()` 语义为"连不上也返回"**：破坏性变更，且把"首次握手失败要不要抛"的决策权从调用方拿走。

## 决策

- 流式服务：方案 2。新增 `GatewayBackend.serve_http_stream(handler)` 与 `HttpExchange`；`serve_http` 改为构建在同一个流式层之上（收齐请求体后调用原 handler，响应仍在一个 body 帧里发出），保持签名与可观察行为不变（0.1.0 的单元测试与契约测试原样通过即验收）。两者都注册 kind=`http`，同时调用时后者覆盖前者，已在 README 与 docstring 写明。
- 关键语义固定在流式层一处：handler 收到 `http_request` 头帧即启动并与读请求体并发；body 队列的结束标记是粘性的且允许多个任务并发读（ASGI 服务器会同时读 body 和监听断连）；客户端中断后置位 `exchange.disconnected`、唤醒阻塞读者、给 handler 5 秒宽限再 cancel；消费帧走 channel 的 `async for`（同步 `put_nowait`）而不是 `on_message`（每条消息一个 task，顺序不保证）；`write` 直接 `await channel.send` 让背压自然传导。
- 关闭语义统一：新增 `ChannelClosedError`（继承 `RuntimeError`，0.1.0 里捕获 `RuntimeError` 的代码不受影响），`GatewayChannel.send` 与 exchange 的写路径都抛它；handler 里这类异常静默吞掉——客户端已经走了，没什么可通知的。
- ASGI：方案 1。新增 `zclaudia_gateway.asgi`（纯标准库 + SDK 自身，可从顶层 `zclaudia_gateway` 导入），进程内调用应用，`extra_headers` 每个请求注入并覆盖网关透传的同名头。
- 首连：方案 1。`start()` 幂等、非阻塞、失败只记 warning（stdlib logger）并按 `reconnect_min_ms`/`reconnect_max_ms` 指数退避重试；连上后交给既有 supervisor。`start()` 与 `connect()` 混用抛 `RuntimeError`；`close()` 一并取消后台任务。
- 顺带修一个既有缺陷：`GatewayChannel` 在"已关闭之后才注册迭代"时会永远挂在 `inbox.get()` 上（close handler 注册晚于 `_mark_closed`），流式路径会踩到（网关可能在 handler 启动前就拆掉 channel），故 `__aiter__` 在注册时补发结束标记。

## 后果

- 正面：SSE/长响应可用，且这些容易出错的语义（保序、粘性结束、取消、背压）只有一份实现，由单元 + 真实网关契约测试共同覆盖；下游无需再自建 streaming/asgi/link 三块（zcharlie 可整体删除）；首连阶段网关不可达不再是应用启动的阻塞条件。
- 负面/需要承担的：`serve_http` 的实现路径变了（虽有既有测试兜底，仍属于"内部重构"）；SDK 多出一个需要维护的 ASGI 适配层，其 scope 翻译要跟 ASGI 规范演进；`HttpExchange` 是一份公共 API 承诺（`start`/`write`/`read_chunk`/`body`/`disconnected` 的语义不能随意改）。
- 非目标（刻意不做）：ASGI lifespan/WebSocket 协议（只做 `type: "http"`）；响应 trailers；请求头 allowlist 之外的凭证透传（网关不转发，SDK 不绕过）；`HttpExchange` 的跨请求复用（网关每个代理请求拨一条新 channel）。
- 触发重新评估的条件：协议 v5 改变 HTTP 映射；网关放宽/收紧 30 s、60 s 限制或 allowlist，使 README 中的限制说明失真；ASGI 规范出现让"进程内调用"不再安全的变更（例如默认要求 lifespan 协商）。
