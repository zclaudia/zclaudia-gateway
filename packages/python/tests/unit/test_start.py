"""Unit tests for the background first-connect lifecycle (``start``)."""

from __future__ import annotations

import asyncio
import socket
from collections.abc import Callable

import pytest
from fake_gateway import BACKEND_ID, FakeGateway, until

from zclaudia_gateway import GatewayBackend, GatewayError


def closed_port_url() -> str:
    """A ws:// URL nothing listens on (the port is bound and released again)."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    return f"ws://127.0.0.1:{port}"


async def test_start_retries_until_the_gateway_accepts(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    gateway.reject_hello = ("UNAUTHORIZED", "not yet")
    backend = backends(gateway.url)

    await backend.start()  # must not raise although every handshake is refused
    await until(lambda: len(gateway.hellos) >= 3)
    assert backend.state != "connected"

    gateway.reject_hello = None
    await asyncio.wait_for(backend.wait_connected(), 5)
    assert backend.state == "connected"
    assert backend.backend_id == BACKEND_ID


async def test_start_does_not_raise_for_an_unreachable_gateway(
    backends: Callable[..., GatewayBackend],
) -> None:
    backend = backends(closed_port_url())
    await backend.start()
    await asyncio.sleep(0.2)
    assert backend.state == "connecting"

    await backend.close()
    assert backend.state == "closed"
    await asyncio.wait_for(backend.wait_closed(), 1)


async def test_start_is_idempotent(gateway: FakeGateway, backends: Callable[..., GatewayBackend]) -> None:
    backend = backends(gateway.url)
    await backend.start()
    await backend.start()
    await backend.start()

    await asyncio.wait_for(backend.wait_connected(), 5)
    await asyncio.sleep(0.2)
    assert gateway.connection_count == 1  # no second supervisor, no second handshake


async def test_wait_connected_returns_at_once_when_connected(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    backend = backends(gateway.url)
    await backend.connect()
    await asyncio.wait_for(backend.wait_connected(), 0.5)


async def test_close_cancels_the_background_connect(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    gateway.reject_hello = ("UNAUTHORIZED", "nope")
    backend = backends(gateway.url)
    await backend.start()
    await until(lambda: len(gateway.hellos) >= 2)

    await backend.close()
    assert backend.state == "closed"
    await asyncio.wait_for(backend.wait_closed(), 1)

    attempts = len(gateway.hellos)
    await asyncio.sleep(0.3)  # the retry loop would have fired several times by now
    assert len(gateway.hellos) == attempts


async def test_start_after_close_connects_again(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    backend = backends(gateway.url)
    await backend.start()
    await asyncio.wait_for(backend.wait_connected(), 5)
    await backend.close()

    await backend.start()
    await asyncio.wait_for(backend.wait_connected(), 5)
    assert gateway.connection_count == 2


async def test_mixing_start_and_connect_is_rejected(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    started = backends(gateway.url)
    await started.start()
    with pytest.raises(RuntimeError, match=r"connect\(\) or start\(\)"):
        await started.connect()
    await asyncio.wait_for(started.wait_connected(), 5)

    connected = backends(gateway.url)
    await connected.connect()
    with pytest.raises(RuntimeError, match=r"start\(\) or connect\(\)"):
        await connected.start()


async def test_a_failed_connect_leaves_start_available(
    gateway: FakeGateway, backends: Callable[..., GatewayBackend]
) -> None:
    gateway.reject_hello = ("UNAUTHORIZED", "bad credential")
    backend = backends(gateway.url)
    with pytest.raises(GatewayError):
        await backend.connect()

    gateway.reject_hello = None
    await backend.start()  # nothing was left running by the failed connect
    await asyncio.wait_for(backend.wait_connected(), 5)
    assert backend.state == "connected"
