# 0004. SDK 包存放与发布策略

- 状态：Accepted
- 日期：2026-09-03

## 背景

Phase 3 拆分公共 SDK（ROADMAP：`gateway-protocol` / `gateway-client` / `gateway-backend` / `gateway-testing`）。需要决定包放在哪个仓库、命名与版本策略（ROADMAP 第 8 节第 9 条）。约束：单维护者；v4 协议、Gateway 服务端与 SDK 在未来数周内高频共同演进；契约测试需要对真实服务端运行。

## 候选方案

1. **与 Gateway 服务端同仓（pnpm workspace）**：协议、服务端、SDK 的变更是原子提交；契约测试在同一 CI 里直接对真实服务端跑；无跨仓版本联动成本。代价：仓库名 `zclaudia-gateway` 承载了超出服务端的内容。
2. **每包独立仓库**：边界清晰；但 v4 迭代期每个协议改动要横跨 2–4 个仓库发版联动，对单维护者是纯摩擦。
3. **并入 zclaudia-protocol 仓库**：该仓库定位是 v3 类型包，混入 SDK 会使其消费方（zclaudia 全家）被动引入无关依赖。

## 决策

采用方案 1：本仓库转为 pnpm workspace，服务端保留在根（`@zclaudia/gateway`），SDK 位于 `packages/`：

- `@zclaudia/gateway-protocol` — v4 wire 类型与常量，零依赖；
- `@zclaudia/gateway-client` — 控制连接、Channel、Topic、重连；面向 WHATWG WebSocket（WebView/浏览器/Node ≥21 原生均可），Node 场景可注入 socketFactory；
- `@zclaudia/gateway-backend` — Backend 注册、心跳、channel offer 处理、Topic 发布、HTTP channel 服务；依赖 gateway-client 复用连接核心；
- `gateway-testing` 暂不单列，契约测试先以根仓库测试套件形式存在，抽包时机等到 Hermes/Comfy Adapter 需要复用测试夹具。

版本策略：迁移期全部 0.x，与 Gateway minor 版本对齐（lockstep）；先不发布 npm（workspace 内消费 + git 依赖），首个外部消费者（zclaudia 迁移分支）稳定后再发布。协议稳定、多语言 SDK 启动时重新评估拆仓。

## 后果

- 正面：v4 迭代零联动成本；契约测试天然覆盖"SDK ↔ 真实服务端"。
- 负面/需要承担的：仓库职责变宽；未来若拆仓需要迁移 git 历史。
- 触发重新评估的条件：SDK 出现 Gateway 之外的独立发布节奏需求；Go/多语言 SDK 启动。
