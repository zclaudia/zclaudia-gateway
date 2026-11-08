/**
 * Connection capacity regression: the per-IP control-connection limit
 * (default, custom, release-on-close, disable) and slow-consumer behavior
 * (one channel's backlog pauses only that channel; nothing deadlocks; the
 * backlog drains on resume), plus resource recovery observed through the
 * admin diagnostics counters. Small and bounded so it can run in CI; the
 * sustained-load counterpart is scripts/capacity-verify.ts (pnpm capacity).
 */
import { describe, test, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'http';
import net from 'node:net';
import { createGatewayServer } from '../server.js';
import { GatewayBackend } from '@zclaudia/gateway-backend';
import { closeTestServer, listenTestServer, issueToken, TEST_ADMIN_TOKEN } from './test-server.js';

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

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', () => resolve());
    ws.close();
  });
}

/** Resolves with the close code — for connections the gateway refuses. */
function waitForCloseCode(ws: WebSocket, timeoutMs = 5000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for close')), timeoutMs);
    ws.once('close', (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
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

interface Overview {
  backends: number;
  peers: { peerSessionId: string }[];
  diagnostics: { channels: number };
}

async function overview(httpUrl: string): Promise<Overview> {
  const res = await fetch(`${httpUrl}/api/admin/overview`, {
    headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()).data as Overview;
}

// ============================================================================
// Per-IP control-connection limit
// ============================================================================

describeIfLoopback('Per-IP WS connection limit', () => {
  const servers: Server[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    await Promise.all(sockets.map((ws) => closeWs(ws)));
    sockets.length = 0;
    await Promise.all(servers.map((s) => closeTestServer(s)));
    servers.length = 0;
  });

  async function startServer(overrides: Record<string, unknown> = {}): Promise<string> {
    const server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN, ...overrides });
    servers.push(server);
    const { httpUrl } = await listenTestServer(server);
    return httpUrl;
  }

  test('default limit is 10 per IP, pre-auth; the 11th is refused with 1008', async () => {
    const httpUrl = await startServer();
    const wsUrl = httpUrl.replace('http', 'ws') + '/ws';
    for (let i = 0; i < 10; i++) sockets.push(await openWs(wsUrl)); // no hello: quota counts pre-auth
    const eleventh = new WebSocket(wsUrl);
    sockets.push(eleventh);
    await new Promise<void>((resolve) => eleventh.once('open', () => resolve()));
    const { code, reason } = await waitForCloseCode(eleventh);
    expect(code).toBe(1008);
    expect(reason).toBe('Too many connections');
  });

  test('custom limit enforced; quota is released on close, refusals never count', async () => {
    const httpUrl = await startServer({ maxWsConnectionsPerIp: 2 });
    const wsUrl = httpUrl.replace('http', 'ws') + '/ws';

    sockets.push(await openWs(wsUrl), await openWs(wsUrl));
    const third = new WebSocket(wsUrl);
    sockets.push(third);
    await new Promise<void>((resolve) => third.once('open', () => resolve()));
    const { code } = await waitForCloseCode(third);
    expect(code).toBe(1008); // refused — and must not consume quota

    // Close one holder: its slot frees and a new connection is accepted.
    const freed = sockets[0];
    sockets.shift();
    await closeWs(freed);
    const replacement = await openWs(wsUrl);
    sockets.push(replacement);
    await delay(300); // stays open: not refused
    expect(replacement.readyState).toBe(WebSocket.OPEN);

    // Cleanup all holders, then verify the full budget is available again.
    const holders = sockets.splice(0);
    await Promise.all(holders.map((ws) => closeWs(ws)));
    sockets.push(await openWs(wsUrl), await openWs(wsUrl));
    await delay(200);
    expect(sockets.every((ws) => ws.readyState === WebSocket.OPEN)).toBe(true);
  });

  test('0 disables the cap', async () => {
    const httpUrl = await startServer({ maxWsConnectionsPerIp: 0 });
    const wsUrl = httpUrl.replace('http', 'ws') + '/ws';
    for (let i = 0; i < 12; i++) sockets.push(await openWs(wsUrl));
    await delay(200);
    expect(sockets.every((ws) => ws.readyState === WebSocket.OPEN)).toBe(true);
  });
});

// ============================================================================
// Slow-consumer isolation and resource recovery
// ============================================================================

describeIfLoopback('Slow consumers and resource recovery', () => {
  const servers: Server[] = [];
  const sockets: WebSocket[] = [];
  const backends: GatewayBackend[] = [];
  let httpUrl = '';
  let backendToken = '';

  afterEach(async () => {
    for (const backend of backends) backend.close();
    backends.length = 0;
    await Promise.all(sockets.map((ws) => closeWs(ws)));
    sockets.length = 0;
    await Promise.all(servers.map((s) => closeTestServer(s)));
    servers.length = 0;
  });

  async function connect(wsUrl: string): Promise<WebSocket> {
    const ws = new WebSocket(wsUrl);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return ws;
  }

  async function hello(ws: WebSocket, peerType: 'client-only' | 'client+backend', instanceId: string): Promise<{ backendId?: string }> {
    ws.send(JSON.stringify({
      type: 'peer_hello',
      protocolVersion: 4,
      namespace: 'cap',
      clientProtocolVersion: 1,
      peerType,
      gatewaySecret: backendToken,
      identity: { deviceId: `dev-${instanceId}`, instanceId },
      ...(peerType === 'client+backend' ? { backend: { visible: true, capabilities: [], backendProtocolVersion: 1 } } : {}),
    }));
    const ready = await waitForMessage(ws, 'peer_ready');
    return { backendId: ready.backend?.backendId };
  }

  beforeEach(async () => {
    const server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN });
    servers.push(server);
    ({ httpUrl } = await listenTestServer(server));
    backendToken = await issueToken(httpUrl, 'backend', 'cap');
  });

  test('one channel backlog does not block another; the backlog drains on resume', async () => {
    const wsUrl = httpUrl.replace('http', 'ws') + '/ws';
    // Echo backend: text and binary alike.
    const backend = new GatewayBackend({
      url: httpUrl, credential: backendToken, namespace: 'cap',
      identity: { instanceId: 'echo-backend' }, heartbeatIntervalMs: 5000,
    });
    backend.onChannel('echo', (channel) => {
      channel.onMessage((message) => channel.send(message.data));
    });
    backends.push(backend);
    const { backendId } = await backend.connect();

    const base = httpUrl.replace('http', 'ws');
    async function dialChannel(instanceId: string): Promise<{ ctl: WebSocket; data: WebSocket; channelId: string }> {
      const ctl = await connect(wsUrl);
      await hello(ctl, 'client-only', instanceId);
      ctl.send(JSON.stringify({ type: 'channel_open', target: backendId, kind: 'echo' }));
      const ready = await waitForMessage(ctl, 'channel_ready');
      const data = new WebSocket(`${base}${ready.dataPath}?ticket=${ready.ticket}`);
      sockets.push(data);
      await new Promise<void>((resolve, reject) => { data.once('open', resolve); data.once('error', reject); });
      return { ctl, data, channelId: ready.channelId };
    }

    const normal = await dialChannel('normal-client');
    const slow = await dialChannel('slow-client');

    // The slow consumer stops reading; its channel fills the gateway's
    // per-channel high-water mark (4 MiB) and must stall — bounded memory.
    slow.data.pause();
    const FRAME = 1024 * 1024;
    const SLOW_FRAMES = 12;
    let slowReceived = 0;
    slow.data.on('message', (data: Buffer) => { slowReceived += data.length; });
    for (let i = 0; i < SLOW_FRAMES; i++) slow.data.send(Buffer.alloc(FRAME, 1));

    await delay(500); // echo traffic piles up toward the paused consumer
    expect(slowReceived).toBeLessThan(FRAME * SLOW_FRAMES); // stalled, not draining

    // Meanwhile the normal channel keeps echoing text and binary freely.
    let normalEchoes = 0;
    const normalFrameText = JSON.stringify({ probe: 'text', n: 0 });
    const normalFrameBinary = Buffer.alloc(64 * 1024, 2);
    const echoed = new Promise<void>((resolve) => {
      normal.data.on('message', (_data: Buffer, isBinary: boolean) => {
        if (isBinary) normalEchoes++;
        else normalEchoes++;
        if (normalEchoes >= 20) resolve();
      });
    });
    for (let round = 0; round < 10; round++) {
      normal.data.send(normalFrameText);
      normal.data.send(normalFrameBinary);
    }
    await echoed; // isolation: another channel's backlog blocked nothing here
    expect(normalEchoes).toBeGreaterThanOrEqual(20);

    // Resume: the backlog drains completely — backpressure, not a deadlock.
    slow.data.resume();
    await until(() => slowReceived === FRAME * SLOW_FRAMES, 20_000);
  }, 30_000);

  test('cancel, disconnect and reconnect churn return the diagnostics to baseline', async () => {
    const wsUrl = httpUrl.replace('http', 'ws') + '/ws';
    const backend = new GatewayBackend({
      url: httpUrl, credential: backendToken, namespace: 'cap',
      identity: { instanceId: 'churn-backend' }, heartbeatIntervalMs: 5000,
    });
    backend.onChannel('echo', () => undefined); // accept offers; traffic content is irrelevant here
    backends.push(backend);
    const { backendId } = await backend.connect();

    const base = httpUrl.replace('http', 'ws');
    async function connectClient(): Promise<{ ctl: WebSocket; data: WebSocket }> {
      const ctl = await connect(wsUrl);
      await hello(ctl, 'client-only', `churn-${Math.random().toString(36).slice(2, 8)}`);
      ctl.send(JSON.stringify({ type: 'channel_open', target: backendId, kind: 'echo' }));
      const ready = await waitForMessage(ctl, 'channel_ready');
      const data = new WebSocket(`${base}${ready.dataPath}?ticket=${ready.ticket}`);
      sockets.push(data);
      await new Promise<void>((resolve, reject) => { data.once('open', resolve); data.once('error', reject); });
      return { ctl, data };
    }

    const a = await connectClient();
    const b = await connectClient();
    expect((await overview(httpUrl)).diagnostics.channels).toBe(2);

    // Active cancel: closing one data socket tears exactly that channel down.
    await closeWs(a.data);
    await until(async () => (await overview(httpUrl)).diagnostics.channels === 1);

    // Client disconnect: its channels go with it.
    await closeWs(b.ctl);
    await until(async () => (await overview(httpUrl)).diagnostics.channels === 0);

    // Reconnect churn: three full client cycles, then everything drains back
    // to the baseline (one backend online, zero channels).
    for (let i = 0; i < 3; i++) {
      const c = await connectClient();
      await until(async () => (await overview(httpUrl)).diagnostics.channels === 1);
      await closeWs(c.ctl);
      await until(async () => (await overview(httpUrl)).diagnostics.channels === 0);
    }
    // Client a cancelled only its channel earlier; its control connection is
    // still legitimate. Close it too, then the baseline is the backend alone.
    await closeWs(a.ctl);
    await until(async () => (await overview(httpUrl)).peers.length === 1);
    const finalState = await overview(httpUrl);
    expect(finalState.backends).toBe(1);
    expect(finalState.peers).toHaveLength(1); // only the backend's control connection
    expect(finalState.diagnostics.channels).toBe(0);
  }, 30_000);
});
