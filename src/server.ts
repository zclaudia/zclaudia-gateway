/**
 * Gateway Sync Protocol v3 — Server Implementation
 *
 * No prose spec exists; the wire format is defined by the types in
 * @zclaudia/protocol (src/gateway.ts) and the behavior is pinned by
 * the tests in src/__tests__/. See README.md for an overview.
 */

import { createServer as createHttpServer, IncomingMessage, Server } from 'http';
import type { Socket } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import express, { Request, Response } from 'express';
import type {
  PeerHelloMessage,
  PeerReadyMessage,
  RegistrySyncPayload,
  BackendPresence,
  RegistrySnapshotMessage,
  BackendHeartbeatMessage,
  HeartbeatAckMessage,
  BackendResourceSnapshotMessage,
  BackendResourceEventMessage,
  RequestBackendResourceSnapshotMessage,
  SubscribeBackendMessage,
  BackendSubscribedMessage,
  UnsubscribeBackendMessage,
  BackendUnsubscribedMessage,
  BackendClientMessage,
  BackendServerMessage,
  StreamDemandMessage,
  BackendStreamEvent,
  GatewayStreamEvent,
  CatchUpContentMessage,
  ContentPatchMessage,
  ContentPatchErrorMessage,
  SubscriberDisconnectedMessage,
  GatewayErrorMessage,
  GatewayHttpProxyRequest,
  GatewayHttpProxyResponse,
  GatewayHttpProxyResponseStart,
  GatewayHttpProxyResponseChunk,
  GatewayHttpProxyResponseEnd,
  PushNotificationRequestMessage,
} from '@zclaudia/protocol/gateway';
import type { NotificationConfig } from '@zclaudia/protocol/notifications';
import { GatewayStorage, CREDENTIAL_TOKEN_PREFIXES, type CredentialInfo, type CredentialType } from './storage.js';
import { validateGatewayMessage, filterProxyResponseHeaders, PROXY_REQUEST_HEADER_ALLOWLIST } from './validation.js';
import { GatewayState, type PeerSession } from './state.js';
import { encodeProxyRequestBody } from './proxy-body.js';
import { GatewayPushNotificationService } from './push-notification.js';

// ============================================================================
// Config & Helpers
// ============================================================================

interface GatewayConfig {
  gatewaySecret: string;
  /**
   * Admin token for the credential management API (/api/admin/*).
   * When unset, the admin API is disabled. Must differ from gatewaySecret.
   */
  adminToken?: string;
  /** TTL for exchanged backend access credentials. Default 24h. */
  backendAccessTokenTtlMs?: number;
  notificationConfig?: Partial<NotificationConfig>;
  authTimeoutMs?: number;
  proxyRequestTimeoutMs?: number;
  proxyStreamingTimeoutMs?: number;
  /** v4: one-time channel dial ticket TTL (= pairing timeout). Default 30s. */
  channelTicketTtlMs?: number;
  /** v4: max concurrent channels a single peer may hold open. Default 32. */
  maxChannelsPerPeer?: number;
  /**
   * v4: per-channel byte rate limit (bytes/second, per direction) enforced
   * by pausing the sending socket. Unset = unlimited.
   */
  channelByteRateLimit?: number;
  /** Trust X-Forwarded-For header for IP extraction. Only enable behind a trusted reverse proxy. */
  trustProxy?: boolean;
  /**
   * CORS Origin allowlist. When set, only listed origins receive CORS
   * headers (echoed origin, credentials allowed). When unset, keeps the
   * legacy wildcard behavior for backward compatibility.
   */
  allowedOrigins?: string[];
}

