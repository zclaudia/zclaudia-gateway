/**
 * Gateway notification service extension — an optional gateway service,
 * distinct from the core channel/topic contracts.
 *
 * The gateway delivers notifications by generic event fields (name filter,
 * severity → priority mapping). It never interprets application semantics:
 * event names and their meaning belong to the application. The ntfy
 * connection, auth configuration, storage and defaults are gateway-internal
 * and deliberately not part of this public surface.
 */

/** Severity a backend may attach to a push event; the gateway maps it to a delivery priority. */
export type GatewayNotificationSeverity = 'info' | 'success' | 'warning' | 'error';

/**
 * Push event fields the gateway itself reads (backend → gateway
 * `push_notification_request`). Extra application fields may travel in the
 * wire object but are ignored by the gateway.
 */
export interface GatewayPushNotificationEvent {
  /** Filter key: the gateway applies its allow/denylist to this dotted name. */
  name: string;
  severity?: GatewayNotificationSeverity;
  title: string;
  body: string;
  tags?: string[];
  clickUrl?: string;
}

/** Backend → gateway control message requesting a push delivery. */
export interface PushNotificationRequestMessage {
  type: 'push_notification_request';
  namespace?: string;
  event: GatewayPushNotificationEvent;
}

/**
 * Management API DTO for the notification service configuration, served
 * as-is by GET /api/notifications/config. Note: today the gateway returns
 * the resolved config including ntfy credentials — keeping that shape is a
 * round-1 compatibility decision, not an endorsement.
 */
export interface GatewayNotificationConfig {
  enabled: boolean;
  ntfyUrl: string;
  ntfyTopic: string;
  ntfyAuthMode: GatewayNotificationAuthMode;
  ntfyPublishToken: string;
  ntfySubscribeToken: string;
  ntfyUsername: string;
  ntfyPassword: string;
  eventAllowlist: string[];
  eventDenylist: string[];
  minSeverity?: GatewayNotificationSeverity;
}

export type GatewayNotificationAuthMode = 'none' | 'bearer' | 'basic';
