/**
 * SDK connection lifecycle: bounded waits, cancellation, close semantics,
 * late-result handling and the REPLACED stand-down — driven through
 * scripted in-memory sockets (every phase boundary is under the test's
 * control), plus two real-socket cases (dead endpoint, silent TCP server)
 * exercising the timeout paths against the platform WebSocket.
 *
 * Success paths against a real gateway live in phase3-sdk-contract.test.ts.
 */
import { describe, test, expect, afterEach } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'net';
import { GatewayClient } from '@zclaudia/gateway-client';
import type { SocketFactory, WebSocketLike } from '@zclaudia/gateway-client';
import { GatewayBackend } from '@zclaudia/gateway-backend';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Condition not met in time');
    await delay(10);
  }
}

// ============================================================================
// Scripted socket: manual phase control, records sends and closes
// ============================================================================

class FakeSocket implements WebSocketLike {
  binaryType = 'arraybuffer';
  readyState = 0; // 0 connecting, 1 open, 3 closed
  readonly sent: string[] = [];
  readonly closeLog: number[] = [];
  private listeners: Record<string, Array<(event: any) => void>> = {};

  addEventListener(type: string, listener: (event: any) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('send on a non-open socket');
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.closeLog.push(code);
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { code, reason: '' });
  }

  emit(type: string, event?: unknown): void {
    for (const listener of [...(this.listeners[type] ?? [])]) listener(event);
  }

  // --- script helpers ---
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  say(message: unknown): void {
    this.emit('message', { data: JSON.stringify(message) });
  }
}

/** Sockets the factories produced, split by URL role (control vs channel). */
class SocketLog {
  readonly control: FakeSocket[] = [];
  readonly data: FakeSocket[] = [];
  readonly factory: SocketFactory = (url) => {
    const socket = new FakeSocket();
    (url.includes('/channel/') ? this.data : this.control).push(socket);
    return socket;
  };
}

/** Drive a scripted client through the handshake to 'connected'. */
async function connectScripted(client: GatewayClient, log: SocketLog): Promise<void> {
  const connecting = client.connect();
  await until(() => log.control.length > 0);
  const socket = log.control[log.control.length - 1];
  socket.open(); // peer_hello is only sent after open
  await until(() => socket.sent.length > 0);
  socket.say({ type: 'peer_ready', peerSessionId: 'ps-1', registrySync: { items: [] } });
  await connecting;
  expect(client.connectionState).toBe('connected');
}

/** Reply to a pending channel_open with a channel_ready frame. */
async function replyChannelReady(socket: FakeSocket, channelId: string): Promise<void> {
  await until(() => socket.sent.some((raw) => JSON.parse(raw).type === 'channel_open'));
  socket.say({ type: 'channel_ready', channelId, ticket: `ticket-${channelId}`, dataPath: `/channel/${channelId}` });
}

// ============================================================================
// Client SDK
// ============================================================================

