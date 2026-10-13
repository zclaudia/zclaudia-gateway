"""Gateway Backend SDK (Protocol v4).

Registration + lease heartbeat, channel offer handling (dial-is-accept),
topic publishing, HTTP-over-channel serving, and enrollment-credential
exchange — the Python equivalent of ``@zclaudia/gateway-backend``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake

from .channel import (
    MAX_MESSAGE_SIZE,
    GatewayChannel,
    _log_task_failure,
    dial_channel,
    invoke,
    to_http_base,
    to_ws_base,
)
from .protocol import (
    CHANNEL_KIND_HTTP,
    GATEWAY_CLOSE_BACKEND_REPLACED,
    GATEWAY_ERROR_CODES,
    GATEWAY_PROTOCOL_V4,
    PEER_TYPE_CLIENT_BACKEND,
    ChannelOffer,
    GatewayError,
    PeerReady,
    normalize_identity,
)

logger = logging.getLogger("zclaudia_gateway")

GatewayBackendState = Literal["idle", "connecting", "connected", "closed"]

BackendErrorCode = Literal[
    "AUTH_FAILED",
    "GATEWAY_REJECTED",
    "GATEWAY_UNREACHABLE",
    "HANDSHAKE_TIMEOUT",
    "PROTOCOL_ERROR",
    "CONNECT_FAILED",
    "REPLACED",
]

StateHandler = Callable[[GatewayBackendState], Any]
RawMessageHandler = Callable[[dict[str, Any]], Any]
PeerReadyTimeout = 10.0
# Re-exchange an access token this long before the gateway says it expires,
# so a reconnect never presents one that dies mid-handshake.
ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000


@dataclass(frozen=True)
class ChannelOfferInfo:
    """Metadata accompanying a channel offer delivered to a handler."""

    channel_id: str
    kind: str | None = None
    source_peer_session_id: str | None = None


@dataclass(frozen=True)
class BackendErrorInfo:
    """Why the most recent connection attempt failed (:attr:`GatewayBackend.last_error`).

    Safe to log and to show to users: ``message`` is a fixed description per
    ``code``; the raw exception text, request headers, URLs and credentials
    never end up here. Branch on ``code``, not on ``message``.

    ``code`` is one of:

    - ``AUTH_FAILED`` — the gateway refused the credential (``UNAUTHORIZED``
      during the handshake, or HTTP 401/403 from the enrollment exchange);
    - ``GATEWAY_REJECTED`` — the gateway refused the handshake for another
      reason (``gateway_code`` carries its error code when it is a known one);
    - ``GATEWAY_UNREACHABLE`` — no usable link: connection refused, DNS or
      network failure, connect timeout, the connection dropped mid-handshake,
      or a non-WebSocket / unavailable endpoint;
    - ``HANDSHAKE_TIMEOUT`` — connected, but ``peer_ready`` never arrived;
    - ``PROTOCOL_ERROR`` — the gateway answered with something the SDK cannot
      use (e.g. a handshake without a backend identity);
    - ``CONNECT_FAILED`` — anything else;
    - ``REPLACED`` — not a failed attempt: a newer connection with the same
      backend credential took over this backend's identity, so this instance
      stopped (``state == "closed"``, no reconnect) instead of fighting it.
    """

    code: BackendErrorCode
    message: str
    gateway_code: str | None = None
    occurred_at: float = 0.0
    """Wall-clock time (``time.time()``) of the failed attempt."""


class _AttemptError(RuntimeError):
    """An attempt failure the SDK itself can classify (kept a ``RuntimeError``
    so ``connect()`` callers written against earlier releases keep working)."""

    def __init__(self, code: BackendErrorCode, detail: str) -> None:
        super().__init__(detail)
        self.code: BackendErrorCode = code


_ERROR_MESSAGES: dict[BackendErrorCode, str] = {
    "AUTH_FAILED": "The gateway refused the credential.",
    "GATEWAY_REJECTED": "The gateway rejected the handshake.",
    "GATEWAY_UNREACHABLE": "The gateway could not be reached.",
    "HANDSHAKE_TIMEOUT": "The gateway did not complete the handshake in time.",
    "PROTOCOL_ERROR": "The gateway sent an unexpected handshake response.",
    "CONNECT_FAILED": "Connecting to the gateway failed.",
    "REPLACED": "Another connection using the same backend credential replaced this one.",
}


def _describe_failure(exc: BaseException) -> BackendErrorInfo:
    """Map an attempt failure to a credential-free :class:`BackendErrorInfo`."""
    code: BackendErrorCode = "CONNECT_FAILED"
    gateway_code: str | None = None
    message: str | None = None
    if isinstance(exc, GatewayError):
        gateway_code = exc.code if exc.code in GATEWAY_ERROR_CODES else None
        if exc.code == "UNAUTHORIZED":
            code = "AUTH_FAILED"
        else:
            code = "GATEWAY_REJECTED"
            if gateway_code is not None:
                message = f"The gateway rejected the handshake ({gateway_code})."
    elif isinstance(exc, _AttemptError):
        code = exc.code
    elif isinstance(exc, (OSError, ConnectionClosed, InvalidHandshake)):
        code = "GATEWAY_UNREACHABLE"
    return BackendErrorInfo(
        code=code,
        message=message or _ERROR_MESSAGES[code],
        gateway_code=gateway_code,
        occurred_at=time.time(),
    )


ChannelHandler = Callable[[GatewayChannel, ChannelOfferInfo], Any]


class GatewayBackend:
    """A registered Backend peer: connects, holds a lease, serves channels.

    Typical use::

        backend = GatewayBackend(url=..., credential="zgb_...", namespace=...)
        backend.on_channel("rpc", handler)
        backend.serve_http(http_handler)
        backend_id, epoch = await backend.connect()
        await backend.publish_topic("resources", snapshot, retain=True)
        ...
        await backend.close()

    Reconnection (default on) runs in the background with exponential
    backoff; every reconnect establishes a new epoch while the backendId
    stays stable, and all channels from the previous epoch are gone.

    :meth:`connect` waits for the first handshake and raises when it fails.
    Applications that must come up while the gateway is unreachable use
    :meth:`start` instead: it retries in the background and never raises for
    an unreachable gateway (``await backend.wait_connected()`` to know when
    the link is up).

    Because :meth:`start` does not raise, failed attempts are reported through
    :attr:`last_error` instead (see there for its lifecycle).

    ``identity`` is optional and descriptive: a bound backend credential
    (ADR-0009) fixes the ``backendId`` when it is issued, so ``name`` is only
    shown in the registry. Pass ``identity={"name": "My server"}`` to set it;
    omit it to send no identity. A legacy (unbound) backend credential still
    derives the ``backendId`` from ``(namespace, instance_id, channel)`` and
    must keep passing a stable ``instance_id`` (never a hostname, pod name or
    random value); the gateway rejects its hello without one.
    """

    def __init__(
        self,
        url: str,
        credential: str,
        namespace: str,
        identity: dict[str, Any] | None = None,
        *,
        visible: bool = True,
        capabilities: list[str] | None = None,
        backend_protocol_version: int = 1,
        exchange_enrollment: bool = True,
        heartbeat_interval_ms: int = 10_000,
        reconnect: bool = True,
        reconnect_min_ms: int = 1000,
        reconnect_max_ms: int = 30_000,
        max_message_size: int = MAX_MESSAGE_SIZE,
        open_timeout: float = 10.0,
    ) -> None:
        self._credential = credential
        self._namespace = namespace
        self._identity = normalize_identity(identity) if identity is not None else None
        self._visible = visible
        self._capabilities = list(capabilities or [])
        self._backend_protocol_version = backend_protocol_version
        self._exchange_enrollment = exchange_enrollment
        self._heartbeat_interval = heartbeat_interval_ms / 1000.0
        self._reconnect = reconnect
        self._reconnect_min = reconnect_min_ms / 1000.0
        self._reconnect_max = reconnect_max_ms / 1000.0
        self._max_message_size = max_message_size
        self._open_timeout = open_timeout

        self._ws_base = to_ws_base(url)
        self._control_url = f"{self._ws_base}/ws"
        self._token_url = f"{to_http_base(self._ws_base)}/api/backend/token"

        self._backend_id = ""
        self._epoch = 0
        self._lease_ttl_ms = 0
        self._peer_session_id = ""

        self._state: GatewayBackendState = "idle"
        self._last_error: BackendErrorInfo | None = None
        self._closed = False
        self._ws: Any = None
        self._reader_task: asyncio.Task[None] | None = None
        self._heartbeat_task: asyncio.Task[None] | None = None
        self._supervisor_task: asyncio.Task[None] | None = None
        self._start_task: asyncio.Task[None] | None = None
        self._closed_event: asyncio.Event | None = None
        self._connected_event = asyncio.Event()
        self._reconnect_attempt = 0
        # Access token exchanged from a zgb_ enrollment credential, reused
        # across reconnects until shortly before it expires: every exchange
        # rotates the enrollment's access credential on the gateway
        # (ADR-0011), so needless exchanges only churn secrets. Kept across
        # close() — the token stays valid server-side either way; a token the
        # gateway no longer accepts (rotated by another exchange, revoked) is
        # dropped on its first UNAUTHORIZED.
        self._access_token: str | None = None
        self._access_expires_at_ms: int | None = None
        self._used_connect = False
        self._used_start = False

        self._channel_handlers: dict[str, ChannelHandler] = {}
        self._default_channel_handler: ChannelHandler | None = None
        self._channels: dict[str, GatewayChannel] = {}

        self._state_handlers: list[StateHandler] = []
        self._message_handlers: list[RawMessageHandler] = []

    # --- Introspection -----------------------------------------------------

    @property
    def backend_id(self) -> str:
        """The gateway-assigned backend UUID (stable across reconnects)."""
        return self._backend_id

    @property
    def epoch(self) -> int:
        """Current lease epoch (increases on every reconnect)."""
        return self._epoch

    @property
    def state(self) -> GatewayBackendState:
        return self._state

    @property
    def last_error(self) -> BackendErrorInfo | None:
        """The most recent failed connection attempt, or ``None``.

        Read-only and immutable; see :class:`BackendErrorInfo` for the codes.
        Lifecycle:

        - **set / updated** by every failed attempt — the first handshake of
          :meth:`connect` (which also raises) or :meth:`start` (which keeps
          retrying and does not), and every reconnect attempt — so while
          ``state == "connecting"`` it describes the latest failure;
        - **cleared** when a handshake succeeds, before ``state`` becomes
          ``"connected"``, and when :meth:`start` or :meth:`connect` begins a
          fresh run (an idempotent repeat call changes nothing);
        - **kept** across a plain connection drop (a drop is not a failed
          attempt) and by :meth:`close`, which neither sets nor clears it, so
          a backend closed after failing still tells why. Attempts cancelled
          by :meth:`close` are not failures and are not recorded;
        - **set to** ``REPLACED`` when the gateway hands this backend's
          identity to a newer connection (one credential = one backend, newest
          wins). The backend then stops for good — ``state == "closed"``, no
          reconnect — because reconnecting would replace the newer one in
          turn. Call :meth:`connect` or :meth:`start` to take it back.
        """
        return self._last_error

    @property
    def lease_ttl_ms(self) -> int:
        """Lease TTL granted by the gateway (heartbeats must be more frequent)."""
        return self._lease_ttl_ms

    @property
    def peer_session_id(self) -> str:
        return self._peer_session_id

    # --- Handler registration ---------------------------------------------

    def on_state(self, handler: StateHandler) -> Callable[[], None]:
        self._state_handlers.append(handler)
        return lambda: self._state_handlers.remove(handler)

    def on_message(self, handler: RawMessageHandler) -> Callable[[], None]:
        """Raw tap on inbound control messages (e.g. the directed
        ``backend_server_message`` fallback). Messages the SDK consumes
        internally (``channel_offer``) are still delivered here."""
        self._message_handlers.append(handler)
        return lambda: self._message_handlers.remove(handler)

    def on_channel(self, kind: str, handler: ChannelHandler) -> None:
        """Register a handler for a specific channel kind (e.g. ``'rpc'``)."""
        self._channel_handlers[kind] = handler

    def on_any_channel(self, handler: ChannelHandler) -> None:
        """Fallback handler for kinds without a specific handler."""
        self._default_channel_handler = handler

    def serve_http(self, handler: Any) -> None:
        """Serve HTTP-over-channel requests (gateway ``/api/proxy``).

        The handler receives an :class:`~zclaudia_gateway.http.HttpServeRequest`
        and returns an :class:`~zclaudia_gateway.http.HttpServeResponse`
        (sync or async); the SDK does the frame plumbing
        (``docs/protocol-v4.md`` §7).

        Both directions are buffered: the handler is called once the request
        body is complete and the response goes out in one piece. For SSE or
        any other streamed response use :meth:`serve_http_stream` instead —
        both register the ``http`` channel kind, so the last call wins.
        """
        from .http import build_http_handler

        self.on_channel(CHANNEL_KIND_HTTP, build_http_handler(handler))

    def serve_http_stream(self, handler: Any) -> None:
        """Serve HTTP-over-channel requests with a streaming handler.

        The handler is an async function taking an
        :class:`~zclaudia_gateway.http.HttpExchange`; it starts as soon as the
        request head arrives, reads the body with ``read_chunk()`` /
        ``body()``, and answers with ``await start(status, headers)`` followed
        by ``await write(chunk)``. Closing the channel — which the SDK does
        when the handler returns — ends the response.

        Use instead of :meth:`serve_http`; both register the ``http`` channel
        kind, so the last call wins.
        """
        from .http import build_http_stream_handler

        self.on_channel(CHANNEL_KIND_HTTP, build_http_stream_handler(handler))

    # --- Lifecycle ---------------------------------------------------------

    async def connect(self) -> tuple[str, int]:
        """Connect and complete the handshake; returns ``(backend_id, epoch)``.

        Raises on handshake failure. After a successful connect, unexpected
        disconnects are auto-recovered in the background (unless
        ``reconnect=False``), matching the TypeScript SDK.

        Use either this or :meth:`start`, not both: ``start`` only differs in
        that it retries the first handshake in the background. A failed
        ``connect`` leaves :meth:`start` available.
        """
        if self._used_start:
            raise RuntimeError("start() was already called; use connect() or start(), not both")
        if self._ws is not None or (self._supervisor_task is not None and not self._supervisor_task.done()):
            raise RuntimeError("Already connected")
        self._closed = False
        self._closed_event = asyncio.Event()
        self._reconnect_attempt = 0
        self._last_error = None
        try:
            await self._establish()
        except Exception as exc:
            self._record_failure(exc)
            raise
        self._used_connect = True
        self._supervisor_task = asyncio.ensure_future(self._supervise())
        return self._backend_id, self._epoch

    async def start(self) -> None:
        """Connect in the background, retrying until the gateway accepts.

        Unlike :meth:`connect`, this returns immediately and never raises for
        an unreachable gateway, a refused handshake (``gateway_error``), or a
        temporarily invalid credential: the first attempt starts right away
        and failures are retried with exponential backoff between
        ``reconnect_min_ms`` and ``reconnect_max_ms``. Once connected, the
        same background supervisor as :meth:`connect` keeps the link up.

        Idempotent; pair it with :meth:`wait_connected` when something must
        happen once the link is up. Do not mix it with :meth:`connect`.
        """
        if self._used_connect:
            raise RuntimeError("connect() was already called; use start() or connect(), not both")
        if self._start_task is not None and not self._start_task.done():
            return
        if self._ws is not None or (self._supervisor_task is not None and not self._supervisor_task.done()):
            return
        self._used_start = True
        self._closed = False
        self._closed_event = asyncio.Event()
        self._reconnect_attempt = 0
        self._last_error = None
        self._start_task = asyncio.ensure_future(self._connect_until_up())

    async def wait_connected(self) -> None:
        """Wait until the backend reaches the ``connected`` state.

        Returns immediately when already connected. State changes keep being
        reported to :meth:`on_state` handlers, so this only adds a way to
        await the link without polling. A backend that is closed before ever
        connecting leaves this waiting, so cancel the waiter on shutdown.
        """
        await self._connected_event.wait()

    async def wait_closed(self) -> None:
        """Wait until the backend is fully closed.

        Set by :meth:`close`, or by a terminal disconnect when
        ``reconnect=False``.
        """
        if self._closed_event is None:
            return
        await self._closed_event.wait()

    async def close(self) -> None:
        """Close the control connection and all channels (idempotent)."""
        self._closed = True
        if self._closed_event is not None:
            self._closed_event.set()

        supervisor = self._supervisor_task
        self._supervisor_task = None
        if supervisor is not None and not supervisor.done():
            supervisor.cancel()

        starter = self._start_task
        self._start_task = None
        if starter is not None and not starter.done():
            starter.cancel()

        ws = self._ws
        if ws is not None:
            try:
                await ws.close(1000)
            except Exception:
                pass

        for task in (self._heartbeat_task, self._reader_task):
            if task is not None and not task.done():
                task.cancel()
        for task in (supervisor, starter):
            if task is not None:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
        self._heartbeat_task = None
        self._reader_task = None
        self._ws = None

        for channel in list(self._channels.values()):
            await channel.close()
        self._channels.clear()

        self._set_state("closed")

    async def __aenter__(self) -> GatewayBackend:
        await self.connect()
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        await self.close()

    # --- Sending -----------------------------------------------------------

    async def send(self, message: dict[str, Any]) -> None:
        """Send a raw control message (e.g. the directed fallback path)."""
        ws = self._ws
        if ws is None:
            raise RuntimeError("Not connected")
        try:
            await ws.send(json.dumps(message))
        except ConnectionClosed as exc:
            raise RuntimeError("Not connected") from exc

    async def publish_topic(self, topic: str, payload: Any = None, *, retain: bool = False) -> None:
        """Publish a Topic payload (the gateway fans out to subscribers).

        ``retain=True`` stores the payload as the topic's current state and
        replays it to new subscribers immediately after they subscribe.
        """
        message: dict[str, Any] = {"type": "topic_publish", "topic": topic, "payload": payload}
        if retain:
            message["retain"] = True
        await self.send(message)

    # --- Internals ---------------------------------------------------------

    def _set_state(self, state: GatewayBackendState) -> None:
        if self._state == state:
            return
        self._state = state
        if state == "connected":
            self._connected_event.set()
        else:
            self._connected_event.clear()
        for handler in list(self._state_handlers):
            invoke(handler, state)

    def _record_failure(self, exc: BaseException) -> None:
        if self._closed:  # close() owns the final value; late failures must not change it
            return
        self._last_error = _describe_failure(exc)

    async def _establish(self) -> None:
        self._set_state("connecting")
        # Resolved on every attempt, but an unexpired exchanged access token
        # is reused rather than exchanged again (see _resolve_credential).
        credential, cached = await self._resolve_credential()
        try:
            await self._handshake(credential)
        except GatewayError as exc:
            # The gateway no longer accepts the cached token (revoked, its
            # database replaced, ...): drop it and exchange afresh within this
            # attempt. A refused enrollment credential still fails the attempt.
            if not cached or exc.code != "UNAUTHORIZED":
                raise
            self._drop_access_token()
            credential, _ = await self._resolve_credential()
            await self._handshake(credential)

    async def _handshake(self, credential: str) -> None:
        ws = await ws_connect(
            self._control_url,
            max_size=self._max_message_size,
            open_timeout=self._open_timeout,
        )
        self._ws = ws
        hello: dict[str, Any] = {
            "type": "peer_hello",
            "protocolVersion": GATEWAY_PROTOCOL_V4,
            "namespace": self._namespace,
            "clientProtocolVersion": self._backend_protocol_version,
            "peerType": PEER_TYPE_CLIENT_BACKEND,
            "gatewaySecret": credential,
            "backend": {
                "visible": self._visible,
                "capabilities": self._capabilities,
                "backendProtocolVersion": self._backend_protocol_version,
            },
        }
        if self._identity is not None:
            hello["identity"] = self._identity
        try:
            await ws.send(json.dumps(hello))
            ready = await self._await_peer_ready(ws)
        except BaseException:
            self._ws = None
            try:
                await ws.close()
            except Exception:
                pass
            raise

        if ready.backend_id is None or ready.epoch is None:
            self._ws = None
            try:
                await ws.close()
            except Exception:
                pass
            raise _AttemptError("PROTOCOL_ERROR", "Gateway did not assign a backend identity")

        self._backend_id = ready.backend_id
        self._epoch = ready.epoch
        self._lease_ttl_ms = ready.lease_ttl_ms or 0
        self._peer_session_id = ready.peer_session_id
        self._reader_task = asyncio.ensure_future(self._read_control(ws))
        self._heartbeat_task = asyncio.ensure_future(self._heartbeat_loop(ws))
        self._reconnect_attempt = 0
        self._last_error = None
        self._set_state("connected")

    async def _await_peer_ready(self, ws: Any) -> PeerReady:
        async def wait() -> PeerReady:
            while True:
                raw = await ws.recv()
                if isinstance(raw, bytes):
                    continue
                try:
                    message = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(message, dict):
                    continue
                kind = message.get("type")
                if kind == "peer_ready":
                    return PeerReady.parse(message)
                if kind == "gateway_error":
                    raise GatewayError(str(message.get("code") or "UNKNOWN"), str(message.get("message") or ""))

        try:
            return await asyncio.wait_for(wait(), timeout=PeerReadyTimeout)
        except TimeoutError:
            raise _AttemptError("HANDSHAKE_TIMEOUT", "peer_ready timeout") from None

    async def _read_control(self, ws: Any) -> None:
        try:
            async for raw in ws:
                if isinstance(raw, bytes):
                    continue
                try:
                    message = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(message, dict):
                    continue
                if message.get("type") == "channel_offer":
                    try:
                        offer = ChannelOffer.parse(message)
                    except ValueError:
                        continue
                    task = asyncio.ensure_future(self._handle_offer(offer))
                    task.add_done_callback(_log_task_failure)
                tap = list(self._message_handlers)
                for handler in tap:
                    invoke(handler, message)
        except ConnectionClosed:
            pass
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("control read loop failed")

    async def _heartbeat_loop(self, ws: Any) -> None:
        try:
            while True:
                await asyncio.sleep(self._heartbeat_interval)
                await ws.send(
                    json.dumps(
                        {
                            "type": "backend_heartbeat",
                            "epoch": self._epoch,
                            "observedAt": int(time.time() * 1000),
                        }
                    )
                )
        except (ConnectionClosed, asyncio.CancelledError):
            pass
        except Exception:
            logger.debug("heartbeat loop stopped", exc_info=True)

    async def _supervise(self) -> None:
        """Own the connection lifecycle: wait for a drop, then reconnect."""
        while True:
            ws = self._ws
            reader = self._reader_task
            if reader is not None:
                try:
                    await reader
                except asyncio.CancelledError:
                    raise
            self._teardown_connection()
            if not self._closed and getattr(ws, "close_code", None) == GATEWAY_CLOSE_BACKEND_REPLACED:
                # Replaced, not dropped: stand down rather than replace the newer one back.
                self._last_error = BackendErrorInfo(
                    code="REPLACED", message=_ERROR_MESSAGES["REPLACED"], occurred_at=time.time()
                )
                logger.warning("backend %s was replaced by a newer connection; not reconnecting", self._backend_id)
                self._set_state("closed")
                if self._closed_event is not None:
                    self._closed_event.set()
                return
            if self._closed or not self._reconnect:
                self._set_state("closed")
                if self._closed_event is not None:
                    self._closed_event.set()
                return
            self._set_state("connecting")
            while True:
                if self._closed:
                    self._set_state("closed")
                    if self._closed_event is not None:
                        self._closed_event.set()
                    return
                try:
                    await self._establish()
                    break
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self._record_failure(exc)
                    logger.warning("reconnect attempt failed: %s", exc)
                    await asyncio.sleep(self._next_backoff())

    async def _connect_until_up(self) -> None:
        """Backing loop of :meth:`start`: retry the first connect forever.

        Nothing here raises for a failed attempt — the application is allowed
        to run while the gateway is unreachable — and the SDK's supervisor
        takes over from the moment a handshake succeeds.
        """
        while True:
            if self._closed:
                return
            try:
                await self._establish()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._record_failure(exc)
                logger.warning("connect attempt failed: %s", exc)
                await asyncio.sleep(self._next_backoff())
                continue
            if self._closed:  # closed while the handshake completed
                return
            self._supervisor_task = asyncio.ensure_future(self._supervise())
            return

    def _teardown_connection(self) -> None:
        heartbeat = self._heartbeat_task
        if heartbeat is not None and not heartbeat.done():
            heartbeat.cancel()
        self._heartbeat_task = None
        self._reader_task = None
        self._ws = None

    def _next_backoff(self) -> float:
        delay = min(self._reconnect_min * (2**self._reconnect_attempt), self._reconnect_max)
        self._reconnect_attempt += 1
        return delay

    async def _handle_offer(self, offer: ChannelOffer) -> None:
        if self._closed:
            return
        handler: ChannelHandler | None = None
        if offer.kind:
            handler = self._channel_handlers.get(offer.kind)
        if handler is None:
            handler = self._default_channel_handler
        if handler is None:
            await self._reject(offer.channel_id, "no_handler")
            return
        try:
            channel = await dial_channel(
                self._ws_base,
                offer.data_path,
                offer.ticket,
                offer.channel_id,
                offer.kind,
                max_message_size=self._max_message_size,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("channel dial failed")
            await self._reject(offer.channel_id, "dial_failed")
            return
        self._channels[offer.channel_id] = channel
        channel.on_close(lambda: self._channels.pop(offer.channel_id, None))
        try:
            info = ChannelOfferInfo(
                channel_id=offer.channel_id,
                kind=offer.kind,
                source_peer_session_id=offer.source_peer_session_id,
            )
            invoke(handler, channel, info)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("channel handler failed")
            await channel.close()
            await self._reject(offer.channel_id, "dial_failed")

    async def _reject(self, channel_id: str, reason: str) -> None:
        try:
            await self.send({"type": "channel_reject", "channelId": channel_id, "reason": reason})
        except RuntimeError:
            pass

    async def _resolve_credential(self) -> tuple[str, bool]:
        """The credential for the next handshake, and whether it came from the cache."""
        if not self._exchange_enrollment or not self._credential.startswith("zgb_"):
            return self._credential, False
        if self._access_token is not None and self._access_token_fresh():
            return self._access_token, True
        self._drop_access_token()
        body = await asyncio.to_thread(self._exchange_enrollment_blocking)
        data = body.get("data") or {}
        token = data.get("token")
        if not token:
            raise _AttemptError("PROTOCOL_ERROR", "Enrollment exchange returned no token")
        expires_at = data.get("expiresAt")
        self._access_token = str(token)
        self._access_expires_at_ms = int(expires_at) if isinstance(expires_at, (int, float)) else None
        return self._access_token, False

    def _access_token_fresh(self) -> bool:
        if self._access_expires_at_ms is None:
            return True
        return time.time() * 1000 < self._access_expires_at_ms - ACCESS_TOKEN_REFRESH_MARGIN_MS

    def _drop_access_token(self) -> None:
        self._access_token = None
        self._access_expires_at_ms = None

    def _exchange_enrollment_blocking(self) -> dict[str, Any]:
        request = urllib.request.Request(
            self._token_url,
            method="POST",
            headers={"Authorization": f"Bearer {self._credential}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                parsed = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            exc.close()  # the error object owns the response socket; don't wait for the GC
            code: BackendErrorCode = "AUTH_FAILED" if exc.code in (401, 403) else "GATEWAY_UNREACHABLE"
            raise _AttemptError(code, f"Enrollment exchange failed: HTTP {exc.code}") from exc
        if not isinstance(parsed, dict):
            raise _AttemptError("PROTOCOL_ERROR", "Enrollment exchange returned a non-object body")
        return parsed
