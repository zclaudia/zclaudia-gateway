"""Unit tests for GatewayBackend against an in-process fake gateway."""

from __future__ import annotations

import asyncio
import json

import pytest
from fake_gateway import BACKEND_ID, FakeGateway, until

from zclaudia_gateway import GatewayBackend, GatewayError


@pytest.fixture
async def gateway():
    gw = FakeGateway()
    await gw.start()
    try:
        yield gw
    finally:
        await gw.stop()


@pytest.fixture
async def make_gateway():
    created = []

    async def make(**kwargs):
        gw = FakeGateway(**kwargs)
        await gw.start()
        created.append(gw)
        return gw

    yield make
    for gw in created:
        await gw.stop()


@pytest.fixture
async def backends():
    created = []

    def make(url, **kwargs):
        kwargs.setdefault("credential", "zgb_test")
        kwargs.setdefault("namespace", "test-ns")
        kwargs.setdefault("identity", {"device_id": "dev-1", "instance_id": "inst-1"})
        kwargs.setdefault("exchange_enrollment", False)
        kwargs.setdefault("heartbeat_interval_ms", 100)
        kwargs.setdefault("reconnect_min_ms", 50)
        kwargs.setdefault("reconnect_max_ms", 200)
        backend = GatewayBackend(url=url, **kwargs)
        created.append(backend)
        return backend

    yield make
    for backend in created:
        await backend.close()


async def test_connect_sends_hello_and_returns_identity(gateway, backends):
    backend = backends(gateway.url)
    backend_id, epoch = await backend.connect()

    assert backend_id == BACKEND_ID
    assert epoch == 1
    assert backend.state == "connected"
    assert backend.lease_ttl_ms == 30_000

    hello = gateway.hellos[0]
    assert hello["type"] == "peer_hello"
    assert hello["protocolVersion"] == 4
    assert hello["namespace"] == "test-ns"
    assert hello["peerType"] == "client+backend"
    assert hello["gatewaySecret"] == "zgb_test"
    assert hello["identity"] == {"deviceId": "dev-1", "instanceId": "inst-1"}
    assert hello["backend"] == {"visible": True, "capabilities": [], "backendProtocolVersion": 1}


async def test_connect_options_are_carried(gateway, backends):
    backend = backends(
        gateway.url,
        identity={"device_id": "dev-1", "instance_id": "inst-1", "name": "srv", "channel": "staging"},
        visible=False,
        capabilities=["rpc", "http"],
        backend_protocol_version=7,
    )
    await backend.connect()
    hello = gateway.hellos[0]
    assert hello["identity"] == {"deviceId": "dev-1", "instanceId": "inst-1", "name": "srv", "channel": "staging"}
    assert hello["backend"] == {"visible": False, "capabilities": ["rpc", "http"], "backendProtocolVersion": 7}
    assert hello["clientProtocolVersion"] == 7


async def test_identity_omitted_sends_no_identity(gateway, backends):
    # Bound credential (ADR-0008): the credential grants the backendId, so
    # url/credential/namespace are enough and the hello carries no identity.
    backend = backends(gateway.url, identity=None)
    backend_id, _ = await backend.connect()
    assert backend_id == BACKEND_ID
    assert "identity" not in gateway.hellos[0]


async def test_identity_defaults_to_omitted(gateway):
    backend = GatewayBackend(url=gateway.url, credential="zgb_x", namespace="ns", exchange_enrollment=False)
    try:
        await backend.connect()
        assert "identity" not in gateway.hellos[0]
    finally:
        await backend.close()


async def test_partial_identity_sends_only_provided_keys(gateway, backends):
    backend = backends(gateway.url, identity={"name": "srv"})
    await backend.connect()
    assert gateway.hellos[0]["identity"] == {"name": "srv"}


async def test_gateway_error_fails_connect(make_gateway, backends):
    gw = await make_gateway(reject_hello=("UNAUTHORIZED", "bad credential"))
    backend = backends(gw.url)
    with pytest.raises(GatewayError) as excinfo:
        await backend.connect()
    assert excinfo.value.code == "UNAUTHORIZED"
    assert backend.state in ("connecting", "closed")


async def test_heartbeat_carries_epoch(gateway, backends):
    backend = backends(gateway.url)
    _, epoch = await backend.connect()
    await until(lambda: len(gateway.heartbeats) >= 2)
    assert all(hb["type"] == "backend_heartbeat" and hb["epoch"] == epoch for hb in gateway.heartbeats)
    assert isinstance(gateway.heartbeats[0]["observedAt"], int)


async def test_channel_offer_echo_text_and_binary(gateway, backends):
    backend = backends(gateway.url)
    received = []

    async def echo(channel, info):
        assert info.kind == "echo"
        assert info.source_peer_session_id == "peer-1"
        received.append(info)
        async for data in channel:
            await channel.send(data)

    backend.on_channel("echo", echo)
    await backend.connect()

    seen = []
    done = asyncio.Event()

    async def on_connection(ws):
        await ws.send("hello")
        await ws.send(b"\x00\x01\xfe\xff")
        count = 0
        async for data in ws:
            seen.append(data)
            count += 1
            if count == 2:
                done.set()
                break

    await gateway.offer_channel(kind="echo", on_connection=on_connection)
    await asyncio.wait_for(done.wait(), 5)

    assert seen[0] == "hello"
    assert seen[1] == b"\x00\x01\xfe\xff"
    assert len(received) == 1


