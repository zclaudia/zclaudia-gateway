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

## Send backpressure (`sendBounded`)

`send()` stays fire-and-forget: it queues immediately and returns; when the
peer (or the network) is slow, the bytes pile up in the local socket's send
buffer. The channel exposes that state and a bounded way to respect it:

```ts
channel.bufferedAmount;        // snapshot: bytes queued locally, not yet handed to the OS
channel.sendBufferObservable;  // false when the socket cannot report a buffer

// Bounded, ordered send — wait for local buffer space, then queue once:
await channel.sendBounded(chunk, {
  lowWaterBytes: 512 * 1024, // wait until bufferedAmount <= this (default 4 MiB,
                             // matching the gateway relay's high-water mark)
  timeoutMs: 10_000,         // reject (and never queue) after this long (default 10 s)
  signal: abortController.signal, // cancel the wait; rejects with the reason
});
```

**What it promises — and what it does not.** `sendBounded` resolves once the
bytes were *accepted into the local socket's send buffer*. That is the only
stage it can prove. It does **not** mean the gateway or the peer received the
data, and it says nothing about business-level completion — the protocol has
no acknowledgements, and none were added. If you need end-to-end confirmation,
layer your own request/response semantics on top of the channel.

Semantics:

- `sendBounded` calls are strictly FIFO among themselves; each observes the
  live `bufferedAmount` after its predecessor queued. Plain `send()` never
  waits and is not ordered against them.
- On timeout, abort, or channel close (either side), the promise rejects and
  the data is **never queued** — nothing is sent partially, and no waits or
  timers survive a close.
- When the socket cannot report `bufferedAmount` (`sendBufferObservable ===
  false`), it degrades to an ordered immediate send — still bounded by
  `timeoutMs` and close. Browser, Node-native and `ws` sockets all report it.
- No busy loop: the drain wait polls on an adaptive timer (10→100 ms);
  close and abort wake the waiter immediately.

**Slow-consumer example** — stream file chunks without letting a stalled peer
grow memory without bound:

```ts
for await (const chunk of fileChunks) {
  try {
    await channel.sendBounded(chunk, { lowWaterBytes: 1 * 1024 * 1024, timeoutMs: 30_000 });
  } catch (error) {
    break; // peer stalled past the budget, or the channel closed: stop feeding it
  }
}
```

**Migration**: none required. Existing `send()` calls keep their exact
behavior; adopt `sendBounded` call by call where unbounded buffering is not
acceptable. The same API is available on the backend side — `GatewayChannel`
is shared, so `serveHttp` handlers and `onChannel` handlers can use it too.

## Lifecycle, timeouts and cancellation

`connectionState` is `'idle' | 'connecting' | 'connected' | 'closed'`.

- **`connect()`** settles exactly once: resolved once connected, rejected when
  any phase fails or times out. Every phase is bounded by `connectTimeoutMs`
  (default 10 s): waiting for the socket to open, waiting for `peer_ready`,
  and dialing a channel data socket (`openChannel`). Pass an `AbortSignal` to
  cancel: `client.connect({ signal })` rejects with the signal's reason and
  closes its socket. Concurrent calls coalesce onto the running attempt.
- **A failed `connect()` ends clean**: the socket is closed, no state is
  wedged, the client returns to `'idle'` and `connect()` may be called again.
  Only a disconnect *after* a successful connect triggers auto-reconnect
  (exponential backoff, subscriptions restored); a failed initial connect
  never auto-retries — the caller decides.
- **`close()` is final and idempotent.** Everything in flight ends
  definitively: the socket is closed (a mid-handshake `connect()` rejects
  promptly with `Connection closed before peer_ready`), pending control
  operations and channel dials fail, and `'closed'` is emitted to `onState`
  exactly once per close. A late `open`, `peer_ready` or `channel_ready` that
  arrives afterwards is dropped — it can never re-enter `'connected'` or
  leave an orphan socket, timer or promise behind. After `close()`, only an
  explicit `connect()` starts a new session.
- **`openChannel()`** fails definitively when the negotiation or the data
  dial times out, the dial fails, or the client closes mid-dial (the dial is
  aborted and its socket closed). On failure nothing is registered: the next
  `openChannel` starts fresh.

Gateway server and protocol spec: [zclaudia/zclaudia-gateway](https://github.com/zclaudia/zclaudia-gateway).
