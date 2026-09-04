/**
 * Phase 3: SDK contract tests — @zclaudia/gateway-client and
 * @zclaudia/gateway-backend talking to each other through a real gateway
 * instance. Uses Node's native WHATWG WebSocket, i.e. the same API surface
 * a WebView client has (no custom headers).
 */
import { describe, test, expect, afterEach } from 'vitest';
import type { Server } from 'http';
import net from 'node:net';
import { createGatewayServer } from '../server.js';
import { listenTestServer, closeTestServer, issueToken, TEST_ADMIN_TOKEN } from './test-server.js';
import { GatewayClient } from '@zclaudia/gateway-client';
import { GatewayBackend } from '@zclaudia/gateway-backend';

// Issued zgb_ token, refreshed for every test server instance.
let GATEWAY_SECRET = '';

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

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Condition not met in time');
    await delay(25);
  }
}

describeIfLoopback('Phase 3: SDK contract', () => {
  const servers: Server[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
    await Promise.all(servers.map((s) => closeTestServer(s)));
    servers.length = 0;
  });

  async function startServer(overrides: Partial<Parameters<typeof createGatewayServer>[0]> = {}) {
    const server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN, ...overrides });
    servers.push(server);
    const { httpUrl } = await listenTestServer(server);
    GATEWAY_SECRET = await issueToken(httpUrl, 'backend', 'sdk-test');
    return { httpUrl };
  }

  function makeBackend(url: string, instanceId: string) {
    const backend = new GatewayBackend({
      url,
      credential: GATEWAY_SECRET,
      namespace: 'sdk-test',
      identity: { deviceId: `dev-${instanceId}`, instanceId, name: instanceId },
      heartbeatIntervalMs: 2000,
    });
    cleanups.push(() => backend.close());
    return backend;
  }

  function makeClient(url: string, instanceId: string, reconnect = true) {
    const client = new GatewayClient({
      url,
      credential: GATEWAY_SECRET,
      namespace: 'sdk-test',
      identity: { deviceId: `dev-${instanceId}`, instanceId },
      reconnect,
      reconnectMinMs: 100,
    });
    cleanups.push(() => client.close());
    return client;
  }

  test('registry is visible through the client SDK', async () => {
    const { httpUrl } = await startServer();
    const backend = makeBackend(httpUrl, 'reg-backend');
    const { backendId } = await backend.connect();

    const client = makeClient(httpUrl, 'reg-client');
    await client.connect();
    expect(client.registry.map((b) => b.backendId)).toContain(backendId);
    expect(client.registry.find((b) => b.backendId === backendId)?.name).toBe('reg-backend');
  });

  test('channel: SDK client to SDK backend, echo both text and binary', async () => {
    const { httpUrl } = await startServer();
    const backend = makeBackend(httpUrl, 'ch-backend');
    const { backendId } = await backend.connect();

    backend.onChannel('echo', (channel) => {
      channel.onMessage((message) => {
        if (message.binary) channel.send(message.data as Uint8Array);
        else channel.send(`echo:${message.data}`);
      });
    });

    const client = makeClient(httpUrl, 'ch-client');
    await client.connect();
    const channel = await client.openChannel(backendId, 'echo');

    const received: Array<{ data: string | Uint8Array; binary: boolean }> = [];
    channel.onMessage((m) => received.push(m));

    channel.send('hello');
    await until(() => received.length >= 1);
    expect(received[0].binary).toBe(false);
    expect(received[0].data).toBe('echo:hello');

    const bytes = new Uint8Array([0, 1, 254, 255, 128]);
    channel.send(bytes);
    await until(() => received.length >= 2);
    expect(received[1].binary).toBe(true);
    expect(Array.from(received[1].data as Uint8Array)).toEqual(Array.from(bytes));

    // Close from the client side; both wrappers observe the close
    let backendSawClose = false;
    // (Re-open a channel to observe backend-side close cleanly)
    const channel2 = await client.openChannel(backendId, 'echo');
    backend.onChannel('echo', (ch) => ch.onClose(() => { backendSawClose = true; }));
    const channel3 = await client.openChannel(backendId, 'echo');
    channel3.close();
    await until(() => backendSawClose);
    channel.close();
    channel2.close();
  });

  test('unhandled channel kinds are rejected by the backend SDK', async () => {
    const { httpUrl } = await startServer();
    const backend = makeBackend(httpUrl, 'rej-backend');
    const { backendId } = await backend.connect();
    // No handler registered at all

    const client = makeClient(httpUrl, 'rej-client');
    await client.connect();
    // channel_ready arrives before the backend rejects, so the open may
    // succeed and then close immediately — accept either outcome.
    try {
      const channel = await client.openChannel(backendId, 'unknown-kind');
      await until(() => !channel.isOpen);
    } catch {
      // rejected before ready — also fine
    }
  });

  test('topics: backend publishes once, subscribers receive; unsubscribe works', async () => {
    const { httpUrl } = await startServer();
    const backend = makeBackend(httpUrl, 'topic-backend');
    const { backendId } = await backend.connect();

    const client = makeClient(httpUrl, 'topic-client');
    await client.connect();

    const seen: unknown[] = [];
    const unsubscribe = await client.subscribeTopic(backendId, 'resources', (payload) => seen.push(payload));
    backend.publishTopic('resources', { rev: 1 });
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual({ rev: 1 });

    await unsubscribe();
    backend.publishTopic('resources', { rev: 2 });
    await delay(200);
    expect(seen).toHaveLength(1);
  });

  test('serveHttp: fetch through the gateway reaches the backend SDK handler', async () => {
    const { httpUrl } = await startServer();
    const backend = makeBackend(httpUrl, 'http-backend');
    const { backendId } = await backend.connect();

    backend.serveHttp((request) => {
      if (request.method === 'POST' && request.path === '/sum') {
        const numbers = JSON.parse(new TextDecoder().decode(request.body)) as number[];
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sum: numbers.reduce((a, b) => a + b, 0) }),
        };
      }
      return { status: 404, body: 'not found' };
    });

    const ok = await fetch(`${httpUrl}/api/proxy/${backendId}/sum`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GATEWAY_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([1, 2, 3, 4]),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ sum: 10 });

    const missing = await fetch(`${httpUrl}/api/proxy/${backendId}/nope`, {
      headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
    });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('not found');
  });

  test('backend SDK reconnects with a fresh epoch and raw messages pass through', async () => {
    const { httpUrl } = await startServer();
    const backend = makeBackend(httpUrl, 'brc-backend');
    (backend as unknown as { opts: { reconnectMinMs: number } }).opts.reconnectMinMs = 100;
    const { backendId, epoch: epoch1 } = await backend.connect();

    // Raw inbound tap: registry_snapshot arrives when another backend joins
    const tapped: string[] = [];
    backend.onMessage((msg) => tapped.push(msg.type as string));
    const backend2 = makeBackend(httpUrl, 'brc-other');
    await backend2.connect();
    await until(() => tapped.includes('registry_snapshot'));

    // Raw outbound: send a topic_publish through the raw pipe, observe via SDK client
    const client = makeClient(httpUrl, 'brc-client');
    await client.connect();
    const seen: unknown[] = [];
    await client.subscribeTopic(backendId, 'raw', (payload) => seen.push(payload));
    backend.send({ type: 'topic_publish', topic: 'raw', payload: 'via-raw-send' });
    await until(() => seen.includes('via-raw-send'));

    // Simulated network drop: backend reconnects and gets a fresh epoch
    const states: string[] = [];
    backend.onState((s) => states.push(s));
    (backend as unknown as { socket: { close: (code: number) => void } }).socket.close(4000);
    await until(() => states.includes('connected'), 10_000);
    expect(backend.currentEpoch).toBeGreaterThan(epoch1);
    expect(backend.id).toBe(backendId); // v4 identity is stable

    // Still fully functional: channels reach it after the reconnect
    backend.onChannel('post-rc', (channel) => {
      channel.onMessage(() => channel.send('alive'));
    });
    const channel = await client.openChannel(backendId, 'post-rc');
    const replies: unknown[] = [];
    channel.onMessage((m) => replies.push(m.data));
    channel.send('ping');
    await until(() => replies.includes('alive'));
  });

  test('backend SDK auto-exchanges an enrollment credential before connecting', async () => {
    const ADMIN = TEST_ADMIN_TOKEN;
    const { httpUrl } = await startServer();
    const issued = await fetch(`${httpUrl}/api/admin/credentials`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'backend', namespace: 'sdk-test', name: 'sdk-enrollment' }),
    }).then((r) => r.json());

    const backend = new GatewayBackend({
      url: httpUrl,
      credential: issued.data.token,
      namespace: 'sdk-test',
      identity: { deviceId: 'dev-exch', instanceId: 'sdk-exch-backend' },
    });
    cleanups.push(() => backend.close());
    const { backendId } = await backend.connect();
    expect(backendId).toBeDefined();

    // The SDK exchanged the enrollment for a backend-access credential
    const list = await fetch(`${httpUrl}/api/admin/credentials`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    }).then((r) => r.json());
    const accessCred = list.data.find((c: any) => c.type === 'backend-access' && c.parentId === issued.data.id);
    expect(accessCred).toBeDefined();
    expect(accessCred.lastUsedAt).not.toBeNull();
  });

  test('client auto-reconnects after a dropped connection and topics resubscribe', async () => {
    const { httpUrl } = await startServer();
    const backend = makeBackend(httpUrl, 'rc-backend');
    const { backendId } = await backend.connect();

    const client = makeClient(httpUrl, 'rc-client');
    await client.connect();

    const seen: unknown[] = [];
    await client.subscribeTopic(backendId, 'beat', (payload) => seen.push(payload));

    const states: string[] = [];
    client.onState((s) => states.push(s));

    // Simulate a network drop by terminating the client's own socket.
    const raw = (client as unknown as { socket: { close: (code?: number) => void } }).socket;
    raw.close(4000);

    await until(() => states.includes('connected'), 10_000);
    // Topic subscription must survive the reconnect
    await until(() => {
      backend.publishTopic('beat', 'after-reconnect');
      return seen.includes('after-reconnect');
    }, 10_000);
  });
});
