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
        identity={"device_id": "server-1", "instance_id": "inst-1"},
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

## API sketch

- `GatewayBackend(url, credential, namespace, identity, ...)` — `identity`
  accepts `device_id`/`instance_id` (mapped to the wire's camelCase keys).
- `await connect() -> (backend_id, epoch)` · `await close()` ·
  `await wait_closed()` · `async with` supported.
- `on_channel(kind, handler)` / `on_any_channel(handler)` — handler receives
  `(channel, info)`; sync or async.
- `serve_http(handler)` — buffered `HttpServeRequest` → `HttpServeResponse`.
- `await publish_topic(topic, payload, retain=False)`.
- `on_state(handler)` · `on_message(handler)` (raw control-plane tap) ·
  `await send(message)` (e.g. the directed `backend_server_message` fallback).

Channel objects (`GatewayChannel`): `await send(str|bytes)`, `on_message`,
`on_close`, `await close()`.

## Compatibility

| Python SDK | Gateway protocol (`peer_hello.protocolVersion`) |
| --- | --- |
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
