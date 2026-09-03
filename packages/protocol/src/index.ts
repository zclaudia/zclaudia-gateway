/**
 * Gateway Protocol v4 — wire types and constants.
 *
 * Scope: only what the gateway routes on plus the v4 channel/topic/http
 * frames (see zclaudia-gateway/docs/protocol-v4.md). Application payloads
 * stay opaque. v3-only message shapes remain in @zclaudia/protocol.
 */

export const GATEWAY_PROTOCOL_V4 = 4;

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
  protocolVersion: 3 | 4;
  namespace: string;
  clientProtocolVersion: number;
  peerType: 'client-only' | 'client+backend';
  /** Legacy shared secret or an issued credential token (zgd_/zgb_). */
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
  /** Gateway sync protocol version the backend registered with (3 or 4). */
  gatewayProtocolVersion?: number;
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

export interface GatewayErrorV4 {
  type: 'gateway_error';
  code: string;
  message: string;
  recovery?: string;
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
