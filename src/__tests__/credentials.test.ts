/**
 * Credential system tests (ADR-0002): admin issuance/revocation, WS auth
 * with credentials (namespace derivation, backend registration restriction),
 * HTTP proxy namespace scoping. Issued credentials are the only
 * authentication — the shared-secret path no longer exists.
 */
import { describe, test, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'http';
import net from 'node:net';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer } from './test-server.js';

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
    const server = createGatewayServer({ adminToken: ADMIN_TOKEN, ...overrides });
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
      protocolVersion: 4,
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

      // A server without an admin token cannot exist: credentials would be unissuable
      expect(() => createGatewayServer({ adminToken: '' } as never)).toThrow(/adminToken is required/);
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

    test('a shared-secret-style token is rejected: credentials are the only auth', async () => {
      const { wsUrl } = await startServer();
      const ws = await connect(wsUrl);
      sendHello(ws, 'some-shared-secret-value', 'zclaudia', 'client+backend', 'legacy-backend');
      const err = await waitForMessage(ws, 'gateway_error');
      expect(err.code).toBe('UNAUTHORIZED');
    });
  });

  describe('Enrollment exchange (backend-access tokens)', () => {
    async function exchange(httpUrl: string, token: string) {
      const res = await fetch(`${httpUrl}/api/backend/token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      return { status: res.status, body: await res.json() };
    }

    test('enrollment credential exchanges for a working short-lived token', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const enrollment = await issueCredential(httpUrl, { type: 'backend', namespace: 'hermes', name: 'host-1' });

      const exchanged = await exchange(httpUrl, enrollment.body.data.token);
      expect(exchanged.status).toBe(201);
      expect(exchanged.body.data.token).toMatch(/^zga_/);
      expect(exchanged.body.data.namespace).toBe('hermes');
      expect(exchanged.body.data.expiresAt).toBeGreaterThan(Date.now());

      // The access token can register a backend in its namespace
      const ws = await connect(wsUrl);
      sendHello(ws, exchanged.body.data.token, 'hermes', 'client+backend', 'exch-backend');
      const ready = await waitForMessage(ws, 'peer_ready');
      expect(ready.backend.backendId).toBeDefined();
    });

    test('device tokens, access tokens, and the legacy secret cannot exchange', async () => {
      const { httpUrl } = await startServer();
      const device = await issueCredential(httpUrl, { type: 'device', namespace: 'hermes' });
      expect((await exchange(httpUrl, device.body.data.token)).status).toBe(403);

      const enrollment = await issueCredential(httpUrl, { type: 'backend', namespace: 'hermes' });
      const access = await exchange(httpUrl, enrollment.body.data.token);
      expect((await exchange(httpUrl, access.body.data.token)).status).toBe(403);

      expect((await exchange(httpUrl, 'some-shared-secret-value')).status).toBe(401);
      expect((await exchange(httpUrl, 'zgb_bogus')).status).toBe(401);
    });

    test('revoking the enrollment cascades: access tokens die and peers disconnect', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const enrollment = await issueCredential(httpUrl, { type: 'backend', namespace: 'hermes', name: 'host-2' });
      const access = await exchange(httpUrl, enrollment.body.data.token);

      const ws = await connect(wsUrl);
      sendHello(ws, access.body.data.token, 'hermes', 'client+backend', 'cascade-backend');
      await waitForMessage(ws, 'peer_ready');

      const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
      const revoke = await fetch(`${httpUrl}/api/admin/credentials/${enrollment.body.data.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      const revokeBody = await revoke.json();
      // Both the enrollment and its access token are reported revoked
      expect(revokeBody.data.revoked).toHaveLength(2);
      expect(await closed).toBe(1008);

      // The access token is dead for reconnects too
      const ws2 = await connect(wsUrl);
      sendHello(ws2, access.body.data.token, 'hermes', 'client+backend', 'cascade-backend');
      const err = await waitForMessage(ws2, 'gateway_error');
      expect(err.code).toBe('UNAUTHORIZED');
    });

    test('expired access tokens are rejected', async () => {
      const { wsUrl, httpUrl } = await startServer({ backendAccessTokenTtlMs: 50 });
      const enrollment = await issueCredential(httpUrl, { type: 'backend', namespace: 'hermes' });
      const access = await exchange(httpUrl, enrollment.body.data.token);

      await new Promise((r) => setTimeout(r, 120));
      const ws = await connect(wsUrl);
      sendHello(ws, access.body.data.token, 'hermes', 'client+backend', 'expired-backend');
      const err = await waitForMessage(ws, 'gateway_error');
      expect(err.code).toBe('UNAUTHORIZED');
    });
  });

  describe('HTTP proxy with credentials', () => {
    /** v4 backend serving http channels: every request answers 200 'ok'. */
    async function registerEchoBackend(wsUrl: string, httpUrl: string, namespace: string, instanceId: string) {
      const issued = await issueCredential(httpUrl, { type: 'backend', namespace });
      const ws = await connect(wsUrl);
      sendHello(ws, issued.body.data.token, namespace, 'client+backend', instanceId);
      const ready = await waitForMessage(ws, 'peer_ready');
      const base = wsUrl.replace(/\/ws$/, '');
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type !== 'channel_offer' || msg.kind !== 'http') return;
        const dataWs = new WebSocket(`${base}${msg.dataPath}?ticket=${msg.ticket}`);
        sockets.push(dataWs);
        dataWs.on('message', (d: Buffer, isBinary: boolean) => {
          if (isBinary) return;
          const frame = JSON.parse(d.toString());
          if (frame.type === 'http_request_end') {
            dataWs.send(JSON.stringify({ type: 'http_response', status: 200, headers: { 'content-type': 'text/plain' } }));
            dataWs.send(Buffer.from('ok'));
            dataWs.close(1000);
          }
        });
      });
      return ready.backend.backendId as string;
    }

    test('device credential can proxy to its own namespace only', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const zclaudiaBackend = await registerEchoBackend(wsUrl, httpUrl, 'zclaudia', 'proxy-z');
      const hermesBackend = await registerEchoBackend(wsUrl, httpUrl, 'hermes', 'proxy-h');
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

    test('a non-credential bearer token cannot proxy anywhere', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const hermesBackend = await registerEchoBackend(wsUrl, httpUrl, 'hermes', 'proxy-legacy');
      const response = await fetch(`${httpUrl}/api/proxy/${hermesBackend}/test`, {
        headers: { Authorization: 'Bearer some-shared-secret-value' },
      });
      expect(response.status).toBe(401);
    });
  });
});
