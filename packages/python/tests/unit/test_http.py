"""Unit tests for HTTP-over-channel serving (kind='http')."""

from __future__ import annotations

import asyncio
import json

import pytest
from fake_gateway import FakeGateway

from zclaudia_gateway import HttpServeRequest, HttpServeResponse


@pytest.fixture
async def gateway():
    gw = FakeGateway()
    await gw.start()
    try:
        yield gw
    finally:
        await gw.stop()


@pytest.fixture
async def backend(gateway):
    from zclaudia_gateway import GatewayBackend

    backend = GatewayBackend(
        url=gateway.url,
        credential="zgb_test",
        namespace="test-ns",
        identity={"device_id": "dev-1", "instance_id": "inst-1"},
        exchange_enrollment=False,
        heartbeat_interval_ms=1000,
    )
    yield backend
    await backend.close()


async def _drive_request(gateway, channel_id: str, frames: list) -> list:
    """Offer an http channel, send frames, collect response frames."""
    responses: list = []
    closed = asyncio.Event()

    async def on_connection(ws):
        for frame in frames:
            await ws.send(frame if isinstance(frame, bytes) else json.dumps(frame))
        async for raw in ws:
            responses.append(raw if isinstance(raw, bytes) else json.loads(raw))
        closed.set()

    await gateway.offer_channel(kind="http", channel_id=channel_id, on_connection=on_connection)
    await asyncio.wait_for(closed.wait(), 5)
    return responses


async def test_serve_http_round_trip(gateway, backend):
    captured = []

    def handler(request: HttpServeRequest) -> HttpServeResponse:
        captured.append(request)
        numbers = json.loads(request.body)
        return HttpServeResponse(
            status=200,
            headers={"Content-Type": "application/json"},
            body=json.dumps({"sum": sum(numbers)}),
        )

    backend.serve_http(handler)
    await backend.connect()

    responses = await _drive_request(
        gateway,
        "ch-http",
        [
            {
                "type": "http_request",
                "method": "POST",
                "path": "/sum?verbose=1",
                "headers": {"content-type": "application/json"},
            },
            b"[1,2,3,4]",
            {"type": "http_request_end"},
        ],
    )

    assert len(captured) == 1
    assert captured[0].method == "POST"
    assert captured[0].path == "/sum?verbose=1"
    assert captured[0].headers == {"content-type": "application/json"}
    assert captured[0].body == b"[1,2,3,4]"

    assert responses[0] == {"type": "http_response", "status": 200, "headers": {"Content-Type": "application/json"}}
    assert responses[1] == b'{"sum": 10}'


async def test_serve_http_async_handler_and_streamed_body(gateway, backend):
    async def handler(request: HttpServeRequest) -> HttpServeResponse:
        await asyncio.sleep(0.01)
        return HttpServeResponse(status=201, body=b"chunk")

    backend.serve_http(handler)
    await backend.connect()

    responses = await _drive_request(
        gateway,
        "ch-http-async",
        [
            {"type": "http_request", "method": "GET", "path": "/x", "headers": {}},
            b"ab",
            b"cd",
            {"type": "http_request_end"},
        ],
    )
    assert responses[0]["status"] == 201
    assert responses[1] == b"chunk"


async def test_serve_http_handler_error_returns_500(gateway, backend):
    def handler(request):
        raise ValueError("boom")

    backend.serve_http(handler)
    await backend.connect()

    responses = await _drive_request(
        gateway,
        "ch-http-err",
        [
            {"type": "http_request", "method": "GET", "path": "/x", "headers": {}},
            {"type": "http_request_end"},
        ],
    )
    assert responses[0] == {"type": "http_response", "status": 500, "headers": {}}


async def test_serve_http_empty_body_response(gateway, backend):
    backend.serve_http(lambda request: HttpServeResponse(status=204))
    await backend.connect()

    responses = await _drive_request(
        gateway,
        "ch-http-204",
        [
            {"type": "http_request", "method": "DELETE", "path": "/x", "headers": {}},
            {"type": "http_request_end"},
        ],
    )
    assert len(responses) == 1
    assert responses[0]["status"] == 204
