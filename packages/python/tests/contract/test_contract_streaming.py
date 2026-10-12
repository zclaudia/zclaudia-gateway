"""Contract tests for the 0.2.0 additions: streaming HTTP and background start.

Same release gate as ``test_contract.py`` — the real gateway process, this SDK
as the Backend, and a ``zgd_`` device credential as the remote HTTP client —
but through :meth:`GatewayBackend.serve_http_stream` (and the ASGI adapter)
instead of the buffered handler.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Mapping
from typing import Any

import pytest
from helpers import (
    NAMESPACE,
    HttpResponse,
    ProxyHttpStream,
    open_proxy_request,
    proxy_request,
)

from zclaudia_gateway import GatewayBackend, HttpServeResponse, asgi_http_handler

ProxyBase = str
AuthHeaders = dict[str, str]


class AppState:
    """Events the streaming routes below block on / report through."""

    def __init__(self) -> None:
        self.release = asyncio.Event()
        self.finished = asyncio.Event()


async def read_body(receive: Any) -> bytes:
    chunks: list[bytes] = []
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            break
        chunks.append(message.get("body", b""))
        if not message.get("more_body", False):
            break
    return b"".join(chunks)


async def send_json(send: Any, status: int, payload: Any) -> None:
    body = json.dumps(payload).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"application/json")],
        }
    )
    await send({"type": "http.response.body", "body": body, "more_body": False})


def stream_app(state: AppState) -> Any:
    """A dependency-free ASGI app (no FastAPI/Starlette in the dev extras)."""

    async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
        path = scope["path"]
        if path == "/ping":
            await read_body(receive)
            headers = {name.decode(): value.decode() for name, value in scope["headers"]}
            await send_json(
                send,
                200,
                {
                    "method": scope["method"],
                    "query": scope["query_string"].decode(),
                    "api_key": headers.get("x-api-key"),
                },
            )
        elif path == "/echo":
            body = await read_body(receive)
            await send_json(send, 200, {"len": len(body)})
        elif path == "/stream":
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [(b"content-type", b"text/event-stream")],
                }
            )
            await send({"type": "http.response.body", "body": b"data: one\n\n", "more_body": True})
            try:
                await state.release.wait()
                await send({"type": "http.response.body", "body": b"data: two\n\n", "more_body": False})
            finally:
                state.finished.set()
        else:
            await send(
                {"type": "http.response.start", "status": 404, "headers": []},
            )
            await send({"type": "http.response.body", "body": b"not found", "more_body": False})

    return app


@pytest.fixture
async def proxied(
    gateway, enrollment, device
) -> AsyncIterator[tuple[ProxyBase, AuthHeaders, AppState, GatewayBackend]]:
    """(proxy base url, auth headers, app state, backend) with a streaming backend."""
    state = AppState()
    backend = GatewayBackend(
        url=gateway["httpUrl"],
        credential=enrollment["token"],
        namespace=NAMESPACE,
        identity={"device_id": "stream-dev", "instance_id": "stream-inst", "name": "stream-backend"},
    )
    backend.serve_http_stream(
        asgi_http_handler(stream_app(state), extra_headers={"X-API-Key": "backend-secret"})
    )
    await asyncio.wait_for(backend.connect(), 15)
    auth = {"Authorization": f"Bearer {device['token']}"}
    try:
        yield f"{gateway['httpUrl']}/api/proxy/{backend.backend_id}", auth, state, backend
    finally:
        await backend.close()


async def read_until(stream: ProxyHttpStream, marker: bytes, *, limit: int = 8) -> bytes:
    """Accumulate body chunks until ``marker`` shows up (chunking is opaque)."""
    buffer = b""
    for _ in range(limit):
        buffer += await stream.next_body_chunk()
        if marker in buffer:
            return buffer
    raise AssertionError(f"{marker!r} did not arrive within {limit} chunks: {buffer!r}")


async def test_proxy_json_get_post_404_and_missing_credential(
    proxied: tuple[ProxyBase, AuthHeaders, AppState, GatewayBackend],
) -> None:
    base, auth, _state, _backend = proxied

    ping = await proxy_request(base, "GET", "/ping?a=1&b=x%20y", headers=auth)
    assert ping.status == 200
    assert json.loads(ping.body) == {"method": "GET", "query": "a=1&b=x%20y", "api_key": "backend-secret"}

    upload = await proxy_request(
        base,
        "POST",
        "/echo",
        headers={**auth, "Content-Type": "application/octet-stream"},
        body=b"x" * 200_000,
    )
    assert upload.status == 200
    assert json.loads(upload.body) == {"len": 200_000}

    missing = await proxy_request(base, "GET", "/missing", headers=auth)
    assert missing.status == 404
    assert missing.body == b"not found"

    anonymous = await proxy_request(base, "GET", "/ping")
    assert anonymous.status in (401, 403)
    assert b"backend-secret" not in anonymous.body


async def test_proxy_streams_and_propagates_client_abort(
    proxied: tuple[ProxyBase, AuthHeaders, AppState, GatewayBackend],
) -> None:
    base, auth, state, _backend = proxied

    stream = await open_proxy_request(base, "GET", "/stream", headers={**auth, "Accept": "text/event-stream"})
    try:
        assert stream.status == 200
        assert stream.headers["content-type"].startswith("text/event-stream")
        # The first event only exists while the backend handler is still open:
        # a buffering SDK would hang here until the handler returned.
        assert b"data: one" in await read_until(stream, b"data: one")
        assert not state.finished.is_set()
    finally:
        await stream.close()  # dropping the response is the client abort

    # Cancellation propagates end to end: gateway -> channel -> handler.
    await asyncio.wait_for(state.finished.wait(), 15)

    state.release.set()
    full = await proxy_request(base, "GET", "/stream", headers={**auth, "Accept": "text/event-stream"})
    assert full.status == 200
    assert full.body == b"data: one\n\ndata: two\n\n"


async def test_background_start_connects_with_an_enrollment_credential(gateway, enrollment) -> None:
    # The exchange endpoint answers 201 (not 200) on success; the SDK must
    # accept any 2xx.
    exchange = await proxy_request(
        gateway["httpUrl"],
        "POST",
        "/api/backend/token",
        headers={"Authorization": f"Bearer {enrollment['token']}"},
        body=b"",
    )
    assert exchange.status == 201

    backend = GatewayBackend(
        url=gateway["httpUrl"],
        credential=enrollment["token"],  # zgb_: exchanged for a zga_ access credential
        namespace=NAMESPACE,
        identity={"device_id": "start-dev", "instance_id": "start-inst", "name": "start-backend"},
        reconnect_min_ms=200,
        reconnect_max_ms=1000,
    )
    try:
        await backend.start()  # returns immediately, never raises for the gateway being away
        await asyncio.wait_for(backend.wait_connected(), 15)
        assert backend.state == "connected"
        assert backend.backend_id
    finally:
        await backend.close()
    assert backend.state == "closed"


async def test_buffered_serve_http_still_works_over_a_device_credential(gateway, enrollment, device) -> None:
    """0.1.0 behavior guard: the buffered handler still answers /api/proxy."""

    def handler(request: Any) -> HttpServeResponse:
        return HttpServeResponse(200, {"Content-Type": "application/json"}, json.dumps({"path": request.path}))

    backend = GatewayBackend(
        url=gateway["httpUrl"],
        credential=enrollment["token"],
        namespace=NAMESPACE,
        identity={"device_id": "buffered-dev", "instance_id": "buffered-inst", "name": "buffered-backend"},
    )
    backend.serve_http(handler)
    await asyncio.wait_for(backend.connect(), 15)
    auth: Mapping[str, str] = {"Authorization": f"Bearer {device['token']}"}
    try:
        response: HttpResponse = await proxy_request(
            f"{gateway['httpUrl']}/api/proxy/{backend.backend_id}", "GET", "/buffered?x=1", headers=auth
        )
        assert response.status == 200
        assert json.loads(response.body) == {"path": "/buffered?x=1"}
    finally:
        await backend.close()
