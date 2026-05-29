import { createGatewayServer } from './server.js';
import { DEFAULT_NOTIFICATION_CONFIG } from '@zclaudia/protocol/notifications';
import type { NotificationAuthMode, NotificationConfig } from '@zclaudia/protocol/notifications';

const PORT = parseInt(process.env.GATEWAY_PORT || '3200', 10);
if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Error: GATEWAY_PORT must be a valid port number (1-65535), got: ${process.env.GATEWAY_PORT}`);
  process.exit(1);
}

const GATEWAY_SECRET = process.env.GATEWAY_SECRET;
if (!GATEWAY_SECRET) {
  console.error('Error: GATEWAY_SECRET environment variable is required');
  process.exit(1);
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseAuthModeEnv(value: string | undefined): NotificationAuthMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'none') return 'none';
  if (normalized === 'bearer' || normalized === 'basic') return normalized;
  console.error(`Error: invalid NTFY_AUTH_MODE: ${value}. Expected none, bearer, or basic.`);
  process.exit(1);
}

function parseNotificationConfigFromEnv(): Partial<NotificationConfig> {
  const ntfyUrl = process.env.NTFY_URL?.trim();
  if (ntfyUrl) {
    try {
      const parsed = new URL(ntfyUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('NTFY_URL must use http or https');
      }
    } catch (error) {
      console.error(`Error: invalid NTFY_URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  }

  const eventDefaults = DEFAULT_NOTIFICATION_CONFIG.events;
  const ntfyAuthMode = parseAuthModeEnv(process.env.NTFY_AUTH_MODE);
  const ntfyPublishToken = process.env.NTFY_PUBLISH_TOKEN?.trim() ?? '';
  const ntfySubscribeToken = process.env.NTFY_SUBSCRIBE_TOKEN?.trim() ?? ntfyPublishToken;
  const ntfyUsername = process.env.NTFY_USERNAME?.trim() ?? '';
  const ntfyPassword = process.env.NTFY_PASSWORD ?? '';

  if (ntfyAuthMode === 'bearer' && !ntfyPublishToken) {
    console.error('Error: NTFY_PUBLISH_TOKEN is required when NTFY_AUTH_MODE=bearer');
    process.exit(1);
  }
  if (ntfyAuthMode === 'basic' && (!ntfyUsername || !ntfyPassword)) {
    console.error('Error: NTFY_USERNAME and NTFY_PASSWORD are required when NTFY_AUTH_MODE=basic');
    process.exit(1);
  }

  return {
    enabled: parseBooleanEnv(process.env.NTFY_ENABLED, DEFAULT_NOTIFICATION_CONFIG.enabled),
    ntfyUrl: ntfyUrl ?? DEFAULT_NOTIFICATION_CONFIG.ntfyUrl,
    ntfyTopic: process.env.NTFY_TOPIC?.trim() ?? DEFAULT_NOTIFICATION_CONFIG.ntfyTopic,
    ntfyAuthMode,
    ntfyPublishToken,
    ntfySubscribeToken,
    ntfyUsername,
    ntfyPassword,
    events: {
      permissionRequest: parseBooleanEnv(process.env.NTFY_NOTIFY_PERMISSION_REQUEST, eventDefaults.permissionRequest),
      promptRequest: parseBooleanEnv(process.env.NTFY_NOTIFY_PROMPT_REQUEST, eventDefaults.promptRequest),
      runCompleted: parseBooleanEnv(process.env.NTFY_NOTIFY_RUN_COMPLETED, eventDefaults.runCompleted),
      runFailed: parseBooleanEnv(process.env.NTFY_NOTIFY_RUN_FAILED, eventDefaults.runFailed),
      backgroundPermission: parseBooleanEnv(process.env.NTFY_NOTIFY_BACKGROUND_PERMISSION, eventDefaults.backgroundPermission),
      processLeak: parseBooleanEnv(process.env.NTFY_NOTIFY_PROCESS_LEAK, eventDefaults.processLeak),
    },
  };
}

const server = createGatewayServer({
  gatewaySecret: GATEWAY_SECRET,
  notificationConfig: parseNotificationConfigFromEnv(),
  trustProxy: process.env.GATEWAY_TRUST_PROXY === 'true',
});

server.listen(PORT, () => {
  console.log(`Gateway server listening on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
});
