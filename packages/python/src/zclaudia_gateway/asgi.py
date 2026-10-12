"""Adapt an ASGI application (FastAPI, Starlette, …) to a gateway HTTP handler.

Pure ASGI: this module imports nothing beyond the standard library and the
SDK itself, and the application is called in-process — no loopback port.

Requests are dispatched with the gateway's request headers only. That
allowlist (``content-type``, ``accept``, ``x-request-id``, ``range``,
``if-none-match``, ``if-modified-since``) carries no ``Authorization`` and no
cookies, so any credential the application needs must be held by the backend
itself and injected with ``extra_headers`` — which also override a same-named
header a client managed to get through. Clients therefore never see the
backend's credentials; conversely, anyone who can reach the backend through
the gateway reaches it with those credentials attached.

The scope says ``scheme: "http"``: the gateway terminates TLS, and the proxy
hop carries no forwarded-proto header, so absolute URLs an application builds
from the scope always come out as ``http``.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from urllib.parse import unquote

from websockets.exceptions import ConnectionClosed

from .channel import ChannelClosedError
from .http import HttpExchange, HttpStreamHandler


def asgi_http_handler(app: Any, *, extra_headers: Mapping[str, str] | None = None) -> HttpStreamHandler:
    """Build a streaming handler that serves ``app`` behind the gateway proxy.

    ``extra_headers`` are sent to the application on every request (for
    example ``{"X-API-Key": "..."}``), overriding gateway-forwarded headers of
    the same name. Pass the result to
    :meth:`~zclaudia_gateway.GatewayBackend.serve_http_stream`.
    """

    injected = {name.lower(): value for name, value in (extra_headers or {}).items()}

    async def handle(exchange: HttpExchange) -> None:
        request = exchange.request
        raw_path, _, query = request.path.partition("?")
        headers = {name.lower(): value for name, value in request.headers.items()}
        headers.setdefault("host", "localhost")
        headers.update(injected)
        scope: dict[str, Any] = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": request.method.upper(),
            "scheme": "http",
            "path": unquote(raw_path),
            "raw_path": raw_path.encode("latin-1", "replace"),
            "query_string": query.encode("latin-1", "replace"),
            "root_path": "",
            "headers": [(name.encode("latin-1"), value.encode("latin-1")) for name, value in headers.items()],
            # Never None: applications rate-limit and audit by client host.
            "client": ("gateway", 0),
            "server": ("gateway", 0),
        }
        body_done = False

        async def receive() -> dict[str, Any]:
            # ASGI servers poll receive() for the body and for disconnects
            # from different tasks, so this holds no per-call iterator state.
            nonlocal body_done
            if not body_done:
                chunk = await exchange.read_chunk()
                if chunk is not None:
                    return {"type": "http.request", "body": chunk, "more_body": True}
                if not body_done:  # re-check: a concurrent reader may have raced us here
                    body_done = True
                    return {"type": "http.request", "body": b"", "more_body": False}
            await exchange.disconnected.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict[str, Any]) -> None:
            if exchange.disconnected.is_set():
                return  # as on a real server, output after a disconnect is dropped
            try:
                kind = message.get("type")
                if kind == "http.response.start":
                    merged: dict[str, str] = {}
                    for raw_name, raw_value in message.get("headers") or ():
                        name = raw_name.decode("latin-1").lower()
                        value = raw_value.decode("latin-1")
                        # Repeated headers are folded into one comma-separated
                        # value: the gateway forwards a flat name -> value map.
                        merged[name] = f"{merged[name]}, {value}" if name in merged else value
                    await exchange.start(int(message["status"]), merged)
                elif kind == "http.response.body":
                    await exchange.write(message.get("body") or b"")
            except (ChannelClosedError, ConnectionClosed):
                exchange.disconnected.set()

        await app(scope, receive, send)

    return handle
