# 0005. 管理端 Web UI：同进程托管与 Cookie 会话

- 状态：Accepted
- 日期：2026-09-05

## 背景

凭证管理此前只有两条路：`scripts/gateway-admin.sh`（curl 包装）或直接调 Admin API。签发后令牌只显示一次、靠人肉保管列表，查看凭证状态（过期、最近使用、级联吊销）在终端里很费劲。管理面需要一个 Web UI。

约束与前提：

- 单实例、单运营者（ADR-0002）；`/api/admin/*` 已在公网可达（Caddy 终结 TLS，`gateway.zhvala.space:28443`），仅靠 Bearer `GATEWAY_ADMIN_TOKEN` + 限速防护。
- 管理员令牌是整个凭证体系的信任根，长期有效且无法旋转下属权限——**不能**把它放进浏览器 localStorage。
- ROADMAP 曾把"应用 UI 静态资源托管"列为第一阶段非目标（针对的是业务应用 UI，不是管理面）；ADR-0002 本就把浏览器 Cookie Session 列为规划中的凭证载体。

## 候选方案

1. **网关同进程托管 SPA + Cookie 会话**：React + Vite 构建静态产物，`express.static` 挂在 `/admin`；登录页用管理员令牌换发 HttpOnly + SameSite=Strict 会话 Cookie（内存会话表，固定 TTL）。同源免 CORS，部署零新增组件。
2. **Caddy 独立托管静态文件**：网关保持纯 API。多一个部署组件（静态文件与镜像版本可能脱节），且必须配 CORS 与 Cookie 域——对单运营者是纯增负担。
3. **Bearer 令牌直接存 localStorage**：实现最省事，但 XSS 一次即丢信任根，且与 ADR-0002 已规划的 Cookie 会话载体背道而驰。

## 决策

采用方案 1（2026-09-05 实施）：

- 新增 `packages/admin-ui`（React + Vite，私有 workspace 包），构建产物由网关在 `/admin` 托管；`GATEWAY_ADMIN_UI_DIR` 未设置时网关保持纯 API，行为与此前完全一致。
- 会话端点：`POST /api/admin/session`（令牌换取 Cookie）、`GET`（探测）、`DELETE`（登出）。会话为内存态、默认 12h 固定 TTL（`GATEWAY_ADMIN_SESSION_TTL_HOURS`），**重启即全部登出**。
- `requireAdmin` 变为双通道：Bearer 管理员令牌（CLI 与既有脚本不变）或有效会话 Cookie。Cookie 认证的写请求额外做 Origin 校验（浏览器在 POST/DELETE 上必带 Origin），与 SameSite=Strict 构成纵深防御。
- 新增 `GET /api/admin/overview`：在线后端/连接、凭证计数（活跃/吊销/过期/按类型），供仪表盘只读展示。

## 后果

- 正面：令牌只出现在登录瞬间，不落浏览器存储；管理操作有可视界面（签发、仅显示一次的令牌、级联吊销提示、最近使用时间）；CLI 零改动。
- 负面/需要承担的：会话不持久（重启登出）；网关镜像承担一份 UI 产物（约 200 KB gzip）；管理面 Cookie 会话提前落地了 ADR-0002 表格中的一行——但 **peer 隧道的浏览器 Cookie 仍属 Phase 5**，两者互不依赖。
- 非目标（刻意不做）：审计事件持久化与查询界面（当前审计仍为 console 日志）、多管理员/角色、IP 白名单、会话滑动续期。
- 触发重新评估的条件：需要审计合规、多运营者协作，或管理面暴露面扩大（如需 MFA/SSO）。
