/**
 * Phase 1 credential system tests (ADR-0002): admin issuance/revocation,
 * WS auth with credentials (namespace derivation, backend registration
 * restriction), HTTP proxy namespace scoping, and legacy compatibility.
 */
import { describe, test, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'http';
import net from 'node:net';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer } from './test-server.js';

const GATEWAY_SECRET = 'test-secret-credentials';
const ADMIN_TOKEN = 'test-admin-token';

async function canBindLoopback(): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

const describeIfLoopback = (await canBindLoopback()) ? describe : describe.skip;

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.on('open', () => resolve());
    ws.on('error', (err) => reject(err));
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on('close', () => resolve());
    ws.close();
  });
}

function waitForMessage(ws: WebSocket, type: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for message type: ${type}`));
    }, timeoutMs);
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

describeIfLoopback('Phase 1: Credential System', () => {
  const servers: Server[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    await Promise.all(sockets.map((ws) => closeWs(ws)));
    sockets.length = 0;
    await Promise.all(servers.map((s) => closeTestServer(s)));
    servers.length = 0;
  });

  async function startServer(overrides: Partial<Parameters<typeof createGatewayServer>[0]> = {}) {
    const server = createGatewayServer({ gatewaySecret: GATEWAY_SECRET, adminToken: ADMIN_TOKEN, ...overrides });
    servers.push(server);
    const { wsUrl, httpUrl } = await listenTestServer(server);
    return { server, wsUrl, httpUrl };
  }

  async function issueCredential(httpUrl: string, body: Record<string, unknown>) {
    const res = await fetch(`${httpUrl}/api/admin/credentials`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  async function connect(wsUrl: string): Promise<WebSocket> {
    const ws = new WebSocket(wsUrl);
    sockets.push(ws);
    await waitForOpen(ws);
    return ws;
  }

  function sendHello(ws: WebSocket, secret: string, namespace: string, peerType: 'client-only' | 'client+backend', instanceId: string) {
    const hello: Record<string, unknown> = {
      type: 'peer_hello',
      protocolVersion: 3,
      namespace,
      clientProtocolVersion: 1,
      peerType,
      gatewaySecret: secret,
      identity: { deviceId: `dev-${instanceId}`, instanceId },
    };
    if (peerType === 'client+backend') {
      hello.backend = { visible: true, capabilities: [], backendProtocolVersion: 1 };
    }
    ws.send(JSON.stringify(hello));
  }

  describe('Admin API', () => {
    test('issues, lists, and revokes credentials', async () => {
      const { httpUrl } = await startServer();

      const issued = await issueCredential(httpUrl, { type: 'device', namespace: 'zclaudia', name: 'my-phone' });
      expect(issued.status).toBe(201);
      expect(issued.body.data.token).toMatch(/^zgd_/);
      expect(issued.body.data.namespace).toBe('zclaudia');
      expect(issued.body.data.expiresAt).toBeGreaterThan(Date.now());

      const list = await fetch(`${httpUrl}/api/admin/credentials`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      const listBody = await list.json();
      // Storage is shared within a vitest worker — find by id, not by count
      const entry = listBody.data.find((c: any) => c.id === issued.body.data.id);
      expect(entry).toBeDefined();
      // Token digest must never leak through the list API
      expect(entry.token).toBeUndefined();
      expect(entry.tokenHash).toBeUndefined();

      const revoke = await fetch(`${httpUrl}/api/admin/credentials/${issued.body.data.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(revoke.status).toBe(200);

      const revokeAgain = await fetch(`${httpUrl}/api/admin/credentials/${issued.body.data.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(revokeAgain.status).toBe(404);
    });

    test('backend credentials default to no expiry, ttlDays is honored', async () => {
      const { httpUrl } = await startServer();
      const backend = await issueCredential(httpUrl, { type: 'backend', namespace: 'hermes' });
      expect(backend.body.data.token).toMatch(/^zgb_/);
      expect(backend.body.data.expiresAt).toBeNull();

      const shortLived = await issueCredential(httpUrl, { type: 'device', namespace: 'hermes', ttlDays: 1 });
      const oneDayFromNow = Date.now() + 24 * 60 * 60 * 1000;
      expect(Math.abs(shortLived.body.data.expiresAt - oneDayFromNow)).toBeLessThan(5000);
    });

    test('rejects wrong admin token and disabled admin API', async () => {
      const { httpUrl } = await startServer();
      const wrong = await fetch(`${httpUrl}/api/admin/credentials`, {
        headers: { Authorization: 'Bearer wrong' },
      });
      expect(wrong.status).toBe(401);

      // Gateway secret must not work as admin token
      const viaSecret = await fetch(`${httpUrl}/api/admin/credentials`, {
        headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
      });
      expect(viaSecret.status).toBe(401);

      const { httpUrl: noAdminUrl } = await startServer({ adminToken: undefined });
      const disabled = await fetch(`${noAdminUrl}/api/admin/credentials`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(disabled.status).toBe(503);
    });
  });

  describe('WebSocket auth with credentials', () => {
    test('device credential authenticates a client in its namespace', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const issued = await issueCredential(httpUrl, { type: 'device', namespace: 'zclaudia' });

      const ws = await connect(wsUrl);
      sendHello(ws, issued.body.data.token, 'zclaudia', 'client-only', 'cred-client');
      const ready = await waitForMessage(ws, 'peer_ready');
      expect(ready.peerSessionId).toBeDefined();
    });

    test('namespace is derived from the credential: mismatch is rejected', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const issued = await issueCredential(httpUrl, { type: 'device', namespace: 'zclaudia' });

      const ws = await connect(wsUrl);
      sendHello(ws, issued.body.data.token, 'hermes', 'client-only', 'ns-mismatch');
      const err = await waitForMessage(ws, 'gateway_error');
      expect(err.code).toBe('UNAUTHORIZED');
    });

    test('device credential cannot register a backend', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const issued = await issueCredential(httpUrl, { type: 'device', namespace: 'zclaudia' });

      const ws = await connect(wsUrl);
      sendHello(ws, issued.body.data.token, 'zclaudia', 'client+backend', 'sneaky-backend');
      const err = await waitForMessage(ws, 'gateway_error');
      expect(err.code).toBe('UNAUTHORIZED');
      expect(err.message).toContain('cannot register a backend');
    });

    test('backend credential can register a backend', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const issued = await issueCredential(httpUrl, { type: 'backend', namespace: 'hermes' });

      const ws = await connect(wsUrl);
      sendHello(ws, issued.body.data.token, 'hermes', 'client+backend', 'legit-backend');
      const ready = await waitForMessage(ws, 'peer_ready');
      expect(ready.backend.backendId).toBeDefined();
    });

    test('revoking a credential disconnects its live peer and blocks reconnect', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const issued = await issueCredential(httpUrl, { type: 'device', namespace: 'zclaudia' });

      const ws = await connect(wsUrl);
      sendHello(ws, issued.body.data.token, 'zclaudia', 'client-only', 'to-revoke');
      await waitForMessage(ws, 'peer_ready');

      const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
      await fetch(`${httpUrl}/api/admin/credentials/${issued.body.data.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(await closed).toBe(1008);

      // Reconnect with the revoked token must fail
      const ws2 = await connect(wsUrl);
      sendHello(ws2, issued.body.data.token, 'zclaudia', 'client-only', 'to-revoke');
      const err = await waitForMessage(ws2, 'gateway_error');
      expect(err.code).toBe('UNAUTHORIZED');
    });

    test('legacy shared secret still authenticates both peer types', async () => {
      const { wsUrl } = await startServer();
      const wsBackend = await connect(wsUrl);
      sendHello(wsBackend, GATEWAY_SECRET, 'zclaudia', 'client+backend', 'legacy-backend');
      const ready = await waitForMessage(wsBackend, 'peer_ready');
      expect(ready.backend.backendId).toBeDefined();

      const wsClient = await connect(wsUrl);
      sendHello(wsClient, GATEWAY_SECRET, 'zclaudia', 'client-only', 'legacy-client');
      const clientReady = await waitForMessage(wsClient, 'peer_ready');
      expect(clientReady.peerSessionId).toBeDefined();
    });
  });

  describe('HTTP proxy with credentials', () => {
    async function registerEchoBackend(wsUrl: string, namespace: string, instanceId: string) {
      const ws = await connect(wsUrl);
      sendHello(ws, GATEWAY_SECRET, namespace, 'client+backend', instanceId);
      const ready = await waitForMessage(ws, 'peer_ready');
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'http_proxy_request') {
          ws.send(JSON.stringify({
            type: 'http_proxy_response', requestId: msg.requestId,
            statusCode: 200, headers: {}, bodyEncoding: 'utf8', body: 'ok',
          }));
        }
      });
      return ready.backend.backendId as string;
    }

    test('device credential can proxy to its own namespace only', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const zclaudiaBackend = await registerEchoBackend(wsUrl, 'zclaudia', 'proxy-z');
      const hermesBackend = await registerEchoBackend(wsUrl, 'hermes', 'proxy-h');
      const issued = await issueCredential(httpUrl, { type: 'device', namespace: 'zclaudia' });
      const token = issued.body.data.token;

      const own = await fetch(`${httpUrl}/api/proxy/${zclaudiaBackend}/test`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(own.status).toBe(200);
      expect(await own.text()).toBe('ok');

      const foreign = await fetch(`${httpUrl}/api/proxy/${hermesBackend}/test`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(foreign.status).toBe(502);
      const body = await foreign.json();
      expect(body.error.code).toBe('BACKEND_OFFLINE');
    });

    test('legacy shared secret can still proxy to any namespace', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const hermesBackend = await registerEchoBackend(wsUrl, 'hermes', 'proxy-legacy');
      const response = await fetch(`${httpUrl}/api/proxy/${hermesBackend}/test`, {
        headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
      });
      expect(response.status).toBe(200);
    });
  });
});
