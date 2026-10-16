/**
 * Backend discovery endpoint (GET /api/discovery/backends): lets pairing
 * clients with a namespace-scoped device credential learn which backends the
 * credential can reach, without knowing a backendId up front.
 */
import { describe, test, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'http';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer, issueToken, TEST_ADMIN_TOKEN } from './test-server.js';

const describeWs = process.platform === 'win32' ? describe.skip : describe;

describeWs('GET /api/discovery/backends', () => {
  const servers: Server[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) {
      ws.readyState === WebSocket.OPEN && ws.close();
    }
    sockets.length = 0;
    await Promise.all(servers.map((s) => closeTestServer(s)));
    servers.length = 0;
  });

  async function startServer() {
    const server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN });
    servers.push(server);
    const { wsUrl, httpUrl } = await listenTestServer(server);
    return { wsUrl, httpUrl };
  }

  async function issueDevice(httpUrl: string, namespace: string, allowedBackends?: string[]): Promise<string> {
    const res = await fetch(`${httpUrl}/api/admin/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: JSON.stringify({ type: 'device', namespace, name: 'pairing-phone', allowedBackends }),
    });
    const body = await res.json() as { success: boolean; data?: { token: string } };
    if (!body.success || !body.data) throw new Error(`issueDevice failed: ${res.status}`);
    return body.data.token;
  }

  async function registerBackend(wsUrl: string, namespace: string, instanceId: string): Promise<string> {
    const ws = new WebSocket(wsUrl);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const backendToken = await issueToken(httpUrlOf(wsUrl), 'backend', namespace);
    ws.send(JSON.stringify({
      type: 'peer_hello',
      protocolVersion: 4,
      namespace,
      clientProtocolVersion: 1,
      peerType: 'client+backend',
      gatewaySecret: backendToken,
      identity: { deviceId: `dev-${instanceId}`, instanceId, name: instanceId },
      backend: { visible: true, capabilities: [], backendProtocolVersion: 1 },
    }));
    const ready = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting peer_ready')), 5000);
      ws.on('message', function handler(data: WebSocket.Data) {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'peer_ready') { clearTimeout(timer); ws.off('message', handler); resolve(msg); }
      });
    });
    return ready.backend.backendId as string;
  }

  function httpUrlOf(wsUrl: string): string {
    return wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
  }

  function discover(httpUrl: string, token?: string): Promise<{ status: number; body: any }> {
    return fetch(`${httpUrl}/api/discovery/backends`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).then(async (res) => ({ status: res.status, body: await res.json() }));
  }

  test('requires a bearer credential', async () => {
    const { httpUrl } = await startServer();
    const missing = await discover(httpUrl);
    expect(missing.status).toBe(401);
    const bad = await discover(httpUrl, 'zgd_not-a-credential');
    expect(bad.status).toBe(401);
  });

  test('namespace-scoped device sees only its own namespace backends', async () => {
    const { wsUrl, httpUrl } = await startServer();
    const backendId = await registerBackend(wsUrl, 'home-ns', 'inst-home');
    await registerBackend(wsUrl, 'other-ns', 'inst-other');

    const token = await issueDevice(httpUrl, 'home-ns');
    const res = await discover(httpUrl, token);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({
      backendId,
      name: 'inst-home',
      online: true,
    });
    expect(typeof res.body.data.items[0].lastSeenAt).toBe('number');
  });

  test('backend-scoped device does not see out-of-scope backends', async () => {
    const { wsUrl, httpUrl } = await startServer();
    const idA = await registerBackend(wsUrl, 'ns', 'inst-a');
    await registerBackend(wsUrl, 'ns', 'inst-b');

    const token = await issueDevice(httpUrl, 'ns', [idA]);
    const res = await discover(httpUrl, token);
    expect(res.status).toBe(200);
    const ids = (res.body.data.items as Array<{ backendId: string }>).map((i) => i.backendId);
    expect(ids).toEqual([idA]);
  });

  test('empty namespace returns an empty list, not an error', async () => {
    const { httpUrl } = await startServer();
    const token = await issueDevice(httpUrl, 'empty-ns');
    const res = await discover(httpUrl, token);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });
});
