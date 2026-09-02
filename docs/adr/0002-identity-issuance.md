# 0002. 身份签发：Gateway 最小认证

- 状态：Accepted
- 日期：2026-09-02

## 背景

Phase 1 要拆分管理员、Backend、用户、浏览器和设备五类凭证，前提是明确"用户/设备身份由谁签发"。当前是全体共享单一 `GATEWAY_SECRET`，无 per-client 身份、无撤销能力。规模事实：单运营者、个位数用户、三个应用。

## 候选方案

1. **Gateway 自带最小认证**：管理员持 setup/admin 凭证，签发可撤销的设备 token 与浏览器 Cookie Session；Backend 用 enrollment 凭证换短期访问凭证。comfy-mobile-ui 的自建 gateway 已在生产验证了这套模式（setup token → HttpOnly Cookie / `cmdt_*` 设备 token，SHA-256 摘要存储，180 天 TTL，可撤销）。无外部运行时依赖。
2. **接入外部 IdP（OIDC）**：标准化、生态成熟；但当前没有现成 IdP，为个位数用户引入并维护一个 IdP（Authentik 等）成本远超收益，且 Gateway 作为其他一切服务的接入层，自身依赖越少越好。

## 决策

采用方案 1。凭证模型（Phase 1 实施）：

| 凭证类型 | 载体 | 签发 | 撤销 |
| --- | --- | --- | --- |
| Admin | 环境变量/CLI 配置 | 部署时 | 换值重启 |
| 设备 token | `Authorization: Bearer` | Admin 授权的注册流程 | 单个撤销，摘要存储 |
| 浏览器 Session | HttpOnly + SameSite + Secure Cookie | 登录（setup token） | 服务端 Session 失效 |
| Backend enrollment | 配置文件/env | Admin 签发 | 单个撤销 |
| Backend 访问凭证 | 短期（enrollment 换取） | 自动 | 随 enrollment 撤销或 TTL 过期 |

角色、Namespace 和 scopes 均在服务端从凭证记录派生，不信任客户端声明。

## 后果

- 正面：零外部依赖；撤销粒度到单设备/单 Backend；与 comfy gateway 迁移路径天然对齐。
- 负面/需要承担的：Gateway 自己承担凭证存储（SQLite 新表）、签发流程和审计；无 SSO/MFA 等高级能力。
- 触发重新评估的条件：用户规模超出个人/小团队（两位数以上），或出现必须对接组织身份体系的需求。
