"""Unit tests for streaming HTTP-over-channel serving (kind='http')."""

from __future__ import annotations

import asyncio
import json

import pytest
from fake_gateway import FakeGateway, read_http_response, send_http_request, until
from websockets.exceptions import ConnectionClosed

from zclaudia_gateway import (
    ChannelClosedError,
    GatewayBackend,
    GatewayChannel,
    HttpExchange,
    HttpServeResponse,
)


async def test_round_trip_with_query_and_framed_body(gateway: FakeGateway, backend: GatewayBackend):
    seen: list[HttpExchange] = []

    async def handler(exchange: HttpExchange) -> None:
        seen.append(exchange)
        chunks = [chunk async for chunk in exchange.body()]
        await exchange.start(200, {"content-type": "application/json"})
        await exchange.write(
            json.dumps(
                {
                    "method": exchange.request.method,
                    "path": exchange.request.path,
                    "headers": exchange.request.headers,
                    "body": b"".join(chunks).decode(),
                }
            )
        )

    backend.serve_http_stream(handler)
    await backend.connect()

    ws = await gateway.offer_http("ch-stream")
    await send_http_request(
        ws,
        "POST",
        "/sum?verbose=1",
        headers={"content-type": "application/json"},
        body=(b"[1,", b"2,3]"),
    )
    meta, body = await read_http_response(ws)

    assert meta == {"type": "http_response", "status": 200, "headers": {"content-type": "application/json"}}
    assert json.loads(body) == {
        "method": "POST",
        "path": "/sum?verbose=1",
        "headers": {"content-type": "application/json"},
        "body": "[1,2,3]",
    }
    assert seen[0].request.path == "/sum?verbose=1"
    assert seen[0].started is True


async def test_response_streams_before_the_handler_finishes(gateway: FakeGateway, backend: GatewayBackend):
    release = asyncio.Event()
    finished = asyncio.Event()

    async def handler(exchange: HttpExchange) -> None:
        try:
            await exchange.start(200, {"content-type": "text/event-stream"})
            await exchange.write(b"data: one\n\n")
            await release.wait()
            await exchange.write(b"data: two\n\n")
        finally:
            finished.set()

    backend.serve_http_stream(handler)
    await backend.connect()

    ws = await gateway.offer_http("ch-sse")
    await send_http_request(ws, "GET", "/events")

    meta = json.loads(await asyncio.wait_for(ws.recv(), 5))
    assert meta["status"] == 200
    assert await asyncio.wait_for(ws.recv(), 5) == b"data: one\n\n"
    assert not finished.is_set()  # the first chunk left while the handler was still open

    release.set()
    assert await asyncio.wait_for(ws.recv(), 5) == b"data: two\n\n"
    # The handler returned, so the SDK closed the channel — that ends the response.
    with pytest.raises(ConnectionClosed):
        await asyncio.wait_for(ws.recv(), 5)
    await asyncio.wait_for(finished.wait(), 5)


async def test_handler_status_passes_through(gateway: FakeGateway, backend: GatewayBackend):
    async def handler(exchange: HttpExchange) -> None:
        await exchange.start(404, {"content-type": "text/plain"})

    backend.serve_http_stream(handler)
    await backend.connect()

    ws = await gateway.offer_http("ch-404")
    await send_http_request(ws, "GET", "/missing")
    meta, body = await read_http_response(ws)

    assert meta == {"type": "http_response", "status": 404, "headers": {"content-type": "text/plain"}}
    assert body == b""


async def test_handler_exception_returns_500(gateway: FakeGateway, backend: GatewayBackend):
    async def handler(exchange: HttpExchange) -> None:
        raise RuntimeError("boom")

    backend.serve_http_stream(handler)
    await backend.connect()

    ws = await gateway.offer_http("ch-boom")
    await send_http_request(ws, "GET", "/x")
    assert await read_http_response(ws) == ({"type": "http_response", "status": 500, "headers": {}}, b"")


async def test_handler_without_start_returns_500(gateway: FakeGateway, backend: GatewayBackend):
    async def handler(exchange: HttpExchange) -> None:
        return

    backend.serve_http_stream(handler)
    await backend.connect()

    ws = await gateway.offer_http("ch-silent")
    await send_http_request(ws, "GET", "/x")
    assert await read_http_response(ws) == ({"type": "http_response", "status": 500, "headers": {}}, b"")


