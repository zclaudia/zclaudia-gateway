# @zclaudia/gateway-backend

Backend SDK for the zclaudia gateway (Protocol v4): registration and
heartbeats, channel offers (dial-is-accept), topic publishing with retain,
and `serveHttp` for answering the gateway's streaming HTTP proxy over a
channel. Reconnects with exponential backoff; supports enrollment-credential
exchange (`zgb_` → short-lived access credential). The access token is cached
and reused across reconnects until 60 s before it expires (each exchange
mints a new credential on the gateway), and exchanged afresh at once if the
gateway stops accepting it.

```ts
import { GatewayBackend } from '@zclaudia/gateway-backend';

const backend = new GatewayBackend({
  url: 'https://gateway.example.com',
  credential: 'zgb_...',
  namespace: 'myapp',
  identity: { name: 'My server' }, // optional, display only
});
await backend.connect(); // backend.backendId is the one bound to the credential
backend.publishTopic('resources', snapshot, { retain: true });
```

The backend's identity comes from its credential: a `zgb_` credential is
bound to a `backendId` when it is issued, so `url`, `credential` and
`namespace` are all a backend needs. `identity` is optional and descriptive
(`name` is shown in the registry). Run several backends by issuing one
credential per backend — backends sharing a credential replace each other.

**Legacy (unbound) backend credentials** — issued before credential binding
and not yet migrated — still derive the `backendId` from
`(namespace, identity.instanceId, identity.channel)`. Such a backend must keep
passing a stable `instanceId`: never a hostname, pod name or random value, or
every restart gets a new `backendId`. The gateway rejects a legacy backend
hello without `instanceId` (`INVALID_MESSAGE`). See
[ADR-0009](https://github.com/zclaudia/zclaudia-gateway/blob/main/docs/adr/0009-credential-bound-backend-identity.md).

## Why is it not connecting? `lastError`

`connect()` rejects when the first handshake fails, but the background
reconnects that follow a dropped link fail silently. `backend.lastError` is
`null` or an immutable `BackendErrorInfo` (`code`, `message`, `gatewayCode?`,
`occurredAt` in epoch ms) describing the most recent failed attempt:

```ts
backend.onState((state) => {
  if (state === 'connecting' && backend.lastError?.code === 'AUTH_FAILED') {
    showSettingsHint('The gateway refused the credential.');
  }
});
```

| `code` | Meaning |
| --- | --- |
| `AUTH_FAILED` | Credential refused: `UNAUTHORIZED` at the handshake, or HTTP 401/403 from the enrollment exchange |
| `GATEWAY_REJECTED` | Handshake refused for another reason (`gatewayCode` holds the gateway's code if it is a known one) |
| `GATEWAY_UNREACHABLE` | Connection refused, DNS/network failure, connection dropped mid-handshake, or the endpoint is unavailable |
| `HANDSHAKE_TIMEOUT` | Connected, but `peer_ready` never arrived |
| `PROTOCOL_ERROR` | The gateway's answer was unusable (no backend identity, no token) |
| `CONNECT_FAILED` | Anything else |
| `REPLACED` | Not a failed attempt: another connection using the same credential took over this backend (one credential = one backend, newest wins). The backend stops — state `'closed'`, no reconnect — instead of fighting it; `connect()` takes it back deliberately ([ADR-0010](https://github.com/zclaudia/zclaudia-gateway/blob/main/docs/adr/0010-replaced-backend-stands-down.md)) |

Branch on `code`; `message` is a fixed description per code — raw error text,
URLs, headers and credentials are never copied into it.

Lifecycle: **set or replaced** by every failed attempt (`connect()`'s first
handshake and each background reconnect); **cleared** when a handshake succeeds
(before the state becomes `'connected'`) and when `connect()` starts a fresh
run; **kept** across a plain drop (not a failed attempt) and by `close()`,
which neither sets nor clears it. Nothing is recorded after `close()`. **Set to
`REPLACED`** when a newer connection with the same credential takes over; the
backend then stays closed until `connect()` is called. The Python SDK exposes
the same codes and lifecycle as `last_error`.

Gateway server and protocol spec: [zclaudia/zclaudia-gateway](https://github.com/zclaudia/zclaudia-gateway).
