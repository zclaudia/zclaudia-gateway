/**
 * Runtime validation for inbound protocol messages and proxy header hygiene.
 *
 * Leniency rule (v3 compatibility): ONLY the fields the gateway itself reads
 * for routing are required. Everything else stays opaque — the @zclaudia/protocol
 * .d.ts shapes are aspirational and real v3 traffic diverges from them (e.g.
 * backend_resource_snapshot carries sessions/projects rather than resources,
 * some client messages use payload instead of message). Do not tighten these
 * specs beyond routing needs before Protocol v4.
 */

type FieldKind =
  | 'string'
  | 'non-empty-string'
  | 'number'
  | 'status-code'
  | 'object'
  | 'array'
  | 'present';

interface FieldSpec {
  kind: FieldKind;
  optional?: boolean;
  /** Restrict a string field to specific values. */
  oneOf?: string[];
}

type MessageSpec = Record<string, FieldSpec>;

const MESSAGE_SPECS: Record<string, MessageSpec> = {
  backend_heartbeat: {
    epoch: { kind: 'number' },
    observedAt: { kind: 'number', optional: true },
  },
  // Pure relays: gateway only reads the optional delivery target.
  backend_resource_snapshot: {
    targetPeerSessionId: { kind: 'string', optional: true },
  },
  backend_resource_event: {
    targetPeerSessionId: { kind: 'string', optional: true },
  },
  backend_stream_event: {
    streamId: { kind: 'non-empty-string' },
    eventName: { kind: 'non-empty-string' },
    seq: { kind: 'number' },
    channel: { kind: 'string', optional: true },
  },
  request_registry_snapshot: {},
  request_backend_resource_snapshot: {
    backendId: { kind: 'non-empty-string' },
    resourceTypes: { kind: 'array', optional: true },
    targetPeerSessionId: { kind: 'string', optional: true },
  },
  subscribe_backend: {
    backendId: { kind: 'non-empty-string' },
  },
  unsubscribe_backend: {
    backendId: { kind: 'non-empty-string' },
  },
  // Relayed whole; some traffic uses `payload` instead of `message`, so no
  // payload-field requirement — only the routing field.
  backend_client_message: {
    backendId: { kind: 'non-empty-string' },
  },
  backend_server_message: {
    backendId: { kind: 'non-empty-string' },
    targetPeerSessionId: { kind: 'string', optional: true },
  },
  content_patch: {
    backendId: { kind: 'non-empty-string' },
  },
  content_patch_error: {
    backendId: { kind: 'non-empty-string' },
  },
  catch_up_content: {
    backendId: { kind: 'non-empty-string' },
    contentStreamId: { kind: 'non-empty-string' },
    afterOffset: { kind: 'number' },
  },
  http_proxy_response: {
    requestId: { kind: 'non-empty-string' },
    statusCode: { kind: 'status-code' },
    headers: { kind: 'object', optional: true },
    bodyEncoding: { kind: 'string', optional: true, oneOf: ['utf8', 'base64'] },
    body: { kind: 'string', optional: true },
  },
  http_proxy_response_start: {
    requestId: { kind: 'non-empty-string' },
    statusCode: { kind: 'status-code' },
    headers: { kind: 'object', optional: true },
  },
  http_proxy_response_chunk: {
    requestId: { kind: 'non-empty-string' },
    data: { kind: 'string' },
  },
  http_proxy_response_end: {
    requestId: { kind: 'non-empty-string' },
  },
  push_notification_request: {
    event: { kind: 'present' },
  },
  ping: {
    ts: { kind: 'number', optional: true },
  },
  // v4 channel control messages (docs/protocol-v4.md)
  channel_open: {
    target: { kind: 'non-empty-string' },
    kind: { kind: 'string', optional: true },
  },
  channel_reject: {
    channelId: { kind: 'non-empty-string' },
    reason: { kind: 'string', optional: true },
  },
  channel_close: {
    channelId: { kind: 'non-empty-string' },
  },
};

function checkField(value: unknown, spec: FieldSpec): string | null {
  switch (spec.kind) {
    case 'string':
      if (typeof value !== 'string') return 'must be a string';
      break;
    case 'non-empty-string':
      if (typeof value !== 'string' || value === '') return 'must be a non-empty string';
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a finite number';
      break;
    case 'status-code':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) {
        return 'must be an integer HTTP status code (100-599)';
      }
      break;
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'must be an object';
      break;
    case 'array':
      if (!Array.isArray(value)) return 'must be an array';
      break;
    case 'present':
      if (value === undefined) return 'is required';
      break;
  }
  if (spec.oneOf && typeof value === 'string' && !spec.oneOf.includes(value)) {
    return `must be one of: ${spec.oneOf.join(', ')}`;
  }
  return null;
}

/**
 * Validate an inbound (post-hello) protocol message against its spec.
 * Returns an error string, or null when valid. Message types without a
 * spec are left to the router's unknown-type handling.
 */
export function validateGatewayMessage(message: unknown): string | null {
  if (!message || typeof message !== 'object') return 'message must be an object';
  const msg = message as Record<string, unknown>;
  if (typeof msg.type !== 'string') return 'message.type must be a string';
  const spec = MESSAGE_SPECS[msg.type];
  if (!spec) return null;
  for (const [field, fieldSpec] of Object.entries(spec)) {
    const value = msg[field];
    if (value === undefined) {
      if (fieldSpec.optional || fieldSpec.kind === 'present') {
        if (fieldSpec.kind === 'present') return `${msg.type}.${field} is required`;
        continue;
      }
      return `${msg.type}.${field} is required`;
    }
    const error = checkField(value, fieldSpec);
    if (error) return `${msg.type}.${field} ${error}`;
  }
  return null;
}

// ============================================================================
// Proxy header hygiene (Phase 1: unified allowlists, default-deny)
// ============================================================================

/** Client request headers forwarded to the backend. Everything else is dropped. */
export const PROXY_REQUEST_HEADER_ALLOWLIST = [
  'content-type',
  'accept',
  'x-request-id',
  'range',
  'if-none-match',
  'if-modified-since',
] as const;

/**
 * Backend response headers forwarded to the client. Notably excluded:
 * set-cookie (local session material must never reach remote clients),
 * hop-by-hop headers, and server fingerprint headers.
 */
export const PROXY_RESPONSE_HEADER_ALLOWLIST = new Set([
  'content-type',
  'content-length',
  'content-disposition',
  'content-encoding',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
  'expires',
  'vary',
  'location',
  'x-request-id',
]);

export function filterProxyResponseHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  if (!headers) return filtered;
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string') continue;
    if (PROXY_RESPONSE_HEADER_ALLOWLIST.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}
