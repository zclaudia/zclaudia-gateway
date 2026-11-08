/**
 * Runtime build info + backend/channel diagnostics on the admin overview:
 * build injection vs the 'unknown' dev fallback, the live channel count
 * moving with the channel lifecycle, normalized backend disconnect reasons
 * (closed / replaced / credential_revoked), correct state after reconnect,
 * and the bounded disconnect history. Diagnostics must never surface
 * tokens: the overview body is checked for credential token prefixes.
 */
import { describe, test, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'http';
import net from 'node:net';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer, TEST_ADMIN_TOKEN } from './test-server.js';
import type { AdminOverview } from '@zclaudia/gateway-protocol/admin';

async function canBindLoopback(): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

const describeIfLoopback = (await canBindLoopback()) ? describe : describe.skip;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Poll an (async) condition until it holds or the timeout expires. */
async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error('Condition not met in time');
    await delay(10);
  }
}

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
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
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

/** Issue a credential and return the full record (id, token, backendId). */
async function issueCredential(
  httpUrl: string,
  body: Record<string, unknown>,
): Promise<{ id: string; token: string; backendId: string | null }> {
  const res = await fetch(`${httpUrl}/api/admin/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  const json = await res.json() as { data: { id: string; token: string; backendId: string | null } };
  return json.data;
}

describeIfLoopback('Admin overview: build info & connection diagnostics', () => {
  const servers: Server[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    await Promise.all(sockets.map((ws) => closeWs(ws)));
    sockets.length = 0;
    await Promise.all(servers.map((s) => closeTestServer(s)));
    servers.length = 0;
  });

  async function startServer(overrides: Partial<Parameters<typeof createGatewayServer>[0]> = {}): Promise<string> {
    const server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN, ...overrides });
    servers.push(server);
    const { httpUrl } = await listenTestServer(server);
    return httpUrl;
  }

  async function overview(httpUrl: string): Promise<AdminOverview> {
    const res = await fetch(`${httpUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: AdminOverview };
    return body.data;
  }

  async function connect(wsUrl: string): Promise<WebSocket> {
    const ws = new WebSocket(wsUrl);
    sockets.push(ws);
    await waitForOpen(ws);
    return ws;
  }

  async function hello(
    ws: WebSocket,
    opts: { namespace: string; token: string; peerType: 'client-only' | 'client+backend'; instanceId: string },
  ): Promise<{ backendId?: string }> {
    const msg: Record<string, unknown> = {
      type: 'peer_hello',
      protocolVersion: 4,
      namespace: opts.namespace,
      clientProtocolVersion: 1,
      peerType: opts.peerType,
      gatewaySecret: opts.token,
      identity: { deviceId: `dev-${opts.instanceId}`, instanceId: opts.instanceId },
    };
    if (opts.peerType === 'client+backend') {
      msg.backend = { visible: true, capabilities: [], backendProtocolVersion: 1 };
    }
    ws.send(JSON.stringify(msg));
    const ready = await waitForMessage(ws, 'peer_ready');
    return { backendId: ready.backend?.backendId };
  }

  test('build info: injected values pass through; dev default is unknown + protocol 4', async () => {
    const injected = await startServer({
      buildInfo: { version: '9.9.9-test', commit: 'abc1234', buildTime: '2026-11-08T00:00:00Z', protocolVersion: 4 },
    });
    expect((await overview(injected)).build).toEqual({
      version: '9.9.9-test',
      commit: 'abc1234',
      buildTime: '2026-11-08T00:00:00Z',
      protocolVersion: 4,
    });

    // No injection (the vitest process never sets GATEWAY_BUILD_*): the
    // gateway must say so explicitly instead of guessing.
    const dev = await startServer();
    expect((await overview(dev)).build).toEqual({
      version: 'unknown',
      commit: 'unknown',
      buildTime: 'unknown',
      protocolVersion: 4,
    });
  });

  test('diagnostics.channels follows the channel lifecycle (open → dial → close)', async () => {
    const httpUrl = await startServer();
    const wsUrl = httpUrl.replace('http', 'ws') + '/ws';
    const backendToken = (await issueCredential(httpUrl, { type: 'backend', namespace: 'diag-ch', name: 'diag-backend' })).token;
    const deviceToken = (await issueCredential(httpUrl, { type: 'device', namespace: 'diag-ch', name: 'diag-client' })).token;

    const backendCtl = await connect(wsUrl);
    const { backendId } = await hello(backendCtl, { namespace: 'diag-ch', token: backendToken, peerType: 'client+backend', instanceId: 'diag-backend' });
    expect(backendId).toBeTruthy();
    const clientCtl = await connect(wsUrl);
    await hello(clientCtl, { namespace: 'diag-ch', token: deviceToken, peerType: 'client-only', instanceId: 'diag-client' });

    expect((await overview(httpUrl)).diagnostics.channels).toBe(0);

    // Attach the offer listener before sending channel_open: a frame that
    // arrives with no listener attached is dropped by ws.
    const offerPromise = waitForMessage(backendCtl, 'channel_offer');
    clientCtl.send(JSON.stringify({ type: 'channel_open', target: backendId, kind: 'diag' }));
    const ready = await waitForMessage(clientCtl, 'channel_ready');
    const offer = await offerPromise;
    // Tracked from channel_open on — including the pairing window.
    expect((await overview(httpUrl)).diagnostics.channels).toBe(1);
    const clientData = new WebSocket(`${httpUrl.replace('http', 'ws')}${ready.dataPath}?ticket=${ready.ticket}`);
    const backendData = new WebSocket(`${httpUrl.replace('http', 'ws')}${offer.dataPath}?ticket=${offer.ticket}`);
    sockets.push(clientData, backendData);
    await Promise.all([waitForOpen(clientData), waitForOpen(backendData)]);
    expect((await overview(httpUrl)).diagnostics.channels).toBe(1);

    await closeWs(backendData);
    await until(async () => (await overview(httpUrl)).diagnostics.channels === 0);
  });

  test('backend disconnects are recorded with normalized reasons; state recovers on reconnect', async () => {
    const httpUrl = await startServer();
    const wsUrl = httpUrl.replace('http', 'ws') + '/ws';
    const { token: backendToken, backendId } = await issueCredential(httpUrl, { type: 'backend', namespace: 'diag-disc', name: 'diag-backend' });
    expect(backendId).toBeTruthy();

    // --- closed: plain disconnect ---
    const first = await connect(wsUrl);
    await hello(first, { namespace: 'diag-disc', token: backendToken, peerType: 'client+backend', instanceId: 'inst-1' });
    expect((await overview(httpUrl)).diagnostics.recentBackendDisconnects).toHaveLength(0);
    await closeWs(first);
    await until(async () => (await overview(httpUrl)).diagnostics.recentBackendDisconnects.length === 1);
    {
      const data = await overview(httpUrl);
      expect(data.backends).toBe(0);
      expect(data.diagnostics.recentBackendDisconnects[0]).toMatchObject({ backendId, reason: 'closed' });
      expect(typeof data.diagnostics.recentBackendDisconnects[0].at).toBe('number');
    }

    // --- reconnect: online again, history retained ---
    const second = await connect(wsUrl);
    await hello(second, { namespace: 'diag-disc', token: backendToken, peerType: 'client+backend', instanceId: 'inst-1' });
    expect((await overview(httpUrl)).backends).toBe(1);

    // --- replaced: a second live connection with the same credential ---
    const third = await connect(wsUrl);
    await hello(third, { namespace: 'diag-disc', token: backendToken, peerType: 'client+backend', instanceId: 'inst-1' });
    await until(async () => (await overview(httpUrl)).diagnostics.recentBackendDisconnects[0]?.reason === 'replaced');
    {
      const data = await overview(httpUrl);
      expect(data.backends).toBe(1); // the newer connection stays online
      expect(data.diagnostics.recentBackendDisconnects[0]).toMatchObject({ backendId, reason: 'replaced' });
    }

    // --- credential_revoked: admin revocation closes the live backend ---
    const { id: credId, token: revokedToken } = await issueCredential(httpUrl, { type: 'backend', namespace: 'diag-revoke', name: 'diag-revoked' });
    const doomed = await connect(wsUrl);
    const { backendId: revokedBackendId } = await hello(doomed, { namespace: 'diag-revoke', token: revokedToken, peerType: 'client+backend', instanceId: 'inst-r' });
    const revokeRes = await fetch(`${httpUrl}/api/admin/credentials/${credId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(revokeRes.status).toBe(200);
    await until(async () => {
      const data = await overview(httpUrl);
      return data.diagnostics.recentBackendDisconnects.some((e) => e.backendId === revokedBackendId && e.reason === 'credential_revoked');
    });

    // Diagnostics carry ids and normalized reasons only — never tokens.
    const raw = await (await fetch(`${httpUrl}/api/admin/overview`, { headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` } })).text();
    expect(raw).not.toMatch(/zgd_|zgb_|zga_/);
    expect(raw).not.toContain(backendToken);
  });

  test('recent disconnects stay bounded (cap 20) and newest-first', async () => {
    const httpUrl = await startServer();
    const wsUrl = httpUrl.replace('http', 'ws') + '/ws';
    const { token } = await issueCredential(httpUrl, { type: 'backend', namespace: 'diag-ring', name: 'diag-ring' });

    for (let i = 0; i < 24; i++) {
      const ws = new WebSocket(wsUrl);
      await waitForOpen(ws);
      await hello(ws, { namespace: 'diag-ring', token, peerType: 'client+backend', instanceId: 'inst-ring' });
      await closeWs(ws);
      // Let the server finish its disconnect cleanup so the next connection
      // is a plain (re)connect, not a replacement.
      await until(async () => (await overview(httpUrl)).backends === 0);
    }

    const data = await overview(httpUrl);
    const events = data.diagnostics.recentBackendDisconnects;
    expect(events).toHaveLength(20);
    expect(events.every((e) => e.reason === 'closed')).toBe(true);
    for (let i = 1; i < events.length; i++) {
      expect(events[i - 1].at).toBeGreaterThanOrEqual(events[i].at);
    }
  });
});