describe('GatewayClient lifecycle', () => {
  const clients: GatewayClient[] = [];
  const logs: SocketLog[] = [];

  afterEach(() => {
    for (const client of clients) client.close();
    clients.length = 0;
    logs.length = 0;
  });

  function makeClient(overrides: Record<string, unknown> = {}): { client: GatewayClient; log: SocketLog } {
    const log = new SocketLog();
    const client = new GatewayClient({
      url: 'http://gateway.test',
      credential: 'zgd_test-credential',
      namespace: 'lc',
      socketFactory: log.factory,
      reconnect: false,
      connectTimeoutMs: 80,
      ...overrides,
    });
    clients.push(client);
    logs.push(log);
    return { client, log };
  }

  test('connect() times out when the socket never opens, then stays retryable', async () => {
    const { client, log } = makeClient();
    await expect(client.connect()).rejects.toThrow(/open timeout/);
    expect(client.connectionState).toBe('idle'); // not wedged in 'connecting'
    expect(log.control[0].closeLog.length).toBeGreaterThan(0); // no orphan socket

    // The failed attempt leaves nothing behind: the next connect succeeds.
    const second = client.connect();
    await until(() => log.control.length > 1);
    log.control[1].open();
    await until(() => log.control[1].sent.length > 0);
    log.control[1].say({ type: 'peer_ready', peerSessionId: 'ps-2', registrySync: { items: [] } });
    await second;
    expect(client.connectionState).toBe('connected');
  });

  test('a peer_ready timeout closes the socket and fails the connect promise', async () => {
    const { client, log } = makeClient();
    const connecting = client.connect();
    await until(() => log.control.length > 0);
    const socket = log.control[0];
    socket.open(); // gateway never answers the hello
    await expect(connecting).rejects.toThrow(/peer_ready timeout/);
    expect(client.connectionState).toBe('idle');
    expect(socket.closeLog.length).toBeGreaterThan(0);
  });

  test('close() during the handshake rejects promptly; a late peer_ready cannot revive', async () => {
    const { client, log } = makeClient({ connectTimeoutMs: 10_000 });
    const states: string[] = [];
    client.onState((s) => states.push(s));
    const connecting = client.connect();
    await until(() => log.control.length > 0);
    const socket = log.control[0];
    socket.open();
    await until(() => socket.sent.length > 0);

    client.close(); // mid-handshake
    await expect(connecting).rejects.toThrow(/closed before peer_ready/); // not the 10s timeout
    expect(client.connectionState).toBe('closed');

    socket.say({ type: 'peer_ready', peerSessionId: 'ps-late', registrySync: { items: [] } }); // late result
    await delay(50);
    expect(client.connectionState).toBe('closed'); // never re-entered connected
    expect(states).not.toContain('connected');
    expect(client.sessionId).toBe('');
  });

  test('connect() is cancellable via AbortSignal', async () => {
    const { client, log } = makeClient({ connectTimeoutMs: 10_000 });
    const abort = new AbortController();
    const connecting = client.connect({ signal: abort.signal });
    abort.abort(new Error('gave up'));
    await expect(connecting).rejects.toThrow('gave up');
    expect(client.connectionState).toBe('idle');
    expect(log.control[0].closeLog.length).toBeGreaterThan(0);
  });

  test('close() is idempotent and emits the closed state exactly once', async () => {
    const { client, log } = makeClient();
    await connectScripted(client, log);
    const states: string[] = [];
    client.onState((s) => states.push(s));
    client.close();
    client.close();
    client.close();
    expect(client.connectionState).toBe('closed');
    expect(states.filter((s) => s === 'closed')).toHaveLength(1);
  });

  test('a channel dial timeout fails openChannel definitively; the client stays usable', async () => {
    const { client, log } = makeClient();
    await connectScripted(client, log);
    const control = log.control[0];

    const opening = client.openChannel('backend-1', 'test');
    await replyChannelReady(control, 'ch-1');
    await expect(opening).rejects.toThrow(/open timeout/); // data socket never opens
    expect(log.data[0].closeLog.length).toBeGreaterThan(0); // dial socket cleaned up

    // Second attempt succeeds: nothing was wedged by the first failure.
    const retry = client.openChannel('backend-1', 'test');
    await replyChannelReady(control, 'ch-2');
    await until(() => log.data.length > 1);
    log.data[1].open();
    const channel = await retry;
    expect(channel.isOpen).toBe(true);
    channel.close();
    await until(() => !channel.isOpen);
  });

  test('close() during a channel dial aborts it; a late dial open is dropped', async () => {
    const { client, log } = makeClient({ connectTimeoutMs: 10_000 });
    await connectScripted(client, log);
    const control = log.control[0];

    const opening = client.openChannel('backend-1', 'test');
    await replyChannelReady(control, 'ch-1');
    // Data socket is created but never opens.
    await until(() => log.data.length > 0);

    client.close();
    await expect(opening).rejects.toThrow(/Client closed during channel dial/);
    expect(log.data[0].closeLog.length).toBeGreaterThan(0);

    log.data[0].open(); // late open on the aborted dial
    await delay(50);
    expect(client.connectionState).toBe('closed');
  });
});

// ============================================================================
// Backend SDK
// ============================================================================

