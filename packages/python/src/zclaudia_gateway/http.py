"""HTTP-over-channel serving (``docs/protocol-v4.md`` §7, channel kind ``http``).

Wire shape on the data connection, per request:

1. text frame ``{"type": "http_request", method, path, headers}``
2. zero or more binary body frames
3. text frame ``{"type": "http_request_end"}``

Response: text frame ``{"type": "http_response", status, headers}``, then
binary body frames; closing the data connection ends the response.

Two handler styles are built on that shape:

* :func:`build_http_handler` — buffered: the request is collected, the handler
  returns one :class:`HttpServeResponse`, the response goes out in one frame.
* :func:`build_http_stream_handler` — streaming: the handler receives an
  :class:`HttpExchange` as soon as the head arrives and may stream both
  directions (SSE, chunked responses, long polling).

Both register the ``http`` channel kind, so only one of them can serve.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from .channel import ChannelClosedError, GatewayChannel

logger = logging.getLogger("zclaudia_gateway")

#: How long a streaming handler may take to wind down after the client
#: disconnected before it is cancelled.
_ABORT_GRACE_SECONDS = 5.0


@dataclass
class HttpServeRequest:
    """A buffered request forwarded through the gateway's HTTP proxy."""

    method: str
    path: str
    headers: dict[str, str]
    body: bytes


@dataclass
class HttpServeResponse:
    """The response to send back through the channel."""

    status: int
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes | str | None = None


HttpHandler = Callable[[HttpServeRequest], "HttpServeResponse | Awaitable[HttpServeResponse]"]


@dataclass
class HttpStreamRequest:
    """The head of a request forwarded through the gateway's HTTP proxy.

    ``path`` is the request target exactly as the gateway forwarded it — path
    plus query string, not percent-decoded. ``headers`` holds only what the
    gateway's allowlist forwards (``content-type``, ``accept``,
    ``x-request-id``, ``range``, ``if-none-match``, ``if-modified-since``);
    notably no ``Authorization`` and no cookies.
    """

    method: str
    path: str
    headers: dict[str, str]


class HttpExchange:
    """One proxied request/response pair on an ``http`` channel.

    The handler is started as soon as the ``http_request`` head frame arrives
    and runs concurrently with the request body being streamed in, so it can
    answer before the body is complete and stream the response out
    (:meth:`start` once, then :meth:`write` per chunk).

    The body queue is unbounded: the gateway proxies application API calls,
    whose bodies are small, and a bounded queue would stall disconnect
    detection behind a handler that never reads.
    """

    def __init__(self, request: HttpStreamRequest, channel: GatewayChannel) -> None:
        self.request = request
        self.disconnected = asyncio.Event()
        self.started = False
        self._channel = channel
        self._body: asyncio.Queue[bytes | None] = asyncio.Queue()

    def __repr__(self) -> str:
        return (
            f"<HttpExchange {self.request.method} {self.request.path!r} "
            f"started={self.started} disconnected={self.disconnected.is_set()}>"
        )

    # --- Request body ------------------------------------------------------

    async def read_chunk(self) -> bytes | None:
        """Next request body chunk, or ``None`` once the body ended.

        The end marker is sticky — every later call returns ``None``
        immediately — and several tasks may await this at once, because ASGI
        servers read the body and watch for a disconnect concurrently.
        """
        chunk = await self._body.get()
        if chunk is None:
            self._body.put_nowait(None)
        return chunk

    async def body(self) -> AsyncIterator[bytes]:
        """Request body chunks; ends at ``http_request_end`` or on abort.

        Single-consumer: use :meth:`read_chunk` when several tasks read the
        body concurrently.
        """
        while (chunk := await self.read_chunk()) is not None:
            yield chunk

    # --- Response ----------------------------------------------------------

    async def start(self, status: int, headers: dict[str, str] | None = None) -> None:
        """Send the response head; allowed once, before any :meth:`write`."""
        if self.started:
            raise RuntimeError("Response already started")
        self.started = True
        frame = json.dumps({"type": "http_response", "status": status, "headers": headers or {}})
        await self._send(frame)

    async def write(self, chunk: bytes | str) -> None:
        """Send one response body chunk as a binary frame (``start`` first)."""
        if not self.started:
            raise RuntimeError("Response not started")
        if not chunk:
            return
        await self._send(chunk.encode("utf-8") if isinstance(chunk, str) else chunk)

    # --- Internals ---------------------------------------------------------

    def _feed(self, chunk: bytes) -> None:
        self._body.put_nowait(chunk)

    def _end_body(self) -> None:
        self._body.put_nowait(None)

    def _abort(self) -> None:
        """Mark the exchange dead and wake readers blocked on the body."""
        self.disconnected.set()
        self._body.put_nowait(None)

    async def _send(self, data: str | bytes) -> None:
        if self.disconnected.is_set():
            raise ChannelClosedError(self._channel.channel_id)
        try:
            await self._channel.send(data)
        except ChannelClosedError:
            self.disconnected.set()
            raise


