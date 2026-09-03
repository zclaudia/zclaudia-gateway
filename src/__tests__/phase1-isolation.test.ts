/**
 * Phase 1 security & isolation tests: namespace isolation, proxy response
 * ownership binding, targeted message subscription checks, HTTP status
 * mapping, and CORS allowlist.
 */
import { describe, test, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'http';
import net from 'node:net';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer } from './test-server.js';

const GATEWAY_SECRET = 'test-secret-phase1';

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

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIfLoopback('Phase 1: Security & Isolation', () => {
  const servers: Server[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    await Promise.all(sockets.map((ws) => closeWs(ws)));
    sockets.length = 0;
    await Promise.all(servers.map((s) => closeTestServer(s)));
    servers.length = 0;
  });

  async function startServer(config: Parameters<typeof createGatewayServer>[0] = { gatewaySecret: GATEWAY_SECRET }) {
    const server = createGatewayServer(config);
    servers.push(server);
    const { wsUrl, httpUrl } = await listenTestServer(server);
    return { server, wsUrl, httpUrl };
  }

  async function connect(wsUrl: string): Promise<WebSocket> {
    const ws = new WebSocket(wsUrl);
    sockets.push(ws);
    await waitForOpen(ws);
    return ws;
  }

  async function registerBackend(ws: WebSocket, namespace: string, instanceId: string, name = instanceId) {
    ws.send(JSON.stringify({
      type: 'peer_hello',
      protocolVersion: 3,
      namespace,
      clientProtocolVersion: 1,
      peerType: 'client+backend',
      gatewaySecret: GATEWAY_SECRET,
      identity: { deviceId: `dev-${instanceId}`, instanceId, name },
      backend: { visible: true, capabilities: [], backendProtocolVersion: 1 },
    }));
    const ready = await waitForMessage(ws, 'peer_ready');
    return { backendId: ready.backend.backendId as string, epoch: ready.backend.epoch as number, registrySync: ready.registrySync };
  }

  async function registerClient(ws: WebSocket, namespace: string, instanceId: string) {
    ws.send(JSON.stringify({
      type: 'peer_hello',
      protocolVersion: 3,
      namespace,
      clientProtocolVersion: 1,
      peerType: 'client-only',
      gatewaySecret: GATEWAY_SECRET,
      identity: { deviceId: `dev-${instanceId}`, instanceId },
    }));
    const ready = await waitForMessage(ws, 'peer_ready');
    return { peerSessionId: ready.peerSessionId as string, registrySync: ready.registrySync };
  }

  describe('Namespace isolation', () => {
    test('backends in different namespaces are mutually invisible in the registry', async () => {
      const { wsUrl } = await startServer();
      const wsA = await connect(wsUrl);
      const wsB = await connect(wsUrl);
      const a = await registerBackend(wsA, 'app-a', 'inst-a');
      const b = await registerBackend(wsB, 'app-b', 'inst-b');

      // Each backend's own registrySync must not contain the other
      expect(a.registrySync.items.map((i: any) => i.backendId)).toEqual([a.backendId]);
      expect(b.registrySync.items.map((i: any) => i.backendId)).toEqual([b.backendId]);

      // A fresh client in app-a sees only backend A
      const wsClient = await connect(wsUrl);
      const client = await registerClient(wsClient, 'app-a', 'client-a');
      const ids = client.registrySync.items.map((i: any) => i.backendId);
      expect(ids).toContain(a.backendId);
      expect(ids).not.toContain(b.backendId);
    });

    test('request_registry_snapshot is namespace-scoped', async () => {
      const { wsUrl } = await startServer();
      const wsA = await connect(wsUrl);
      await registerBackend(wsA, 'app-a', 'inst-a2');
      const wsClient = await connect(wsUrl);
      await registerClient(wsClient, 'app-b', 'client-b2');

      wsClient.send(JSON.stringify({ type: 'request_registry_snapshot' }));
      const snapshot = await waitForMessage(wsClient, 'registry_snapshot');
      expect(snapshot.items).toEqual([]);
    });

    test('cross-namespace subscribe is rejected like a nonexistent backend', async () => {
      const { wsUrl } = await startServer();
      const wsA = await connect(wsUrl);
      const a = await registerBackend(wsA, 'app-a', 'inst-a3');
      const wsClient = await connect(wsUrl);
      await registerClient(wsClient, 'app-b', 'client-b3');

      wsClient.send(JSON.stringify({ type: 'subscribe_backend', backendId: a.backendId }));
      const err = await waitForMessage(wsClient, 'gateway_error');
      expect(err.code).toBe('BACKEND_OFFLINE');
    });

    test('registry broadcasts stay within the namespace', async () => {
      const { wsUrl } = await startServer();
      const wsClient = await connect(wsUrl);
      await registerClient(wsClient, 'app-b', 'client-b4');

      // Registering a backend in app-a triggers a broadcast; app-b client
      // must receive its own (empty) slice, never the app-a backend.
      const received: any[] = [];
      wsClient.on('message', (data) => received.push(JSON.parse(data.toString())));
      const wsA = await connect(wsUrl);
      await registerBackend(wsA, 'app-a', 'inst-a4');
      await delay(200);

      for (const msg of received) {
        if (msg.type === 'registry_snapshot') {
          expect(msg.items).toEqual([]);
        }
      }
    });
  });

  describe('Proxy response ownership binding', () => {
    test('a different backend cannot spoof a proxy response, owner response still wins', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const wsOwner = await connect(wsUrl);
      const owner = await registerBackend(wsOwner, 'app-a', 'inst-owner');
      const wsAttacker = await connect(wsUrl);
      await registerBackend(wsAttacker, 'app-a', 'inst-attacker');

      wsOwner.on('message', async (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'http_proxy_request') {
          // Attacker responds first with the stolen requestId
          wsAttacker.send(JSON.stringify({
            type: 'http_proxy_response', requestId: msg.requestId,
            statusCode: 200, headers: {}, bodyEncoding: 'utf8', body: 'spoofed',
          }));
          await delay(150);
          // Owner responds afterwards; this is the one that must win
          wsOwner.send(JSON.stringify({
            type: 'http_proxy_response', requestId: msg.requestId,
            statusCode: 200, headers: {}, bodyEncoding: 'utf8', body: 'legit',
          }));
        }
      });

      const response = await fetch(`${httpUrl}/api/proxy/${owner.backendId}/test`, {
        headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('legit');
    });
  });

  describe('Targeted message subscription checks', () => {
    test('targeted backend_server_message reaches same-namespace peers, never other namespaces', async () => {
      const { wsUrl } = await startServer();
      const wsBackend = await connect(wsUrl);
      const b = await registerBackend(wsBackend, 'app-a', 'inst-target');
      const wsClient = await connect(wsUrl);
      const client = await registerClient(wsClient, 'app-a', 'client-target');
      const wsOther = await connect(wsUrl);
      const other = await registerClient(wsOther, 'app-b', 'client-other-ns');

      const receivedOther: any[] = [];
      wsOther.on('message', (data) => receivedOther.push(JSON.parse(data.toString())));

      // Same namespace, not v3-subscribed (v4 clients hold channels/topics
      // instead): targeted message is delivered
      wsBackend.send(JSON.stringify({
        type: 'backend_server_message', backendId: b.backendId,
        targetPeerSessionId: client.peerSessionId, message: { seq: 1 },
      }));
      const delivered = await waitForMessage(wsClient, 'backend_server_message');
      expect(delivered.message.seq).toBe(1);

      // Cross-namespace: dropped even with a guessed session id
      wsBackend.send(JSON.stringify({
        type: 'backend_server_message', backendId: b.backendId,
        targetPeerSessionId: other.peerSessionId, message: { seq: 2 },
      }));
      await delay(150);
      expect(receivedOther.filter((m) => m.type === 'backend_server_message')).toEqual([]);
    });

    test('request_backend_resource_snapshot requires subscription', async () => {
      const { wsUrl } = await startServer();
      const wsBackend = await connect(wsUrl);
      const b = await registerBackend(wsBackend, 'app-a', 'inst-snap');
      const wsClient = await connect(wsUrl);
      await registerClient(wsClient, 'app-a', 'client-snap');

      wsClient.send(JSON.stringify({ type: 'request_backend_resource_snapshot', backendId: b.backendId }));
      const err = await waitForMessage(wsClient, 'gateway_error');
      expect(err.code).toBe('BACKEND_NOT_SUBSCRIBED');
    });

    test('resource snapshot with targetPeerSessionId reaches only the target', async () => {
      const { wsUrl } = await startServer();
      const wsBackend = await connect(wsUrl);
      const b = await registerBackend(wsBackend, 'app-a', 'inst-tsnap');

      const wsC1 = await connect(wsUrl);
      const c1 = await registerClient(wsC1, 'app-a', 'client-t1');
      const wsC2 = await connect(wsUrl);
      await registerClient(wsC2, 'app-a', 'client-t2');
      wsC1.send(JSON.stringify({ type: 'subscribe_backend', backendId: b.backendId }));
      await waitForMessage(wsC1, 'backend_subscribed');
      wsC2.send(JSON.stringify({ type: 'subscribe_backend', backendId: b.backendId }));
      await waitForMessage(wsC2, 'backend_subscribed');

      const c2Received: any[] = [];
      wsC2.on('message', (data) => c2Received.push(JSON.parse(data.toString())));

      wsBackend.send(JSON.stringify({
        type: 'backend_resource_snapshot',
        targetPeerSessionId: c1.peerSessionId,
        resources: [{ resourceType: 'session', resourceId: 'r1', resource: {} }],
      }));

      const snap = await waitForMessage(wsC1, 'backend_resource_snapshot');
      expect(snap.backendId).toBe(b.backendId);
      await delay(150);
      expect(c2Received.filter((m) => m.type === 'backend_resource_snapshot')).toEqual([]);
    });
  });

  describe('HTTP status mapping', () => {
    test('proxy timeout returns 504', async () => {
      const { wsUrl, httpUrl } = await startServer({ gatewaySecret: GATEWAY_SECRET, proxyRequestTimeoutMs: 400 });
      const wsBackend = await connect(wsUrl);
      const b = await registerBackend(wsBackend, 'app-a', 'inst-504');
      // Backend never responds to the proxy request

      const response = await fetch(`${httpUrl}/api/proxy/${b.backendId}/slow`, {
        headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
      });
      expect(response.status).toBe(504);
      const body = await response.json();
      expect(body.error.code).toBe('GATEWAY_TIMEOUT');
    });

    test('backend disconnect during proxy returns 502', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const wsBackend = await connect(wsUrl);
      const b = await registerBackend(wsBackend, 'app-a', 'inst-502');

      wsBackend.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'http_proxy_request') {
          wsBackend.close();
        }
      });

      const response = await fetch(`${httpUrl}/api/proxy/${b.backendId}/dropped`, {
        headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
      });
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body.error.code).toBe('BACKEND_OFFLINE');
    });
  });

  describe('CORS allowlist', () => {
    test('allowed origin is echoed with credentials, others get no CORS header', async () => {
      const { httpUrl } = await startServer({
        gatewaySecret: GATEWAY_SECRET,
        allowedOrigins: ['https://app.example.com'],
      });

      const allowed = await fetch(`${httpUrl}/health`, { headers: { Origin: 'https://app.example.com' } });
      expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
      expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');

      const denied = await fetch(`${httpUrl}/health`, { headers: { Origin: 'https://evil.example.com' } });
      expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    });

    test('without an allowlist the legacy wildcard is preserved', async () => {
      const { httpUrl } = await startServer();
      const response = await fetch(`${httpUrl}/health`, { headers: { Origin: 'https://anything.example.com' } });
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
    });
  });
});
