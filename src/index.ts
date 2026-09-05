import { createGatewayServer } from './server.js';
import { DEFAULT_NOTIFICATION_CONFIG } from '@zclaudia/protocol/notifications';
import type { NotificationAuthMode, NotificationConfig } from '@zclaudia/protocol/notifications';

const PORT = parseInt(process.env.GATEWAY_PORT || '3200', 10);
if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Error: GATEWAY_PORT must be a valid port number (1-65535), got: ${process.env.GATEWAY_PORT}`);
  process.exit(1);
}

const ADMIN_TOKEN = process.env.GATEWAY_ADMIN_TOKEN?.trim();
if (!ADMIN_TOKEN) {
  console.error('Error: GATEWAY_ADMIN_TOKEN environment variable is required — '
    + 'issued credentials are the only authentication (see README)');
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

function parseListEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function parseSeverityEnv(value: string | undefined): NotificationConfig['minSeverity'] {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'info' || normalized === 'success' || normalized === 'warning' || normalized === 'error') {
    return normalized;
  }
  console.error(`Error: invalid NTFY_MIN_SEVERITY: ${value}. Expected info, success, warning, or error.`);
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
    eventAllowlist: parseListEnv(process.env.NTFY_EVENT_ALLOWLIST),
    eventDenylist: parseListEnv(process.env.NTFY_EVENT_DENYLIST),
    minSeverity: parseSeverityEnv(process.env.NTFY_MIN_SEVERITY),
  };
}

const allowedOrigins = parseListEnv(process.env.GATEWAY_ALLOWED_ORIGINS);

// Admin web UI (ADR-0005): unset dir keeps the gateway API-only.
const ADMIN_UI_DIR = process.env.GATEWAY_ADMIN_UI_DIR?.trim() || undefined;

let adminSessionTtlMs: number | undefined;
if (process.env.GATEWAY_ADMIN_SESSION_TTL_HOURS?.trim()) {
  const hours = parseFloat(process.env.GATEWAY_ADMIN_SESSION_TTL_HOURS);
  if (isNaN(hours) || hours <= 0) {
    console.error(`Error: GATEWAY_ADMIN_SESSION_TTL_HOURS must be a positive number, got: ${process.env.GATEWAY_ADMIN_SESSION_TTL_HOURS}`);
    process.exit(1);
  }
  adminSessionTtlMs = hours * 60 * 60 * 1000;
}

const server = createGatewayServer({
  adminToken: ADMIN_TOKEN,
  notificationConfig: parseNotificationConfigFromEnv(),
  trustProxy: process.env.GATEWAY_TRUST_PROXY === 'true',
  allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : undefined,
  adminStaticDir: ADMIN_UI_DIR,
  adminSessionTtlMs,
});

server.listen(PORT, () => {
  console.log(`Gateway server listening on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
  if (ADMIN_UI_DIR) {
    console.log(`Admin web UI: http://localhost:${PORT}/admin (static dir: ${ADMIN_UI_DIR})`);
  }
});