describe('GatewayBackend lifecycle', () => {
  const backends: GatewayBackend[] = [];

  afterEach(() => {
    for (const backend of backends) backend.close();
    backends.length = 0;
  });

  function makeBackend(overrides: Record<string, unknown> = {}): { backend: GatewayBackend; log: SocketLog } {
    const log = new SocketLog();
    const backend = new GatewayBackend({
      url: 'http://gateway.test',
      credential: 'zga_test-credential',
      exchangeEnrollment: false,
      namespace: 'lb',
      socketFactory: log.factory,
      reconnect: false,
      reconnectMinMs: 20,
      connectTimeoutMs: 80,
      heartbeatIntervalMs: 60_000,
      ...overrides,
    });
    backends.push(backend);
    return { backend, log };
  }

  /** Drive a scripted backend through the handshake to 'connected'. */
  async function connectScriptedBackend(backend: GatewayBackend, log: SocketLog): Promise<void> {
    const connecting = backend.connect();
    await until(() => log.control.length > 0); // factory runs after the credential resolves
    const socket = log.control[log.control.length - 1];
    socket.open(); // peer_hello is only sent after open
    await until(() => socket.sent.length > 0);
    socket.say({ type: 'peer_ready', peerSessionId: 'ps-1', registrySync: { items: [] }, backend: { backendId: 'b-1', epoch: 1, leaseTtlMs: 30_000 } });
    await connecting;
    expect(backend.connectionState).toBe('connected');
  }

  test('connect() times out when the socket never opens (GATEWAY_UNREACHABLE), then stays retryable', async () => {
    const { backend, log } = makeBackend();
    await expect(backend.connect()).rejects.toThrow(/open timeout/);
    expect(backend.connectionState).toBe('idle');
    expect(backend.lastError?.code).toBe('GATEWAY_UNREACHABLE');
    expect(log.control[0].closeLog.length).toBeGreaterThan(0);

    await connectScriptedBackend(backend, log); // retryable: one clean attempt later
  });

  test('close() during connect rejects promptly; a late peer_ready cannot revive or restart heartbeats', async () => {
    const { backend, log } = makeBackend({ connectTimeoutMs: 10_000 });
    const connecting = backend.connect();
    await until(() => log.control.length > 0);
    const socket = log.control[0];
    socket.open();
    await until(() => socket.sent.length > 0);

    backend.close();
    await expect(connecting).rejects.toThrow(); // promptly, not the 10s timeout
    expect(backend.connectionState).toBe('closed');
    expect(backend.lastError).toBeNull(); // close() owns the final value

    socket.say({ type: 'peer_ready', peerSessionId: 'ps-late', registrySync: { items: [] }, backend: { backendId: 'b-late', epoch: 9, leaseTtlMs: 30_000 } });
    await delay(60);
    expect(backend.connectionState).toBe('closed'); // no revival
    expect(backend.id).toBe(''); // identity never adopted
    expect(backend.currentEpoch).toBe(0);
  });

  test('REPLACED (close 4001) stands down: closed, no reconnect, no identity theft', async () => {
    const { backend, log } = makeBackend({ reconnect: true });
    await connectScriptedBackend(backend, log);
    expect(log.control).toHaveLength(1);

    log.control[0].emit('close', { code: 4001, reason: 'replaced' });
    await until(() => backend.connectionState === 'closed');
    expect(backend.lastError?.code).toBe('REPLACED');

    await delay(150); // many backoff periods: the loser must not take it back
    expect(backend.connectionState).toBe('closed');
    expect(log.control).toHaveLength(1); // no reconnect attempt, ever
  });

  test('connect() is cancellable via AbortSignal', async () => {
    const { backend, log } = makeBackend({ connectTimeoutMs: 10_000 });
    const abort = new AbortController();
    const connecting = backend.connect({ signal: abort.signal });
    abort.abort(new Error('gave up'));
    await expect(connecting).rejects.toThrow('gave up');
    expect(backend.connectionState).toBe('idle');
    expect(log.control[0].closeLog.length).toBeGreaterThan(0);
  });

  test('concurrent connect() calls coalesce onto one attempt', async () => {
    const { backend, log } = makeBackend();
    const first = backend.connect();
    const second = backend.connect();
    await until(() => log.control.length > 0);
    const socket = log.control[0];
    socket.open();
    await until(() => socket.sent.length > 0);
    socket.say({ type: 'peer_ready', peerSessionId: 'ps-1', registrySync: { items: [] }, backend: { backendId: 'b-1', epoch: 1, leaseTtlMs: 30_000 } });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(log.control).toHaveLength(1); // exactly one socket for two calls
  });

  test('a dropped connection (no REPLACED) still reconnects', async () => {
    const { backend, log } = makeBackend({ reconnect: true });
    await connectScriptedBackend(backend, log);
    log.control[0].emit('close', { code: 1006, reason: '' }); // plain network drop
    await until(() => log.control.length > 1);
    const socket = log.control[1];
    socket.open();
    await until(() => socket.sent.length > 0);
    socket.say({ type: 'peer_ready', peerSessionId: 'ps-2', registrySync: { items: [] }, backend: { backendId: 'b-1', epoch: 2, leaseTtlMs: 30_000 } });
    await until(() => backend.connectionState === 'connected');
    expect(backend.currentEpoch).toBe(2);
  });
});

// ============================================================================
// Real sockets: the timeout paths against the platform WebSocket
// ============================================================================

async function canBindLoopback(): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

const describeIfLoopback = (await canBindLoopback()) ? describe : describe.skip;

describeIfLoopback('SDK lifecycle against real sockets', () => {
  test('client connect() to a dead endpoint rejects and stays retryable', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const { port: p } = probe.address() as AddressInfo;
        probe.close(() => resolve(p));
      });
    });
    const client = new GatewayClient({
      url: `http://127.0.0.1:${port}`,
      credential: 'zgd_test-credential',
      namespace: 'lc',
      reconnect: false,
      connectTimeoutMs: 500,
    });
    try {
      await expect(client.connect()).rejects.toThrow();
      expect(client.connectionState).toBe('idle');
    } finally {
      client.close(); // safe on a never-connected client
      expect(client.connectionState).toBe('closed');
    }
  });

  test('backend connect() times out against a silent TCP server (open phase, real WebSocket)', async () => {
    // Accepts TCP but never completes the WS upgrade: open never fires.
    const silent = net.createServer((socket) => { socket.on('error', () => undefined); });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as AddressInfo;
    const backend = new GatewayBackend({
      url: `http://127.0.0.1:${port}`,
      credential: 'zga_test-credential',
      exchangeEnrollment: false,
      namespace: 'lb',
      reconnect: false,
      connectTimeoutMs: 300,
    });
    try {
      await expect(backend.connect()).rejects.toThrow(/open timeout|WebSocket/);
      expect(backend.connectionState).toBe('idle');
      expect(backend.lastError?.code).toBe('GATEWAY_UNREACHABLE');
    } finally {
      backend.close();
      silent.close();
    }
  });
});
