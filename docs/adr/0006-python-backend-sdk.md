# 0006. Python Backend SDK：原生实现、打包与发布

- 状态：Accepted
- 日期：2026-10-11

## 背景

网关协议（v4）是语言无关的：控制面是 JSON-over-WS，数据面是不透明字节管道，服务端不感知对端实现语言。任何语言的后端接入，成本都等于"在该语言里把 Backend 角色实现一遍"。

需求来源与既定规划：

- Hermes 本体是 **Python 进程**（ROADMAP Phase 4 调研），Phase 4 当时的选择是 Node sidecar（`gateway-adapter-hermes`，复用 `@zclaudia/gateway-backend`），并把"Go/多语言 SDK"推迟到"协议稳定且确有需要时"，同时要求"未来扩展时使用语言无关的协议规范、golden fixtures 和跨语言 contract suite"（ROADMAP 风险表）。
- ADR-0004 明确写着"协议稳定、多语言 SDK 启动时重新评估拆仓"——本决策即该触发条件的响应。
- PyPI 与 npm 不同：没有 scope，包名全局唯一（`zclaudia-gateway` 等三个候选名经查证均可用）。

## 候选方案

1. **只做 Node sidecar**：每个 Python 后端旁边跑一个 Node 进程，本地 IPC 桥接。零协议实现成本，但每个部署多背一个 Node 运行时 + 一层本地 IPC 设计；协议能力受 sidecar 中间层限制。
2. **原生 Python SDK，同仓单包，PyPI Trusted Publisher 发布**：直接实现协议（TS SDK 约 400 行核心逻辑可移植）；与协议演进同仓原子提交；契约测试复用仓库既有"起真网关对打"的基建。
3. **原生 Python SDK，独立仓库**：边界清晰，但 v4 仍处 0.x 高频演进期，跨仓版本联动对一个维护者是纯摩擦——ADR-0004 已对同构方案给过同样的否决理由。

## 决策

采用方案 2（2026-10-11 落地，0.1.0）：

- 包：`packages/python`，PyPI 名 `zclaudia-gateway`，import 名 `zclaudia_gateway`。**单包**，不镜像 npm 三包；将来 Python client SDK 以子模块加入，不新增发布流水线。
- 技术形态：asyncio；唯一运行时依赖 `websockets>=15`；凭证交换（`zgb_→zga_`）用标准库；`requires-python >= 3.11`（websockets 现版底线；3.9 已 EOL、3.10 同月 EOL）。
- 版本：独立 0.x + 包内 `GATEWAY_PROTOCOL_VERSION = 4` 常量 + README 兼容矩阵。
- 测试：单元（Python fake gateway，无 Node 依赖）+ 跨语言契约套件（真实网关进程 + TypeScript `@zclaudia/gateway-client` 作远端对端），后者是发布闸门。
- 发布：PyPI Trusted Publisher（OIDC，无 token）+ tag `gateway-python-v<版本>` 触发 + tag/`pyproject.toml` 版本一致性校验，与 npm 侧 `publish.yml` 同构；首发布走 TestPyPI 验证。
- 与既有规划的关系：Node sidecar 路线**不废弃**（对不适合进程内 SDK 的场景仍是可选替代）；Hermes 的接入选型由 Phase 4 自行裁决。
- ADR-0004 的同仓判据维持：拆仓触发条件虽已成立，但评估结论仍是同仓，理由不变（协议高频演进 + 契约测试需对真实服务端运行）。

## 后果

- 正面：任意 Python 后端（含 Hermes）可直接进程内接入，无 Node 依赖；契约套件顺带成为网关行为的跨语言回归测试；发布流程与 npm 三包同构（OIDC 无 token、tag 防漂移校验）。
- 负面/需要承担的：仓库引入第二套工具链（uv/ruff/mypy/pytest，CI 两个新 job）；协议变更需同步维护两份实现，靠契约套件与兼容矩阵暴露漂移。
- 非目标（刻意不做）：Python client SDK、管理面 Admin API 封装、同步 API、流式 HTTP handler（首批为缓冲式，与 TS SDK 的 `serveHttp` 对齐）。
- 触发重新评估的条件：Python SDK 出现独立于网关的发布节奏（触发拆仓）；协议 v5 破坏性变更；双实现维护成本或漂移风险超过 sidecar 方案。
