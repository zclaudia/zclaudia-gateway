"""Minimal in-process stand-in for the gateway control plane.

Implements just enough of Gateway Protocol v4 for SDK unit tests: the
``/ws`` handshake, heartbeats, server-initiated channel offers with ticket
validation on ``/channel/<id>``, topic capture, and the enrollment-credential
exchange endpoint (served via ``process_request`` on the same port).
"""

from __future__ import annotations

import asyncio
import inspect
import json
import secrets
import time
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import parse_qs, urlsplit

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

BACKEND_ID = "a1b2c3d4-0000-4000-8000-000000000001"

DataHandler = Callable[[ServerConnection], Awaitable[None]]


async def until(predicate: Callable[[], Any], timeout: float = 5.0, interval: float = 0.01) -> None:
    """Poll ``predicate`` (sync or async) until truthy; raise on timeout."""
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while True:
        value = predicate()
        if inspect.isawaitable(value):
            value = await value
        if value:
            return
        if loop.time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(interval)


class FakeGateway:
    def __init__(
        self,
        *,
        reject_hello: tuple[str, str] | None = None,
        reject_exchange: bool = False,
        exchange_token: str = "zga_exchanged",
        lease_ttl_ms: int = 30_000,
        silent_hello: bool = False,
        drop_on_hello: bool = False,
        exchange_ttl_ms: int | None = None,
    ) -> None:
        self.reject_hello = reject_hello
        self.reject_exchange = reject_exchange
        self.exchange_token = exchange_token
        self.lease_ttl_ms = lease_ttl_ms
        self.silent_hello = silent_hello  # read peer_hello, then never answer
        self.drop_on_hello = drop_on_hello  # read peer_hello, then hang up without gateway_error
        self.exchange_ttl_ms = exchange_ttl_ms  # None = exchanged tokens never expire
        self.revoked_tokens: set[str] = set()  # hellos with these secrets get UNAUTHORIZED

        self.hellos: list[dict[str, Any]] = []
        self.heartbeats: list[dict[str, Any]] = []
        self.topic_publishes: list[dict[str, Any]] = []
        self.channel_rejects: list[dict[str, Any]] = []
        self.token_requests: list[dict[str, str]] = []
        self.connection_count = 0
        self.control_ws: ServerConnection | None = None

        self._data: dict[str, dict[str, Any]] = {}
        self._server: Any = None
        self.port = 0

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}"

    async def start(self) -> None:
        self._server = await serve(
            self._route,
            "127.0.0.1",
            0,
            max_size=64 * 1024 * 1024,
            process_request=self._process_request,
        )
        self.port = self._server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        self._server.close()
        await self._server.wait_closed()

    # --- Server routes -----------------------------------------------------

    async def _process_request(self, connection: ServerConnection, request: Any) -> Any:
        path = urlsplit(request.path).path
        if path != "/api/backend/token":
            return None
        authorization = request.headers.get("Authorization", "")
        self.token_requests.append({"authorization": authorization})
        if self.reject_exchange or not authorization.startswith("Bearer zgb_"):
            return connection.respond(401, json.dumps({"success": False}))
        expires_at = None if self.exchange_ttl_ms is None else int(time.time() * 1000) + self.exchange_ttl_ms
        body = json.dumps(
            {"success": True, "data": {"token": self.exchange_token, "expiresAt": expires_at, "namespace": "test-ns"}}
        )
        return connection.respond(201, body)

    async def _route(self, ws: ServerConnection) -> None:
        path = urlsplit(ws.request.path).path
        if path == "/ws":
            await self._control(ws)
        elif path.startswith("/channel/"):
            await self._data_connection(ws, path[len("/channel/") :])
        else:
            await ws.close(1008, "unknown path")

    async def _control(self, ws: ServerConnection) -> None:
        self.connection_count += 1
        epoch = self.connection_count
        self.control_ws = ws
        try:
            raw = await ws.recv()
            hello = json.loads(raw)
            self.hellos.append(hello)
            if self.silent_hello:
                await ws.wait_closed()
                return
            if self.drop_on_hello:
                await ws.close(1011, "boom")
                return
            reject = self.reject_hello
            if reject is None and hello.get("gatewaySecret") in self.revoked_tokens:
                reject = ("UNAUTHORIZED", "Invalid gateway secret")
            if reject is not None:
                code, message = reject
                await ws.send(json.dumps({"type": "gateway_error", "code": code, "message": message}))
                await ws.close(1008, "rejected")
                return
            if hello.get("type") != "peer_hello":
                await ws.send(
                    json.dumps({"type": "gateway_error", "code": "INVALID_MESSAGE", "message": "expected peer_hello"})
                )
                await ws.close(1008, "rejected")
                return
            await ws.send(
                json.dumps(
                    {
                        "type": "peer_ready",
                        "protocolVersion": 4,
                        "peerSessionId": f"peer-session-{self.connection_count}",
                        "recoveryToken": f"recovery-{self.connection_count}",
                        "backend": {"backendId": BACKEND_ID, "epoch": epoch, "leaseTtlMs": self.lease_ttl_ms},
                        "registrySync": {"items": []},
                    }
                )
            )
            async for raw in ws:
                message = json.loads(raw)
                kind = message.get("type")
                if kind == "backend_heartbeat":
                    self.heartbeats.append(message)
                elif kind == "topic_publish":
                    self.topic_publishes.append(message)
                elif kind == "channel_reject":
                    self.channel_rejects.append(message)
        except ConnectionClosed:
            pass

    async def _data_connection(self, ws: ServerConnection, channel_id: str) -> None:
        query = parse_qs(urlsplit(ws.request.path).query)
        ticket = (query.get("ticket") or [""])[0]
        entry = self._data.get(channel_id)
        if entry is None or entry["ticket"] != ticket:
            await ws.close(1008, "bad ticket")
            return
        entry["ws"] = ws
        entry["connected"].set()
        handler = entry["handler"]
        try:
            if handler is not None:
                await handler(ws)
            else:
                async for _ in ws:
                    pass
        except ConnectionClosed:
            pass

    # --- Test-driver helpers ----------------------------------------------

    async def send_control(self, message: dict[str, Any]) -> None:
        assert self.control_ws is not None, "no control connection"
        await self.control_ws.send(json.dumps(message))

    async def drop_control(self, code: int = 4000) -> None:
        assert self.control_ws is not None, "no control connection"
        await self.control_ws.close(code)

    async def offer_channel(
        self,
        *,
        kind: str | None = None,
        channel_id: str = "ch-1",
        source_peer_session_id: str | None = "peer-1",
        on_connection: DataHandler | None = None,
    ) -> str:
        ticket = secrets.token_urlsafe(16)
        self._data[channel_id] = {
            "ticket": ticket,
            "handler": on_connection,
            "connected": asyncio.Event(),
            "ws": None,
        }
        offer: dict[str, Any] = {
            "type": "channel_offer",
            "channelId": channel_id,
            "ticket": ticket,
            "dataPath": f"/channel/{channel_id}",
        }
        if kind is not None:
            offer["kind"] = kind
        if source_peer_session_id is not None:
            offer["sourcePeerSessionId"] = source_peer_session_id
        await self.send_control(offer)
        return ticket

    async def wait_for_data_connection(self, channel_id: str, timeout: float = 5.0) -> ServerConnection:
        entry = self._data[channel_id]
        await asyncio.wait_for(entry["connected"].wait(), timeout)
        return entry["ws"]

    async def offer_http(self, channel_id: str = "ch-http") -> ServerConnection:
        """Offer an ``http`` channel; returns the gateway end of its data socket.

        Unlike :meth:`offer_channel` with a driver handler, the returned
        socket stays untouched: the test writes the request frames and reads
        the response frames itself.
        """

        async def idle(ws: ServerConnection) -> None:
            await ws.wait_closed()

        await self.offer_channel(kind="http", channel_id=channel_id, on_connection=idle)
        return await self.wait_for_data_connection(channel_id)


async def send_http_request(
    ws: ServerConnection,
    method: str,
    path: str,
    *,
    headers: dict[str, str] | None = None,
    body: tuple[bytes, ...] = (),
) -> None:
    """Drive the request direction: head frame, body frames, end frame."""
    await ws.send(json.dumps({"type": "http_request", "method": method, "path": path, "headers": headers or {}}))
    for chunk in body:
        await ws.send(chunk)
    await ws.send(json.dumps({"type": "http_request_end"}))


async def read_http_response(ws: ServerConnection, timeout: float = 5.0) -> tuple[dict[str, Any], bytes]:
    """Collect the response direction: head frame, then body frames to close."""
    meta = json.loads(await asyncio.wait_for(ws.recv(), timeout))
    assert meta["type"] == "http_response"
    chunks: list[bytes] = []
    try:
        while True:
            frame = await asyncio.wait_for(ws.recv(), timeout)
            assert isinstance(frame, bytes)
            chunks.append(frame)
    except ConnectionClosed:
        pass
    return meta, b"".join(chunks)