async def test_unhandled_kind_is_rejected(gateway, backends):
    backend = backends(gateway.url)
    await backend.connect()
    await gateway.offer_channel(kind="unknown-kind")
    await until(lambda: len(gateway.channel_rejects) >= 1)
    reject = gateway.channel_rejects[0]
    assert reject["channelId"] == "ch-1"
    assert reject["reason"] == "no_handler"


async def test_on_any_channel_handles_unknown_kinds(gateway, backends):
    backend = backends(gateway.url)
    kinds = []

    async def handle(channel, info):
        kinds.append(info.kind)
        await channel.close()

    backend.on_any_channel(handle)
    await backend.connect()

    done = asyncio.Event()

    async def on_connection(ws):
        await ws.send("ping")
        async for _ in ws:
            pass
        done.set()

    await gateway.offer_channel(kind="anything", on_connection=on_connection)
    await until(lambda: kinds == ["anything"])
    await until(lambda: done.is_set())


async def test_raw_message_tap_and_send(gateway, backends):
    backend = backends(gateway.url)
    seen = []
    backend.on_message(seen.append)
    await backend.connect()

    await gateway.send_control({"type": "registry_snapshot", "items": []})
    await until(lambda: any(m["type"] == "registry_snapshot" for m in seen))

    await backend.send({"type": "backend_server_message", "backendId": BACKEND_ID, "message": "hi"})
    await until(lambda: len(gateway.topic_publishes) == 0)  # no crash; nothing routed


async def test_publish_topic_retain_flag(gateway, backends):
    backend = backends(gateway.url)
    await backend.connect()

    await backend.publish_topic("resources", {"rev": 1}, retain=True)
    await backend.publish_topic("events", "plain")
    await until(lambda: len(gateway.topic_publishes) >= 2)

    assert gateway.topic_publishes[0] == {
        "type": "topic_publish",
        "topic": "resources",
        "payload": {"rev": 1},
        "retain": True,
    }
    assert gateway.topic_publishes[1] == {"type": "topic_publish", "topic": "events", "payload": "plain"}


async def test_reconnect_gets_fresh_epoch_and_stable_id(gateway, backends):
    backend = backends(gateway.url)
    states = []
    backend.on_state(states.append)

    backend_id, epoch1 = await backend.connect()
    await gateway.drop_control(4000)
    await until(lambda: backend.state == "connected" and backend.epoch > epoch1, timeout=10)

    assert backend.backend_id == backend_id
    assert gateway.connection_count >= 2
    assert "connecting" in states

    # Channels work on the new epoch.
    backend.on_channel("post-rc", lambda channel, info: None)
    await gateway.offer_channel(kind="post-rc", channel_id="ch-after")
    await gateway.wait_for_data_connection("ch-after")


async def test_reconnect_disabled_closes_on_drop(gateway, backends):
    backend = backends(gateway.url, reconnect=False)
    await backend.connect()
    await gateway.drop_control(4000)
    await asyncio.wait_for(backend.wait_closed(), 5)
    assert backend.state == "closed"


async def test_close_is_terminal_and_idempotent(gateway, backends):
    backend = backends(gateway.url)
    await backend.connect()
    await backend.close()
    await backend.close()
    assert backend.state == "closed"
    await asyncio.wait_for(backend.wait_closed(), 1)
    with pytest.raises(RuntimeError):
        await backend.send({"type": "ping"})


async def test_enrollment_credential_is_exchanged(make_gateway, backends):
    gw = await make_gateway()
    backend = backends(gw.url, exchange_enrollment=True)
    await backend.connect()

    assert gw.token_requests[0]["authorization"] == "Bearer zgb_test"
    assert gw.hellos[0]["gatewaySecret"] == "zga_exchanged"


async def test_enrollment_exchange_failure_raises(make_gateway, backends):
    gw = await make_gateway(reject_exchange=True)
    backend = backends(gw.url, exchange_enrollment=True)
    with pytest.raises(RuntimeError, match="HTTP 401"):
        await backend.connect()


async def test_async_context_manager(gateway, backends):
    backend = backends(gateway.url)
    async with backend as connected:
        assert connected is backend
        assert backend.state == "connected"
    assert backend.state == "closed"


async def test_channel_close_propagates(gateway, backends):
    backend = backends(gateway.url)
    closed = asyncio.Event()

    async def handler(channel, info):
        channel.on_close(closed.set)

    backend.on_channel("live", handler)
    await backend.connect()

    async def on_connection(ws):
        await asyncio.sleep(5)

    await gateway.offer_channel(kind="live", on_connection=on_connection)
    data_ws = await gateway.wait_for_data_connection("ch-1")
    await data_ws.close(1000)
    await asyncio.wait_for(closed.wait(), 5)


async def test_offered_channels_are_closed_with_backend(gateway, backends):
    backend = backends(gateway.url)
    backend.on_channel("live", lambda channel, info: None)
    await backend.connect()
    await gateway.offer_channel(kind="live")
    data_ws = await gateway.wait_for_data_connection("ch-1")
    await backend.close()
    await until(lambda: data_ws.close_code is not None, timeout=5)


async def test_json_roundtrip_of_control_messages(gateway, backends):
    """Messages on the control plane are JSON text frames."""
    backend = backends(gateway.url)
    await backend.connect()
    await backend.publish_topic("t", {"nested": [1, 2, {"x": None}]})
    await until(lambda: len(gateway.topic_publishes) == 1)
    assert gateway.topic_publishes[0]["payload"] == {"nested": [1, 2, {"x": None}]}
    assert json.dumps(gateway.topic_publishes[0])  # serializable