async def test_client_abort_sets_disconnected_and_wakes_readers(gateway: FakeGateway, backend: GatewayBackend):
    observations: dict[str, object] = {}
    finished = asyncio.Event()

    async def handler(exchange: HttpExchange) -> None:
        try:
            await exchange.start(200)
            await exchange.write(b"data: one\n\n")
            # The request has no end frame yet: this blocks until the abort.
            observations["end_marker"] = await exchange.read_chunk()
            observations["disconnected"] = exchange.disconnected.is_set()
            observations["sticky_end"] = await exchange.read_chunk()
            try:
                await exchange.write(b"data: late\n\n")
            except ChannelClosedError as exc:
                observations["write_error"] = exc
        except BaseException as exc:  # surface anything unexpected to the test
            observations["error"] = exc
            raise
        finally:
            finished.set()

    backend.serve_http_stream(handler)
    await backend.connect()

    ws = await gateway.offer_http("ch-abort")
    await ws.send(json.dumps({"type": "http_request", "method": "GET", "path": "/events", "headers": {}}))
    assert json.loads(await asyncio.wait_for(ws.recv(), 5))["status"] == 200
    assert await asyncio.wait_for(ws.recv(), 5) == b"data: one\n\n"

    await ws.close(1000)  # what the gateway does when the HTTP client goes away

    await asyncio.wait_for(finished.wait(), 5)  # no grace-period timeout: readers wake up
    assert "error" not in observations
    assert observations["end_marker"] is None
    assert observations["disconnected"] is True
    assert observations["sticky_end"] is None
    assert isinstance(observations["write_error"], ChannelClosedError)


async def test_write_before_start_and_double_start_are_rejected(gateway: FakeGateway, backend: GatewayBackend):
    observations: dict[str, object] = {}
    finished = asyncio.Event()

    async def handler(exchange: HttpExchange) -> None:
        try:
            try:
                await exchange.write(b"too early")
            except RuntimeError as exc:
                observations["write"] = exc
            await exchange.start(201)
            try:
                await exchange.start(500)
            except RuntimeError as exc:
                observations["start"] = exc
            await exchange.write(b"body")
        except BaseException as exc:
            observations["error"] = exc
            raise
        finally:
            finished.set()

    backend.serve_http_stream(handler)
    await backend.connect()

    ws = await gateway.offer_http("ch-misuse")
    await send_http_request(ws, "POST", "/x")
    meta, body = await read_http_response(ws)

    await asyncio.wait_for(finished.wait(), 5)
    assert "error" not in observations
    assert isinstance(observations["write"], RuntimeError)
    assert isinstance(observations["start"], RuntimeError)
    assert meta["status"] == 201
    assert body == b"body"


async def test_serve_http_stream_replaces_the_buffered_handler(gateway: FakeGateway, backend: GatewayBackend):
    def buffered(request: object) -> HttpServeResponse:
        return HttpServeResponse(200, body=b"buffered")

    async def streaming(exchange: HttpExchange) -> None:
        await exchange.start(200)
        await exchange.write(b"streaming")

    backend.serve_http(buffered)
    backend.serve_http_stream(streaming)  # both register kind 'http'; the last one wins
    await backend.connect()

    ws = await gateway.offer_http("ch-both")
    await send_http_request(ws, "GET", "/x")
    _meta, body = await read_http_response(ws)
    assert body == b"streaming"


async def test_send_on_closed_channel_raises_channel_closed_error(gateway: FakeGateway, backend: GatewayBackend):
    channels: list[GatewayChannel] = []
    closed = asyncio.Event()

    async def handler(channel: GatewayChannel, info: object) -> None:
        channels.append(channel)
        channel.on_close(closed.set)

    backend.on_channel("probe", handler)
    await backend.connect()

    await gateway.offer_channel(kind="probe", channel_id="ch-probe")
    data_ws = await gateway.wait_for_data_connection("ch-probe")
    await until(lambda: bool(channels))
    await data_ws.close(1000)
    await asyncio.wait_for(closed.wait(), 5)

    with pytest.raises(ChannelClosedError) as excinfo:
        await channels[0].send(b"late")
    assert isinstance(excinfo.value, RuntimeError)  # back-compat with 0.1.0 handlers
    assert channels[0].channel_id in str(excinfo.value)


async def test_streaming_request_without_end_frame_reads_until_abort(gateway: FakeGateway, backend: GatewayBackend):
    """The handler runs on the head frame alone, before the body is complete."""

    first_chunk = asyncio.Event()
    observations: dict[str, object] = {}

    async def handler(exchange: HttpExchange) -> None:
        await exchange.start(200, {"content-type": "text/plain"})
        chunks: list[bytes] = []
        async for chunk in exchange.body():
            chunks.append(chunk)
            first_chunk.set()
        observations["body"] = b"".join(chunks)

    backend.serve_http_stream(handler)
    await backend.connect()

    ws = await gateway.offer_http("ch-early")
    await ws.send(json.dumps({"type": "http_request", "method": "POST", "path": "/x", "headers": {}}))
    # No http_request_end: the response head is already on its way.
    assert json.loads(await asyncio.wait_for(ws.recv(), 5))["status"] == 200

    await ws.send(b"part one")
    await asyncio.wait_for(first_chunk.wait(), 5)
    await ws.send(b"part two")
    await ws.send(json.dumps({"type": "http_request_end"}))

    with pytest.raises(ConnectionClosed):
        await asyncio.wait_for(ws.recv(), 5)
    assert observations["body"] == b"part one" + b"part two"
