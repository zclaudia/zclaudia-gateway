# 0001. 部署形态与 TLS 终止

- 状态：Accepted
- 日期：2026-09-02

## 背景

Gateway 的存在意义是暴露在公网上为 NAT 后的 Backend 提供接入，TLS 与部署形态决定：Cookie 的 `Secure`/`SameSite` 行为、`GATEWAY_TRUST_PROXY` 是否可开、设备凭证绑定的 canonical origin，以及 ComfyUI 迁移（Phase 5）时设备 token origin 重绑定的目标值。

已确认的事实：有公网服务器、有域名、使用 Let's Encrypt 证书。

## 候选方案

1. **前置反向代理终止 TLS**（Caddy/Nginx + Let's Encrypt 自动续期），Gateway 监听 loopback：证书管理与应用解耦，Gateway 无需 root/443 权限，同机可托管多服务；代价是多一层转发和 `X-Forwarded-For` 信任配置。
2. **Gateway 自行终止 TLS**：少一层组件；代价是证书续期逻辑进入应用、443 特权端口、与未来同机其他服务冲突。
3. **Cloudflare Tunnel**：无需暴露端口；但已有直连公网服务器，引入第三方依赖无必要。

## 决策

采用方案 1：前置反向代理（推荐 Caddy，自动管理 Let's Encrypt）终止 TLS，Gateway 监听 `127.0.0.1`，`GATEWAY_TRUST_PROXY=true`。

**Canonical origin 为 `https://<域名>`（标准 443 端口，无端口后缀）**：所有设备凭证、浏览器 Session、future 的 channel ticket 均绑定此 origin；Phase 5 迁移 ComfyUI 设备凭证时以此为重注册目标。

## 后果

- 正面：证书零维护；Gateway 保持纯 HTTP 简单性；同机可并存其他服务。
- 负面/需要承担的：反代是新的单点，其超时/缓冲配置必须适配 WS 长连接与流式响应（禁用代理缓冲、拉长空闲超时）；`trustProxy` 开启后必须保证 Gateway 端口不直接暴露公网（防火墙仅放行 80/443）。
- 触发重新评估的条件：需要 QUIC/HTTP3 隧道（反代支持不足时）；或部署形态变更（失去公网服务器）。

## 实际部署备注（2026-09-04）

实际部署与决策有两处偏差，Phase 5 做 origin 绑定（浏览器 Session、设备凭证
origin 重绑定）时必须以实际值为准：

- **canonical origin 是 `https://gateway.zhvala.space:28443`（带端口后缀）**，
  非标准 443——公网入口经路由器端口映射（28443 → Caddy 内部 https 8443）。
- Caddy 以 Docker 容器运行（iStoreOS），非宿主进程；gateway 上游经容器网络
  互通，宿主 loopback 绑定对 bridge 网络内的 Caddy 不可达（曾致 503，已修复）。
