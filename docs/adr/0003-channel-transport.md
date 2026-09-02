# 0003. Channel 传输承载：每 Channel 一条独立 WebSocket 连接

- 状态：Accepted
- 日期：2026-09-02

## 背景

Protocol v4 的核心抽象是 Channel——某一客户端与某一 Backend 之间的逻辑专线（见 ROADMAP Phase 2）。Channel 语义（open/accept/data/close、四元组身份、隔离、生命周期）与承载方式正交，本 ADR 决定承载方式。约束：三个应用、个人/小团队规模；客户端多为 WebView（WHATWG WebSocket，无自定义 header）；ComfyUI 需要 1 GiB 级文件流与原生二进制帧；Backend 上行带宽有限（家庭宽带）。

## 候选方案

1. **每 Channel 一条独立 WebSocket 连接**：控制连接只跑元数据，数据走独立连接，Gateway 将两端 socket 对接成纯字节管道。背压由 TCP/Node stream pipe 天然提供且按连接隔离；取消 = 关连接；二进制 = 原生 binary frame；`window.update`/`ack`、per-channel framing、流控状态机整体不需要。代价：每 channel 一次 TCP+TLS+WS 握手（1–2 RTT）、更多文件描述符。
2. **单连接自研多路复用**：在 WebSocket 上重新实现 HTTP/2 子集（stream ID、流控窗口、取消传播、帧调度）。节省连接数；但实现与跨语言移植成本高，此类协议历史上普遍超期 2–3 倍，慢消费者隔离和队头阻塞都要自己处理。
3. **反向 HTTP/2（Backend 隧道）**：Backend 外拨后角色反转跑 HTTP/2，流控由成熟栈提供。实现质量高于自研，但接线非常规、调试工具链弱，且只解决 Backend 腿。

## 决策

采用方案 1。要点：

- 控制面与数据面物理分离：控制连接（`/ws`）跑注册、registry、channel 协商；数据连接（`/channel/:channelId`）经一次性 ticket 认证后成为不被解析的字节管道。
- 长命 channel（会话、WS 代理）与大文件传输直接受益；高频短 HTTP 请求不为每请求开 channel，由常驻 http channel 复用（后续批次）。
- SDK 的 Channel 接口保持传输无关：若连接数被真实指标证伪为瓶颈，Gateway↔Backend 腿可单独切换到方案 3，客户端不动。

## 后果

- 正面：数据面实现约百行级；内存有界与背压零代码；二进制不经 Base64/JSON。
- 负面/需要承担的：每 channel 一次握手 RTT；Gateway fd 数随并发 channel 线性增长（当前规模为几十，无压力）；反代必须正确处理大量并发 WS 升级。
- 触发重新评估的条件：并发 channel 数或握手延迟成为实测瓶颈；出现浏览器连接数限制的实际案例。
