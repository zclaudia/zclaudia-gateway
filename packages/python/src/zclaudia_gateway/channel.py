"""Data-plane channel wrapper, dialing, and shared transport helpers.

A channel is a dedicated WebSocket relayed verbatim by the gateway: text and
binary frame types are preserved, backpressure is TCP-natural, and closing it
closes the whole channel for both ends.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import logging
from collections.abc import Callable
from typing import Any
from urllib.parse import quote, urlsplit

from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger("zclaudia_gateway")

#: Matches the gateway's WS ``maxPayload`` (``src/server.ts``); large payloads
#: must be split into frames by the application.
MAX_MESSAGE_SIZE = 50 * 1024 * 1024

ChannelData = str | bytes
MessageHandler = Callable[[ChannelData], Any]
CloseHandler = Callable[[], Any]

_CHANNEL_END = object()

#: Messages arriving between dial completion and the first consumer
#: registration are kept in a small early buffer and flushed on registration.
_EARLY_BUFFER_LIMIT = 64


def to_ws_base(url: str) -> str:
    """Derive the ws(s) base URL (no path) from a gateway URL of any scheme."""
    if "://" not in url:
        url = "http://" + url
    parts = urlsplit(url)
    scheme = "wss" if parts.scheme in ("https", "wss") else "ws"
    return f"{scheme}://{parts.netloc}"


def to_http_base(ws_base: str) -> str:
    """Inverse of :func:`to_ws_base` for the HTTP endpoints (token exchange)."""
    return ws_base.replace("ws", "http", 1)


def invoke(handler: Callable[..., Any], *args: Any) -> asyncio.Task | None:
    """Call a sync or async handler; schedule awaitable results as tasks.

    Returns the task for async handlers (already running), else ``None``.
    """
    result = handler(*args)
    if inspect.isawaitable(result):
        task = asyncio.ensure_future(result)
        task.add_done_callback(_log_task_failure)
        return task
    return None


def _log_task_failure(task: asyncio.Task[Any]) -> None:
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.error("background handler failed", exc_info=exc)


class GatewayChannel:
    """A live data-plane channel (one relayed WebSocket).

    ``on_message`` handlers receive ``str`` for text frames and ``bytes`` for
    binary frames — the gateway preserves the distinction verbatim. Handlers
    may be sync or async; async handlers run as tasks.
    """

    def __init__(self, channel_id: str, ws: Any, kind: str | None = None) -> None:
        self.channel_id = channel_id
        self.kind = kind
        self._ws = ws
        self._closed = False
        self._message_handlers: list[MessageHandler] = []
        self._close_handlers: list[CloseHandler] = []
        self._pending: list[ChannelData] = []
        self._inbox: asyncio.Queue[Any] | None = None
        self._reader = asyncio.ensure_future(self._read_loop())

    def __repr__(self) -> str:
        return f"<GatewayChannel {self.channel_id!r} kind={self.kind!r} open={self.is_open}>"

    @property
    def is_open(self) -> bool:
        return not self._closed

    async def _read_loop(self) -> None:
        try:
            async for message in self._ws:
                handlers = list(self._message_handlers)
                if handlers:
                    for handler in handlers:
                        invoke(handler, message)
                elif len(self._pending) < _EARLY_BUFFER_LIMIT:
                    # No consumer yet (between dial and handler registration):
                    # hold the message for the first registrant.
                    self._pending.append(message)
                else:
                    logger.warning("channel %s: early buffer full, dropping message", self.channel_id)
        except ConnectionClosed:
            pass
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("channel read loop failed")
        finally:
            self._mark_closed()

    def _mark_closed(self) -> None:
        if self._closed:
            return
        self._closed = True
        for handler in list(self._close_handlers):
            invoke(handler)

    async def send(self, data: ChannelData) -> None:
        if self._closed:
            raise RuntimeError("Channel is closed")
        await self._ws.send(data)

    def on_message(self, handler: MessageHandler) -> Callable[[], None]:
        """Register a message handler; returns an unsubscribe callable.

        Messages that arrived before the first registration are delivered to
        the first registrant (small bounded early buffer).
        """
        self._message_handlers.append(handler)
        if self._pending:
            pending, self._pending = self._pending, []
            for message in pending:
                invoke(handler, message)
        return lambda: self._message_handlers.remove(handler)

    def on_close(self, handler: CloseHandler) -> Callable[[], None]:
        """Register a close handler; returns an unsubscribe callable."""
        self._close_handlers.append(handler)
        return lambda: self._close_handlers.remove(handler)

    def __aiter__(self) -> GatewayChannel:
        """Iterate inbound messages (``str``/``bytes``) until the channel closes.

        Single-consumer. Messages that arrived before the first consumer
        registered are delivered first (small bounded early buffer).
        Alternatively use :meth:`on_message` for callback style.
        """
        if self._inbox is None:
            inbox: asyncio.Queue[Any] = asyncio.Queue()
            self._inbox = inbox
            self.on_message(inbox.put_nowait)
            self.on_close(lambda: inbox.put_nowait(_CHANNEL_END))
        return self

    async def __anext__(self) -> ChannelData:
        if self._inbox is None:
            self.__aiter__()
        assert self._inbox is not None
        item = await self._inbox.get()
        if item is _CHANNEL_END:
            raise StopAsyncIteration
        return item

    async def close(self) -> None:
        """Close the channel (closes it for both ends)."""
        self._mark_closed()
        with contextlib.suppress(Exception):
            await self._ws.close(1000)
        if not self._reader.done():
            self._reader.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._reader


async def dial_channel(
    ws_base: str,
    data_path: str,
    ticket: str,
    channel_id: str,
    kind: str | None = None,
    *,
    max_message_size: int = MAX_MESSAGE_SIZE,
) -> GatewayChannel:
    """Dial a channel data socket with a one-time ticket and wrap it."""
    url = f"{ws_base}{data_path}?ticket={quote(ticket, safe='')}"
    ws = await ws_connect(url, max_size=max_message_size)
    return GatewayChannel(channel_id, ws, kind)
