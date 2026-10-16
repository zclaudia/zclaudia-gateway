/**
 * Gateway Protocol v4 — Server Implementation
 *
 * Wire spec: docs/protocol-v4.md; behavior is pinned by the tests in
 * src/__tests__/. See README.md for an overview.
 */

import { createServer as createHttpServer, IncomingMessage, Server } from 'http';
import type { Socket } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import path from 'node:path';
import express, { Request, Response } from 'express';
import type {
  BackendHeartbeatMessage,
  BackendPresenceV4,
  BackendServerMessage,
  GatewayErrorV4,
  HeartbeatAckMessage,
  PeerHelloV4,
  PeerReadyV4,
  RegistrySnapshotV4,
} from '@zclaudia/gateway-protocol';
import { GATEWAY_CLOSE_BACKEND_REPLACED } from '@zclaudia/gateway-protocol';
import type {
  GatewayNotificationConfig as NotificationConfig,
  PushNotificationRequestMessage,
} from '@zclaudia/gateway-protocol/notifications';
import { GatewayStorage, CREDENTIAL_TOKEN_PREFIXES, type CredentialInfo, type CredentialType } from './storage.js';
import { validateGatewayMessage, filterProxyResponseHeaders, PROXY_REQUEST_HEADER_ALLOWLIST } from './validation.js';
import { GatewayState, type PeerSession } from './state.js';
import { GatewayPushNotificationService } from './push-notification.js';
import { AdminSessionStore, ADMIN_SESSION_COOKIE, readSessionCookie } from './admin-session.js';

/** How long a replaced backend gets to answer the close handshake before it is terminated. */
const REPLACED_CLOSE_GRACE_MS = 2000;

// ============================================================================
// Config & Helpers
// ============================================================================

interface GatewayConfig {
  /**
   * Admin token for the credential management API (/api/admin/*). Required:
   * issued credentials are the only authentication, so without the admin API
   * no peer could ever connect.
   */
  adminToken: string;
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
  /**
   * Max authenticated proxied requests per client IP per 60s window. The
   * mobile embedded console spends ~15 requests per page navigation (static
   * assets included) plus ~0.5Hz polling, so the default is set above bursts
   * of normal multi-device usage.
   */
  proxyRateLimit?: number;
  /** Trust X-Forwarded-For header for IP extraction. Only enable behind a trusted reverse proxy. */
  trustProxy?: boolean;
  /**
   * CORS Origin allowlist. When set, only listed origins receive CORS
   * headers (echoed origin, credentials allowed). When unset, keeps the
   * legacy wildcard behavior for backward compatibility.
   */
  allowedOrigins?: string[];
  /** Serve the admin web UI static bundle from this directory at /admin. Unset = API-only (ADR-0005). */
  adminStaticDir?: string;
  /** Admin web UI session TTL. Default 12h. Fixed expiry, no sliding renewal. */
  adminSessionTtlMs?: number;
  /** Storage override (tests); default opens the data-dir database. Closed with the server. */
  storage?: GatewayStorage;
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

function validatePeerHelloV4(message: unknown): string | null {
  if (!message || typeof message !== 'object') return 'peer_hello must be an object';
  const msg = message as Record<string, unknown>;
  if (msg.type !== 'peer_hello') return 'First message must be peer_hello';
  if (typeof msg.gatewaySecret !== 'string') return 'peer_hello.gatewaySecret must be a string';
  if (typeof msg.protocolVersion !== 'number') return 'peer_hello.protocolVersion must be a number';
  if (typeof msg.namespace !== 'string' || !msg.namespace) return 'peer_hello.namespace must be a non-empty string';
  if (typeof msg.clientProtocolVersion !== 'number') return 'peer_hello.clientProtocolVersion must be a number';
  if (msg.peerType !== 'client-only' && msg.peerType !== 'client+backend') {
    return 'peer_hello.peerType must be client-only or client+backend';
  }
  // identity is descriptive except for legacy backend credentials, whose
  // instanceId is enforced after authentication (ADR-0009).
  if (msg.identity !== undefined) {
    if (!msg.identity || typeof msg.identity !== 'object') return 'peer_hello.identity must be an object';
    const identity = msg.identity as Record<string, unknown>;
    for (const field of ['deviceId', 'instanceId', 'channel', 'name']) {
      if (identity[field] !== undefined && typeof identity[field] !== 'string') return `peer_hello.identity.${field} must be a string`;
    }
  }
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
  if (!config.adminToken) {
    throw new Error('adminToken is required: issued credentials are the only authentication');
  }
  const storage = config.storage ?? new GatewayStorage();
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
  const adminSessions = new AdminSessionStore(config.adminSessionTtlMs ?? 12 * 60 * 60 * 1000);

  const app = express();
  app.disable('x-powered-by');

  // --- Rate limiting ---
  // Strict limit for failed auth attempts (brute-force protection)
  const authFailures = new Map<string, { count: number; resetAt: number }>();
  const AUTH_FAIL_LIMIT = 10;
  const AUTH_FAIL_WINDOW = 60_000;

  // Generous limit for authenticated proxy requests (normal app usage)
  const proxyRequests = new Map<string, { count: number; resetAt: number }>();
  const PROXY_RATE_LIMIT = config.proxyRateLimit ?? 600;
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

  /** 429 whose Retry-After carries the fixed window's remaining seconds. */
  function rateLimited(res: Response, map: Map<string, { count: number; resetAt: number }>, key: string, windowMs: number): void {
    const resetAt = map.get(key)?.resetAt;
    const retryAfter = resetAt ? Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) : Math.ceil(windowMs / 1000);
    res.status(429).set('Retry-After', String(retryAfter)).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
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

  // JSON parser for gateway-own endpoints. Must NOT touch /api/proxy: the
  // streaming channel bridge needs the raw request stream — a JSON request
  // consumed here would never reach the bridge as body frames.
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
   * The only accepted authentication is an issued, revocable credential
   * (zgd_/zgb_/zga_ Bearer token or peer_hello.gatewaySecret): namespace and
   * capabilities derive from the server-side record, never the client. The
   * shared-secret path was removed once every peer migrated (ADR-0002).
   */
  type AuthContext = { kind: 'credential'; credential: CredentialInfo };

  function isCredentialToken(token: string): boolean {
    return Object.values(CREDENTIAL_TOKEN_PREFIXES).some((prefix) => token.startsWith(prefix));
  }

  function resolveToken(token: string): AuthContext | null {
    if (!isCredentialToken(token)) return null;
    const credential = storage.findValidCredential(token);
    if (!credential) return null;
    return { kind: 'credential', credential };
  }

  function audit(event: string, fields: Record<string, unknown>): void {
    const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`[audit] ${event} ${parts}`);
  }

