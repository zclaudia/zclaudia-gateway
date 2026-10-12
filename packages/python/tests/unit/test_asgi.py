"""Unit tests for the ASGI adapter (``zclaudia_gateway.asgi``).

Every application here is hand-written ASGI (no FastAPI/Starlette anywhere),
which is what keeps the adapter's zero-dependency promise honest.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fake_gateway import FakeGateway, read_http_response, send_http_request

from zclaudia_gateway import GatewayBackend, asgi_http_handler


async def read_body(receive: Any) -> bytes:
    """Drain the request body the way an ASGI application does."""
    chunks: list[bytes] = []
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            break
        chunks.append(message.get("body", b""))
        if not message.get("more_body", False):
            break
    return b"".join(chunks)


async def respond(send: Any, status: int, body: bytes = b"", content_type: str = "text/plain") -> None:
    await send(
        {"type": "http.response.start", "status": status, "headers": [(b"content-type", content_type.encode())]}
    )
    await send({"type": "http.response.body", "body": body})


def echo_app() -> Any:
    """Report back everything the adapter put into the ASGI scope."""

    async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
        body = await read_body(receive)
        payload = {
            "method": scope["method"],
            "path": scope["path"],
            "raw_path": scope["raw_path"].decode(),
            "query_string": scope["query_string"].decode(),
            "http_version": scope["http_version"],
            "root_path": scope["root_path"],
            "client": list(scope["client"]),
            "server": list(scope["server"]),
            "headers": {name.decode(): value.decode() for name, value in scope["headers"]},
            "body": body.decode(),
        }
        await respond(send, 200, json.dumps(payload).encode(), "application/json")

    return app


async def test_scope_translation_and_injected_credentials(gateway: FakeGateway, backend: GatewayBackend):
    backend.serve_http_stream(asgi_http_handler(echo_app(), extra_headers={"X-API-Key": "backend-secret"}))
    await backend.connect()

    ws = await gateway.offer_http("ch-asgi")
    await send_http_request(
        ws,
        "post",
        "/a%20b/sum?q=x%20y&n=1",
        headers={"content-type": "application/json", "x-api-key": "client-supplied"},
        body=(b"[1,", b"2]"),
    )
    meta, body = await read_http_response(ws)
    payload = json.loads(body)

    assert meta == {"type": "http_response", "status": 200, "headers": {"content-type": "application/json"}}
    assert payload["method"] == "POST"  # upper-cased
    assert payload["path"] == "/a b/sum"  # percent-decoded
    assert payload["raw_path"] == "/a%20b/sum"
    assert payload["query_string"] == "q=x%20y&n=1"
    assert payload["http_version"] == "1.1"
    assert payload["root_path"] == ""
    assert payload["client"] == ["gateway", 0]  # never None: apps rate-limit by client host
    assert payload["server"] == ["gateway", 0]
    assert payload["headers"]["x-api-key"] == "backend-secret"  # injected wins over the client's value
    assert payload["headers"]["host"] == "localhost"  # the gateway forwards no Host header
    assert payload["body"] == "[1,2]"


async def test_missing_route_is_404_and_app_error_is_500(gateway: FakeGateway, backend: GatewayBackend):
    async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
        await read_body(receive)
        if scope["path"] == "/missing":
            await respond(send, 404, b"not found")
        elif scope["path"] == "/boom":
            raise RuntimeError("boom")
        else:
            await respond(send, 200, b"ok")

    backend.serve_http_stream(asgi_http_handler(app))
    await backend.connect()

    # One channel per proxied request: the gateway dials a fresh one each time
    # and the SDK ends the response by closing it.
    ws = await gateway.offer_http("ch-asgi-404")
    await send_http_request(ws, "GET", "/missing")
    meta, body = await read_http_response(ws)
    assert meta == {"type": "http_response", "status": 404, "headers": {"content-type": "text/plain"}}
    assert body == b"not found"

    ws = await gateway.offer_http("ch-asgi-boom")
    await send_http_request(ws, "GET", "/boom")
    assert await read_http_response(ws) == ({"type": "http_response", "status": 500, "headers": {}}, b"")


async def test_response_headers_are_lowercased_and_folded(gateway: FakeGateway, backend: GatewayBackend):
    async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"X-Multi", b"a"), (b"x-multi", b"b")],
            }
        )
        await send({"type": "http.response.body", "body": b"x"})

    backend.serve_http_stream(asgi_http_handler(app))
    await backend.connect()

    ws = await gateway.offer_http("ch-asgi-headers")
    await send_http_request(ws, "GET", "/x")
    meta, body = await read_http_response(ws)
    assert meta == {"type": "http_response", "status": 200, "headers": {"x-multi": "a, b"}}
    assert body == b"x"


async def test_response_streams_and_output_after_disconnect_is_dropped(
    gateway: FakeGateway, backend: GatewayBackend
):
    observations: dict[str, Any] = {}
    finished = asyncio.Event()

    async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"text/event-stream")],
            }
        )
        await send({"type": "http.response.body", "body": b"data: one\n\n", "more_body": True})
        await read_body(receive)
        # The body is done, so this only returns on a client disconnect.
        observations["message"] = await receive()
        try:
            await send({"type": "http.response.body", "body": b"data: two\n\n", "more_body": True})
            observations["send_error"] = None
        except BaseException as exc:  # a real server drops post-disconnect output
            observations["send_error"] = exc
        finally:
            finished.set()

    backend.serve_http_stream(asgi_http_handler(app))
    await backend.connect()

    ws = await gateway.offer_http("ch-asgi-sse")
    await send_http_request(ws, "GET", "/events")

    assert json.loads(await asyncio.wait_for(ws.recv(), 5))["status"] == 200
    assert await asyncio.wait_for(ws.recv(), 5) == b"data: one\n\n"
    assert not finished.is_set()  # first event out while the application is still running

    await ws.close(1000)  # what the gateway does when the HTTP client goes away

    await asyncio.wait_for(finished.wait(), 5)
    assert observations["message"] == {"type": "http.disconnect"}
    assert observations["send_error"] is None


async def test_concurrent_receive_calls_are_served(gateway: FakeGateway, backend: GatewayBackend):
    """Two tasks polling ``receive()`` at once must not trip shared state.

    Servers read the body and watch for a disconnect from separate tasks; a
    body implemented as an async generator raised "asynchronous generator is
    already running" there and streamed nothing at all.
    """

    observations: dict[str, Any] = {}

    async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
        seen: list[dict[str, Any]] = []
        errors: list[BaseException] = []
        stop = asyncio.Event()

        async def reader() -> None:
            try:
                while not stop.is_set():
                    message = await receive()
                    seen.append(message)
                    if message["type"] == "http.disconnect" or (
                        message["type"] == "http.request" and not message.get("more_body", False)
                    ):
                        stop.set()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # the regression surfaced as a RuntimeError here
                errors.append(exc)

        tasks = [asyncio.ensure_future(reader()) for _ in range(2)]
        await asyncio.wait_for(stop.wait(), 5)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

        observations["seen"] = seen
        observations["errors"] = errors
        await respond(send, 200, b"ok")

    backend.serve_http_stream(asgi_http_handler(app))
    await backend.connect()

    ws = await gateway.offer_http("ch-asgi-concurrent")
    await send_http_request(ws, "POST", "/x", body=(b"a", b"b"))
    meta, body = await read_http_response(ws)

    assert observations["errors"] == []
    assert meta["status"] == 200
    assert body == b"ok"
    terminals = [
        message
        for message in observations["seen"]
        if message["type"] == "http.request" and not message.get("more_body", False)
    ]
    assert len(terminals) == 1  # the end of the body is reported exactly once
