# @zclaudia/gateway-client

Client SDK for the zclaudia gateway (Protocol v4): control connection,
per-channel data connections (dedicated WebSocket each), topic subscribe with
retained payloads, exponential-backoff reconnect with subscription recovery.

Built against the WHATWG WebSocket API — works in Node ≥22 and WebViews alike;
a custom `socketFactory` can be injected for anything else.

```ts
import { GatewayClient } from '@zclaudia/gateway-client';

const client = new GatewayClient({
  url: 'https://gateway.example.com',
  credential: 'zgd_...',
  namespace: 'myapp',
  identity: { name: 'My laptop' }, // optional, display only
});
await client.connect();
// A backend's id comes with its credential, so it can be configured up front;
// waitForBackend resolves once it is online (immediately if it already is).
const backendId = 'BACKEND_ID_FROM_ADMIN_CONSOLE';
await client.waitForBackend(backendId, { timeoutMs: 30_000 });
await client.subscribeTopic(backendId, 'resources', (payload) => { /* ... */ });
const channel = await client.openChannel(backendId, 'myapp');
```

## Choosing a backend

A backend's `backendId` is stable — it is fixed when the backend's credential is
issued (ADR-0009) and survives reconnects and credential rotation. Two ways to
get one:

- **Configured**: the id is shown in the admin console at issuance; write it
  into the app's configuration ("one backend, many clients").
- **Discovered**: `discoverBackends()` lists the backends this credential can
  address, so a pairing screen can offer a list instead of asking for a UUID.
  It needs no control connection (`connect()` not required) and, unlike the
  registry, it includes backends that are currently **offline**:

```ts
const backends = await client.discoverBackends(); // online ones first
// [{ backendId, name, online, lastSeenAt }, ...]
const picked = backends.find((b) => b.online) ?? backends[0];
// Persist picked.backendId, then treat it as configured:
await client.waitForBackend(picked.backendId, { timeoutMs: 60_000 });
```

Discovery is a pairing step, not the steady state: persist the picked id and use
that from then on. `online: false` means the backend exists and this credential
may address it, but it is down — worth telling the user, unlike an empty list.
Backends outside the credential's scope are never listed at all, exactly like
nonexistent ones.

Gateway server and protocol spec: [zclaudia/zclaudia-gateway](https://github.com/zclaudia/zclaudia-gateway).
