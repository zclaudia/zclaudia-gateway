"""Shared unit-test fixtures: an in-process fake gateway and a backend.

``tests/unit/test_http.py`` and ``tests/unit/test_backend.py`` keep their own
copies; the fixtures here are for the streaming, ASGI and lifecycle suites.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from typing import Any

import pytest
from fake_gateway import FakeGateway

from zclaudia_gateway import GatewayBackend


@pytest.fixture
async def gateway() -> AsyncIterator[FakeGateway]:
    gw = FakeGateway()
    await gw.start()
    try:
        yield gw
    finally:
        await gw.stop()


@pytest.fixture
async def backend(gateway: FakeGateway) -> AsyncIterator[GatewayBackend]:
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


@pytest.fixture
async def backends() -> AsyncIterator[Callable[..., GatewayBackend]]:
    """Factory for backends with test-friendly backoff, closed on teardown."""
    created: list[GatewayBackend] = []

    def make(url: str, **kwargs: Any) -> GatewayBackend:
        kwargs.setdefault("credential", "zgb_test")
        kwargs.setdefault("namespace", "test-ns")
        kwargs.setdefault("identity", {"device_id": "dev-1", "instance_id": "inst-1"})
        kwargs.setdefault("exchange_enrollment", False)
        kwargs.setdefault("heartbeat_interval_ms", 100)
        kwargs.setdefault("reconnect_min_ms", 20)
        kwargs.setdefault("reconnect_max_ms", 50)
        backend = GatewayBackend(url=url, **kwargs)
        created.append(backend)
        return backend

    yield make
    for backend in created:
        await backend.close()
