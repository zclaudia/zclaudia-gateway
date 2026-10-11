"""HTTP-over-channel serving (``docs/protocol-v4.md`` §7, channel kind ``http``).

Wire shape on the data connection, per request:

1. text frame ``{"type": "http_request", method, path, headers}``
2. zero or more binary body frames
3. text frame ``{"type": "http_request_end"}``

Response: text frame ``{"type": "http_response", status, headers}``, then
binary body frames; closing the data connection ends the response.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from .channel import GatewayChannel

logger = logging.getLogger("zclaudia_gateway")


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


def build_http_handler(handler: HttpHandler) -> Callable[[GatewayChannel, Any], None]:
    """Wrap a user HTTP handler into a channel handler for kind ``http``."""

    def on_channel(channel: GatewayChannel, _info: Any) -> None:
        meta: dict[str, Any] | None = None
        chunks: list[bytes] = []

        async def process() -> None:
            assert meta is not None
            request = HttpServeRequest(
                method=str(meta.get("method") or "GET"),
                path=str(meta.get("path") or "/"),
                headers=dict(meta.get("headers") or {}),
                body=b"".join(chunks),
            )
            try:
                result = handler(request)
                if inspect.isawaitable(result):
                    result = await result
                if not isinstance(result, HttpServeResponse):
                    raise TypeError("serve_http handler must return HttpServeResponse")
                await channel.send(
                    json.dumps(
                        {
                            "type": "http_response",
                            "status": result.status,
                            "headers": result.headers or {},
                        }
                    )
                )
                if result.body is not None:
                    body = result.body.encode("utf-8") if isinstance(result.body, str) else result.body
                    if len(body) > 0:
                        await channel.send(body)
            except Exception:
                logger.exception("serve_http handler failed")
                try:
                    await channel.send(json.dumps({"type": "http_response", "status": 500, "headers": {}}))
                except Exception:
                    pass
            finally:
                await channel.close()

        def on_message(data: str | bytes) -> None:
            nonlocal meta
            if isinstance(data, bytes):
                chunks.append(data)
                return
            try:
                frame = json.loads(data)
            except ValueError:
                return
            if not isinstance(frame, dict):
                return
            if frame.get("type") == "http_request":
                meta = frame
            elif frame.get("type") == "http_request_end" and meta is not None:
                # Fire-and-forget: the channel reader must stay responsive
                # while the handler runs.
                task = asyncio.ensure_future(process())
                task.add_done_callback(_log_task_failure)

        channel.on_message(on_message)

    return on_channel


def _log_task_failure(task: asyncio.Task[Any]) -> None:
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.error("http channel task failed", exc_info=exc)