  // ==========================================================================
  // Backend identity & device scope (ADR-0009)
  // ==========================================================================

  /**
   * A bound credential *is* its backend: the hello's instanceId/channel are
   * descriptive only. Legacy (unbound) credentials keep the old
   * (namespace, instanceId, environment) mapping until migrated.
   */
  function resolveBackendIdentity(
    credential: CredentialInfo,
    namespace: string,
    identity: { instanceId?: string; name?: string },
    channel: string,
  ): string {
    if (credential.backendId) {
      // An in-place-bound identity remembers the instanceId it used to be
      // keyed by; a different one means the credential is shared by another
      // backend that the observation window missed — they will keep replacing
      // each other until it gets its own credential.
      const known = storage.getBackendIdentity(credential.backendId);
      if (known?.instanceId && identity.instanceId && identity.instanceId !== known.instanceId) {
        audit('backend.instance_mismatch', { backendId: credential.backendId, credentialId: credential.id, expected: known.instanceId, got: identity.instanceId });
      }
      return credential.backendId;
    }
    return storage.getOrCreateBackendIdV4({ namespace, instanceId: identity.instanceId ?? '', environment: channel, name: identity.name });
  }

  const OWNER_FLAP_WINDOW_MS = 60_000;
  const OWNER_FLAP_THRESHOLD = 3;
  const ownerReplacements = new Map<string, number[]>();

  /** Repeated takeovers of one backendId usually mean a shared or leaked credential. */
  function noteOwnerReplaced(backendId: string, credentialId: string): void {
    const now = Date.now();
    const recent = (ownerReplacements.get(backendId) ?? []).filter((t) => now - t < OWNER_FLAP_WINDOW_MS);
    recent.push(now);
    ownerReplacements.set(backendId, recent);
    audit('backend.owner_replaced', { backendId, credentialId });
    if (recent.length >= OWNER_FLAP_THRESHOLD) {
      audit('backend.owner_flapping', { backendId, credentialId, replacements: recent.length, windowSec: OWNER_FLAP_WINDOW_MS / 1000 });
    }
  }

  /** Namespace isolation, narrowed by a device credential's backend scope. */
  function canReach(
    scope: { namespace: string; allowedBackends: string[] | null },
    target: { namespace: string; backendId: string },
  ): boolean {
    if (target.namespace !== scope.namespace) return false;
    return scope.allowedBackends === null || scope.allowedBackends.includes(target.backendId);
  }

  function visibleRegistry(peer: PeerSession): BackendPresenceV4[] {
    return state.getRegistrySnapshot(peer.namespace).filter((item) => canReach(peer, item));
  }

  function isKnownBackend(backendId: string, namespace: string): boolean {
    return storage.getBackendIdentity(backendId)?.namespace === namespace;
  }

  /** null = whole namespace; otherwise a non-empty list of known backends in the namespace. Returns an error message on failure. */
  function parseBackendScope(value: unknown, namespace: string): string[] | null | string {
    if (value === null) return null;
    if (!Array.isArray(value) || value.length === 0 || !value.every((id) => typeof id === 'string')) {
      return 'allowedBackends must be null or a non-empty array of backend ids';
    }
    const ids = [...new Set(value as string[])];
    const unknown = ids.filter((id) => !isKnownBackend(id, namespace));
    if (unknown.length > 0) return `Unknown backends in this namespace: ${unknown.join(', ')}`;
    return ids;
  }

