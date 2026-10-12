# 0008. Backend SDK：`last_error` / `lastError`

- 状态：Accepted
- 日期：2026-10-12

## 背景

本 ADR 起初针对 Python SDK；TS SDK（`@zclaudia/gateway-backend`）的后台重连同样静默吞掉失败原因，故两侧一并落地，并以 0.3.0 对齐发布。

[ADR-0007](0007-python-streaming-http-and-asgi.md) 引入的 `start()` 在网关不可达或握手失败时只记日志并继续退避重试，调用方能看到的只有 `state == "connecting"`。下游 zcharlie 的设置页需要区分"凭证被拒"和"网关连不上"（例如显示 `AUTH_FAILED`），而不是解析日志。

约束：`start()` 不抛错、`start()`/`connect()` 互斥、`wait_connected()` 与 `state` 的语义都不能变；不能把可能含凭证、请求头、带 userinfo 的 URL 的原始异常文本交给调用方。

## 候选方案

1. **复用 `GatewayError` 作为 `last_error`**：不新增类型，但它只覆盖网关主动拒绝的握手，无法表达"连不上"；并且它的 `message` 来自网关、`str(exc)` 来自库，内容不可控；存 Exception 还会连带保留 traceback 与栈帧（含凭证局部变量）。
2. **新增不可变信息对象 `BackendErrorInfo`（选定）**：`code` 是 SDK 自己定义的稳定枚举，`message` 是每个 code 固定的说明文字，本身不含任何运行时数据。
3. **增加 `on_error` 回调**：适合事件流，但设置页需要的是"现在为什么没连上"的快照；回调可以以后加，不冲突。

## 决策

- `GatewayBackend.last_error: BackendErrorInfo | None`，只读属性；`BackendErrorInfo` 是 frozen dataclass：`code`、`message`、`gateway_code`、`occurred_at`。
- `code`：`AUTH_FAILED`（握手 `UNAUTHORIZED`，或 enrollment 交换返回 401/403）、`GATEWAY_REJECTED`、`GATEWAY_UNREACHABLE`、`HANDSHAKE_TIMEOUT`、`PROTOCOL_ERROR`、`CONNECT_FAILED`（兜底）。分类基于异常类型而非异常文本；`gateway_code` 只透传已知的网关错误码，未知码置 `None`，防止网关回显内容进入该字段。
- 内部失败用 `RuntimeError` 的私有子类携带 code，`connect()` 抛出的类型与消息保持不变（`GatewayError` / `RuntimeError`），0.2.1 的调用方不受影响。
- 生命周期：每次失败的尝试（`connect()` 首次握手、`start()` 的重试、断线后的重连）置位或替换；握手成功时在 `state` 变为 `connected` 之前清空；新一轮 `start()`/`connect()` 开始时清空（幂等的重复 `start()` 不动）；普通断线不算失败，不改动；`close()` 既不置位也不清空，之后不再记录新的失败。
- 顺带修复：enrollment 凭证交换返回 HTTP 错误时显式关闭 `HTTPError`，避免重试循环里响应 socket 等 GC 才释放。

- TS 侧：`GatewayBackend.lastError: BackendErrorInfo | null`，字段为 `code`、`message`、`gatewayCode?`、`occurredAt`（epoch 毫秒；Python 为 `time.time()` 秒），code 集合与生命周期同上。TS 没有 `start()`，所以它的价值在 `connect()` 失败（同时 reject）与此前完全静默的后台重连。分类同样基于私有的 `AttemptError`，`connect()` 的拒绝原因文本不变（网络层 `fetch` 失败由 `TypeError` 变为同文本的 `AttemptError`）。
- TS 顺带修复：失败的尝试现在会关闭自己的 socket（此前超时/握手失败时半开 socket 随重试累积）；握手期间连接被关闭会立即以 `GATEWAY_UNREACHABLE` 失败，而不是等满 10 秒的 `peer_ready` 超时。

## 后果

- 纯加法的 API，向后兼容；Python 与 npm（`@zclaudia/gateway-backend`）同按 0.3.0 发布。
- 日志仍保留原始异常文本（`logger.warning`），这是运维面的信息，不属于 `last_error` 的契约。
- 新增错误场景时只需扩展分类函数与 code 枚举；调用方对未知 code 应走兜底分支。