function isVitestProcess(): boolean {
  return process.argv.some((arg) => arg.includes('vitest'))
    || process.env.VITEST_POOL_ID !== undefined
    || process.env.VITEST_WORKER_ID !== undefined;
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function sendToWs(ws: WebSocket, message: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/** Proxy failure carrying the HTTP status the client should receive. */
class ProxyError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

function validatePeerHelloMessage(message: unknown): string | null {
  if (!message || typeof message !== 'object') return 'peer_hello must be an object';
  const msg = message as Record<string, unknown>;
  if (msg.type !== 'peer_hello') return 'First message must be peer_hello';
  if (typeof msg.gatewaySecret !== 'string') return 'peer_hello.gatewaySecret must be a string';
  if (msg.protocolVersion !== 3 && msg.protocolVersion !== 4) return 'peer_hello.protocolVersion must be 3 or 4';
  if (typeof msg.namespace !== 'string' || !msg.namespace) return 'peer_hello.namespace must be a non-empty string';
  if (typeof msg.clientProtocolVersion !== 'number') return 'peer_hello.clientProtocolVersion must be a number';
  if (msg.peerType !== 'client-only' && msg.peerType !== 'client+backend') {
    return 'peer_hello.peerType must be client-only or client+backend';
  }
  if (!msg.identity || typeof msg.identity !== 'object') return 'peer_hello.identity is required';
  const identity = msg.identity as Record<string, unknown>;
  if (typeof identity.deviceId !== 'string') return 'peer_hello.identity.deviceId must be a string';
  if (typeof identity.instanceId !== 'string') return 'peer_hello.identity.instanceId must be a string';
  if (identity.channel !== undefined && typeof identity.channel !== 'string') return 'peer_hello.identity.channel must be a string';
  if (identity.name !== undefined && typeof identity.name !== 'string') return 'peer_hello.identity.name must be a string';
  if (msg.peerType === 'client+backend') {
    if (!msg.backend || typeof msg.backend !== 'object') return 'peer_hello.backend is required for client+backend peers';
    const backend = msg.backend as Record<string, unknown>;
    if (typeof backend.visible !== 'boolean') return 'peer_hello.backend.visible must be a boolean';
    if (!Array.isArray(backend.capabilities)) return 'peer_hello.backend.capabilities must be an array';
    if (typeof backend.backendProtocolVersion !== 'number') return 'peer_hello.backend.backendProtocolVersion must be a number';
  }
  return null;
}

// ============================================================================
// Server Factory
// ============================================================================

export function createGatewayServer(config: GatewayConfig): Server {
  if (config.adminToken !== undefined && config.adminToken === config.gatewaySecret) {
    throw new Error('adminToken must differ from gatewaySecret');
  }
  const storage = new GatewayStorage();
  const pushNotificationService = new GatewayPushNotificationService(config.notificationConfig);
  const state = new GatewayState();
  const recoveryTokens = new Map<string, string>();
  const authTimeoutMs = config.authTimeoutMs ?? 10_000;
  const proxyRequestTimeoutMs = config.proxyRequestTimeoutMs ?? 30_000;
  const proxyStreamingTimeoutMs = config.proxyStreamingTimeoutMs ?? 60_000;
  const channelTicketTtlMs = config.channelTicketTtlMs ?? 30_000;
  const maxChannelsPerPeer = config.maxChannelsPerPeer ?? 32;
  const channelByteRateLimit = config.channelByteRateLimit;
  const trustProxy = config.trustProxy ?? false;

  const app = express();
  app.disable('x-powered-by');

  // --- Rate limiting ---
  // Strict limit for failed auth attempts (brute-force protection)
  const authFailures = new Map<string, { count: number; resetAt: number }>();
  const AUTH_FAIL_LIMIT = 10;
  const AUTH_FAIL_WINDOW = 60_000;

  // Generous limit for authenticated proxy requests (normal app usage)
  const proxyRequests = new Map<string, { count: number; resetAt: number }>();
  const PROXY_RATE_LIMIT = 200;
  const PROXY_RATE_WINDOW = 60_000;

  function checkLimit(
    map: Map<string, { count: number; resetAt: number }>,
    key: string,
    limit: number,
    window: number,
  ): boolean {
    const now = Date.now();
    const entry = map.get(key);
    if (!entry || now > entry.resetAt) {
      map.set(key, { count: 1, resetAt: now + window });
      return true;
    }
    if (++entry.count > limit) return false;
    return true;
  }

  function checkAuthFailLimit(ip: string): boolean {
    return checkLimit(authFailures, ip, AUTH_FAIL_LIMIT, AUTH_FAIL_WINDOW);
  }

  function checkProxyRateLimit(ip: string): boolean {
    return checkLimit(proxyRequests, ip, PROXY_RATE_LIMIT, PROXY_RATE_WINDOW);
  }

  const rateLimitCleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of authFailures) {
      if (now > entry.resetAt) authFailures.delete(ip);
    }
    for (const [ip, entry] of proxyRequests) {
      if (now > entry.resetAt) proxyRequests.delete(ip);
    }
    for (const [token, ticket] of channelTickets) {
      if (now > ticket.expiresAt) channelTickets.delete(token);
    }
  }, 5 * 60_000);

  // --- CORS ---
  const allowedOrigins = config.allowedOrigins;
  app.use((req: Request, res: Response, next: () => void) => {
    if (allowedOrigins) {
      const origin = req.headers.origin;
      if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
      }
      // Origins outside the allowlist get no CORS headers: the browser
      // blocks the cross-origin read. Non-browser clients are unaffected.
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Preserve raw bytes for proxy uploads before JSON/body-parser mutation.
  // v4 backends are proxied via streaming channels (docs/protocol-v4.md §7):
  // their request bodies must NOT be buffered, so the raw parser only runs
  // for legacy v3 backends.
  const proxyRawParser = express.raw({ type: '*/*', limit: '100mb' });
  app.use('/api/proxy', (req: Request, res: Response, next: () => void) => {
    const backendId = req.path.split('/')[1];
    const lease = backendId ? state.leases.get(backendId) : undefined;
    const backendPeer = lease ? state.peers.get(lease.peerSessionId) : undefined;
    if (backendPeer?.protocolVersion === 4) { next(); return; }
    proxyRawParser(req, res, next);
  });
  // JSON parser for gateway-own endpoints. Must NOT touch /api/proxy: the
  // v4 streaming bridge needs the raw request stream (the legacy v3 path
  // is protected by the raw parser above, but a v4 JSON request would be
  // consumed here and the bridge would never see body or end).
  const jsonParser = express.json({ limit: '15mb' });
  app.use((req: Request, res: Response, next: (err?: unknown) => void) => {
    if (req.path.startsWith('/api/proxy/')) { next(); return; }
    jsonParser(req, res, next);
  });

  // ========================================================================
  // HTTP Endpoints
  // ========================================================================

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      backends: state.registry.items.size,
      peers: state.peers.size,
    });
  });

  /**
   * Accepted Bearer token formats (must be identical across all HTTP auth paths):
   *   1. `Bearer <gatewaySecret>`          — what all current clients send
   *   2. `Bearer <clientId>:<gatewaySecret>` — legacy composite; clientId is ignored
   * A secret containing ':' still works via the whole-token comparison in (1).
   */
  function isValidGatewayToken(token: string): boolean {
    if (safeCompare(token, config.gatewaySecret)) return true;
    const colonIndex = token.indexOf(':');
    return colonIndex !== -1 && safeCompare(token.slice(colonIndex + 1), config.gatewaySecret);
  }

  /**
   * Resolved identity of a presented token.
   * 'legacy' — the shared gateway secret: full access, self-declared
   *   namespace (compatibility mode until all clients migrate).
   * 'credential' — an issued, revocable credential: namespace and
   *   capabilities derive from the server-side record, never the client.
   */
  type AuthContext =
    | { kind: 'legacy' }
    | { kind: 'credential'; credential: CredentialInfo };

  function isCredentialToken(token: string): boolean {
    return Object.values(CREDENTIAL_TOKEN_PREFIXES).some((prefix) => token.startsWith(prefix));
  }

  function resolveToken(token: string): AuthContext | null {
    if (isCredentialToken(token)) {
      const credential = storage.findValidCredential(token);
      if (!credential) return null;
      return { kind: 'credential', credential };
    }
    return isValidGatewayToken(token) ? { kind: 'legacy' } : null;
  }

  function audit(event: string, fields: Record<string, unknown>): void {
    const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`[audit] ${event} ${parts}`);
  }

  function requireGatewayAuth(req: Request, res: Response, next: () => void): void {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authorization required' } });
      return;
    }
    const auth = resolveToken(authHeader.slice(7));
    if (!auth) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
      return;
    }
    res.locals.auth = auth;
    next();
  }

  function requireRecoveryToken(req: Request, res: Response, next: () => void): void {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authorization required' } });
      return;
    }
    const token = authHeader.slice(7);
    const peerSessionId = recoveryTokens.get(token);
    const peer = peerSessionId ? state.peers.get(peerSessionId) : undefined;
    if (!peer) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid recovery token' } });
      return;
    }
    res.locals.peer = peer;
    next();
  }

  // --- Poll Recovery: Registry ---
  app.get('/sync/registry', requireRecoveryToken, (_req: Request, res: Response) => {
    const peer = res.locals.peer as PeerSession;
    res.json({ items: state.getRegistrySnapshot(peer.namespace) });
  });

  // --- Notification Config ---
  app.get('/api/notifications/config', requireGatewayAuth, (_req: Request, res: Response) => {
    try {
      const cfg = pushNotificationService.getConfig();
      res.json({ success: true, data: cfg });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Unknown error' } });
    }
  });

  app.post('/api/notifications/test', requireGatewayAuth, async (_req: Request, res: Response) => {
    try {
      await pushNotificationService.sendTest();
      res.json({ success: true, data: { message: 'Test notification sent' } });
    } catch (err) {
      res.status(400).json({ success: false, error: { code: 'NOTIFICATION_FAILED', message: err instanceof Error ? err.message : 'Failed to send test notification' } });
    }
  });

  // --- Admin: credential management (ADR-0002) ---
  function requireAdmin(req: Request, res: Response, next: () => void): void {
    if (!config.adminToken) {
      res.status(503).json({ success: false, error: { code: 'ADMIN_DISABLED', message: 'Admin API is not configured' } });
      return;
    }
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !safeCompare(authHeader.slice(7), config.adminToken)) {
      if (!checkAuthFailLimit(clientIp)) {
        res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
        return;
      }
      audit('admin.auth_failed', { ip: clientIp });
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid admin token' } });
      return;
    }
    next();
  }

  app.post('/api/admin/credentials', requireAdmin, (req: Request, res: Response) => {
    const { type, namespace, name, ttlDays } = (req.body ?? {}) as {
      type?: unknown; namespace?: unknown; name?: unknown; ttlDays?: unknown;
    };
    if (type !== 'device' && type !== 'backend') {
      res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'type must be device or backend' } });
      return;
    }
    if (typeof namespace !== 'string' || !namespace) {
      res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'namespace must be a non-empty string' } });
      return;
    }
    if (name !== undefined && typeof name !== 'string') {
      res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'name must be a string' } });
      return;
    }
    let ttlMs: number | null | undefined;
    if (ttlDays !== undefined) {
      if (ttlDays === null) {
        ttlMs = null;
      } else if (typeof ttlDays === 'number' && Number.isFinite(ttlDays) && ttlDays > 0) {
        ttlMs = ttlDays * 24 * 60 * 60 * 1000;
      } else {
        res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'ttlDays must be a positive number or null' } });
        return;
      }
    }
    const { credential, token } = storage.createCredential({
      type: type as CredentialType,
      namespace,
      name: typeof name === 'string' ? name : undefined,
      ttlMs,
    });
    audit('credential.issued', { id: credential.id, type: credential.type, namespace: credential.namespace, name: credential.name });
    res.status(201).json({ success: true, data: { ...credential, token } });
  });

  app.get('/api/admin/credentials', requireAdmin, (_req: Request, res: Response) => {
    res.json({ success: true, data: storage.listCredentials() });
  });

  app.delete('/api/admin/credentials/:id', requireAdmin, (req: Request, res: Response) => {
    const revokedIds = storage.revokeCredential(req.params.id);
    if (revokedIds.length === 0) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Credential not found or already revoked' } });
      return;
    }
    audit('credential.revoked', { ids: revokedIds.join(',') });
    // Disconnect live peers on the credential or anything exchanged from it
    const revokedSet = new Set(revokedIds);
    for (const peer of state.peers.values()) {
      if (peer.credentialId && revokedSet.has(peer.credentialId)) {
        audit('credential.peer_disconnected', { id: peer.credentialId, peerSessionId: peer.peerSessionId });
        peer.ws.close(1008, 'Credential revoked');
      }
    }
    res.json({ success: true, data: { revoked: revokedIds } });
  });

  // --- Backend enrollment -> short-lived access credential (ADR-0002) ---
  app.post('/api/backend/token', (req: Request, res: Response) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const auth = token ? resolveToken(token) : null;
    if (!auth) {
      if (!checkAuthFailLimit(clientIp)) {
        res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
        return;
      }
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
      return;
    }
    // Only enrollment credentials may be exchanged — not device tokens, not
    // already-exchanged access tokens, not the legacy shared secret.
    if (auth.kind !== 'credential' || auth.credential.type !== 'backend') {
      res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only backend enrollment credentials can be exchanged' } });
      return;
    }
    const { credential, token: accessToken } = storage.createCredential({
      type: 'backend-access',
      namespace: auth.credential.namespace,
      name: `access:${auth.credential.name || auth.credential.id}`,
      parentId: auth.credential.id,
      ttlMs: config.backendAccessTokenTtlMs,
    });
    audit('credential.exchanged', { parent: auth.credential.id, id: credential.id });
    res.status(201).json({ success: true, data: { token: accessToken, expiresAt: credential.expiresAt, namespace: credential.namespace } });
  });

  // --- HTTP Proxy ---
  const pendingHttpRequests = new Map<string, {
    resolve: (response: GatewayHttpProxyResponse | null) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
    res?: Response;
    backendId: string;
  }>();
  const pendingStreamingRequests = new Map<string, {
    res: Response; resolve: () => void; timeout: NodeJS.Timeout;
    backendId: string;
  }>();

  function abortStreamingResponse(requestId: string, res: Response, reason: string): void {
    pendingStreamingRequests.delete(requestId);
    if (!res.writableEnded && !res.destroyed) {
      res.destroy(new Error(reason));
    }
  }

  app.all('/api/proxy/:backendId/*', async (req: Request, res: Response) => {
    try {
      const { backendId } = req.params;
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

      // Check auth first, then apply appropriate rate limit
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        if (!checkAuthFailLimit(clientIp)) {
          res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
          return;
        }
        res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authorization required' } });
        return;
      }
      const auth = resolveToken(authHeader.slice(7));
      if (!auth) {
        if (!checkAuthFailLimit(clientIp)) {
          res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
          return;
        }
        res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
        return;
      }

      // Authenticated — apply generous proxy rate limit
      if (!checkProxyRateLimit(clientIp)) {
        res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
        return;
      }
      const lease = state.leases.get(backendId);
      if (!lease) {
        res.status(502).json({ success: false, error: { code: 'BACKEND_OFFLINE', message: 'Backend not found or offline' } });
        return;
      }
      // Credential-based callers may only reach backends in their own
      // namespace; answered like an offline backend to avoid an existence
      // oracle. Legacy shared-secret callers are unrestricted (compat).
      if (auth.kind === 'credential') {
        const presence = state.registry.items.get(backendId);
        if (!presence || presence.namespace !== auth.credential.namespace) {
          res.status(502).json({ success: false, error: { code: 'BACKEND_OFFLINE', message: 'Backend not found or offline' } });
          return;
        }
      }
      const backendPeer = state.peers.get(lease.peerSessionId);
      if (!backendPeer) {
        res.status(502).json({ success: false, error: { code: 'BACKEND_OFFLINE', message: 'Backend peer not found' } });
        return;
      }
      const fullPath = req.params[0] || '';
      const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      const targetPath = `/${fullPath}${queryString}`;
      const requestId = uuidv4();
      // Path logged without query string — queries may carry sensitive values.
      audit('proxy.request', { backendId, method: req.method, path: `/${fullPath}`, ip: clientIp, auth: auth.kind === 'credential' ? auth.credential.id : 'legacy' });
      // v4 backend: stream through an internal channel — no buffering, no base64.
      if (backendPeer.protocolVersion === 4) {
        proxyViaChannel(req, res, backendId, lease.epoch, backendPeer, targetPath);
        return;
      }
      const contentType = req.headers['content-type'];
      const encodedBody = ['GET', 'HEAD'].includes(req.method)
        ? {}
        : encodeProxyRequestBody(
          req.body,
          typeof contentType === 'string' ? contentType : undefined,
        );
      const proxyRequest: GatewayHttpProxyRequest = {
        type: 'http_proxy_request', requestId, method: req.method,
        path: targetPath,
        headers: {},
        ...encodedBody,
      };
      // Default-deny: only allowlisted request headers reach the backend.
      for (const headerName of PROXY_REQUEST_HEADER_ALLOWLIST) {
        const value = req.headers[headerName];
        if (typeof value === 'string') proxyRequest.headers[headerName] = value;
      }
      const clientRequestId = req.headers['x-request-id'];

      const response = await new Promise<GatewayHttpProxyResponse | null>((resolve, reject) => {
        const timeout = setTimeout(() => { pendingHttpRequests.delete(requestId); reject(new ProxyError(504, 'GATEWAY_TIMEOUT', 'Proxy request timeout')); }, proxyRequestTimeoutMs);
        pendingHttpRequests.set(requestId, { resolve, reject, timeout, res, backendId });
        sendToWs(backendPeer.ws, proxyRequest);
      });
      if (response === null) return;
      for (const [key, value] of Object.entries(filterProxyResponseHeaders(response.headers))) res.setHeader(key, value);
      if (clientRequestId) res.setHeader('x-request-id', clientRequestId);
      const responseBody = response.bodyEncoding === 'base64'
        ? Buffer.from(response.body, 'base64')
        : response.body;
      res.status(response.statusCode).send(responseBody);
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof ProxyError) {
        res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
      } else {
        res.status(500).json({ success: false, error: { code: 'PROXY_ERROR', message: 'Failed to proxy request' } });
      }
    }
  });

  app.use((_req: Request, res: Response) => { res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } }); });
  app.use((err: Error, _req: Request, res: Response, _next: () => void) => { console.error('[Gateway] Unhandled error:', err); res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }); });

  // ========================================================================
  // WebSocket Layer
  // ========================================================================

  const httpServer = createHttpServer(app);
  const sockets = new Set<Socket>();
  const wsConnectionsPerIp = new Map<string, number>();
  const MAX_WS_CONNECTIONS_PER_IP = 10;
  // Control plane (/ws) and data plane (/channel/:id) are separate WS
  // servers routed manually off the single HTTP server (ADR-0003).
  const wss = new WebSocketServer({ noServer: true, maxPayload: 50 * 1024 * 1024 });
  const channelWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  let cleanedUp = false;

  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket as Socket, head, (ws) => wss.emit('connection', ws, req));
    } else if (pathname.startsWith('/channel/')) {
      handleChannelUpgrade(req, socket as Socket, head, pathname);
    } else {
      socket.destroy();
    }
  });

  // ========================================================================
  // v4 Channels (docs/protocol-v4.md, ADR-0003)
  // ========================================================================

  interface ChannelRecord {
    channelId: string;
    backendId: string;
    epoch: number;
    kind?: string;
    clientPeerSessionId: string;
    backendPeerSessionId: string;
    clientSocket?: WebSocket;
    backendSocket?: WebSocket;
    piped: boolean;
    /** Ticket tokens, kept so teardown can invalidate unused ones. */
    ticketTokens: string[];
    pairingTimeout: NodeJS.Timeout;
    /**
     * Internal HTTP channel (docs/protocol-v4.md §7): the client end is an
     * HTTP request/response pair on the gateway itself, not a dialed socket.
     */
    onBackendSocket?: (ws: WebSocket) => void;
    internalRes?: Response;
  }

  const channels = new Map<string, ChannelRecord>();
  const channelTickets = new Map<string, { channelId: string; role: 'client' | 'backend'; expiresAt: number }>();

  function issueChannelTicket(channelId: string, role: 'client' | 'backend'): string {
    const token = crypto.randomBytes(24).toString('base64url');
    channelTickets.set(token, { channelId, role, expiresAt: Date.now() + channelTicketTtlMs });
    return token;
  }

  function countChannelsForPeer(peerSessionId: string): number {
    let count = 0;
    for (const ch of channels.values()) {
      if (ch.clientPeerSessionId === peerSessionId || ch.backendPeerSessionId === peerSessionId) count++;
    }
    return count;
  }

  function teardownChannel(channelId: string, reason: string): void {
    const ch = channels.get(channelId);
    if (!ch) return;
    channels.delete(channelId);
    clearTimeout(ch.pairingTimeout);
    for (const token of ch.ticketTokens) channelTickets.delete(token);
    // Internal HTTP channel: map the teardown reason onto the HTTP response.
    if (ch.internalRes) {
      const res = ch.internalRes;
      if (!res.headersSent) {
        const status = reason === 'timeout' ? 504 : 502;
        const code = reason === 'timeout' ? 'GATEWAY_TIMEOUT' : 'BACKEND_OFFLINE';
        res.status(status).json({ success: false, error: { code, message: `Proxy channel ${reason}` } });
      } else if (!res.writableEnded && !res.destroyed) {
        // Mid-stream failure: truncate hard rather than fake a clean end.
        res.destroy(new Error(`Proxy channel ${reason}`));
      }
    }
    for (const socket of [ch.clientSocket, ch.backendSocket]) {
      if (!socket) continue;
      // A paused (rate-limited) socket cannot complete the close handshake;
      // resume before closing so the peer's close frame gets processed.
      socket.resume();
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, reason);
      else socket.terminate();
    }
    const closedMsg = { type: 'channel_closed', channelId, reason };
    for (const sessionId of [ch.clientPeerSessionId, ch.backendPeerSessionId]) {
      const peer = state.peers.get(sessionId);
      if (peer) sendToWs(peer.ws, closedMsg);
    }
    audit('channel.closed', { channelId, reason });
  }

  function closeChannelsForBackend(backendId: string, reason: string): void {
    for (const ch of [...channels.values()]) {
      if (ch.backendId === backendId) teardownChannel(ch.channelId, reason);
    }
  }

  function closeChannelsForPeer(peerSessionId: string): void {
    for (const ch of [...channels.values()]) {
      if (ch.clientPeerSessionId === peerSessionId || ch.backendPeerSessionId === peerSessionId) {
        teardownChannel(ch.channelId, 'closed');
      }
    }
  }

  /**
   * Frame-level relay preserving the text/binary flag (a stream pipe would
   * coerce everything to binary). Backpressure: when the receiver's send
   * buffer exceeds the high-water mark, pause the sender's socket until it
   * drains — memory stays bounded per channel.
   */
  function wireChannel(ch: ChannelRecord): void {
    const a = ch.clientSocket!;
    const b = ch.backendSocket!;
    ch.piped = true;
    const HIGH_WATER = 4 * 1024 * 1024;
    const relay = (from: WebSocket, to: WebSocket) => {
      // Token bucket per direction: 1s windows, overflow pauses the sender
      // until the window resets. Frames are never split.
      const bucket = { used: 0, resetAt: 0 };
      from.on('message', (data: Buffer, isBinary: boolean) => {
        if (to.readyState !== WebSocket.OPEN) return;
        to.send(data, { binary: isBinary });
        if (channelByteRateLimit) {
          const now = Date.now();
          if (now >= bucket.resetAt) {
            // Carry overshoot into the new window so sustained throughput
            // converges to the limit (each window may overshoot by at most
            // one frame, since frames are never split).
            bucket.used = Math.max(0, bucket.used - channelByteRateLimit) + data.length;
            bucket.resetAt = now + 1000;
          } else {
            bucket.used += data.length;
          }
          if (bucket.used > channelByteRateLimit) {
            from.pause();
            // Resume unconditionally: a CLOSING socket still needs to read
            // the peer's close frame, or it wedges until the 30s ws
            // close timeout.
            setTimeout(() => from.resume(), bucket.resetAt - now);
          }
        }
        if (to.bufferedAmount > HIGH_WATER) {
          from.pause();
          const drain = setInterval(() => {
            if (to.bufferedAmount <= HIGH_WATER / 4 || to.readyState !== WebSocket.OPEN) {
              clearInterval(drain);
              from.resume();
            }
          }, 20);
        }
      });
      from.on('close', () => teardownChannel(ch.channelId, 'closed'));
      from.on('error', () => teardownChannel(ch.channelId, 'closed'));
    };
    relay(a, b);
    relay(b, a);
    audit('channel.open', { channelId: ch.channelId, backendId: ch.backendId, kind: ch.kind ?? '' });
  }

  function handleChannelUpgrade(req: IncomingMessage, socket: Socket, head: Buffer, pathname: string): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const channelId = pathname.slice('/channel/'.length);
    const token = url.searchParams.get('ticket') ?? '';
    const ticket = channelTickets.get(token);
    // One-time: consume before any further checks.
    if (ticket) channelTickets.delete(token);
    const ch = channelId ? channels.get(channelId) : undefined;
    if (!ticket || !ch || ticket.channelId !== channelId || Date.now() > ticket.expiresAt) {
      audit('channel.dial_rejected', { channelId: channelId || 'none' });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    channelWss.handleUpgrade(req, socket, head, (ws) => {
      if (!channels.has(channelId)) { ws.terminate(); return; }
      if (ticket.role === 'client') ch.clientSocket = ws;
      else ch.backendSocket = ws;
      // Internal HTTP channel: the gateway itself is the client end.
      if (ch.onBackendSocket && ch.backendSocket && !ch.piped) {
        ch.piped = true;
        clearTimeout(ch.pairingTimeout);
        ch.onBackendSocket(ch.backendSocket);
        return;
      }
      if (ch.clientSocket && ch.backendSocket && !ch.piped) {
        clearTimeout(ch.pairingTimeout);
        wireChannel(ch);
      }
    });
  }

  function handleChannelOpen(peer: PeerSession, msg: { target: string; kind?: string }): void {
    if (peer.protocolVersion !== 4) {
      sendToWs(peer.ws, { type: 'gateway_error', code: 'INVALID_MESSAGE', message: 'channel_open requires protocol v4' } satisfies GatewayErrorMessage);
      return;
    }
    const presence = state.registry.items.get(msg.target);
    const lease = state.leases.get(msg.target);
    const backendPeer = lease ? state.peers.get(lease.peerSessionId) : undefined;
    // Same non-oracle answer for nonexistent, offline, and cross-namespace.
    if (!presence || !lease || !backendPeer || presence.namespace !== peer.namespace) {
      sendToWs(peer.ws, { type: 'gateway_error', code: 'BACKEND_OFFLINE', message: `Backend ${msg.target} not found or offline` } satisfies GatewayErrorMessage);
      return;
    }
    if (countChannelsForPeer(peer.peerSessionId) >= maxChannelsPerPeer) {
      sendToWs(peer.ws, { type: 'gateway_error', code: 'RATE_LIMITED', message: 'Too many open channels' } satisfies GatewayErrorMessage);
      return;
    }
    const channelId = crypto.randomBytes(16).toString('hex');
    const clientTicket = issueChannelTicket(channelId, 'client');
    const backendTicket = issueChannelTicket(channelId, 'backend');
    const ch: ChannelRecord = {
      channelId,
      backendId: msg.target,
      epoch: lease.epoch,
      kind: msg.kind,
      clientPeerSessionId: peer.peerSessionId,
      backendPeerSessionId: lease.peerSessionId,
      piped: false,
      ticketTokens: [clientTicket, backendTicket],
      pairingTimeout: setTimeout(() => teardownChannel(channelId, 'timeout'), channelTicketTtlMs),
    };
    channels.set(channelId, ch);
    const dataPath = `/channel/${channelId}`;
    sendToWs(backendPeer.ws, { type: 'channel_offer', channelId, kind: msg.kind, sourcePeerSessionId: peer.peerSessionId, ticket: backendTicket, dataPath });
    sendToWs(peer.ws, { type: 'channel_ready', channelId, ticket: clientTicket, dataPath });
  }

  function handleChannelReject(peer: PeerSession, msg: { channelId: string; reason?: string }): void {
    const ch = channels.get(msg.channelId);
    if (!ch || ch.backendPeerSessionId !== peer.peerSessionId) return;
    teardownChannel(msg.channelId, 'rejected');
  }

  function handleChannelClose(peer: PeerSession, msg: { channelId: string }): void {
    const ch = channels.get(msg.channelId);
    if (!ch) return;
    if (ch.clientPeerSessionId !== peer.peerSessionId && ch.backendPeerSessionId !== peer.peerSessionId) return;
    teardownChannel(msg.channelId, 'closed');
  }

  /**
   * v4 HTTP streaming proxy (docs/protocol-v4.md §7): bridge an incoming
   * HTTP request onto an internal channel. The backend dials the data
   * socket as usual; the gateway's end is the req/res stream pair.
   */
  function proxyViaChannel(req: Request, res: Response, backendId: string, epoch: number, backendPeer: PeerSession, targetPath: string): void {
    if (countChannelsForPeer(backendPeer.peerSessionId) >= maxChannelsPerPeer) {
      res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many open channels' } });
      return;
    }
    const channelId = crypto.randomBytes(16).toString('hex');
    const backendTicket = issueChannelTicket(channelId, 'backend');
    const ch: ChannelRecord = {
      channelId,
      backendId,
      epoch,
      kind: 'http',
      clientPeerSessionId: '',
      backendPeerSessionId: backendPeer.peerSessionId,
      piped: false,
      ticketTokens: [backendTicket],
      pairingTimeout: setTimeout(() => teardownChannel(channelId, 'timeout'), channelTicketTtlMs),
      internalRes: res,
      onBackendSocket: (ws) => bridgeHttpChannel(ch, ws, req, res, targetPath),
    };
    channels.set(channelId, ch);
    // Client abort propagates end-to-end: response close tears the channel
    // down, which closes the backend's data socket.
    res.once('close', () => teardownChannel(channelId, 'closed'));
    sendToWs(backendPeer.ws, { type: 'channel_offer', channelId, kind: 'http', ticket: backendTicket, dataPath: `/channel/${channelId}` });
  }

  function bridgeHttpChannel(ch: ChannelRecord, ws: WebSocket, req: Request, res: Response, targetPath: string): void {
    const HIGH_WATER = 4 * 1024 * 1024;
    // --- Request direction: meta frame, then binary body frames, then end frame ---
    const requestHeaders: Record<string, string> = {};
    for (const headerName of PROXY_REQUEST_HEADER_ALLOWLIST) {
      const value = req.headers[headerName];
      if (typeof value === 'string') requestHeaders[headerName] = value;
    }
    ws.send(JSON.stringify({ type: 'http_request', method: req.method, path: targetPath, headers: requestHeaders }));
    req.on('data', (chunk: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(chunk, { binary: true });
      if (ws.bufferedAmount > HIGH_WATER) {
        req.pause();
        const drain = setInterval(() => {
          if (ws.bufferedAmount <= HIGH_WATER / 4 || ws.readyState !== WebSocket.OPEN) {
            clearInterval(drain);
            req.resume();
          }
        }, 20);
      }
    });
    req.on('end', () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'http_request_end' }));
    });

    // --- Response direction: meta frame, then binary body frames, close = end ---
    let metaReceived = false;
    let responseTimer: NodeJS.Timeout | null = setTimeout(() => teardownChannel(ch.channelId, 'timeout'), proxyRequestTimeoutMs);
    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => teardownChannel(ch.channelId, 'timeout'), proxyStreamingTimeoutMs);
    };
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!metaReceived) {
        if (responseTimer) { clearTimeout(responseTimer); responseTimer = null; }
        if (isBinary) { teardownChannel(ch.channelId, 'closed'); return; }
        let meta: { status?: unknown; headers?: Record<string, string> };
        try { meta = JSON.parse(data.toString()); } catch { teardownChannel(ch.channelId, 'closed'); return; }
        metaReceived = true;
        const status = typeof meta.status === 'number' && Number.isInteger(meta.status) && meta.status >= 100 && meta.status <= 599
          ? meta.status : 502;
        for (const [key, value] of Object.entries(filterProxyResponseHeaders(meta.headers))) res.setHeader(key, value);
        const clientRequestId = req.headers['x-request-id'];
        if (typeof clientRequestId === 'string') res.setHeader('x-request-id', clientRequestId);
        res.status(status);
        // Flush headers even for empty bodies so the client isn't left waiting.
        res.write('');
        resetIdle();
        return;
      }
      if (isBinary) {
        resetIdle();
        const writable = res.write(data);
        if (!writable) {
          ws.pause();
          res.once('drain', () => ws.resume());
        }
      }
      // Text frames after meta are reserved (trailers); ignored for now.
    });
    ws.on('close', () => {
      if (responseTimer) clearTimeout(responseTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (metaReceived) {
        // Normal completion: backend closing the socket ends the response.
        if (!res.writableEnded && !res.destroyed) res.end();
        ch.internalRes = undefined;
        teardownChannel(ch.channelId, 'closed');
      } else {
        // Socket closed before any response: surfaces as 502 via teardown.
        teardownChannel(ch.channelId, 'closed');
      }
    });
    ws.on('error', () => teardownChannel(ch.channelId, 'closed'));
  }

  // ========================================================================
  // v4 Topic broadcast (docs/protocol-v4.md §6)
  // ========================================================================

  /** backendId → topic → subscribing peerSessionIds */
  const topicSubs = new Map<string, Map<string, Set<string>>>();
  /**
   * backendId → topic → last payload published with retain: true. Delivered
   * to new subscribers on subscribe (MQTT retain semantics) so cold
   * subscribers get the current state (e.g. a resource snapshot) without a
   * request round-trip. Cleared with the backend's topics (disconnect /
   * epoch change) — stale state must not outlive its epoch.
   */
  const retainedTopics = new Map<string, Map<string, unknown>>();
  const MAX_RETAINED_TOPICS_PER_BACKEND = 64;

  function handleTopicSubscribe(peer: PeerSession, msg: { backendId: string; topic: string }): void {
    if (peer.protocolVersion !== 4) {
      sendToWs(peer.ws, { type: 'gateway_error', code: 'INVALID_MESSAGE', message: 'topic_subscribe requires protocol v4' } satisfies GatewayErrorMessage);
      return;
    }
    const presence = state.registry.items.get(msg.backendId);
    if (!presence || presence.namespace !== peer.namespace) {
      sendToWs(peer.ws, { type: 'gateway_error', code: 'BACKEND_OFFLINE', message: `Backend ${msg.backendId} not found or offline` } satisfies GatewayErrorMessage);
      return;
    }
    let topics = topicSubs.get(msg.backendId);
    if (!topics) { topics = new Map(); topicSubs.set(msg.backendId, topics); }
    let subs = topics.get(msg.topic);
    if (!subs) { subs = new Set(); topics.set(msg.topic, subs); }
    subs.add(peer.peerSessionId);
    sendToWs(peer.ws, { type: 'topic_subscribed', backendId: msg.backendId, topic: msg.topic });
    const retained = retainedTopics.get(msg.backendId)?.get(msg.topic);
    if (retained !== undefined) {
      sendToWs(peer.ws, { type: 'topic_message', backendId: msg.backendId, topic: msg.topic, payload: retained });
    }
  }

  function handleTopicUnsubscribe(peer: PeerSession, msg: { backendId: string; topic: string }): void {
    topicSubs.get(msg.backendId)?.get(msg.topic)?.delete(peer.peerSessionId);
    sendToWs(peer.ws, { type: 'topic_unsubscribed', backendId: msg.backendId, topic: msg.topic });
  }

  /** Backend publishes once; gateway fans out on its own (well-provisioned) side. */
  function handleTopicPublish(peer: PeerSession, msg: { topic: string; payload?: unknown; retain?: boolean }): void {
    if (!isCurrentBackendOwner(peer)) return;
    if (msg.retain === true && msg.payload !== undefined) {
      let retained = retainedTopics.get(peer.backendId!);
      if (!retained) { retained = new Map(); retainedTopics.set(peer.backendId!, retained); }
      if (retained.size >= MAX_RETAINED_TOPICS_PER_BACKEND && !retained.has(msg.topic)) {
        audit('topic.retain_cap', { backendId: peer.backendId!, topic: msg.topic });
      } else {
        retained.set(msg.topic, msg.payload);
      }
    }
    const subs = topicSubs.get(peer.backendId!)?.get(msg.topic);
    if (!subs || subs.size === 0) return;
    const outbound = { type: 'topic_message', backendId: peer.backendId, topic: msg.topic, payload: msg.payload };
    for (const subId of subs) {
      const subscriber = state.peers.get(subId);
      if (subscriber) sendToWs(subscriber.ws, outbound);
    }
  }

  function removeTopicSubscriptionsForPeer(peerSessionId: string): void {
    for (const topics of topicSubs.values()) {
      for (const subs of topics.values()) subs.delete(peerSessionId);
    }
  }

  function removeTopicsForBackend(backendId: string): void {
    topicSubs.delete(backendId);
    retainedTopics.delete(backendId);
  }

  httpServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  function cleanupServerResources(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(pingInterval);
    clearInterval(leaseCheckInterval);
    clearInterval(registryPollInterval);
    clearInterval(rateLimitCleanup);
    for (const ch of [...channels.values()]) teardownChannel(ch.channelId, 'closed');
    channelWss.close();
    state.destroy();
    storage.close();
  }

  const pingInterval = setInterval(() => {
    state.peers.forEach((peer, peerSessionId) => {
      if (!peer.isAlive) { console.log(`[Gateway] Peer ${peerSessionId} ping timeout`); handlePeerDisconnect(peerSessionId); return; }
      peer.isAlive = false; peer.ws.ping();
    });
  }, 30_000);

  const leaseCheckInterval = setInterval(() => {
    const now = Date.now();
    for (const [backendId, lease] of state.leases) {
      if (now - lease.lastHeartbeatAt > lease.leaseTtlMs) { console.log(`[Gateway] Backend ${backendId} lease expired`); handleBackendLeaseExpired(backendId); }
    }
  }, 5_000);

  // Periodic registry snapshot push — fallback to keep clients in sync
  const registryPollInterval = setInterval(() => {
    if (state.peers.size > 0) {
      broadcastRegistrySnapshot();
    }
  }, 30_000);

  function extractIp(req: IncomingMessage): string {
    if (trustProxy) {
      const forwarded = req.headers['x-forwarded-for']?.toString().split(',')[0].trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ip = extractIp(req);
    const currentCount = wsConnectionsPerIp.get(ip) || 0;
    if (currentCount >= MAX_WS_CONNECTIONS_PER_IP) { ws.close(1008, 'Too many connections'); return; }
    wsConnectionsPerIp.set(ip, currentCount + 1);
    let peerSessionId: string | null = null;
    const authTimeout = setTimeout(() => { if (!peerSessionId) ws.close(1008, 'Authentication timeout'); }, authTimeoutMs);

    ws.on('pong', () => { if (peerSessionId) { const peer = state.peers.get(peerSessionId); if (peer) peer.isAlive = true; } });
    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        if (!peerSessionId) {
          const validationError = validatePeerHelloMessage(message);
          if (validationError) {
            sendToWs(ws, { type: 'gateway_error', code: 'INVALID_MESSAGE', message: validationError } satisfies GatewayErrorMessage);
            ws.close(1008, 'Invalid peer_hello');
            return;
          }
          clearTimeout(authTimeout);
          peerSessionId = handlePeerHello(ws, message as PeerHelloMessage);
          return;
        }
        handlePeerMessage(peerSessionId, message);
      } catch (error) {
        console.error('[Gateway] Message parse error:', error);
        sendToWs(ws, { type: 'gateway_error', code: 'INVALID_MESSAGE', message: 'Invalid message format' } satisfies GatewayErrorMessage);
        if (!peerSessionId) {
          ws.close(1008, 'Invalid message format');
        }
      }
    });
    ws.on('close', () => {
      clearTimeout(authTimeout);
      const count = wsConnectionsPerIp.get(ip) || 1;
      if (count <= 1) wsConnectionsPerIp.delete(ip); else wsConnectionsPerIp.set(ip, count - 1);
      if (peerSessionId) handlePeerDisconnect(peerSessionId);
    });
    ws.on('error', (error) => { console.error('[Gateway] WebSocket error:', error); });
  });

  wss.on('close', cleanupServerResources);

  const originalClose = httpServer.close.bind(httpServer);
  httpServer.close = ((callback?: (err?: Error) => void) => {
    let callbackCalled = false;
    let pendingClosers = 0;
    let closeError: Error | undefined;

    const finishClose = () => {
      if (callbackCalled || pendingClosers > 0) return;
      callbackCalled = true;
      if (!cleanedUp) {
        cleanupServerResources();
      }
      callback?.(closeError);
    };

    const registerCloser = (closeFn: (done: (err?: Error) => void) => void) => {
      pendingClosers += 1;
      closeFn((err?: Error) => {
        if (err && !closeError) {
          closeError = err;
        }
        pendingClosers -= 1;
        finishClose();
      });
    };

    for (const client of wss.clients) {
      client.terminate();
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    httpServer.closeAllConnections?.();
    httpServer.closeIdleConnections?.();

    registerCloser((done) => {
      try {
        wss.close(() => done());
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)));
      }
    });

    registerCloser((done) => {
      try {
        originalClose((err?: Error) => done(err));
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)));
      }
    });

    if (isVitestProcess()) {
      setTimeout(() => {
        pendingClosers = 0;
        finishClose();
      }, 50).unref();
    }

    finishClose();
    return httpServer;
  }) as typeof httpServer.close;

  // ========================================================================
  // Peer Hello
  // ========================================================================

  function handlePeerHello(ws: WebSocket, message: PeerHelloMessage): string | null {
    // The gatewaySecret field carries either the legacy shared secret or an
    // issued credential token (zgd_/zgb_ prefix).
    const auth = resolveToken(message.gatewaySecret);
    if (!auth) {
      audit('peer.auth_failed', { namespace: message.namespace, peerType: message.peerType });
      sendToWs(ws, { type: 'gateway_error', code: 'UNAUTHORIZED', message: 'Invalid gateway secret' } satisfies GatewayErrorMessage); ws.close(); return null;
    }
    if (auth.kind === 'credential') {
      // Namespace derives from the server-side credential record; a declared
      // namespace that disagrees is an error, never a grant.
      if (auth.credential.namespace !== message.namespace) {
        audit('peer.namespace_mismatch', { credentialId: auth.credential.id, declared: message.namespace });
        sendToWs(ws, { type: 'gateway_error', code: 'UNAUTHORIZED', message: 'Namespace not permitted by credential' } satisfies GatewayErrorMessage); ws.close(); return null;
      }
      // A device credential must never be able to register (or impersonate) a backend.
      if (message.peerType === 'client+backend' && auth.credential.type !== 'backend' && auth.credential.type !== 'backend-access') {
        audit('peer.backend_registration_denied', { credentialId: auth.credential.id });
        sendToWs(ws, { type: 'gateway_error', code: 'UNAUTHORIZED', message: 'This credential cannot register a backend' } satisfies GatewayErrorMessage); ws.close(); return null;
      }
    }
    if (message.protocolVersion !== 3 && message.protocolVersion !== 4) {
      sendToWs(ws, { type: 'gateway_error', code: 'PROTOCOL_VERSION_MISMATCH', message: `Expected protocol version 3 or 4, got ${message.protocolVersion}` } satisfies GatewayErrorMessage); ws.close(); return null;
    }
    const peerSessionId = uuidv4();
    const recoveryToken = crypto.randomBytes(32).toString('hex');
    const { identity, peerType } = message;
    const channel = identity.channel || 'prod';
    const peer: PeerSession = {
      peerSessionId,
      ws,
      protocolVersion: message.protocolVersion as 3 | 4,
      peerType,
      namespace: message.namespace,
      credentialId: auth.kind === 'credential' ? auth.credential.id : undefined,
      deviceId: identity.deviceId,
      instanceId: identity.instanceId,
      channel,
      name: identity.name || '',
      recoveryToken,
      isAlive: true,
      subscribedBackends: new Set()
    };

    let backendInfo: PeerReadyMessage['backend'] | undefined;
    if (peerType === 'client+backend' && message.backend) {
      // v4: UUID keyed by (namespace, instance, environment); v3: legacy
      // instance-keyed short IDs, unchanged for wire compatibility.
      const backendId = peer.protocolVersion === 4
        ? storage.getOrCreateBackendIdV4({ namespace: message.namespace, instanceId: identity.instanceId, environment: channel, name: identity.name })
        : storage.getOrCreateBackendIdByInstance(identity.instanceId, identity.deviceId, channel, identity.name);
      const previousLease = state.leases.get(backendId);
      const epoch = storage.allocateEpoch();
      peer.backendId = backendId; peer.epoch = epoch;
      if (previousLease && (previousLease.peerSessionId !== peerSessionId || previousLease.epoch !== epoch)) {
        handleBackendOwnerReplaced(backendId, previousLease.epoch, epoch, previousLease.peerSessionId);
      }
      state.addLease({ backendId, epoch, peerSessionId, leaseTtlMs: state.config.defaultLeaseTtlMs, lastHeartbeatAt: Date.now(), leaseTimer: null });
      const presence: BackendPresence = { namespace: message.namespace, backendId, instanceId: identity.instanceId, deviceId: identity.deviceId, name: identity.name || '', channel, visible: message.backend.visible, capabilities: message.backend.capabilities, backendProtocolVersion: message.backend.backendProtocolVersion, minClientProtocolVersion: message.backend.minClientProtocolVersion, epoch, connectedAt: Date.now(), lastSeenAt: Date.now() };
      state.registryUpsert(presence);
      state.streamDemand.set(backendId, { subscriberCount: 0, active: false });
      backendInfo = { backendId, epoch, leaseTtlMs: state.config.defaultLeaseTtlMs };
    }

    state.addPeer(peer);
    recoveryTokens.set(recoveryToken, peerSessionId);
    const registrySync: RegistrySyncPayload = { items: state.getRegistrySnapshot(peer.namespace) };
    const ready: PeerReadyMessage = { type: 'peer_ready', protocolVersion: peer.protocolVersion, peerSessionId, recoveryToken, backend: backendInfo, registrySync };
    sendToWs(ws, ready);

    if (peer.backendId) {
      broadcastRegistrySnapshot(peerSessionId);
    }
    audit('peer.connected', {
      peerSessionId,
      namespace: peer.namespace,
      peerType,
      backendId: peer.backendId ?? 'none',
      credentialId: peer.credentialId ?? 'legacy',
    });
    return peerSessionId;
  }

  // ========================================================================
  // Message Router
  // ========================================================================

  function handlePeerMessage(peerSessionId: string, message: any): void {
    const peer = state.peers.get(peerSessionId);
    if (!peer) return;
    const validationError = validateGatewayMessage(message);
    if (validationError) {
      audit('message.invalid', { peerSessionId, type: message?.type, error: validationError });
      sendToWs(peer.ws, { type: 'gateway_error', code: 'INVALID_MESSAGE', message: validationError } satisfies GatewayErrorMessage);
      return;
    }
    switch (message.type) {
      case 'backend_heartbeat': handleBackendHeartbeat(peer, message); break;
      case 'backend_resource_snapshot': handleBackendResourceSnapshot(peer, message); break;
      case 'backend_resource_event': handleBackendResourceEvent(peer, message); break;
      case 'backend_stream_event': handleBackendStreamEvent(peer, message); break;
      case 'request_registry_snapshot': handleRequestRegistrySnapshot(peer); break;
      case 'request_backend_resource_snapshot': handleRequestBackendResourceSnapshot(peer, message); break;
      case 'subscribe_backend': handleSubscribeBackend(peer, message); break;
      case 'unsubscribe_backend': handleUnsubscribeBackend(peer, message); break;
      case 'backend_client_message': handleBackendClientMessage(peer, message); break;
      case 'backend_server_message': handleBackendServerMessage(peer, message); break;
      case 'content_patch': handleContentPatch(peer, message); break;
      case 'content_patch_error': handleContentPatchError(peer, message); break;
      case 'catch_up_content': handleCatchUpContent(peer, message); break;
      case 'http_proxy_response': handleHttpProxyResponse(peer, message); break;
      case 'http_proxy_response_start': handleHttpProxyResponseStart(peer, message); break;
      case 'http_proxy_response_chunk': handleHttpProxyResponseChunk(peer, message); break;
      case 'http_proxy_response_end': handleHttpProxyResponseEnd(peer, message); break;
      case 'push_notification_request': handlePushNotificationRequest(peer, message); break;
      case 'channel_open': handleChannelOpen(peer, message); break;
      case 'channel_reject': handleChannelReject(peer, message); break;
      case 'channel_close': handleChannelClose(peer, message); break;
      case 'topic_subscribe': handleTopicSubscribe(peer, message); break;
      case 'topic_unsubscribe': handleTopicUnsubscribe(peer, message); break;
      case 'topic_publish': handleTopicPublish(peer, message); break;
      case 'ping': sendToWs(peer.ws, { type: 'pong', ts: message.ts }); break;
      default: sendToWs(peer.ws, { type: 'gateway_error', code: 'INVALID_MESSAGE', message: `Unknown message type: ${message.type}` } satisfies GatewayErrorMessage);
    }
  }

  // ========================================================================
  // Backend Message Handlers
  // ========================================================================

  function handleBackendHeartbeat(peer: PeerSession, msg: BackendHeartbeatMessage): void {
    if (!isCurrentBackendOwner(peer, msg.epoch)) return;
    const backendId = peer.backendId!;
    const lease = state.leases.get(backendId);
    if (!lease) return;
    lease.lastHeartbeatAt = Date.now();
    const presence = state.registry.items.get(backendId);
    if (presence) presence.lastSeenAt = Date.now();
    sendToWs(peer.ws, { type: 'heartbeat_ack', epoch: msg.epoch, streamDemand: state.getStreamDemand(backendId) } satisfies HeartbeatAckMessage);
  }

  /**
   * Relay a backend's resource snapshot/event to its subscribers.
   * If the message carries targetPeerSessionId (additive, not yet in the
   * protocol types), deliver only to that subscriber — this lets backends
   * answer snapshot requests without broadcasting to everyone.
   */
  function relayToSubscribers(peer: PeerSession, msg: BackendResourceSnapshotMessage | BackendResourceEventMessage): void {
    if (!isCurrentBackendOwner(peer)) return;
    const backendId = peer.backendId!;
    const subscribers = state.getSubscribers(backendId);
    const relayMsg = { ...msg, backendId };
    const target = (msg as { targetPeerSessionId?: string }).targetPeerSessionId;
    if (target) {
      if (!subscribers.has(target)) return;
      const p = state.peers.get(target);
      if (p) sendToWs(p.ws, relayMsg);
      return;
    }
    for (const subId of subscribers) {
      const p = state.peers.get(subId);
      if (p) sendToWs(p.ws, relayMsg);
    }
  }

  function handleBackendResourceSnapshot(peer: PeerSession, msg: BackendResourceSnapshotMessage): void {
    relayToSubscribers(peer, msg);
  }

  function handleBackendResourceEvent(peer: PeerSession, msg: BackendResourceEventMessage): void {
    relayToSubscribers(peer, msg);
  }

  function handleBackendStreamEvent(peer: PeerSession, msg: BackendStreamEvent): void {
    if (!isCurrentBackendOwner(peer)) return;
    const backendId = peer.backendId!;
    const subscribers = state.getSubscribers(backendId);
    if (subscribers.size === 0) return;
    const clientEvent: GatewayStreamEvent = { type: 'backend_stream_event', backendId, streamId: msg.streamId, eventName: msg.eventName, seq: msg.seq, channel: msg.channel, payload: msg.payload, metadata: msg.metadata };
    for (const subId of subscribers) {
      const clientPeer = state.peers.get(subId);
      if (clientPeer) sendToWs(clientPeer.ws, clientEvent);
    }
  }

  // ========================================================================
  // Client Message Handlers
  // ========================================================================

  function handleRequestRegistrySnapshot(peer: PeerSession): void {
    sendToWs(peer.ws, { type: 'registry_snapshot', items: state.getRegistrySnapshot(peer.namespace) } satisfies RegistrySnapshotMessage);
  }

  function handleRequestBackendResourceSnapshot(peer: PeerSession, msg: RequestBackendResourceSnapshotMessage): void {
    // Only subscribers may ask a backend for a snapshot (subscription is
    // namespace-gated at subscribe time, so this transitively enforces
    // namespace isolation too).
    if (!state.getSubscribers(msg.backendId).has(peer.peerSessionId)) {
      sendToWs(peer.ws, { type: 'gateway_error', code: 'BACKEND_NOT_SUBSCRIBED', message: 'Not subscribed to backend', recovery: 'resubscribe' } satisfies GatewayErrorMessage);
      return;
    }
    const bp = findBackendPeer(msg.backendId);
    if (!bp) {
      sendToWs(peer.ws, { type: 'gateway_error', code: 'BACKEND_OFFLINE', message: `Backend ${msg.backendId} not found or offline`, recovery: 'reconnect' } satisfies GatewayErrorMessage);
      return;
    }
    // Pin the target to the requesting peer: a client must not be able to
    // direct another subscriber's snapshot refresh.
    sendToWs(bp.ws, { type: 'request_backend_resource_snapshot', backendId: msg.backendId, resourceTypes: msg.resourceTypes, targetPeerSessionId: peer.peerSessionId } satisfies RequestBackendResourceSnapshotMessage);
  }

  function handleSubscribeBackend(peer: PeerSession, msg: SubscribeBackendMessage): void {
    const presence = state.registry.items.get(msg.backendId);
    // Cross-namespace subscription is answered exactly like a nonexistent
    // backend so the response is not an existence oracle for other namespaces.
    if (!presence || presence.namespace !== peer.namespace) {
      sendToWs(peer.ws, { type: 'gateway_error', code: 'BACKEND_OFFLINE', message: `Backend ${msg.backendId} not found or offline`, recovery: 'reconnect' } satisfies GatewayErrorMessage);
      return;
    }
    const lease = state.leases.get(msg.backendId);
    if (!lease) {
      sendToWs(peer.ws, { type: 'gateway_error', code: 'BACKEND_OFFLINE', message: `Backend ${msg.backendId} not found or offline`, recovery: 'reconnect' } satisfies GatewayErrorMessage);
      return;
    }
    // Check if this peer is already subscribed before adding
    const alreadySubscribed = peer.subscribedBackends.has(msg.backendId);
    if (!alreadySubscribed) audit('backend.subscribed', { peerSessionId: peer.peerSessionId, backendId: msg.backendId });
    const demandChanged = state.addSubscription(msg.backendId, peer.peerSessionId);
    if (demandChanged) {
      const bp = findBackendPeer(msg.backendId);
      if (bp) sendToWs(bp.ws, { type: 'backend_stream_demand', active: true } satisfies StreamDemandMessage);
    }
    sendToWs(peer.ws, { type: 'backend_subscribed', backendId: msg.backendId, epoch: lease.epoch, capabilities: presence.capabilities } satisfies BackendSubscribedMessage);
    // Request a fresh data snapshot for new subscriptions.
    // Duplicate subscribe_backend from the same peer should not trigger
    // redundant full snapshots that get broadcast to all existing subscribers.
    if (!alreadySubscribed) {
      const bp = findBackendPeer(msg.backendId);
      if (bp) {
        sendToWs(bp.ws, {
          type: 'request_backend_resource_snapshot',
          backendId: msg.backendId,
          targetPeerSessionId: peer.peerSessionId,
        } satisfies RequestBackendResourceSnapshotMessage);
      }
    }
  }

  function handleUnsubscribeBackend(peer: PeerSession, msg: UnsubscribeBackendMessage): void {
    audit('backend.unsubscribed', { peerSessionId: peer.peerSessionId, backendId: msg.backendId });
    const demandChanged = state.removeSubscription(msg.backendId, peer.peerSessionId);
    sendToWs(peer.ws, { type: 'backend_unsubscribed', backendId: msg.backendId, reason: 'client_unsubscribed' } satisfies BackendUnsubscribedMessage);
    // Notify backend to clean up this client's server-side state (virtualClient, terminal, etc.)
    const bp = findBackendPeer(msg.backendId);
    if (bp) {
      sendToWs(bp.ws, { type: 'subscriber_disconnected', backendId: msg.backendId, peerSessionId: peer.peerSessionId } satisfies SubscriberDisconnectedMessage);
    }
    if (demandChanged && bp) {
      sendToWs(bp.ws, { type: 'backend_stream_demand', active: false } satisfies StreamDemandMessage);
    }
  }

  function handleBackendClientMessage(peer: PeerSession, msg: BackendClientMessage): void {
    const subscribers = state.getSubscribers(msg.backendId);
    if (!subscribers.has(peer.peerSessionId)) {
      sendToWs(peer.ws, { type: 'gateway_error', code: 'BACKEND_NOT_SUBSCRIBED', message: 'Not subscribed to backend', recovery: 'resubscribe' } satisfies GatewayErrorMessage);
      return;
    }
    const backendPeer = findBackendPeer(msg.backendId);
    if (!backendPeer) {
      sendToWs(peer.ws, { type: 'gateway_error', code: 'BACKEND_OFFLINE', message: 'Backend offline', recovery: 'reconnect' } satisfies GatewayErrorMessage);
      return;
    }
    // Attach sender identity so backend can distinguish different clients
    sendToWs(backendPeer.ws, { ...msg, sourcePeerSessionId: peer.peerSessionId });
  }

  function handleBackendServerMessage(peer: PeerSession, msg: BackendServerMessage): void {
    if (!isCurrentBackendOwner(peer)) return;
    const backendId = peer.backendId!;
    if (msg.backendId !== backendId) return;

    // If targetPeerSessionId is set, route to that specific client — but only
    // if the target is actually subscribed to this backend. Without this
    // check a backend could message arbitrary peers (including peers in
    // other namespaces) by guessing session IDs.
    if (msg.targetPeerSessionId) {
      if (!state.getSubscribers(backendId).has(msg.targetPeerSessionId)) return;
      const targetPeer = state.peers.get(msg.targetPeerSessionId);
      if (targetPeer) sendToWs(targetPeer.ws, msg);
      return;
    }

    // Otherwise broadcast to all subscribers
    const subscribers = state.getSubscribers(backendId);
    for (const subId of subscribers) {
      const clientPeer = state.peers.get(subId);
      if (clientPeer) sendToWs(clientPeer.ws, msg);
    }
  }

  function handleContentPatch(peer: PeerSession, msg: ContentPatchMessage): void {
    if (!isCurrentBackendOwner(peer)) return;
    const backendId = peer.backendId!;
    if (msg.backendId !== backendId) return;
    const subscribers = state.getSubscribers(backendId);
    for (const subId of subscribers) {
      const clientPeer = state.peers.get(subId);
      if (clientPeer) sendToWs(clientPeer.ws, msg);
    }
  }

  function handleContentPatchError(peer: PeerSession, msg: ContentPatchErrorMessage): void {
    if (!isCurrentBackendOwner(peer)) return;
    const backendId = peer.backendId!;
    if (msg.backendId !== backendId) return;
    const subscribers = state.getSubscribers(backendId);
    for (const subId of subscribers) {
      const clientPeer = state.peers.get(subId);
      if (clientPeer) sendToWs(clientPeer.ws, msg);
    }
  }

  function handleCatchUpContent(peer: PeerSession, msg: CatchUpContentMessage): void {
    const subscribers = state.getSubscribers(msg.backendId);
    if (!subscribers.has(peer.peerSessionId)) {
      sendToWs(peer.ws, { type: 'gateway_error', code: 'BACKEND_NOT_SUBSCRIBED', message: 'Not subscribed to backend', recovery: 'resubscribe' } satisfies GatewayErrorMessage); return;
    }
    const bp = findBackendPeer(msg.backendId);
    if (!bp) { sendToWs(peer.ws, { type: 'gateway_error', code: 'BACKEND_OFFLINE', message: 'Backend offline', recovery: 'reconnect' } satisfies GatewayErrorMessage); return; }
    sendToWs(bp.ws, { type: 'catch_up_content', backendId: msg.backendId, contentStreamId: msg.contentStreamId, afterOffset: msg.afterOffset } satisfies CatchUpContentMessage);
  }

  // ========================================================================
  // HTTP Proxy Response Handlers
  // ========================================================================

  /**
   * A proxy response is only accepted from the current owner of the backend
   * the request was sent to. Anything else (another peer guessing request
   * IDs, a stale pre-epoch-change backend) is dropped.
   */
  function ownsProxyRequest(peer: PeerSession, backendId: string): boolean {
    return peer.backendId === backendId && isCurrentBackendOwner(peer);
  }

  function handleHttpProxyResponse(peer: PeerSession, msg: GatewayHttpProxyResponse): void {
    const pending = pendingHttpRequests.get(msg.requestId);
    if (!pending || !ownsProxyRequest(peer, pending.backendId)) return;
    clearTimeout(pending.timeout); pendingHttpRequests.delete(msg.requestId); pending.resolve(msg);
  }
  function handleHttpProxyResponseStart(peer: PeerSession, msg: GatewayHttpProxyResponseStart): void {
    const pending = pendingHttpRequests.get(msg.requestId);
    if (!pending?.res) return;
    if (!ownsProxyRequest(peer, pending.backendId)) return;
    clearTimeout(pending.timeout); pendingHttpRequests.delete(msg.requestId);
    const res = pending.res;
    for (const [key, value] of Object.entries(filterProxyResponseHeaders(msg.headers))) res.setHeader(key, value);
    res.status(msg.statusCode);
    const streamTimeout = setTimeout(() => { abortStreamingResponse(msg.requestId, res, 'Proxy streaming timeout'); }, proxyStreamingTimeoutMs);
    res.once('close', () => {
      const streaming = pendingStreamingRequests.get(msg.requestId);
      if (!streaming) return;
      clearTimeout(streaming.timeout);
      pendingStreamingRequests.delete(msg.requestId);
    });
    pendingStreamingRequests.set(msg.requestId, { res, resolve: pending.resolve as unknown as () => void, timeout: streamTimeout, backendId: pending.backendId });
    pending.resolve(null);
  }
  function handleHttpProxyResponseChunk(peer: PeerSession, msg: GatewayHttpProxyResponseChunk): void {
    const streaming = pendingStreamingRequests.get(msg.requestId);
    if (!streaming) return;
    if (!ownsProxyRequest(peer, streaming.backendId)) return;
    if (streaming.res.writableEnded || streaming.res.destroyed) {
      pendingStreamingRequests.delete(msg.requestId);
      clearTimeout(streaming.timeout);
      return;
    }
    clearTimeout(streaming.timeout);
    streaming.timeout = setTimeout(() => { abortStreamingResponse(msg.requestId, streaming.res, 'Proxy streaming timeout'); }, proxyStreamingTimeoutMs);
    streaming.res.write(Buffer.from(msg.data, 'base64'));
  }
  function handleHttpProxyResponseEnd(peer: PeerSession, msg: GatewayHttpProxyResponseEnd): void {
    const streaming = pendingStreamingRequests.get(msg.requestId);
    if (!streaming) return;
    if (!ownsProxyRequest(peer, streaming.backendId)) return;
    clearTimeout(streaming.timeout); pendingStreamingRequests.delete(msg.requestId);
    if (!streaming.res.writableEnded) streaming.res.end(); streaming.resolve();
  }

  // ========================================================================
  // Push Notification
  // ========================================================================

  function handlePushNotificationRequest(peer: PeerSession, msg: PushNotificationRequestMessage): void {
    if (!peer.backendId) {
      sendToWs(peer.ws, {
        type: 'gateway_error',
        code: 'INVALID_MESSAGE',
        message: 'push_notification_request is only allowed from backends',
      } satisfies GatewayErrorMessage);
      return;
    }
    void pushNotificationService.notify(msg.event);
  }

  // ========================================================================
  // Lease & Cleanup
  // ========================================================================

  function handleBackendLeaseExpired(backendId: string): void {
    const lease = state.leases.get(backendId);
    if (!lease) return;
    const peer = state.peers.get(lease.peerSessionId);
    closeChannelsForBackend(backendId, 'backend_offline');
    removeTopicsForBackend(backendId);
    rejectPendingProxyRequests(backendId);
    notifySubscribersBackendGone(backendId, 'backend_offline');
    state.registryRemove(backendId);
    broadcastRegistrySnapshot();
    state.removeBackend(backendId);
    if (peer) {
      peer.backendId = undefined;
      peer.epoch = undefined;
      // Clean up this peer's client-side subscriptions and notify backends of demand changes
      const affectedBackends = state.removeAllSubscriptions(peer.peerSessionId);
      for (const bid of affectedBackends) {
        if (!state.getStreamDemand(bid)) {
          const bp = findBackendPeer(bid);
          if (bp) sendToWs(bp.ws, { type: 'backend_stream_demand', active: false } satisfies StreamDemandMessage);
        }
      }
      peer.ws.terminate();
      unregisterRecoveryToken(peer);
      state.removePeer(peer.peerSessionId);
    }
  }

  function rejectPendingProxyRequests(backendId: string): void {
    for (const [requestId, pending] of pendingHttpRequests) {
      if (pending.backendId === backendId) {
        clearTimeout(pending.timeout);
        pendingHttpRequests.delete(requestId);
        pending.reject(new ProxyError(502, 'BACKEND_OFFLINE', 'Backend disconnected'));
      }
    }
    for (const [requestId, streaming] of pendingStreamingRequests) {
      if (streaming.backendId === backendId) {
        abortStreamingResponse(requestId, streaming.res, 'Backend disconnected');
      }
    }
  }

  function handlePeerDisconnect(peerSessionId: string): void {
    const peer = state.peers.get(peerSessionId);
    if (!peer) return;
    audit('peer.disconnected', { peerSessionId, namespace: peer.namespace, backendId: peer.backendId ?? 'none' });
    if (peer.backendId && isCurrentBackendOwner(peer)) {
      // Close backend-side channels first so they carry backend_offline,
      // not the generic per-peer 'closed' from the cleanup below.
      closeChannelsForBackend(peer.backendId, 'backend_offline');
      rejectPendingProxyRequests(peer.backendId);
      notifySubscribersBackendGone(peer.backendId, 'backend_offline');
      state.registryRemove(peer.backendId);
      broadcastRegistrySnapshot(peerSessionId);
      state.removeBackend(peer.backendId);
    }
    // Close any remaining channels where this peer is the client end
    closeChannelsForPeer(peerSessionId);
    removeTopicSubscriptionsForPeer(peerSessionId);
    if (peer.backendId) removeTopicsForBackend(peer.backendId);
    // Clean up this peer's subscriptions: notify backends and update stream demand
    const affectedBackends = state.removeAllSubscriptions(peerSessionId);
    for (const backendId of affectedBackends) {
      const bp = findBackendPeer(backendId);
      if (bp) {
        // Notify backend to clean up this client's server-side state
        sendToWs(bp.ws, { type: 'subscriber_disconnected', backendId, peerSessionId } satisfies SubscriberDisconnectedMessage);
        if (!state.getStreamDemand(backendId)) {
          sendToWs(bp.ws, { type: 'backend_stream_demand', active: false } satisfies StreamDemandMessage);
        }
      }
    }
    peer.ws.terminate();
    unregisterRecoveryToken(peer);
    state.removePeer(peerSessionId);
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  function broadcastRegistrySnapshot(excludePeerSessionId?: string): void {
    // Each peer only ever sees its own namespace's slice of the registry.
    const perNamespace = new Map<string, RegistrySnapshotMessage>();
    for (const peer of state.peers.values()) {
      if (peer.peerSessionId === excludePeerSessionId) continue;
      let msg = perNamespace.get(peer.namespace);
      if (!msg) {
        msg = { type: 'registry_snapshot', items: state.getRegistrySnapshot(peer.namespace) };
        perNamespace.set(peer.namespace, msg);
      }
      sendToWs(peer.ws, msg);
    }
  }

  function notifySubscribersBackendGone(backendId: string, reason: BackendUnsubscribedMessage['reason']): void {
    const subscribers = state.getSubscribers(backendId);
    for (const subId of subscribers) {
      const clientPeer = state.peers.get(subId);
      if (clientPeer) {
        sendToWs(clientPeer.ws, { type: 'backend_unsubscribed', backendId, reason } satisfies BackendUnsubscribedMessage);
      }
    }
    // Clean up all subscriptions for this backend
    for (const subId of [...subscribers]) {
      state.removeSubscription(backendId, subId);
    }
  }

  function findBackendPeer(backendId: string): PeerSession | undefined {
    const lease = state.leases.get(backendId);
    if (!lease) return undefined;
    return state.peers.get(lease.peerSessionId);
  }

  function isCurrentBackendOwner(peer: PeerSession, expectedEpoch?: number): boolean {
    if (!peer.backendId || peer.epoch == null) return false;
    if (expectedEpoch !== undefined && peer.epoch !== expectedEpoch) return false;
    const lease = state.leases.get(peer.backendId);
    return lease?.peerSessionId === peer.peerSessionId && lease.epoch === peer.epoch;
  }

  function unregisterRecoveryToken(peer: PeerSession): void {
    recoveryTokens.delete(peer.recoveryToken);
  }

  function handleBackendOwnerReplaced(
    backendId: string,
    previousEpoch: number,
    nextEpoch: number,
    previousPeerSessionId: string,
  ): void {
    // v4: the gateway is the authority on epoch invalidation — all channels
    // bound to the previous epoch are closed here, not inferred client-side.
    closeChannelsForBackend(backendId, 'epoch_changed');
    removeTopicsForBackend(backendId);
    notifySubscribersBackendGone(backendId, 'epoch_changed');
    state.removeLease(backendId);

    const previousPeer = state.peers.get(previousPeerSessionId);
    if (previousPeer) {
      previousPeer.backendId = undefined;
      previousPeer.epoch = undefined;
      previousPeer.ws.terminate();
    }
  }

  return httpServer;
}