  /** backendId → number of unrevoked backend credentials bound to it. */
  function boundCredentialCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const c of storage.listCredentials()) {
      if (c.type === 'backend' && c.revokedAt === null && c.backendId) {
        counts.set(c.backendId, (counts.get(c.backendId) ?? 0) + 1);
      }
    }
    return counts;
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
    res.json({ items: visibleRegistry(peer) });
  });

  // --- Backend Discovery (device pairing) ---
  // A device credential may be scoped to specific backends (ADR-0009), so a
  // pairing client needs to learn which backends it can address without
  // knowing a backendId up front. The list answers "what may I address" — the
  // credential's scope over known backend identities — not "what is online
  // right now": provisioned-but-offline backends stay listed with
  // `online: false`, so a picker can tell "offline" from "not allowed"
  // (out-of-scope ids never appear, same as nonexistent ones). A bound backend
  // credential creates its identity row at issuance (ADR-0009), so a
  // never-connected backend is discoverable too.
  // Online backends first, then most recently seen; projection only — no
  // capabilities, no identity internals, no channels.
  app.get('/api/discovery/backends', requireGatewayAuth, (_req: Request, res: Response) => {
    const auth = res.locals.auth;
    const items = storage.listBackendIdentities()
      .filter((identity) => canReach(auth.credential, identity))
      .map((identity) => {
        const presence = state.registry.items.get(identity.backendId);
        return {
          backendId: identity.backendId,
          name: identity.name,
          online: presence !== undefined,
          // Live heartbeats beat the last registration/offline transition
          // already recorded on the identity row.
          lastSeenAt: presence ? presence.lastSeenAt : identity.lastSeenAt,
        };
      })
      .sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
    res.json({ success: true, data: { items } });
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

  app.post('/api/notifications/test', requireGatewayAuth, async (req: Request, res: Response) => {
    try {
      const rawBackendId = req.body?.backendId;
      const backendId = typeof rawBackendId === 'string' && rawBackendId.trim() ? rawBackendId.trim() : undefined;
      await pushNotificationService.sendTest(backendId);
      res.json({ success: true, data: { message: 'Test notification sent' } });
    } catch (err) {
      res.status(400).json({ success: false, error: { code: 'NOTIFICATION_FAILED', message: err instanceof Error ? err.message : 'Failed to send test notification' } });
    }
  });

  // --- Admin: credential management (ADR-0002), web UI session login (ADR-0005) ---

  /**
   * The request host, as seen through the proxy chain. Same-origin checks and
   * cookie Secure flags both depend on it.
   */
  function requestIsSecure(req: Request): boolean {
    if (trustProxy) return req.headers['x-forwarded-proto'] === 'https';
    return req.secure;
  }

  /**
   * Defense-in-depth against CSRF for cookie-authenticated requests.
   * SameSite=Strict already keeps the cookie off cross-site requests; this
   * additionally rejects cookie-authenticated mutations whose Origin (browsers
   * always send it on POST/DELETE) does not match this deployment's origins.
   * Non-browser clients are unaffected: they authenticate with Bearer.
   */
  function isTrustedOrigin(req: Request): boolean {
    const origin = req.headers.origin;
    if (!origin) return false;
    if (allowedOrigins && allowedOrigins.length > 0) return allowedOrigins.includes(origin);
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  function isMutatingRequest(req: Request): boolean {
    return req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  }

  function requireAdmin(req: Request, res: Response, next: () => void): void {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const authHeader = req.headers.authorization;
    const bearerOk = !!authHeader
      && authHeader.startsWith('Bearer ')
      && safeCompare(authHeader.slice(7), config.adminToken);
    if (bearerOk) {
      next();
      return;
    }
    // Web UI path: a valid admin session cookie also grants admin access.
    const sessionId = readSessionCookie(req, ADMIN_SESSION_COOKIE);
    if (sessionId && adminSessions.validate(sessionId)) {
      if (isMutatingRequest(req) && !isTrustedOrigin(req)) {
        audit('admin.csrf_rejected', { ip: clientIp, method: req.method, path: req.path });
        res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Origin check failed' } });
        return;
      }
      next();
      return;
    }
    if (!checkAuthFailLimit(clientIp)) {
      rateLimited(res, authFailures, clientIp, AUTH_FAIL_WINDOW);
      return;
    }
    audit('admin.auth_failed', { ip: clientIp });
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid admin token' } });
    return;
  }

  // Login: exchange the admin token (shown once in the form) for a session
  // cookie, so the long-lived token never persists in the browser.
  app.post('/api/admin/session', (req: Request, res: Response) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const token = typeof (req.body as { token?: unknown } | undefined)?.token === 'string'
      ? (req.body as { token: string }).token
      : '';
    if (!token || !safeCompare(token, config.adminToken)) {
      if (!checkAuthFailLimit(clientIp)) {
        rateLimited(res, authFailures, clientIp, AUTH_FAIL_WINDOW);
        return;
      }
      audit('admin.session_login_failed', { ip: clientIp });
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid admin token' } });
      return;
    }
    const session = adminSessions.create();
    audit('admin.session_created', { ip: clientIp, expiresAt: session.expiresAt });
    res.cookie(ADMIN_SESSION_COOKIE, session.id, {
      httpOnly: true,
      sameSite: 'strict',
      secure: requestIsSecure(req),
      path: '/',
      maxAge: session.expiresAt - Date.now(),
    });
    res.json({ success: true, data: { expiresAt: session.expiresAt } });
  });

  // Session probe for the SPA (decide login vs. admin view on boot).
  app.get('/api/admin/session', (req: Request, res: Response) => {
    const sessionId = readSessionCookie(req, ADMIN_SESSION_COOKIE);
    if (!sessionId || !adminSessions.validate(sessionId)) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'No active session' } });
      return;
    }
    res.json({ success: true, data: { expiresAt: adminSessions.expiresAt(sessionId) } });
  });

  app.delete('/api/admin/session', (req: Request, res: Response) => {
    const sessionId = readSessionCookie(req, ADMIN_SESSION_COOKIE);
    if (sessionId && adminSessions.validate(sessionId)) {
      audit('admin.session_destroyed', { ip: req.ip || req.socket.remoteAddress || 'unknown' });
      adminSessions.destroy(sessionId);
    }
    res.clearCookie(ADMIN_SESSION_COOKIE, { path: '/' });
    res.json({ success: true });
  });

  // Read-only dashboard data for the admin web UI (ADR-0005).
  app.get('/api/admin/overview', requireAdmin, (_req: Request, res: Response) => {
    const now = Date.now();
    const credentials = storage.listCredentials();
    const counters = { total: credentials.length, active: 0, revoked: 0, expired: 0, byType: {} as Record<string, number> };
    for (const credential of credentials) {
      if (credential.revokedAt) counters.revoked++;
      else if (credential.expiresAt !== null && credential.expiresAt <= now) counters.expired++;
      else counters.active++;
      counters.byType[credential.type] = (counters.byType[credential.type] ?? 0) + 1;
    }
    res.json({
      success: true,
      data: {
        backends: state.registry.items.size,
        backendIdentities: storage.listBackendIdentities().length,
        legacyBackendCredentials: credentials.filter((c) => c.type === 'backend' && c.revokedAt === null && c.backendId === null).length,
        peers: [...state.peers.values()].map((peer) => ({
          peerSessionId: peer.peerSessionId,
          namespace: peer.namespace,
          peerType: peer.peerType,
          name: peer.name,
          deviceId: peer.deviceId,
          protocolVersion: peer.protocolVersion,
          backendId: peer.backendId ?? null,
        })),
        credentials: counters,
        uptimeSec: Math.floor(process.uptime()),
      },
    });
  });

  app.post('/api/admin/credentials', requireAdmin, (req: Request, res: Response) => {
    const { type, namespace, name, ttlDays, backendId, allowedBackends } = (req.body ?? {}) as {
      type?: unknown; namespace?: unknown; name?: unknown; ttlDays?: unknown; backendId?: unknown; allowedBackends?: unknown;
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
    if (backendId !== undefined) {
      if (type !== 'backend') {
        res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'backendId only applies to backend credentials' } });
        return;
      }
      if (typeof backendId !== 'string' || !isKnownBackend(backendId, namespace)) {
        res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'backendId must be a known backend in the same namespace' } });
        return;
      }
    }
    let scope: string[] | null | undefined;
    if (allowedBackends !== undefined) {
      if (type !== 'device') {
        res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'allowedBackends only applies to device credentials' } });
        return;
      }
      const parsed = parseBackendScope(allowedBackends, namespace);
      if (typeof parsed === 'string') {
        res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: parsed } });
        return;
      }
      scope = parsed;
    }
    const { credential, token } = storage.createCredential({
      type: type as CredentialType,
      namespace,
      name: typeof name === 'string' ? name : undefined,
      ttlMs,
      backendId: typeof backendId === 'string' ? backendId : undefined,
      allowedBackends: scope,
    });
    audit('credential.issued', {
      id: credential.id, type: credential.type, namespace: credential.namespace, name: credential.name,
      backendId: credential.backendId ?? 'none', scope: credential.allowedBackends ? credential.allowedBackends.join(',') : 'namespace',
    });
    res.status(201).json({ success: true, data: { ...credential, token } });
  });

  // Known backend identities with online state (read-only; ADR-0009 step 1).
  app.get('/api/admin/backends', requireAdmin, (_req: Request, res: Response) => {
    const bound = boundCredentialCounts();
    const data = storage.listBackendIdentities().map((identity) => {
      const presence = state.registry.items.get(identity.backendId);
      return {
        backendId: identity.backendId,
        namespace: identity.namespace,
        name: identity.name,
        instanceId: identity.instanceId,
        environment: identity.environment,
        createdAt: identity.createdAt,
        lastSeenAt: identity.lastSeenAt,
        lastCredentialId: identity.lastCredentialId,
        boundCredentials: bound.get(identity.backendId) ?? 0,
        online: presence ? { epoch: presence.epoch, connectedAt: presence.connectedAt } : null,
      };
    });
    res.json({ success: true, data });
  });

  // Forget a backend identity — cleanup for identities left behind by
  // instanceId drift. Refused whenever something may still resolve to it,
  // since a legacy backend would silently get a fresh backendId next time.
  app.delete('/api/admin/backends/:backendId', requireAdmin, (req: Request, res: Response) => {
    const { backendId } = req.params;
    const identity = storage.getBackendIdentity(backendId);
    if (!identity) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Backend identity not found' } });
      return;
    }
    const conflict = (message: string) => res.status(409).json({ success: false, error: { code: 'CONFLICT', message } });
    if (state.registry.items.has(backendId)) {
      conflict('Backend is online');
      return;
    }
    if ((boundCredentialCounts().get(backendId) ?? 0) > 0) {
      conflict('Unrevoked backend credentials are bound to this backend; revoke them first');
      return;
    }
    const last = identity.lastCredentialId ? storage.getCredential(identity.lastCredentialId) : undefined;
    if (last && last.revokedAt === null && last.backendId === null) {
      conflict('The legacy credential last seen registering this backend is still active; bind or revoke it first');
      return;
    }
    storage.deleteBackendIdentity(backendId);
    audit('backend.identity_deleted', { backendId, namespace: identity.namespace });
    res.json({ success: true, data: null });
  });

  app.get('/api/admin/credentials', requireAdmin, (_req: Request, res: Response) => {
    res.json({ success: true, data: storage.listCredentials() });
  });

  // ADR-0009 in-place migration: bind a legacy backend credential (and its
  // live access tokens) to the identity it is known to register. Token unchanged.
  app.post('/api/admin/credentials/:id/bind', requireAdmin, (req: Request, res: Response) => {
    const credential = storage.getCredential(req.params.id);
    if (!credential) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Credential not found' } });
      return;
    }
    if (credential.type !== 'backend' || credential.revokedAt !== null || credential.backendId !== null) {
      res.status(409).json({ success: false, error: { code: 'CONFLICT', message: 'Only unrevoked, unbound backend credentials can be bound' } });
      return;
    }
    const { backendId } = (req.body ?? {}) as { backendId?: unknown };
    if (typeof backendId !== 'string' || !isKnownBackend(backendId, credential.namespace)) {
      res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'backendId must be a known backend in the same namespace' } });
      return;
    }
    storage.bindBackendCredential(credential.id, backendId);
    audit('credential.bound', { id: credential.id, backendId });
    res.json({ success: true, data: storage.getCredential(credential.id) });
  });

  // Change a device credential's backend scope. Live connections are closed
  // so the new scope applies on reconnect, as with revocation.
  app.patch('/api/admin/credentials/:id', requireAdmin, (req: Request, res: Response) => {
    const credential = storage.getCredential(req.params.id);
    if (!credential) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Credential not found' } });
      return;
    }
    if (credential.type !== 'device' || credential.revokedAt !== null) {
      res.status(409).json({ success: false, error: { code: 'CONFLICT', message: 'Only unrevoked device credentials have a backend scope' } });
      return;
    }
    const body = (req.body ?? {}) as { allowedBackends?: unknown };
    if (!('allowedBackends' in body)) {
      res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'allowedBackends is required (null = whole namespace)' } });
      return;
    }
    const scope = parseBackendScope(body.allowedBackends, credential.namespace);
    if (typeof scope === 'string') {
      res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: scope } });
      return;
    }
    storage.setAllowedBackends(credential.id, scope);
    audit('credential.scope_changed', { id: credential.id, scope: scope ? scope.join(',') : 'namespace' });
    for (const peer of state.peers.values()) {
      if (peer.credentialId === credential.id) peer.ws.close(1008, 'Credential scope changed');
    }
    res.json({ success: true, data: storage.getCredential(credential.id) });
  });

  /** Audit and disconnect live peers on the revoked credentials (incl. cascaded access tokens). */
  function afterRevoke(revokedIds: string[]): void {
    if (revokedIds.length === 0) return;
    audit('credential.revoked', { ids: revokedIds.join(',') });
    const revokedSet = new Set(revokedIds);
    for (const peer of state.peers.values()) {
      if (peer.credentialId && revokedSet.has(peer.credentialId)) {
        audit('credential.peer_disconnected', { id: peer.credentialId, peerSessionId: peer.peerSessionId });
        peer.ws.close(1008, 'Credential revoked');
      }
    }
  }

  app.delete('/api/admin/credentials/:id', requireAdmin, (req: Request, res: Response) => {
    const revokedIds = storage.revokeCredential(req.params.id);
    if (revokedIds.length === 0) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Credential not found or already revoked' } });
      return;
    }
    afterRevoke(revokedIds);
    res.json({ success: true, data: { revoked: revokedIds } });
  });

  // Bulk revoke. Unknown or already-revoked ids are reported, not an error,
  // so a stale selection still revokes everything it can.
  app.post('/api/admin/credentials/revoke', requireAdmin, (req: Request, res: Response) => {
    const { ids } = (req.body ?? {}) as { ids?: unknown };
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string')) {
      res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'ids must be a non-empty array of strings' } });
      return;
    }
    const requested = [...new Set(ids as string[])];
    const revokedIds = storage.revokeCredentials(requested);
    afterRevoke(revokedIds);
    const revokedSet = new Set(revokedIds);
    res.json({ success: true, data: { revoked: revokedIds, skipped: requested.filter((id) => !revokedSet.has(id)) } });
  });

  // Permanently delete revoked credentials: the given ids, or all of them when
  // `ids` is omitted. Only revoked rows are ever deleted — active/expired ones
  // must be revoked first, so a stray request cannot erase a live credential.
  app.post('/api/admin/credentials/purge', requireAdmin, (req: Request, res: Response) => {
    const { ids } = (req.body ?? {}) as { ids?: unknown };
    if (ids !== undefined && (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string'))) {
      res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'ids must be an array of strings' } });
      return;
    }
    const deleted = storage.purgeRevokedCredentials(ids as string[] | undefined);
    if (deleted.length > 0) {
      audit('credential.purged', { count: deleted.length, ids: deleted.join(',') });
    }
    res.json({ success: true, data: { deleted } });
  });

  // --- Backend enrollment -> short-lived access credential (ADR-0002) ---
  app.post('/api/backend/token', (req: Request, res: Response) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const auth = token ? resolveToken(token) : null;
    if (!auth) {
      if (!checkAuthFailLimit(clientIp)) {
        rateLimited(res, authFailures, clientIp, AUTH_FAIL_WINDOW);
        return;
      }
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
      return;
    }
    // Only enrollment credentials may be exchanged — not device tokens, not
    // already-exchanged access tokens, not the legacy shared secret.
    if (auth.credential.type !== 'backend') {
      res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only backend enrollment credentials can be exchanged' } });
      return;
    }
    // One access credential per enrollment, rotated in place (ADR-0011):
    // always a new secret, and the previous one stops working.
    const { credential, token: accessToken, rotated } = storage.exchangeAccessCredential(auth.credential, config.backendAccessTokenTtlMs);
    audit('credential.exchanged', { parent: auth.credential.id, id: credential.id, rotated });
    res.status(201).json({ success: true, data: { token: accessToken, expiresAt: credential.expiresAt, namespace: credential.namespace } });
  });

  // --- HTTP Proxy (streaming channel bridge, docs/protocol-v4.md §7) ---
  app.all('/api/proxy/:backendId/*', async (req: Request, res: Response) => {
    try {
      const { backendId } = req.params;
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

      // Check auth first, then apply appropriate rate limit
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        if (!checkAuthFailLimit(clientIp)) {
          rateLimited(res, authFailures, clientIp, AUTH_FAIL_WINDOW);
          return;
        }
        res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authorization required' } });
        return;
      }
      const auth = resolveToken(authHeader.slice(7));
      if (!auth) {
        if (!checkAuthFailLimit(clientIp)) {
          rateLimited(res, authFailures, clientIp, AUTH_FAIL_WINDOW);
          return;
        }
        res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
        return;
      }

      // Authenticated — apply generous proxy rate limit
      if (!checkProxyRateLimit(clientIp)) {
        rateLimited(res, proxyRequests, clientIp, PROXY_RATE_WINDOW);
        return;
      }
      const lease = state.leases.get(backendId);
      if (!lease) {
        res.status(502).json({ success: false, error: { code: 'BACKEND_OFFLINE', message: 'Backend not found or offline' } });
        return;
      }
      // Callers may only reach backends in their credential's namespace;
      // answered like an offline backend to avoid an existence oracle.
      {
        const presence = state.registry.items.get(backendId);
        if (!presence || !canReach(auth.credential, presence)) {
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
      // Path logged without query string — queries may carry sensitive values.
      audit('proxy.request', { backendId, method: req.method, path: `/${fullPath}`, ip: clientIp, auth: auth.credential.id });
      // Stream through an internal channel — no buffering, no base64.
      proxyViaChannel(req, res, backendId, lease.epoch, backendPeer, targetPath);
    } catch (error) {
      console.error('[Gateway] Proxy error:', error);
      if (res.headersSent) return;
      res.status(500).json({ success: false, error: { code: 'PROXY_ERROR', message: 'Failed to proxy request' } });
    }
  });

  // --- Admin web UI static hosting (ADR-0005, optional) ---
  // Unset adminStaticDir keeps the gateway API-only: /admin falls through to
  // the 404 handler below, exactly as before the web UI existed.
  if (config.adminStaticDir) {
    const adminDir = config.adminStaticDir;
    // redirect:false keeps /admin hitting the sendFile fallback below instead
    // of express.static's trailing-slash redirect round trip.
    app.use('/admin', express.static(adminDir, { redirect: false }));
    // The SPA uses hash routing, so only /admin itself needs the entry file.
    app.get('/admin', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(adminDir, 'index.html'));
    });
    app.get('/', (_req: Request, res: Response) => {
      res.redirect('/admin');
    });
  }

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
    // Release frames buffered while waiting for the peer leg to pair.
    a.resume();
    b.resume();
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
      // Hold frames until both legs are wired: the first-connected side may
      // start sending immediately (its dial resolved), and without a pause
      // those pre-pairing frames would have no listener and be lost.
      // pause() keeps them in the stream buffer; wireChannel resumes.
      ws.pause();
      if (ticket.role === 'client') ch.clientSocket = ws;
      else ch.backendSocket = ws;
      // Internal HTTP channel: the gateway itself is the client end.
      if (ch.onBackendSocket && ch.backendSocket && !ch.piped) {
        ch.piped = true;
        clearTimeout(ch.pairingTimeout);
        ch.onBackendSocket(ch.backendSocket);
        ch.backendSocket.resume();
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
      sendToWs(peer.ws, { type: 'gateway_error', code: 'INVALID_MESSAGE', message: 'channel_open requires protocol v4' } satisfies GatewayErrorV4);
      return;
    }
    const presence = state.registry.items.get(msg.target);
    const lease = state.leases.get(msg.target);
    const backendPeer = lease ? state.peers.get(lease.peerSessionId) : undefined;
    // Same non-oracle answer for nonexistent, offline, and cross-namespace.
    if (!presence || !lease || !backendPeer || !canReach(peer, presence)) {
      sendToWs(peer.ws, { type: 'gateway_error', code: 'BACKEND_OFFLINE', message: `Backend ${msg.target} not found or offline` } satisfies GatewayErrorV4);
      return;
    }
    if (countChannelsForPeer(peer.peerSessionId) >= maxChannelsPerPeer) {
      sendToWs(peer.ws, { type: 'gateway_error', code: 'RATE_LIMITED', message: 'Too many open channels' } satisfies GatewayErrorV4);
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
      sendToWs(peer.ws, { type: 'gateway_error', code: 'INVALID_MESSAGE', message: 'topic_subscribe requires protocol v4' } satisfies GatewayErrorV4);
      return;
    }
    const presence = state.registry.items.get(msg.backendId);
    if (!presence || !canReach(peer, presence)) {
      sendToWs(peer.ws, { type: 'gateway_error', code: 'BACKEND_OFFLINE', message: `Backend ${msg.backendId} not found or offline` } satisfies GatewayErrorV4);
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
    adminSessions.dispose();
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
          const validationError = validatePeerHelloV4(message);
          if (validationError) {
            sendToWs(ws, { type: 'gateway_error', code: 'INVALID_MESSAGE', message: validationError } satisfies GatewayErrorV4);
            ws.close(1008, 'Invalid peer_hello');
            return;
          }
          clearTimeout(authTimeout);
          peerSessionId = handlePeerHello(ws, message as PeerHelloV4);
          return;
        }
        handlePeerMessage(peerSessionId, message);
      } catch (error) {
        console.error('[Gateway] Message parse error:', error);
        sendToWs(ws, { type: 'gateway_error', code: 'INVALID_MESSAGE', message: 'Invalid message format' } satisfies GatewayErrorV4);
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

  function handlePeerHello(ws: WebSocket, message: PeerHelloV4): string | null {
    // The gatewaySecret field carries an issued credential token
    // (zgd_/zgb_/zga_ prefix); the field name is kept for wire stability.
    const auth = resolveToken(message.gatewaySecret);
    if (!auth) {
      audit('peer.auth_failed', { namespace: message.namespace, peerType: message.peerType });
      sendToWs(ws, { type: 'gateway_error', code: 'UNAUTHORIZED', message: 'Invalid gateway secret' } satisfies GatewayErrorV4); ws.close(); return null;
    }
    // Namespace derives from the server-side credential record; a declared
    // namespace that disagrees is an error, never a grant.
    if (auth.credential.namespace !== message.namespace) {
      audit('peer.namespace_mismatch', { credentialId: auth.credential.id, declared: message.namespace });
      sendToWs(ws, { type: 'gateway_error', code: 'UNAUTHORIZED', message: 'Namespace not permitted by credential' } satisfies GatewayErrorV4); ws.close(); return null;
    }
    // A device credential must never be able to register (or impersonate) a backend.
    if (message.peerType === 'client+backend' && auth.credential.type !== 'backend' && auth.credential.type !== 'backend-access') {
      audit('peer.backend_registration_denied', { credentialId: auth.credential.id });
      sendToWs(ws, { type: 'gateway_error', code: 'UNAUTHORIZED', message: 'This credential cannot register a backend' } satisfies GatewayErrorV4); ws.close(); return null;
    }
    if (message.protocolVersion !== 4) {
      sendToWs(ws, { type: 'gateway_error', code: 'PROTOCOL_VERSION_MISMATCH', message: `Expected protocol version 4, got ${message.protocolVersion}` } satisfies GatewayErrorV4); ws.close(); return null;
    }
    const { peerType } = message;
    const identity = message.identity ?? {};
    const isBackend = peerType === 'client+backend' && !!message.backend;
    // Legacy (unbound) backend credentials still derive identity from the
    // hello, so they keep needing an instanceId (ADR-0009).
    if (isBackend && !auth.credential.backendId && identity.instanceId === undefined) {
      sendToWs(ws, { type: 'gateway_error', code: 'INVALID_MESSAGE', message: 'peer_hello.identity.instanceId is required for legacy (unbound) backend credentials' } satisfies GatewayErrorV4); ws.close(); return null;
    }
    const peerSessionId = uuidv4();
    const recoveryToken = crypto.randomBytes(32).toString('hex');
    const channel = identity.channel || 'prod';
    const peer: PeerSession = {
      peerSessionId,
      ws,
      protocolVersion: 4,
      peerType,
      namespace: message.namespace,
      credentialId: auth.credential.id,
      allowedBackends: auth.credential.type === 'device' ? auth.credential.allowedBackends : null,
      deviceId: identity.deviceId ?? '',
      instanceId: identity.instanceId ?? '',
      channel,
      name: identity.name || '',
      recoveryToken,
      isAlive: true,
    };

    let backendInfo: PeerReadyV4['backend'] | undefined;
    if (isBackend && message.backend) {
      const backendId = resolveBackendIdentity(auth.credential, message.namespace, identity, channel);
      const previousLease = state.leases.get(backendId);
      const epoch = storage.allocateEpoch();
      peer.backendId = backendId; peer.epoch = epoch;
      if (previousLease && (previousLease.peerSessionId !== peerSessionId || previousLease.epoch !== epoch)) {
        // Newest connection wins (ADR-0009): a restarted backend must not
        // wait for its stale predecessor's lease to time out.
        noteOwnerReplaced(backendId, auth.credential.id);
        handleBackendOwnerReplaced(backendId, previousLease.epoch, epoch, previousLease.peerSessionId);
      }
      state.addLease({ backendId, epoch, peerSessionId, leaseTtlMs: state.config.defaultLeaseTtlMs, lastHeartbeatAt: Date.now(), leaseTimer: null });
      // Which enrollment credential registers which identity (an exchanged
      // zga_ counts as its parent zgb_) — ADR-0009 migration evidence.
      storage.touchBackendIdentity(backendId, auth.credential.parentId ?? auth.credential.id, identity.name);
      // gatewayProtocolVersion lets clients feature-detect from presence.
      const presence: BackendPresenceV4 = { namespace: message.namespace, backendId, instanceId: peer.instanceId, deviceId: peer.deviceId, name: peer.name, channel, visible: message.backend.visible, capabilities: message.backend.capabilities, backendProtocolVersion: message.backend.backendProtocolVersion, minClientProtocolVersion: message.backend.minClientProtocolVersion, epoch, connectedAt: Date.now(), lastSeenAt: Date.now(), gatewayProtocolVersion: peer.protocolVersion };
      state.registryUpsert(presence);
      backendInfo = { backendId, epoch, leaseTtlMs: state.config.defaultLeaseTtlMs };
    }

    state.addPeer(peer);
    recoveryTokens.set(recoveryToken, peerSessionId);
    const registrySync: PeerReadyV4["registrySync"] = { items: visibleRegistry(peer) };
    const ready: PeerReadyV4 = { type: 'peer_ready', protocolVersion: peer.protocolVersion, peerSessionId, recoveryToken, backend: backendInfo, registrySync };
    sendToWs(ws, ready);

    if (peer.backendId) {
      broadcastRegistrySnapshot(peerSessionId);
    }
    audit('peer.connected', {
      peerSessionId,
      namespace: peer.namespace,
      peerType,
      backendId: peer.backendId ?? 'none',
      credentialId: peer.credentialId,
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
      sendToWs(peer.ws, { type: 'gateway_error', code: 'INVALID_MESSAGE', message: validationError } satisfies GatewayErrorV4);
      return;
    }
    switch (message.type) {
      case 'backend_heartbeat': handleBackendHeartbeat(peer, message); break;
      case 'request_registry_snapshot': handleRequestRegistrySnapshot(peer); break;
      case 'backend_server_message': handleBackendServerMessage(peer, message); break;
      case 'push_notification_request': handlePushNotificationRequest(peer, message); break;
      case 'channel_open': handleChannelOpen(peer, message); break;
      case 'channel_reject': handleChannelReject(peer, message); break;
      case 'channel_close': handleChannelClose(peer, message); break;
      case 'topic_subscribe': handleTopicSubscribe(peer, message); break;
      case 'topic_unsubscribe': handleTopicUnsubscribe(peer, message); break;
      case 'topic_publish': handleTopicPublish(peer, message); break;
      case 'ping': sendToWs(peer.ws, { type: 'pong', ts: message.ts }); break;
      default: sendToWs(peer.ws, { type: 'gateway_error', code: 'INVALID_MESSAGE', message: `Unknown message type: ${message.type}` } satisfies GatewayErrorV4);
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
    // streamDemand is a v3 relic: the type still requires it, retained
    // topics made it meaningless — always false.
    sendToWs(peer.ws, { type: 'heartbeat_ack', epoch: msg.epoch, streamDemand: false } satisfies HeartbeatAckMessage);
  }

  // ========================================================================
  // Client Message Handlers
  // ========================================================================

  function handleRequestRegistrySnapshot(peer: PeerSession): void {
    sendToWs(peer.ws, { type: 'registry_snapshot', items: visibleRegistry(peer) } satisfies RegistrySnapshotV4);
  }

  function handleBackendServerMessage(peer: PeerSession, msg: BackendServerMessage): void {
    if (!isCurrentBackendOwner(peer)) return;
    const backendId = peer.backendId!;
    if (msg.backendId !== backendId) return;

    // Targeted fallback path (v4 clients normally receive over their
    // message channel). Namespace equality preserves the anti-probing
    // property: a backend cannot message peers of other applications by
    // guessing session IDs.
    if (!msg.targetPeerSessionId) return;
    const targetPeer = state.peers.get(msg.targetPeerSessionId);
    if (!targetPeer || !canReach(targetPeer, { namespace: peer.namespace, backendId })) return;
    sendToWs(targetPeer.ws, msg);
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
      } satisfies GatewayErrorV4);
      return;
    }
    // peer.backendId is the server-authoritative identity from the
    // credential store; per-backend topics are derived from it, never from
    // client-supplied event fields.
    void pushNotificationService.notify(msg.event, peer.backendId);
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
    state.registryRemove(backendId);
    broadcastRegistrySnapshot();
    state.removeBackend(backendId);
    storage.touchBackendIdentity(backendId);
    if (peer) {
      peer.backendId = undefined;
      peer.epoch = undefined;
      peer.ws.terminate();
      unregisterRecoveryToken(peer);
      state.removePeer(peer.peerSessionId);
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
      state.registryRemove(peer.backendId);
      broadcastRegistrySnapshot(peerSessionId);
      state.removeBackend(peer.backendId);
      storage.touchBackendIdentity(peer.backendId);
    }
    // Close any remaining channels where this peer is the client end
    closeChannelsForPeer(peerSessionId);
    removeTopicSubscriptionsForPeer(peerSessionId);
    if (peer.backendId) removeTopicsForBackend(peer.backendId);
    peer.ws.terminate();
    unregisterRecoveryToken(peer);
    state.removePeer(peerSessionId);
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  function broadcastRegistrySnapshot(excludePeerSessionId?: string): void {
    // Each peer only ever sees its own namespace's slice of the registry,
    // narrowed further by a device credential's backend scope.
    const perScope = new Map<string, RegistrySnapshotV4>();
    for (const peer of state.peers.values()) {
      if (peer.peerSessionId === excludePeerSessionId) continue;
      const scopeKey = `${peer.namespace}\x1f${peer.allowedBackends ? peer.allowedBackends.join(',') : '*'}`;
      let msg = perScope.get(scopeKey);
      if (!msg) {
        msg = { type: 'registry_snapshot', items: visibleRegistry(peer) };
        perScope.set(scopeKey, msg);
      }
      sendToWs(peer.ws, msg);
    }
  }

  function isCurrentBackendOwner(peer: PeerSession, expectedEpoch?: number): boolean {
    if (!peer.backendId || peer.epoch == null) return false;
    if (expectedEpoch !== undefined && peer.epoch !== expectedEpoch) return false;
    const lease = state.leases.get(peer.backendId);
    return lease?.peerSessionId === peer.peerSessionId && lease?.epoch === peer.epoch;
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
    state.removeLease(backendId);

    const previousPeer = state.peers.get(previousPeerSessionId);
    if (previousPeer) {
      previousPeer.backendId = undefined;
      previousPeer.epoch = undefined;
      // A distinct close code tells the SDK it was replaced, not dropped, so
      // it stands down instead of reconnecting and replacing the newer
      // connection in turn (ADR-0010). A half-dead peer never answers the
      // close handshake, so terminate it shortly after.
      const ws = previousPeer.ws;
      ws.close(GATEWAY_CLOSE_BACKEND_REPLACED, 'Backend replaced by a newer connection');
      setTimeout(() => { if (ws.readyState !== WebSocket.CLOSED) ws.terminate(); }, REPLACED_CLOSE_GRACE_MS).unref();
    }
  }

  return httpServer;
}
