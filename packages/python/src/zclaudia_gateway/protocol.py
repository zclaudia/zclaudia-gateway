"""Gateway Protocol v4 wire constants and message models.

Mirrors the subset of ``@zclaudia/gateway-protocol`` a Backend peer needs.
Wire keys are camelCase and must stay byte-compatible with the TypeScript
SDK and the gateway (see ``docs/protocol-v4.md``). Receivers must tolerate
unknown message types and error codes: the gateway may add them in minor
releases.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

GATEWAY_PROTOCOL_V4 = 4

CHANNEL_KIND_HTTP = "http"

PEER_TYPE_CLIENT_BACKEND = "client+backend"

GATEWAY_ERROR_CODES = frozenset(
    {
        "INVALID_MESSAGE",
        "PROTOCOL_VERSION_MISMATCH",
        "UNAUTHORIZED",
        "BACKEND_OFFLINE",
        "RATE_LIMITED",
    }
)

CHANNEL_CLOSED_REASONS = frozenset(
    {
        "closed",
        "rejected",
        "timeout",
        "epoch_changed",
        "backend_offline",
    }
)


class GatewayError(Exception):
    """The gateway rejected a message or the handshake (``gateway_error``)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}" if message else code)
        self.code = code
        self.message = message


def normalize_identity(identity: dict[str, Any]) -> dict[str, str]:
    """Map an identity mapping to the wire (camelCase) form.

    Accepts both snake_case (``device_id``) and wire spelling (``deviceId``).
    ``device_id`` and ``instance_id`` are required: they are the stable parts
    of the v4 backend identity key ``(namespace, instanceId, environment)``.
    """
    device = identity.get("deviceId", identity.get("device_id"))
    instance = identity.get("instanceId", identity.get("instance_id"))
    if not device or not instance:
        raise ValueError("identity requires 'device_id' and 'instance_id'")
    out: dict[str, str] = {"deviceId": str(device), "instanceId": str(instance)}
    name = identity.get("name")
    if name is not None:
        out["name"] = str(name)
    channel = identity.get("channel")
    if channel is not None:
        out["channel"] = str(channel)
    return out


@dataclass(frozen=True)
class PeerReady:
    """Parsed ``peer_ready``: session identity plus the backend assignment."""

    protocol_version: int
    peer_session_id: str
    recovery_token: str
    backend_id: str | None
    epoch: int | None
    lease_ttl_ms: int | None
    registry: tuple[dict[str, Any], ...] = ()

    @classmethod
    def parse(cls, message: dict[str, Any]) -> PeerReady:
        backend = message.get("backend") or {}
        registry = message.get("registrySync") or {}
        return cls(
            protocol_version=int(message.get("protocolVersion") or 0),
            peer_session_id=str(message.get("peerSessionId") or ""),
            recovery_token=str(message.get("recoveryToken") or ""),
            backend_id=backend.get("backendId"),
            epoch=backend.get("epoch"),
            lease_ttl_ms=backend.get("leaseTtlMs"),
            registry=tuple(registry.get("items") or ()),
        )


@dataclass(frozen=True)
class ChannelOffer:
    """Parsed ``channel_offer`` (dial-is-accept: the offer carries the ticket)."""

    channel_id: str
    ticket: str
    data_path: str
    kind: str | None = None
    source_peer_session_id: str | None = None

    @classmethod
    def parse(cls, message: dict[str, Any]) -> ChannelOffer:
        channel_id = message.get("channelId")
        ticket = message.get("ticket")
        data_path = message.get("dataPath")
        if not channel_id or not ticket or not data_path:
            raise ValueError("channel_offer requires channelId, ticket and dataPath")
        return cls(
            channel_id=str(channel_id),
            ticket=str(ticket),
            data_path=str(data_path),
            kind=message.get("kind"),
            source_peer_session_id=message.get("sourcePeerSessionId"),
        )
