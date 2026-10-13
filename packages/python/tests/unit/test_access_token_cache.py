"""Exchanged access tokens are cached and reused across reconnects.

Every POST /api/backend/token mints a new backend-access credential on the
gateway, so a backend that exchanged on every reconnect filled the
credential list with ``access:<name>`` rows.
"""

from __future__ import annotations

from collections.abc import Callable

from fake_gateway import FakeGateway, until

from zclaudia_gateway import GatewayBackend

ENROLLMENT = "zgb_enrollment"


def make(backends: Callable[..., GatewayBackend], gateway: FakeGateway) -> GatewayBackend:
    return backends(gateway.url, credential=ENROLLMENT, exchange_enrollment=True)


async def reconnect(gateway: FakeGateway, backend: GatewayBackend) -> None:
    connections = gateway.connection_count
    await gateway.drop_control()
    await until(lambda: gateway.connection_count > connections and backend.state == "connected")


def secrets_presented(gateway: FakeGateway) -> list[str]:
    return [hello["gatewaySecret"] for hello in gateway.hellos]


async def test_reconnects_reuse_an_unexpired_access_token(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    gateway.exchange_ttl_ms = 24 * 60 * 60 * 1000
    backend = make(backends, gateway)
    await backend.connect()
    for _ in range(3):
        await reconnect(gateway, backend)

    assert len(gateway.token_requests) == 1  # one exchange for four connections
    assert secrets_presented(gateway) == ["zga_exchanged"] * 4


async def test_a_token_never_expiring_is_reused_too(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    gateway.exchange_ttl_ms = None
    backend = make(backends, gateway)
    await backend.connect()
    await reconnect(gateway, backend)
    assert len(gateway.token_requests) == 1


async def test_a_token_inside_the_safety_margin_is_exchanged_again(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    gateway.exchange_ttl_ms = 30_000  # expires within the 60 s margin
    backend = make(backends, gateway)
    await backend.connect()
    await reconnect(gateway, backend)
    await reconnect(gateway, backend)
    assert len(gateway.token_requests) == 3


async def test_a_rejected_cached_token_is_replaced_within_the_same_attempt(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    backend = make(backends, gateway)
    await backend.connect()

    # The gateway stops accepting the cached token; the enrollment is still good
    gateway.revoked_tokens.add("zga_exchanged")
    gateway.exchange_token = "zga_fresh"
    await reconnect(gateway, backend)

    assert secrets_presented(gateway)[-2:] == ["zga_exchanged", "zga_fresh"]
    assert len(gateway.token_requests) == 2
    assert backend.last_error is None  # recovered silently, not reported as AUTH_FAILED

    await reconnect(gateway, backend)  # and the fresh token is cached in turn
    assert len(gateway.token_requests) == 2


async def test_a_revoked_enrollment_still_fails_with_auth_failed(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    backend = make(backends, gateway)
    await backend.connect()

    gateway.revoked_tokens.add("zga_exchanged")
    gateway.reject_exchange = True  # the parent credential is revoked as well
    await gateway.drop_control()
    await until(lambda: backend.last_error is not None)

    assert backend.last_error is not None and backend.last_error.code == "AUTH_FAILED"
    assert backend.state == "connecting"


async def test_close_keeps_the_cached_token_for_a_later_connect(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    backend = make(backends, gateway)
    await backend.connect()
    await backend.close()
    await backend.connect()
    assert backend.state == "connected"
    assert len(gateway.token_requests) == 1


async def test_without_exchange_the_enrollment_token_is_presented_directly(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    backend = backends(gateway.url, credential=ENROLLMENT, exchange_enrollment=False)
    await backend.connect()
    await reconnect(gateway, backend)
    assert gateway.token_requests == []
    assert secrets_presented(gateway) == [ENROLLMENT, ENROLLMENT]
