# Architecture Decision Records

重要设计决策的记录目录。每个决策一个文件，命名 `NNNN-短横线标题.md`，按 [template.md](template.md) 撰写。决策一经 Accepted 不修改正文；被推翻时新增一篇 ADR 并在旧篇标注 Superseded。

## 索引

| # | 标题 | 状态 |
| --- | --- | --- |
| [0001](0001-deployment-and-tls-termination.md) | 部署形态与 TLS 终止 | Accepted |
| [0002](0002-identity-issuance.md) | 身份签发：Gateway 最小认证 | Accepted |
| [0003](0003-channel-transport.md) | Channel 传输承载：每 Channel 一条 WS 连接 | Accepted |
| [0004](0004-sdk-packaging.md) | SDK 包存放与发布策略（workspace 同仓） | Accepted |
| [0005](0005-admin-web-ui.md) | 管理端 Web UI：同进程托管与 Cookie 会话 | Accepted |
| [0006](0006-python-backend-sdk.md) | Python Backend SDK：原生实现、打包与发布 | Accepted |
| [0007](0007-python-streaming-http-and-asgi.md) | Python SDK：流式 HTTP、ASGI 适配与后台首连 | Accepted |
| [0008](0008-python-backend-last-error.md) | Backend SDK：`last_error` / `lastError`（Python + TS） | Accepted |
| [0009](0009-credential-bound-backend-identity.md) | 后端身份由凭证授予，设备凭证可限定后端范围 | Accepted |
| [0010](0010-replaced-backend-stands-down.md) | 被顶替的后端主动退出，不再重连 | Accepted |
| [0011](0011-rotate-backend-access-in-place.md) | 后端访问凭证原地轮换：每个注册凭证只有一行 | Accepted |
| [0012](0012-rate-limit-tenancy-and-fail-bucket.md) | 限流：合法请求按租户计额，未认证失败按 IP 单桶 | Accepted |

## 待定决策

以下决策必须在对应阶段开工前落纸（完整清单见 [ROADMAP.md](../../ROADMAP.md) 第 8 节）：

- **Phase 2 前**：Channel 传输承载（每 Channel 一条 WS 连接【倾向】vs 单连接自研多路复用）；Backend 标识唯一性规则；最大 chunk 与重放规则。
