"""Unit tests for protocol models and URL/identity helpers."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as distribution_version

import pytest

import zclaudia_gateway
from zclaudia_gateway import GATEWAY_PROTOCOL_V4, ChannelOffer, PeerReady
from zclaudia_gateway.channel import to_http_base, to_ws_base
from zclaudia_gateway.protocol import GatewayError, normalize_identity


def test_version_matches_installed_metadata():
    """__version__ derives from package metadata, so a version override at
    build time (publish workflow) stays consistent with the wheel."""
    try:
        installed = distribution_version("zclaudia-gateway")
    except PackageNotFoundError:
        pytest.skip("package is not installed as a distribution")
    assert zclaudia_gateway.__version__ == installed


def test_protocol_version_constant():
    assert GATEWAY_PROTOCOL_V4 == 4


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://gateway.example.com", "wss://gateway.example.com"),
        ("http://127.0.0.1:3200", "ws://127.0.0.1:3200"),
        ("wss://gateway.example.com/ws", "wss://gateway.example.com"),
        ("ws://127.0.0.1:3200/some/path", "ws://127.0.0.1:3200"),
        ("127.0.0.1:3200", "ws://127.0.0.1:3200"),
    ],
)
def test_to_ws_base(url, expected):
    assert to_ws_base(url) == expected


@pytest.mark.parametrize(
    ("ws_base", "expected"),
    [
        ("ws://127.0.0.1:3200", "http://127.0.0.1:3200"),
        ("wss://gateway.example.com", "https://gateway.example.com"),
    ],
)
def test_to_http_base(ws_base, expected):
    assert to_http_base(ws_base) == expected


def test_normalize_identity_snake_and_wire_keys():
    assert normalize_identity({"device_id": "d", "instance_id": "i"}) == {"deviceId": "d", "instanceId": "i"}
    assert normalize_identity({"deviceId": "d", "instanceId": "i", "name": "n"}) == {
        "deviceId": "d",
        "instanceId": "i",
        "name": "n",
    }
    assert normalize_identity({"device_id": "d", "instance_id": "i", "channel": "prod"})["channel"] == "prod"


def test_normalize_identity_requires_ids():
    with pytest.raises(ValueError):
        normalize_identity({"device_id": "d"})
    with pytest.raises(ValueError):
        normalize_identity({})


def test_peer_ready_parse():
    ready = PeerReady.parse(
        {
            "type": "peer_ready",
            "protocolVersion": 4,
            "peerSessionId": "ps-1",
            "recoveryToken": "rt",
            "backend": {"backendId": "b-1", "epoch": 3, "leaseTtlMs": 30000},
            "registrySync": {"items": [{"backendId": "b-2"}]},
        }
    )
    assert ready.protocol_version == 4
    assert ready.peer_session_id == "ps-1"
    assert ready.recovery_token == "rt"
    assert (ready.backend_id, ready.epoch, ready.lease_ttl_ms) == ("b-1", 3, 30000)
    assert ready.registry == ({"backendId": "b-2"},)


def test_peer_ready_parse_without_backend():
    ready = PeerReady.parse({"type": "peer_ready", "protocolVersion": 4})
    assert ready.backend_id is None
    assert ready.epoch is None


def test_channel_offer_parse():
    offer = ChannelOffer.parse(
        {
            "type": "channel_offer",
            "channelId": "c-1",
            "kind": "rpc",
            "sourcePeerSessionId": "ps-9",
            "ticket": "tkt",
            "dataPath": "/channel/c-1",
        }
    )
    assert (offer.channel_id, offer.ticket, offer.data_path) == ("c-1", "tkt", "/channel/c-1")
    assert offer.kind == "rpc"
    assert offer.source_peer_session_id == "ps-9"


def test_channel_offer_parse_rejects_incomplete():
    with pytest.raises(ValueError):
        ChannelOffer.parse({"type": "channel_offer", "channelId": "c-1"})


def test_gateway_error_shape():
    error = GatewayError("UNAUTHORIZED", "bad credential")
    assert error.code == "UNAUTHORIZED"
    assert error.message == "bad credential"
    assert str(error) == "UNAUTHORIZED: bad credential"
