/**
 * Gateway Protocol v4 — canonical wire types and constants.
 *
 * Scope: everything the gateway routes on — handshake, registry, heartbeat,
 * the generic error model, the v4 channel/topic/http frames, and the
 * `backend_server_message` targeted fallback. Application payloads stay
 * opaque (`unknown`); ZClaudia business semantics live in @zclaudia/protocol.
 *
 * Protocol version is 4. v3 is rejected at the handshake and has no type
 * license here. Receivers must still tolerate unknown message types and
 * error codes at runtime — the gateway may add them in minor releases.
 */

import type { PushNotificationRequestMessage } from './notifications.js';

export const GATEWAY_PROTOCOL_V4 = 4;

// ============================================================================
// Scalar aliases
// ============================================================================

export type PeerSessionId = string;
export type BackendId = string;
export type Epoch = number;

// ============================================================================
// Handshake
// ============================================================================

export interface PeerIdentity {
  deviceId: string;
  instanceId: string;
  /** Environment ("prod" default); part of the v4 backend identity key. */
  channel?: string;
  name?: string;
}

export interface PeerHelloV4 {
  type: 'peer_hello';
  protocolVersion: typeof GATEWAY_PROTOCOL_V4;
  namespace: string;
  clientProtocolVersion: number;
  peerType: 'client-only' | 'client+backend';
  /**
   * Issued credential token only (zgd_ device / zgb_ backend enrollment /
   * zga_ backend access). The field name is kept for wire compatibility —
   * shared secrets are no longer accepted, and the admin token is an
   * administrative credential that must never be used for the peer handshake.
   * Namespace and registration rights derive from the server-side
   * credential record, never from this hello.
   */
  gatewaySecret: string;
  identity: PeerIdentity;
  backend?: {
    visible: boolean;
    capabilities: string[];
    backendProtocolVersion: number;
    minClientProtocolVersion?: number;
  };
}

export interface BackendPresenceV4 {
  namespace: string;
  backendId: string;
  instanceId: string;
  deviceId: string;
  name: string;
  channel: string;
  visible: boolean;
  capabilities: string[];
  backendProtocolVersion: number;
  minClientProtocolVersion?: number;
  epoch: number;
  connectedAt: number;
  lastSeenAt: number;
  /** Gateway protocol version the backend registered with. v4 gateways only register v4. */
  gatewayProtocolVersion?: typeof GATEWAY_PROTOCOL_V4;
}

export interface PeerReadyV4 {
  type: 'peer_ready';
  protocolVersion: number;
  peerSessionId: string;
  recoveryToken: string;
  backend?: { backendId: string; epoch: number; leaseTtlMs: number };
  registrySync: { items: BackendPresenceV4[] };
}

export interface RegistrySnapshotV4 {
  type: 'registry_snapshot';
  items: BackendPresenceV4[];
}

// ============================================================================
// Heartbeat
// ============================================================================

export interface BackendHeartbeatMessage {
  type: 'backend_heartbeat';
  epoch: number;
  /** Wall-clock observation time from the backend; the gateway ignores it. */
  observedAt?: number;
}

export interface HeartbeatAckMessage {
  type: 'heartbeat_ack';
  epoch: number;
  /**
   * Always false: the v3 stream-demand negotiation is gone (retained topics
   * made it meaningless). The field stays so the ack shape is stable.
   */
  streamDemand: false;
}

// ============================================================================
// Generic Error Model
// ============================================================================

/** Error codes the gateway sends on the control connection. */
export type GatewayErrorCode =
  | 'INVALID_MESSAGE'
  | 'PROTOCOL_VERSION_MISMATCH'
  | 'UNAUTHORIZED'
  | 'BACKEND_OFFLINE'
  | 'RATE_LIMITED';

/**
 * Recovery hints a gateway_error may carry. The gateway sends none today;
 * clients should treat unknown values as "no recovery action".
 */
export type GatewayErrorRecovery = 'resubscribe' | 'catch_up_content' | 'reconnect';

export interface GatewayErrorV4 {
  type: 'gateway_error';
  code: GatewayErrorCode;
  message: string;
  recovery?: GatewayErrorRecovery;
}

// ============================================================================
// Directed Fallback (docs/protocol-v4.md: the only v3-shaped message kept)
// ============================================================================

/**
 * Backend → gateway directed message; the gateway relays it as-is to the
 * targeted peer. The normal v4 data path is the message channel — this is
 * the fallback used while that channel (re)opens. The payload is opaque:
 * the gateway routes on backendId/targetPeerSessionId only.
 */
export interface BackendServerMessage {
  type: 'backend_server_message';
  backendId: string;
  /**
   * Present on delivered messages: route to exactly this peer instead of
   * broadcasting. The gateway drops directed messages without it.
   */
  targetPeerSessionId?: string;
  /** Opaque application payload. */
  message: unknown;
}

