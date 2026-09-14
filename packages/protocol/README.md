# @zclaudia/gateway-protocol

Canonical wire types and constants for Gateway Protocol v4 — the public
contract the gateway needs for routing, connection management, and its
optional services. Zero runtime dependencies.

## Entries

- `.` — handshake (`peer_hello` / `peer_ready`), registry, heartbeat,
  `gateway_error` model, the `backend_server_message` directed fallback,
  and the channel/topic/streaming-HTTP frames, plus the
  `PeerToGatewayMessage` / `GatewayToPeerMessage` direction unions.
- `auth` — credential metadata (`zgd_` / `zgb_` / `zga_` prefixes, public
  credential info) and the `/api/backend/token` exchange DTO. Storage,
  hashing, and issuance stay inside the gateway server.
- `admin` — DTOs for `/api/admin/session`, `/api/admin/overview` and
  `/api/admin/credentials`. The admin token is an administrative credential
  and never a peer handshake secret.
- `notifications` — the optional gateway push-notification service:
  `push_notification_request` wire message and the management API config
  DTO. The gateway delivers by generic fields (name filter, severity →
  priority); application event semantics are not interpreted here.

Application payloads are opaque (`unknown`): ZClaudia business contracts
live in [`@zclaudia/protocol`](https://www.npmjs.com/package/@zclaudia/protocol).
Protocol version is 4; v3 hellos are rejected.

Shared by [`@zclaudia/gateway-client`](https://www.npmjs.com/package/@zclaudia/gateway-client)
and [`@zclaudia/gateway-backend`](https://www.npmjs.com/package/@zclaudia/gateway-backend).
Protocol spec and gateway server: [zclaudia/zclaudia-gateway](https://github.com/zclaudia/zclaudia-gateway).
