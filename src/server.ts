/**
 * Gateway Sync Protocol — Server Implementation
 *
 * See docs/design/gateway-sync-protocol-v2.md for full specification.
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
import { GatewayStorage } from './storage.js';
import { GatewayState, type PeerSession } from './state.js';
import { encodeProxyRequestBody } from './proxy-body.js';
import { GatewayPushNotificationService } from './push-notification.js';

// ============================================================================
// Config & Helpers
// ============================================================================

interface GatewayConfig {
  gatewaySecret: string;
  notificationConfig?: Partial<NotificationConfig>;
  authTimeoutMs?: number;
  proxyRequestTimeoutMs?: number;
  proxyStreamingTimeoutMs?: number;
  /** Trust X-Forwarded-For header for IP extraction. Only enable behind a trusted reverse proxy. */
  trustProxy?: boolean;
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

function validatePeerHelloMessage(message: unknown): string | null {
  if (!message || typeof message !== 'object') return 'peer_hello must be an object';
  const msg = message as Record<string, unknown>;
  if (msg.type !== 'peer_hello') return 'First message must be peer_hello';
  if (typeof msg.gatewaySecret !== 'string') return 'peer_hello.gatewaySecret must be a string';
  if (msg.protocolVersion !== 3) return 'peer_hello.protocolVersion must be 3';
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
  const storage = new GatewayStorage();
  const pushNotificationService = new GatewayPushNotificationService(config.notificationConfig);
  const state = new GatewayState();
  const recoveryTokens = new Map<string, string>();
  const authTimeoutMs = config.authTimeoutMs ?? 10_000;
  const proxyRequestTimeoutMs = config.proxyRequestTimeoutMs ?? 30_000;
  const proxyStreamingTimeoutMs = config.proxyStreamingTimeoutMs ?? 60_000;
  const trustProxy = config.trustProxy ?? false;

  const app = express();

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
  }, 5 * 60_000);

  // --- CORS ---
  app.use((req: Request, res: Response, next: () => void) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Preserve raw bytes for proxy uploads before JSON/body-parser mutation.
  app.use('/api/proxy', express.raw({ type: '*/*', limit: '100mb' }));
  app.use(express.json({ limit: '15mb' }));

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

  function requireGatewayAuth(req: Request, res: Response, next: () => void): void {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authorization required' } });
      return;
    }
    const token = authHeader.slice(7);
    const colonIndex = token.indexOf(':');
    const secret = colonIndex !== -1 ? token.slice(colonIndex + 1) : token;
    if (!safeCompare(secret, config.gatewaySecret)) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
      return;
    }
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
    if (!peerSessionId || !state.peers.has(peerSessionId)) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid recovery token' } });
      return;
    }
    next();
  }

  // --- Poll Recovery: Registry ---
  app.get('/sync/registry', requireRecoveryToken, (_req: Request, res: Response) => {
    res.json({ items: state.getRegistrySnapshot() });
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
      const token = authHeader.slice(7);
      const colonIndex = token.indexOf(':');
      const gwSecret = colonIndex !== -1 ? token.slice(0, colonIndex) : token;
      if (!safeCompare(gwSecret, config.gatewaySecret)) {
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
      const backendPeer = state.peers.get(lease.peerSessionId);
      if (!backendPeer) {
        res.status(502).json({ success: false, error: { code: 'BACKEND_OFFLINE', message: 'Backend peer not found' } });
        return;
      }
      const fullPath = req.params[0] || '';
      const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      const targetPath = `/${fullPath}${queryString}`;
      const requestId = uuidv4();
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
      if (contentType) proxyRequest.headers['content-type'] = contentType;
      const clientRequestId = req.headers['x-request-id'];
      if (clientRequestId) proxyRequest.headers['x-request-id'] = clientRequestId as string;

      const response = await new Promise<GatewayHttpProxyResponse | null>((resolve, reject) => {
        const timeout = setTimeout(() => { pendingHttpRequests.delete(requestId); reject(new Error('Proxy request timeout')); }, proxyRequestTimeoutMs);
        pendingHttpRequests.set(requestId, { resolve, reject, timeout, res, backendId });
        sendToWs(backendPeer.ws, proxyRequest);
      });
      if (response === null) return;
      if (response.headers) { for (const [key, value] of Object.entries(response.headers)) res.setHeader(key, value); }
      if (clientRequestId) res.setHeader('x-request-id', clientRequestId);
      const responseBody = response.bodyEncoding === 'base64'
        ? Buffer.from(response.body, 'base64')
        : response.body;
      res.status(response.statusCode).send(responseBody);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ success: false, error: { code: 'PROXY_ERROR', message: 'Failed to proxy request' } });
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
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 50 * 1024 * 1024 });
  let cleanedUp = false;

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
    if (!safeCompare(message.gatewaySecret, config.gatewaySecret)) {
      sendToWs(ws, { type: 'gateway_error', code: 'UNAUTHORIZED', message: 'Invalid gateway secret' } satisfies GatewayErrorMessage); ws.close(); return null;
    }
    if (message.protocolVersion !== 3) {
      sendToWs(ws, { type: 'gateway_error', code: 'PROTOCOL_VERSION_MISMATCH', message: `Expected protocol version 3, got ${message.protocolVersion}` } satisfies GatewayErrorMessage); ws.close(); return null;
    }
    const peerSessionId = uuidv4();
    const recoveryToken = crypto.randomBytes(32).toString('hex');
    const { identity, peerType } = message;
    const channel = identity.channel || 'prod';
    const peer: PeerSession = {
      peerSessionId,
      ws,
      peerType,
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
      const backendId = storage.getOrCreateBackendIdByInstance(identity.instanceId, identity.deviceId, channel, identity.name);
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
    const registrySync: RegistrySyncPayload = { items: state.getRegistrySnapshot() };
    const ready: PeerReadyMessage = { type: 'peer_ready', protocolVersion: 3, peerSessionId, recoveryToken, backend: backendInfo, registrySync };
    sendToWs(ws, ready);

    if (peer.backendId) {
      broadcastRegistrySnapshot(peerSessionId);
    }
    console.log(`[Gateway] Peer ${peerSessionId} connected (${peerType}, backend=${peer.backendId || 'none'})`);
    return peerSessionId;
  }

  // ========================================================================
  // Message Router
  // ========================================================================

  function handlePeerMessage(peerSessionId: string, message: any): void {
    const peer = state.peers.get(peerSessionId);
    if (!peer) return;
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
      case 'http_proxy_response': handleHttpProxyResponse(message); break;
      case 'http_proxy_response_start': handleHttpProxyResponseStart(message); break;
      case 'http_proxy_response_chunk': handleHttpProxyResponseChunk(message); break;
      case 'http_proxy_response_end': handleHttpProxyResponseEnd(message); break;
      case 'push_notification_request': handlePushNotificationRequest(peer, message); break;
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

  function handleBackendResourceSnapshot(peer: PeerSession, msg: BackendResourceSnapshotMessage): void {
    if (!isCurrentBackendOwner(peer)) return;
    const backendId = peer.backendId!;
    // Pure relay: forward to all subscribers, adding backendId for routing
    const subscribers = state.getSubscribers(backendId);
    const relayMsg = { ...msg, backendId };
    for (const subId of subscribers) {
      const p = state.peers.get(subId);
      if (p) sendToWs(p.ws, relayMsg);
    }
  }

  function handleBackendResourceEvent(peer: PeerSession, msg: BackendResourceEventMessage): void {
    if (!isCurrentBackendOwner(peer)) return;
    const backendId = peer.backendId!;
    // Pure relay: forward to all subscribers, adding backendId for routing
    const subscribers = state.getSubscribers(backendId);
    const relayMsg = { ...msg, backendId };
    for (const subId of subscribers) {
      const p = state.peers.get(subId);
      if (p) sendToWs(p.ws, relayMsg);
    }
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
    sendToWs(peer.ws, { type: 'registry_snapshot', items: state.getRegistrySnapshot() } satisfies RegistrySnapshotMessage);
  }

  function handleRequestBackendResourceSnapshot(peer: PeerSession, msg: RequestBackendResourceSnapshotMessage): void {
    // Relay request to the backend peer so it can push a fresh snapshot
    const bp = findBackendPeer(msg.backendId);
    if (!bp) {
      sendToWs(peer.ws, { type: 'gateway_error', code: 'BACKEND_OFFLINE', message: `Backend ${msg.backendId} not found or offline`, recovery: 'reconnect' } satisfies GatewayErrorMessage);
      return;
    }
    sendToWs(bp.ws, { type: 'request_backend_resource_snapshot', backendId: msg.backendId, resourceTypes: msg.resourceTypes, targetPeerSessionId: msg.targetPeerSessionId } satisfies RequestBackendResourceSnapshotMessage);
  }

  function handleSubscribeBackend(peer: PeerSession, msg: SubscribeBackendMessage): void {
    const presence = state.registry.items.get(msg.backendId);
    if (!presence) {
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

    // If targetPeerSessionId is set, route to that specific client
    if (msg.targetPeerSessionId) {
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

  function handleHttpProxyResponse(msg: GatewayHttpProxyResponse): void {
    const pending = pendingHttpRequests.get(msg.requestId);
    if (pending) { clearTimeout(pending.timeout); pendingHttpRequests.delete(msg.requestId); pending.resolve(msg); }
  }
  function handleHttpProxyResponseStart(msg: GatewayHttpProxyResponseStart): void {
    const pending = pendingHttpRequests.get(msg.requestId);
    if (!pending?.res) return;
    clearTimeout(pending.timeout); pendingHttpRequests.delete(msg.requestId);
    const res = pending.res;
    if (msg.headers) { for (const [key, value] of Object.entries(msg.headers)) res.setHeader(key, value); }
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
  function handleHttpProxyResponseChunk(msg: GatewayHttpProxyResponseChunk): void {
    const streaming = pendingStreamingRequests.get(msg.requestId);
    if (!streaming) return;
    if (streaming.res.writableEnded || streaming.res.destroyed) {
      pendingStreamingRequests.delete(msg.requestId);
      clearTimeout(streaming.timeout);
      return;
    }
    clearTimeout(streaming.timeout);
    streaming.timeout = setTimeout(() => { abortStreamingResponse(msg.requestId, streaming.res, 'Proxy streaming timeout'); }, proxyStreamingTimeoutMs);
    streaming.res.write(Buffer.from(msg.data, 'base64'));
  }
  function handleHttpProxyResponseEnd(msg: GatewayHttpProxyResponseEnd): void {
    const streaming = pendingStreamingRequests.get(msg.requestId);
    if (!streaming) return;
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
        pending.reject(new Error('Backend disconnected'));
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
    console.log(`[Gateway] Peer ${peerSessionId} disconnected`);
    if (peer.backendId && isCurrentBackendOwner(peer)) {
      rejectPendingProxyRequests(peer.backendId);
      notifySubscribersBackendGone(peer.backendId, 'backend_offline');
      state.registryRemove(peer.backendId);
      broadcastRegistrySnapshot(peerSessionId);
      state.removeBackend(peer.backendId);
    }
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
    const msg: RegistrySnapshotMessage = { type: 'registry_snapshot', items: state.getRegistrySnapshot() };
    for (const peer of state.peers.values()) { if (peer.peerSessionId !== excludePeerSessionId) sendToWs(peer.ws, msg); }
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
