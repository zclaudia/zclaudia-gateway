/**
 * Backend discovery endpoint (GET /api/discovery/backends): lets pairing
 * clients with a device credential learn which backends the credential can
 * address. The list is the credential's backend scope over known backend
 * identities — including offline ones — not the online registry, so a picker
 * can tell "offline" from "not allowed".
 */
import { describe, test, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'http';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer, TEST_ADMIN_TOKEN } from './test-server.js';

const describeWs = process.platform === 'win32' ? describe.skip : describe;

interface DiscoveryItem {
  backendId: string;
  name: string;
  online: boolean;
  lastSeenAt: number | null;
}

describeWs('GET /api/discovery/backends', () => {
  const servers: Server[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.close();
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

  async function issueCredential(httpUrl: string, body: Record<string, unknown>) {
    const res = await fetch(`${httpUrl}/api/admin/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: JSON.stringify(body),
    });
    const parsed = await res.json() as {
      success: boolean;
      data?: { token: string; backendId: string | null; allowedBackends: string[] | null };
    };
    if (!parsed.success || !parsed.data) throw new Error(`issueCredential failed: ${res.status}`);
    return parsed.data;
  }

  /** A backend credential exists before its backend connects (ADR-0009). */
  async function provisionBackend(httpUrl: string, namespace: string, name: string) {
    const credential = await issueCredential(httpUrl, { type: 'backend', namespace, name });
    return { backendId: credential.backendId!, token: credential.token };
  }

  async function issueDevice(httpUrl: string, namespace: string, allowedBackends?: string[]): Promise<string> {
    const credential = await issueCredential(httpUrl, {
      type: 'device',
      namespace,
      name: 'pairing-phone',
      ...(allowedBackends ? { allowedBackends } : {}),
    });
    return credential.token;
  }

  async function registerBackend(
    httpUrl: string,
    wsUrl: string,
    namespace: string,
    instanceId: string,
    options: { visible?: boolean } = {},
  ): Promise<{ backendId: string; ws: WebSocket }> {
    const { backendId, token } = await provisionBackend(httpUrl, namespace, instanceId);
    const ws = new WebSocket(wsUrl);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({
      type: 'peer_hello',
      protocolVersion: 4,
      namespace,
      clientProtocolVersion: 1,
      peerType: 'client+backend',
      gatewaySecret: token,
      identity: { deviceId: `dev-${instanceId}`, instanceId, name: instanceId },
      backend: { visible: options.visible ?? true, capabilities: [], backendProtocolVersion: 1 },
    }));
    const ready = await new Promise<{ backend: { backendId: string } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting peer_ready')), 5000);
      ws.on('message', function handler(data: WebSocket.Data) {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'peer_ready') { clearTimeout(timer); ws.off('message', handler); resolve(msg); }
      });
    });
    // The gateway mints the id at issuance; the hello only echoes it.
    expect(ready.backend.backendId).toBe(backendId);
    return { backendId, ws };
  }

  function discover(httpUrl: string, token?: string): Promise<{ status: number; body: any }> {
    return fetch(`${httpUrl}/api/discovery/backends`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).then(async (res) => ({ status: res.status, body: await res.json() }));
  }

  function itemsOf(body: any): DiscoveryItem[] {
    return body.data.items as DiscoveryItem[];
  }

  async function until(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (await predicate()) return;
      if (Date.now() - start > timeoutMs) throw new Error('Condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
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
    const { backendId } = await registerBackend(httpUrl, wsUrl, 'discovery-home', 'inst-home');
    await registerBackend(httpUrl, wsUrl, 'discovery-other', 'inst-other');

    const token = await issueDevice(httpUrl, 'discovery-home');
    const res = await discover(httpUrl, token);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(itemsOf(res.body)).toHaveLength(1);
    expect(itemsOf(res.body)[0]).toMatchObject({
      backendId,
      name: 'inst-home',
      online: true,
    });
    expect(typeof itemsOf(res.body)[0].lastSeenAt).toBe('number');
  });

  test('backend scope: online members, offline members, never-connected members', async () => {
    const { wsUrl, httpUrl } = await startServer();
    const online = await registerBackend(httpUrl, wsUrl, 'discovery-scope', 'inst-online');
    const waiting = await provisionBackend(httpUrl, 'discovery-scope', 'inst-waiting');
    await registerBackend(httpUrl, wsUrl, 'discovery-scope', 'inst-out-of-scope');

    const token = await issueDevice(httpUrl, 'discovery-scope', [online.backendId, waiting.backendId]);
    const res = await discover(httpUrl, token);
    expect(res.status).toBe(200);
    // Exactly the scope, online first; the out-of-scope backend never appears.
    expect(itemsOf(res.body).map((i) => i.backendId)).toEqual([online.backendId, waiting.backendId]);
    expect(itemsOf(res.body)[0]).toMatchObject({ online: true });
    expect(itemsOf(res.body)[1]).toMatchObject({ online: false, lastSeenAt: null });
  });

  test('a provisioned backend is listed before it ever connects', async () => {
    const { httpUrl } = await startServer();
    const { backendId } = await provisionBackend(httpUrl, 'discovery-orphan', 'home-pc');

    const token = await issueDevice(httpUrl, 'discovery-orphan', [backendId]);
    const res = await discover(httpUrl, token);
    expect(itemsOf(res.body)).toEqual([
      { backendId, name: 'home-pc', online: false, lastSeenAt: null },
    ]);
  });

  test('a backend that went offline stays listed, with its last seen time', async () => {
    const { wsUrl, httpUrl } = await startServer();
    const { backendId, ws } = await registerBackend(httpUrl, wsUrl, 'discovery-offline', 'inst-gone');
    const token = await issueDevice(httpUrl, 'discovery-offline');

    expect(itemsOf((await discover(httpUrl, token)).body)[0]).toMatchObject({ online: true });

    ws.close();
    await until(async () => !itemsOf((await discover(httpUrl, token)).body)[0].online);
    const [item] = itemsOf((await discover(httpUrl, token)).body);
    expect(item.backendId).toBe(backendId);
    expect(typeof item.lastSeenAt).toBe('number');
  });

  test('a backend declaring visible:false is still discovered as online', async () => {
    const { wsUrl, httpUrl } = await startServer();
    const { backendId } = await registerBackend(httpUrl, wsUrl, 'discovery-hidden', 'inst-hidden', { visible: false });

    const token = await issueDevice(httpUrl, 'discovery-hidden');
    const res = await discover(httpUrl, token);
    expect(itemsOf(res.body)).toEqual([
      { backendId, name: 'inst-hidden', online: true, lastSeenAt: expect.any(Number) },
    ]);
  });

  test('empty namespace returns an empty list, not an error', async () => {
    const { httpUrl } = await startServer();
    const token = await issueDevice(httpUrl, 'discovery-empty');
    const res = await discover(httpUrl, token);
    expect(res.status).toBe(200);
    expect(itemsOf(res.body)).toEqual([]);
  });
});
