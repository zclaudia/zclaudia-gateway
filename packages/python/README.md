# zclaudia-gateway (Python)

Python Backend SDK for the zclaudia gateway — **Gateway Protocol v4**: your
Python service registers as a Backend peer behind NAT, and remote clients
reach it through the gateway via channels, topics, and the streaming HTTP
proxy. Wire-compatible with `@zclaudia/gateway-backend`; the gateway needs no
changes.

Spec: [docs/protocol-v4.md](../../docs/protocol-v4.md) ·
Repo: [zclaudia/zclaudia-gateway](https://github.com/zclaudia/zclaudia-gateway)

## Install

```bash
pip install zclaudia-gateway        # websockets>=15 is the only runtime dep
```

Requires Python 3.11+ (asyncio).

## Quick start

```python
import asyncio
from zclaudia_gateway import GatewayBackend, HttpServeRequest, HttpServeResponse

async def main():
    backend = GatewayBackend(
        url="https://gateway.example.com",
        credential="zgb_...",                     # issued by the Admin API
        namespace="myapp",
        identity={"name": "My server"},           # optional, display only
    )

    # Serve application channels (kind is application-defined; the gateway
    # does not interpret it).
    async def rpc(channel, info):
        async for data in channel:                # str for text frames, bytes for binary
            await channel.send(data)

    backend.on_channel("rpc", rpc)

    # Serve the gateway's HTTP proxy: /api/proxy/<backendId>/*
    def http(request: HttpServeRequest) -> HttpServeResponse:
        if request.method == "POST" and request.path == "/sum":
            import json
            numbers = json.loads(request.body)
            return HttpServeResponse(200, {"Content-Type": "application/json"},
                                     json.dumps({"sum": sum(numbers)}))
        return HttpServeResponse(404, body="not found")

    backend.serve_http(http)

    backend_id, epoch = await backend.connect()
    print("registered as", backend_id, "epoch", epoch)

    await backend.publish_topic("resources", {"rev": 1}, retain=True)
    await backend.wait_closed()

asyncio.run(main())
```

`GatewayBackend` reconnects with exponential backoff on unexpected
disconnects; every reconnect gets a fresh `epoch` while the `backend_id`
stays stable, and channels from the previous epoch are gone (the gateway
sends `channel_closed`). Enrollment credentials (`zgb_`) are exchanged for
short-lived access credentials (`zga_`) before each connect unless
`exchange_enrollment=False`.

### Backend identity

The backend's identity comes from its credential: a `zgb_` credential is
bound to a `backend_id` when it is issued, so `url`, `credential` and
`namespace` are all a backend needs. `identity` is optional and descriptive
(`name` is shown in the registry). Run several backends by issuing one
credential per backend — backends sharing a credential replace each other.

**Legacy (unbound) backend credentials** — issued before credential binding
and not yet migrated — still derive the `backend_id` from
`(namespace, instance_id, channel)`. Such a backend must keep passing a stable
`identity={"instance_id": ...}`: never a hostname, pod name or random value,
or every restart gets a new `backend_id`. The gateway rejects a legacy backend
hello without `instance_id` (`INVALID_MESSAGE`). See
[ADR-0009](../../docs/adr/0009-credential-bound-backend-identity.md).

## Streaming HTTP

`serve_http_stream(handler)` serves the same proxy in streaming mode: the
handler is called as soon as the request head arrives, may read the body while
answering, and may write the response chunk by chunk — which is what SSE and
long-running responses need. Closing the channel ends the response, and the SDK
closes it as soon as the handler returns.

```python
import asyncio
from zclaudia_gateway import GatewayBackend, HttpExchange

backend = GatewayBackend(url="https://gateway.example.com", credential="zgb_...",
                         namespace="myapp")

async def handler(exchange: HttpExchange) -> None:
    print(exchange.request.method, exchange.request.path, exchange.request.headers)
    payload = b"".join([chunk async for chunk in exchange.body()])  # the body streams in

    await exchange.start(200, {"content-type": "text/event-stream"})
    for index in range(3):
        if exchange.disconnected.is_set():   # client gone: stop burning work
            break
        await exchange.write(f"data: {index}:{len(payload)}\n\n")
        await asyncio.sleep(1)
    # Returning closes the channel, which is what ends the response.

backend.serve_http_stream(handler)
await backend.connect()
```

`serve_http_stream` and `serve_http` both register the `http` channel kind, so
call exactly one of them — the last call wins.

## ASGI apps behind the proxy

`asgi_http_handler(app)` runs any ASGI application (FastAPI, Starlette, plain
ASGI) in-process — no loopback port and no framework dependency: the adapter is
pure ASGI (standard library plus this package), and the app is passed in by you.

```python
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from zclaudia_gateway import GatewayBackend, asgi_http_handler

app = FastAPI()

@app.get("/events")
async def events():
    async def gen():
        for index in range(10):
            yield f"data: {index}\n\n"
            await asyncio.sleep(1)          # keep the gap under the 60 s idle limit
    return StreamingResponse(gen(), media_type="text/event-stream")

backend = GatewayBackend(url="https://gateway.example.com", credential="zgb_...",
                         namespace="myapp")
backend.serve_http_stream(asgi_http_handler(app, extra_headers={"X-API-Key": "backend-secret"}))
await backend.connect()
```

The gateway forwards only a small request-header allowlist — `content-type`,
`accept`, `x-request-id`, `range`, `if-none-match`, `if-modified-since` — and no
`Authorization` or cookies. Authentication toward the application is therefore
the backend's own business: `extra_headers` are injected into every request and
override same-named headers the gateway passed along. Clients never see the
backend's credentials, and anything that can reach the backend through the
gateway reaches it with those credentials attached.

## Gateway-side limits

What the gateway imposes on proxied HTTP (same for both handler styles):

- **First frame within 30 s.** The response head must be sent within the proxy
  request timeout (30 s), otherwise the gateway answers 504 and tears the
  channel down. Long-running handlers should `start()` early and stream.
- **60 s between chunks.** Two body frames more than 60 s apart look idle and
  the gateway drops the stream. SSE needs a periodic keepalive (a comment line
  such as `: ping\n\n` is enough).
- **Header allowlists, both directions.** Requests carry only the six headers
  listed above; responses are filtered too (no `set-cookie`, no hop-by-hop or
  `x-accel-buffering` headers). Cookie sessions cannot cross the proxy — hold
  the credential in the backend and inject it with `extra_headers`.
- **API-sized bodies.** The request body queue is unbounded and built for API
  calls, not for large uploads; use an application channel for those.

## Starting while the gateway is unreachable

`connect()` raises when the first handshake fails. Applications that must come
up while the gateway is down — and connect once it returns — use `start()`: it
returns immediately, retries the first handshake with exponential backoff
(`reconnect_min_ms`/`reconnect_max_ms`), and never raises for an unreachable
gateway, a refused handshake, or a temporarily invalid credential. From the
first successful handshake on, the same supervisor as `connect()` keeps the
link up, and state changes keep flowing to `on_state`.

```python
import asyncio
from zclaudia_gateway import GatewayBackend

async def main():
    backend = GatewayBackend(url="https://gateway.example.com", credential="zgb_...",
                             namespace="myapp")
    backend.on_state(lambda state: print("gateway:", state))

    await backend.start()             # returns now, connects in the background
    await backend.wait_connected()    # optional: wait until the link is up
    print("registered as", backend.backend_id)

    await asyncio.sleep(3600)
    await backend.close()             # also cancels the background connect

asyncio.run(main())
```

`start()` is idempotent, and `close()` cancels the background task.
`start()` and `connect()` are mutually exclusive on one instance — mixing them
raises `RuntimeError` rather than running two supervisors.

### Why is it not connecting? `last_error`

`start()` returns normally even when the first handshake fails, so the reason
is exposed on `backend.last_error` — `None` or an immutable `BackendErrorInfo`
(`code`, `message`, `gateway_code`, `occurred_at`) describing the most recent
failed attempt:

```python
await backend.start()
await asyncio.sleep(2)
if backend.state != "connected" and backend.last_error is not None:
    if backend.last_error.code == "AUTH_FAILED":
        show("The gateway refused the credential — check it in the settings.")
    else:
        show(backend.last_error.message)       # safe to display and to log
```

| `code` | Meaning |
| --- | --- |
| `AUTH_FAILED` | Credential refused: `UNAUTHORIZED` at the handshake, or HTTP 401/403 from the enrollment exchange |
| `GATEWAY_REJECTED` | Handshake refused for another reason (`gateway_code` holds the gateway's code if it is a known one) |
| `GATEWAY_UNREACHABLE` | Connection refused, DNS/network failure, connect timeout, connection dropped mid-handshake, or the endpoint is unavailable |
| `HANDSHAKE_TIMEOUT` | Connected, but `peer_ready` never arrived |
| `PROTOCOL_ERROR` | The gateway's answer was unusable (no backend identity, no token) |
| `CONNECT_FAILED` | Anything else |
| `REPLACED` | Not a failed attempt: another connection using the same credential took over this backend (one credential = one backend, newest wins). The backend stops — `state == "closed"`, no reconnect — instead of fighting it; `connect()`/`start()` takes it back deliberately ([ADR-0010](../../docs/adr/0010-replaced-backend-stands-down.md)) |

Branch on `code`; `message` is a fixed description per code. Raw exception
text, URLs, headers and credentials are never copied into it (they may still
appear in the SDK's own log records).

Lifecycle:

- **Set or replaced** by every failed attempt: the first handshake of
  `connect()` (which also raises, unchanged), each retry of `start()`, and each
  reconnect after a drop. While `state == "connecting"` it is the latest failure.
- **Cleared** when a handshake succeeds (before `state` turns `"connected"`)
  and when `start()`/`connect()` begins a fresh run; an idempotent repeat
  `start()` leaves it alone.
- **Kept** by a plain connection drop (a drop is not a failed attempt) and by
  `close()`, which neither sets nor clears it — so a backend closed after
  failing still says why. Nothing is recorded once `close()` has been called.
- **Set to `REPLACED`** when a newer connection with the same credential takes
  over this backend; it then stays closed (no reconnect) until `connect()` or
  `start()` is called.

## API sketch

- `GatewayBackend(url, credential, namespace, identity=None, ...)` — `identity`
  is optional and descriptive; it accepts `name`, `channel`, `device_id`/`instance_id`
  (snake_case or the wire's camelCase keys) and sends only the keys given.
- `await connect() -> (backend_id, epoch)` · `await start()` ·
  `await wait_connected()` · `await close()` · `await wait_closed()` ·
  `async with` supported.
- `state` · `last_error` (`BackendErrorInfo | None`, read-only) · `backend_id` ·
  `epoch` · `on_state(handler)`.
- `on_channel(kind, handler)` / `on_any_channel(handler)` — handler receives
  `(channel, info)`; sync or async.
- `serve_http(handler)` — buffered `HttpServeRequest` → `HttpServeResponse`.
- `serve_http_stream(handler)` — streaming `HttpExchange`: `request`,
  `read_chunk()`/`body()`, `await start(status, headers)`, `await write(chunk)`,
  `disconnected` (`asyncio.Event`).
- `asgi_http_handler(app, extra_headers=...)` — serve an ASGI app through
  `serve_http_stream` (importable from `zclaudia_gateway` or
  `zclaudia_gateway.asgi`).
- `await publish_topic(topic, payload, retain=False)`.
- `on_state(handler)` · `on_message(handler)` (raw control-plane tap) ·
  `await send(message)` (e.g. the directed `backend_server_message` fallback).

Channel objects (`GatewayChannel`): `await send(str|bytes)`, `on_message`,
`on_close`, `await close()`. Sending on a closed channel raises
`ChannelClosedError` (a `RuntimeError`).

## Compatibility

| Python SDK | Gateway protocol (`peer_hello.protocolVersion`) |
| --- | --- |
| 0.3.x | 4 |
| 0.2.x | 4 |
| 0.1.x | 4 |

Protocol version is exposed as `zclaudia_gateway.GATEWAY_PROTOCOL_V4`.

## Development

```bash
uv venv .venv
uv pip install -e '.[dev]'
.venv/bin/pytest tests/unit          # unit tests (no Node needed)
.venv/bin/pytest tests/contract      # contract tests against a real gateway (needs Node + built repo)
.venv/bin/ruff check src tests
.venv/bin/mypy
```

The contract suite boots the real gateway from the repo's built `dist/` and
drives it with both this SDK (as the Backend) and the TypeScript
`@zclaudia/gateway-client` (as the remote client) — see
`tests/harness/`.
