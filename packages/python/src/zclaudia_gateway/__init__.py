"""Python Backend SDK for the zclaudia gateway (Gateway Protocol v4)."""

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _distribution_version

from .backend import ChannelOfferInfo, GatewayBackend, GatewayBackendState
from .channel import MAX_MESSAGE_SIZE, GatewayChannel
from .http import HttpServeRequest, HttpServeResponse
from .protocol import (
    CHANNEL_KIND_HTTP,
    GATEWAY_PROTOCOL_V4,
    ChannelOffer,
    GatewayError,
    PeerReady,
)

try:
    __version__ = _distribution_version("zclaudia-gateway")
except PackageNotFoundError:  # source tree without an install
    __version__ = "0.0.0.dev0"

__all__ = [
    "CHANNEL_KIND_HTTP",
    "GATEWAY_PROTOCOL_V4",
    "MAX_MESSAGE_SIZE",
    "ChannelOffer",
    "ChannelOfferInfo",
    "GatewayBackend",
    "GatewayBackendState",
    "GatewayChannel",
    "GatewayError",
    "HttpServeRequest",
    "HttpServeResponse",
    "PeerReady",
    "__version__",
]
