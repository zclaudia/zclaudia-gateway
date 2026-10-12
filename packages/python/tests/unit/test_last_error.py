"""Unit tests for ``GatewayBackend.last_error`` (why the latest attempt failed)."""

from __future__ import annotations

import asyncio
import dataclasses
from collections.abc import Callable

import pytest
from fake_gateway import FakeGateway, until
from test_start import closed_port_url

import zclaudia_gateway.backend as backend_module
from zclaudia_gateway import BackendErrorInfo, GatewayBackend, GatewayError

SECRET = "zgb_SUPER-secret-credential"


def text_of(error: BackendErrorInfo | None) -> str:
    """Everything a caller could read off the error, for leak checks."""
    assert error is not None
    return repr(error) + str(dataclasses.asdict(error))


async def test_last_error_is_none_before_any_attempt(backends: Callable[..., GatewayBackend]) -> None:
    backend = backends("ws://127.0.0.1:1")
    assert backend.last_error is None


async def test_start_reports_a_refused_credential(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    gateway.reject_hello = ("UNAUTHORIZED", "bad credential")
    backend = backends(gateway.url)

    await backend.start()  # still returns normally ...
    await until(lambda: backend.last_error is not None)

    assert backend.state == "connecting"  # ... and keeps retrying
    error = backend.last_error
    assert error is not None
    assert error.code == "AUTH_FAILED"
    assert error.gateway_code == "UNAUTHORIZED"
    assert error.message
    assert error.occurred_at > 0


async def test_start_reports_an_unreachable_gateway(backends: Callable[..., GatewayBackend]) -> None:
    backend = backends(closed_port_url())
    await backend.start()
    await until(lambda: backend.last_error is not None)

    assert backend.state == "connecting"
    assert backend.last_error is not None
    assert backend.last_error.code == "GATEWAY_UNREACHABLE"
    assert backend.last_error.gateway_code is None


async def test_other_handshake_refusals_are_gateway_rejected(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    gateway.reject_hello = ("PROTOCOL_VERSION_MISMATCH", "client too old")
    backend = backends(gateway.url)
    await backend.start()
    await until(lambda: backend.last_error is not None)

    assert backend.last_error is not None
    assert backend.last_error.code == "GATEWAY_REJECTED"
    assert backend.last_error.gateway_code == "PROTOCOL_VERSION_MISMATCH"
    assert "PROTOCOL_VERSION_MISMATCH" in backend.last_error.message


async def test_an_unknown_gateway_code_is_not_passed_through(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    gateway.reject_hello = (f"NEW_CODE_{SECRET}", "whatever")
    backend = backends(gateway.url)
    await backend.start()
    await until(lambda: backend.last_error is not None)

    assert backend.last_error is not None
    assert backend.last_error.code == "GATEWAY_REJECTED"
    assert backend.last_error.gateway_code is None
    assert SECRET not in text_of(backend.last_error)


async def test_connection_dropped_during_the_handshake(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    gateway.drop_on_hello = True
    backend = backends(gateway.url)
    await backend.start()
    await until(lambda: backend.last_error is not None)

    assert backend.last_error is not None
    assert backend.last_error.code == "GATEWAY_UNREACHABLE"


async def test_missing_peer_ready_is_a_handshake_timeout(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(backend_module, "PeerReadyTimeout", 0.1)
    gateway.silent_hello = True
    backend = backends(gateway.url)
    await backend.start()
    await until(lambda: backend.last_error is not None)

    assert backend.last_error is not None
    assert backend.last_error.code == "HANDSHAKE_TIMEOUT"


async def test_enrollment_exchange_401_is_auth_failed(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    gateway.reject_exchange = True
    backend = backends(gateway.url, credential=SECRET, exchange_enrollment=True)
    await backend.start()
    await until(lambda: backend.last_error is not None)

    assert backend.last_error is not None
    assert backend.last_error.code == "AUTH_FAILED"
    assert gateway.hellos == []  # never got as far as the websocket handshake
    assert SECRET not in text_of(backend.last_error)


async def test_last_error_follows_the_latest_failure(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    gateway.reject_hello = ("UNAUTHORIZED", "bad credential")
    backend = backends(gateway.url)
    await backend.start()
    await until(lambda: backend.last_error is not None)
    first = backend.last_error
    assert first is not None and first.code == "AUTH_FAILED"

    gateway.reject_hello = ("RATE_LIMITED", "slow down")
    await until(lambda: backend.last_error is not None and backend.last_error.code == "GATEWAY_REJECTED")
    second = backend.last_error
    assert second is not None
    assert second.gateway_code == "RATE_LIMITED"
    assert second.occurred_at >= first.occurred_at
    assert backend.state == "connecting"

    # Repeated identical failures still refresh the record.
    await until(lambda: backend.last_error is not second)
    assert backend.last_error is not None and backend.last_error.code == "GATEWAY_REJECTED"


async def test_success_clears_last_error(gateway: FakeGateway, backends: Callable[..., GatewayBackend]) -> None:
    gateway.reject_hello = ("UNAUTHORIZED", "not yet")
    backend = backends(gateway.url)
    seen: list[tuple[str, bool]] = []
    backend.on_state(lambda state: seen.append((state, backend.last_error is None)))

    await backend.start()
    await until(lambda: backend.last_error is not None)

    gateway.reject_hello = None
    await asyncio.wait_for(backend.wait_connected(), 5)
    assert backend.state == "connected"
    assert backend.last_error is None
    assert ("connected", True) in seen  # already clear when "connected" is announced


async def test_a_drop_alone_is_not_an_error_and_a_failed_reconnect_is(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    backend = backends(gateway.url)
    await backend.start()
    await asyncio.wait_for(backend.wait_connected(), 5)

    gateway.reject_hello = ("UNAUTHORIZED", "credential revoked")
    await gateway.drop_control()
    await until(lambda: backend.last_error is not None)
    assert backend.last_error is not None and backend.last_error.code == "AUTH_FAILED"
    assert backend.state == "connecting"

    gateway.reject_hello = None
    await asyncio.wait_for(backend.wait_connected(), 5)
    assert backend.last_error is None


async def test_a_plain_drop_leaves_last_error_empty(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    backend = backends(gateway.url)
    await backend.connect()
    await gateway.drop_control()
    await until(lambda: gateway.connection_count >= 2 and backend.state == "connected")
    assert backend.last_error is None


async def test_connect_raises_and_records_the_same_error(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    gateway.reject_hello = ("UNAUTHORIZED", "bad credential")
    backend = backends(gateway.url)
    with pytest.raises(GatewayError):  # the raised type is unchanged
        await backend.connect()

    assert backend.last_error is not None
    assert backend.last_error.code == "AUTH_FAILED"

    gateway.reject_hello = None
    await backend.start()  # a fresh run starts with a clean slate
    await asyncio.wait_for(backend.wait_connected(), 5)
    assert backend.last_error is None


async def test_enrollment_failures_keep_their_runtime_error_type(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    gateway.reject_exchange = True
    backend = backends(gateway.url, exchange_enrollment=True)
    with pytest.raises(RuntimeError, match="Enrollment exchange failed: HTTP 401"):
        await backend.connect()
    assert backend.last_error is not None and backend.last_error.code == "AUTH_FAILED"


async def test_close_keeps_the_last_failure(gateway: FakeGateway, backends: Callable[..., GatewayBackend]) -> None:
    gateway.reject_hello = ("UNAUTHORIZED", "bad credential")
    backend = backends(gateway.url)
    await backend.start()
    await until(lambda: backend.last_error is not None)
    before = backend.last_error

    await backend.close()
    assert backend.state == "closed"
    assert backend.last_error is before
    attempts = len(gateway.hellos)
    await asyncio.sleep(0.2)
    assert len(gateway.hellos) == attempts
    assert backend.last_error is before  # nothing is recorded after close()

    await backend.close()  # idempotent
    assert backend.last_error is before


async def test_close_after_success_leaves_it_empty(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    backend = backends(gateway.url)
    await backend.start()
    await asyncio.wait_for(backend.wait_connected(), 5)
    await backend.close()
    assert backend.last_error is None


async def test_restart_after_close_resets_a_stale_error(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    gateway.reject_hello = ("UNAUTHORIZED", "bad credential")
    backend = backends(gateway.url)
    await backend.start()
    await until(lambda: backend.last_error is not None)
    await backend.close()
    assert backend.last_error is not None

    gateway.silent_hello = True  # the new run hangs, so neither success nor failure lands yet
    await backend.start()
    assert backend.last_error is None
    await until(lambda: len(gateway.hellos) >= 2)  # the new run's handshake is in flight
    assert backend.state == "connecting"
    assert backend.last_error is None


async def test_repeated_start_does_not_reset_the_error(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    gateway.reject_hello = ("UNAUTHORIZED", "bad credential")
    backend = backends(gateway.url, reconnect_min_ms=5000, reconnect_max_ms=5000)
    await backend.start()
    await until(lambda: backend.last_error is not None)
    recorded = backend.last_error

    await backend.start()  # idempotent no-op
    assert backend.last_error is recorded


async def test_start_connect_exclusion_does_not_touch_last_error(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    gateway.reject_hello = ("UNAUTHORIZED", "bad credential")
    backend = backends(gateway.url, reconnect_min_ms=5000, reconnect_max_ms=5000)
    await backend.start()
    await until(lambda: backend.last_error is not None)
    recorded = backend.last_error

    with pytest.raises(RuntimeError, match=r"connect\(\) or start\(\)"):
        await backend.connect()
    assert backend.last_error is recorded


async def test_last_error_is_read_only_and_immutable(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    gateway.reject_hello = ("UNAUTHORIZED", "bad credential")
    backend = backends(gateway.url)
    await backend.start()
    await until(lambda: backend.last_error is not None)

    with pytest.raises(AttributeError):
        backend.last_error = None  # type: ignore[misc]
    error = backend.last_error
    assert error is not None
    with pytest.raises(dataclasses.FrozenInstanceError):
        error.code = "CONNECT_FAILED"  # type: ignore[misc]


async def test_error_text_does_not_leak_credentials_or_raw_exceptions(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend], caplog: pytest.LogCaptureFixture
) -> None:
    # The gateway echoes the credential back in its message — as would a
    # careless reverse proxy or exception string.
    gateway.reject_hello = ("UNAUTHORIZED", f"Bearer {SECRET} rejected for user:hunter2@host")
    backend = backends(gateway.url, credential=SECRET)
    await backend.start()
    await until(lambda: backend.last_error is not None)
    assert SECRET not in text_of(backend.last_error)
    assert "hunter2" not in text_of(backend.last_error)
    await backend.close()

    # An unreachable URL with embedded userinfo must not surface either.
    url = closed_port_url().replace("ws://", "ws://admin:hunter2@")
    unreachable = backends(url, credential=SECRET)
    await unreachable.start()
    await until(lambda: unreachable.last_error is not None)
    assert unreachable.last_error is not None
    assert unreachable.last_error.code == "GATEWAY_UNREACHABLE"
    for leaked in (SECRET, "hunter2", "admin", "127.0.0.1", "Errno"):
        assert leaked not in text_of(unreachable.last_error)