// ============================================================================
// Registry / Utility Control Messages
// ============================================================================

/** Client requests an immediate full registry snapshot (e.g. mobile resume). */
export interface RequestRegistrySnapshotMessage {
  type: 'request_registry_snapshot';
}

/** Application-level liveness probe. */
export interface PingMessage {
  type: 'ping';
  /** Echoed verbatim in the pong; the gateway does not interpret it. */
  ts?: number;
}

export interface PongMessage {
  type: 'pong';
  /** Mirrors ping.ts when present. */
  ts?: number;
}

// ============================================================================
// Channels (docs/protocol-v4.md §3–5)
// ============================================================================

export type ChannelClosedReason =
  | 'closed'
  | 'rejected'
  | 'timeout'
  | 'epoch_changed'
  | 'backend_offline';

export interface ChannelOpenMessage {
  type: 'channel_open';
  /** Target backendId. */
  target: string;
  /** Application-defined channel kind; opaque to the gateway. */
  kind?: string;
}

export interface ChannelReadyMessage {
  type: 'channel_ready';
  channelId: string;
  ticket: string;
  dataPath: string;
}

export interface ChannelOfferMessage {
  type: 'channel_offer';
  channelId: string;
  kind?: string;
  sourcePeerSessionId?: string;
  ticket: string;
  dataPath: string;
}

export interface ChannelRejectMessage {
  type: 'channel_reject';
  channelId: string;
  reason?: string;
}

export interface ChannelCloseMessage {
  type: 'channel_close';
  channelId: string;
}

export interface ChannelClosedMessage {
  type: 'channel_closed';
  channelId: string;
  reason: ChannelClosedReason;
}

// ============================================================================
// Topics (docs/protocol-v4.md §6)
// ============================================================================

export interface TopicSubscribeMessage {
  type: 'topic_subscribe';
  backendId: string;
  topic: string;
}

export interface TopicSubscribedMessage {
  type: 'topic_subscribed';
  backendId: string;
  topic: string;
}

export interface TopicUnsubscribeMessage {
  type: 'topic_unsubscribe';
  backendId: string;
  topic: string;
}

export interface TopicUnsubscribedMessage {
  type: 'topic_unsubscribed';
  backendId: string;
  topic: string;
}

export interface TopicPublishMessage {
  type: 'topic_publish';
  topic: string;
  payload?: unknown;
  /**
   * Retain the payload as the topic's current state: the gateway stores the
   * last retained payload per (backend, topic) and delivers it to new
   * subscribers immediately after topic_subscribed (MQTT retain semantics).
   * Retained state is cleared when the backend disconnects or its epoch
   * changes.
   */
  retain?: boolean;
}

export interface TopicMessage {
  type: 'topic_message';
  backendId: string;
  topic: string;
  payload?: unknown;
}

// ============================================================================
// HTTP-over-channel frames (docs/protocol-v4.md §7, channel kind 'http')
// ============================================================================

export interface HttpRequestFrame {
  type: 'http_request';
  method: string;
  path: string;
  headers: Record<string, string>;
}

export interface HttpRequestEndFrame {
  type: 'http_request_end';
}

export interface HttpResponseFrame {
  type: 'http_response';
  status: number;
  headers?: Record<string, string>;
}

export const CHANNEL_KIND_HTTP = 'http';

// ============================================================================
// Direction unions — senders are constrained to these; receivers validate at
// the parse boundary and must tolerate unknown types at runtime.
// ============================================================================

/** Messages an authenticated peer may send to the gateway (after peer_hello). */
export type PeerToGatewayMessage =
  | BackendHeartbeatMessage
  | RequestRegistrySnapshotMessage
  | BackendServerMessage
  | PushNotificationRequestMessage
  | PingMessage
  | ChannelOpenMessage
  | ChannelRejectMessage
  | ChannelCloseMessage
  | TopicSubscribeMessage
  | TopicUnsubscribeMessage
  | TopicPublishMessage;

/** Messages the gateway sends to a peer (after peer_ready; peer_ready itself first). */
export type GatewayToPeerMessage =
  | PeerReadyV4
  | RegistrySnapshotV4
  | GatewayErrorV4
  | HeartbeatAckMessage
  | PongMessage
  | ChannelReadyMessage
  | ChannelOfferMessage
  | ChannelClosedMessage
  | TopicSubscribedMessage
  | TopicUnsubscribedMessage
  | TopicMessage
  /** Targeted fallback relay, sent to the addressed client only. */
  | BackendServerMessage;

export type { PushNotificationRequestMessage } from './notifications.js';