HttpStreamHandler = Callable[[HttpExchange], Awaitable[None]]


async def serve_http_channel(channel: GatewayChannel, handler: HttpStreamHandler) -> None:
    """Run one ``http`` channel to completion (one request per channel).

    Frames are consumed through the channel iterator (unlike ``on_message``,
    which spawns a task per message and therefore does not preserve order).
    When the channel ends — the client aborted, the gateway tore it down —
    the exchange is marked disconnected, blocked body readers wake up, and
    the handler gets a short grace period to wind down before being
    cancelled.
    """

    exchange: HttpExchange | None = None
    task: asyncio.Task[None] | None = None
    try:
        async for message in channel:
            if isinstance(message, bytes):
                if exchange is not None:
                    exchange._feed(message)
                continue
            if not isinstance(message, str):
                continue
            try:
                frame = json.loads(message)
            except ValueError:
                continue
            if not isinstance(frame, dict):
                continue
            kind = frame.get("type")
            if kind == "http_request" and exchange is None:
                headers = frame.get("headers")
                exchange = HttpExchange(
                    HttpStreamRequest(
                        method=str(frame.get("method") or "GET"),
                        path=str(frame.get("path") or "/"),
                        headers=({str(k): str(v) for k, v in headers.items()} if isinstance(headers, dict) else {}),
                    ),
                    channel,
                )
                task = asyncio.ensure_future(_run_handler(handler, exchange, channel))
            elif kind == "http_request_end" and exchange is not None:
                exchange._end_body()
    finally:
        if exchange is not None:
            exchange._abort()
        if task is not None and not task.done():
            _done, pending = await asyncio.wait({task}, timeout=_ABORT_GRACE_SECONDS)
            for leftover in pending:
                leftover.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
        with contextlib.suppress(Exception):
            await channel.close()  # closing the channel is what ends the response


async def _run_handler(handler: HttpStreamHandler, exchange: HttpExchange, channel: GatewayChannel) -> None:
    try:
        await handler(exchange)
        if not exchange.started:
            # The handler produced no response head: the client still needs one.
            await exchange.start(500)
    except ChannelClosedError:
        # The client went away mid-response; there is nobody left to tell.
        logger.debug("http handler stopped after the channel closed", exc_info=True)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("http handler failed")
        if not exchange.started:
            with contextlib.suppress(ChannelClosedError):
                await exchange.start(500)
    finally:
        with contextlib.suppress(Exception):
            await channel.close()


def build_http_stream_handler(handler: HttpStreamHandler) -> Callable[[GatewayChannel, Any], None]:
    """Wrap a streaming HTTP handler into a channel handler for kind ``http``."""

    def on_channel(channel: GatewayChannel, _info: Any) -> None:
        task = asyncio.ensure_future(serve_http_channel(channel, handler))
        task.add_done_callback(_log_task_failure)

    return on_channel


def build_http_handler(handler: HttpHandler) -> Callable[[GatewayChannel, Any], None]:
    """Wrap a buffered user HTTP handler into a channel handler for kind ``http``.

    Built on the streaming layer: the request body is collected first, the
    handler then produces one :class:`HttpServeResponse` (sync or async), and
    the response is written as a single body frame.
    """

    async def serve(exchange: HttpExchange) -> None:
        chunks: list[bytes] = []
        async for chunk in exchange.body():
            chunks.append(chunk)
        if exchange.disconnected.is_set():
            return  # client gone before the request was complete: nothing to answer
        request = HttpServeRequest(
            method=exchange.request.method,
            path=exchange.request.path,
            headers=exchange.request.headers,
            body=b"".join(chunks),
        )
        try:
            result = handler(request)
            if inspect.isawaitable(result):
                result = await result
            if not isinstance(result, HttpServeResponse):
                raise TypeError("serve_http handler must return HttpServeResponse")
        except Exception:
            logger.exception("serve_http handler failed")
            await exchange.start(500)
            return
        await exchange.start(result.status, result.headers or {})
        if result.body is not None:
            body = result.body.encode("utf-8") if isinstance(result.body, str) else result.body
            if len(body) > 0:
                await exchange.write(body)

    return build_http_stream_handler(serve)


def _log_task_failure(task: asyncio.Task[Any]) -> None:
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.error("http channel task failed", exc_info=exc)
