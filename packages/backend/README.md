# @zclaudia/gateway-backend

Backend SDK for the zclaudia gateway (Protocol v4): registration and
heartbeats, channel offers (dial-is-accept), topic publishing with retain,
and `serveHttp` for answering the gateway's streaming HTTP proxy over a
channel. Reconnects with exponential backoff; supports enrollment-credential
exchange (`zgb_` → short-lived access credential). The access token is cached
and reused across reconnects until 60 s before it expires, and exchanged
afresh at once if the gateway stops accepting it. Each enrollment credential
has a single access credential on the gateway, rotated in place by every
exchange — the previous secret stops working
([ADR-0011](https://github.com/zclaudia/zclaudia-gateway/blob/main/docs/adr/0011-rotate-backend-access-in-place.md)).

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

## Sending with backpressure

`GatewayChannel` is shared with the client SDK, so backend handlers
(`onChannel`, `serveHttp`) can bound their outbound writes the same way:
`channel.bufferedAmount` observes the local send buffer and
`await channel.sendBounded(data, { lowWaterBytes, timeoutMs, signal })`
waits for space before queueing — FIFO among `sendBounded` calls, rejecting
definitively on timeout/abort/close, and resolving only when the bytes were
accepted locally (no delivery acknowledgement; the protocol has none). See
the client SDK's "Send backpressure" section for the full semantics; plain
`channel.send()` is unchanged fire-and-forget.

## Lifecycle, timeouts and cancellation

`connectionState` is `'idle' | 'connecting' | 'connected' | 'closed'`.

- **`connect()`** settles exactly once: resolved with the assigned identity
  once connected, rejected when any phase fails or times out. Every phase is
  bounded by `connectTimeoutMs` (default 10 s): waiting for the socket to
  open, waiting for `peer_ready`, and dialing an offered channel's data
  socket. Pass an `AbortSignal` to cancel: `backend.connect({ signal })`
  rejects with the signal's reason and closes its socket. Concurrent calls
  coalesce onto the running attempt (manual or background) instead of racing
  a second socket.
- **A failed `connect()` ends clean**: the socket is closed, the backend
  returns to `'idle'`, and `connect()` may be called again — never a wedged
  `'connecting'`. Auto-reconnect (exponential backoff, identity stable) only
  kicks in after a successful connection has dropped; a failed initial
  connect never auto-retries.
- **`close()` is final and idempotent.** Everything in flight ends
  definitively: the socket is closed (a mid-handshake `connect()` rejects
  promptly), heartbeats stop, channel-offer dials are aborted, and `'closed'`
  is emitted to `onState` exactly once per close. A late `open` or
  `peer_ready` afterwards is dropped — it can never re-enter `'connected'`,
  adopt an identity, or restart the heartbeat timer. `lastError` keeps the
  value it had when `close()` was called.
- **REPLACED stands down** (ADR-0010): when the gateway hands this backend's
  identity to a newer connection (close code 4001), the backend stops for
  good — state `'closed'`, `lastError.code === 'REPLACED'`, no reconnect —
  because reconnecting would replace the newer one in turn. Only an explicit
  `connect()` takes the identity back deliberately.

Gateway server and protocol spec: [zclaudia/zclaudia-gateway](https://github.com/zclaudia/zclaudia-gateway).
