/**
 * GatewayChannel send backpressure: the bufferedAmount observation, the
 * bounded/ordered sendBounded (wait → queue once), and its definite
 * outcomes on over-budget timeout, abort and close — first against a
 * controllable socket, then against a real local gateway with a paused
 * (slow) backend consumer to prove the end-to-end stall→drain cycle for
 * text and binary frames. Plain send() stays fire-and-forget throughout.
 */
import { describe, test, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'http';
import net from 'node:net';
import { createGatewayServer } from '../server.js';
import { GatewayChannel } from '@zclaudia/gateway-client';
import type { WebSocketLike } from '@zclaudia/gateway-client';
import { GatewayBackend } from '@zclaudia/gateway-backend';
import { GatewayClient } from '@zclaudia/gateway-client';
import { closeTestServer, listenTestServer, issueToken, TEST_ADMIN_TOKEN } from './test-server.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error('Condition not met in time');
    await delay(10);
  }
}

/** Scripted socket with a controllable send buffer. */
class FakeBufferSocket implements WebSocketLike {
  binaryType = 'arraybuffer';
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Array<string | Uint8Array> = [];
  readonly closeLog: number[] = [];
  private listeners: Record<string, Array<(event: any) => void>> = {};

  addEventListener(type: string, listener: (event: any) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  send(data: string | Uint8Array): void { this.sent.push(data); }

  close(code = 1000): void {
    this.closeLog.push(code);
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const listener of [...(this.listeners.close ?? [])]) listener({ code, reason: '' });
  }

  emitClose(): void {
    this.readyState = 3;
    for (const listener of [...(this.listeners.close ?? [])]) listener({ code: 1000, reason: '' });
  }
}

/** A socket that cannot report a send buffer at all. */
class OpaqueSocket extends FakeBufferSocket {
  declare bufferedAmount: never; // deliberately absent
  constructor() {
    super();
    delete (this as { bufferedAmount?: number }).bufferedAmount;
  }
}

// ============================================================================
// Controllable socket: observe, wait, budget, order, cancel, close
// ============================================================================

describe('GatewayChannel.sendBounded (scripted socket)', () => {
  test('sends immediately when the buffer is at or below the low-water mark', async () => {
    const socket = new FakeBufferSocket();
    const channel = new GatewayChannel('ch-1', socket);
    socket.bufferedAmount = 1024;
    const started = Date.now();
    await channel.sendBounded('hello', { lowWaterBytes: 4096 });
    expect(Date.now() - started).toBeLessThan(50); // no polling delay
    expect(socket.sent).toEqual(['hello']);
    expect(channel.bufferedAmount).toBe(1024);
    expect(channel.sendBufferObservable).toBe(true);
  });

  test('waits for the buffer to drain, then sends — FIFO across concurrent calls', async () => {
    const socket = new FakeBufferSocket();
    const channel = new GatewayChannel('ch-1', socket);
    socket.bufferedAmount = 8 * 1024 * 1024;

    const first = channel.sendBounded('a', { lowWaterBytes: 1024, timeoutMs: 5000 });
    const second = channel.sendBounded(new Uint8Array([2]), { lowWaterBytes: 1024, timeoutMs: 5000 });
    const third = channel.sendBounded('c', { lowWaterBytes: 1024, timeoutMs: 5000 });
    await delay(150);
    expect(socket.sent).toEqual([]); // all three are waiting on the full buffer

    socket.bufferedAmount = 0; // the buffer drains
    await Promise.all([first, second, third]);
    expect(socket.sent).toEqual(['a', new Uint8Array([2]), 'c']); // order preserved
  });

  test('a plain send() never waits and is not blocked by pending bounded sends', async () => {
    const socket = new FakeBufferSocket();
    const channel = new GatewayChannel('ch-1', socket);
    socket.bufferedAmount = 8 * 1024 * 1024;
    const waiting = channel.sendBounded('bounded', { lowWaterBytes: 1024, timeoutMs: 5000 });
    channel.send('plain'); // fire-and-forget, immediate
    expect(socket.sent).toEqual(['plain']);
    socket.bufferedAmount = 0;
    await waiting;
    expect(socket.sent).toEqual(['plain', 'bounded']);
  });

  test('timeout rejects without queueing, and the chain stays usable', async () => {
    const socket = new FakeBufferSocket();
    const channel = new GatewayChannel('ch-1', socket);
    socket.bufferedAmount = 8 * 1024 * 1024;

    await expect(channel.sendBounded('nope', { lowWaterBytes: 1024, timeoutMs: 80 }))
      .rejects.toThrow(/timed out.*buffer space/);
    expect(socket.sent).toEqual([]); // never queued

    await channel.sendBounded('after', { lowWaterBytes: 8 * 1024 * 1024 }); // budget now allows
    expect(socket.sent).toEqual(['after']);
  });

  test('abort rejects with the signal reason and never sends', async () => {
    const socket = new FakeBufferSocket();
    const channel = new GatewayChannel('ch-1', socket);
    socket.bufferedAmount = 8 * 1024 * 1024;
    const abort = new AbortController();
    const pending = channel.sendBounded('x', { lowWaterBytes: 1024, timeoutMs: 10_000, signal: abort.signal });
    abort.abort(new Error('gave up'));
    await expect(pending).rejects.toThrow('gave up');
    expect(socket.sent).toEqual([]);
  });

  test('close() rejects the in-flight wait at once and later calls reject immediately', async () => {
    const socket = new FakeBufferSocket();
    const channel = new GatewayChannel('ch-1', socket);
    socket.bufferedAmount = 8 * 1024 * 1024;

    const started = Date.now();
    const pending = channel.sendBounded('x', { lowWaterBytes: 1024, timeoutMs: 10_000 });
    const queued = channel.sendBounded('y', { lowWaterBytes: 1024, timeoutMs: 10_000 });
    channel.close();
    await expect(pending).rejects.toThrow(/Channel.*closed/);
    await expect(queued).rejects.toThrow(/Channel is closed/);
    expect(Date.now() - started).toBeLessThan(100); // woken, not left on the 10s timer
    expect(socket.sent).toEqual([]);
    expect(socket.closeLog).toEqual([1000]);
    // Repeated close stays safe and nothing new can be queued.
    channel.close();
    await expect(channel.sendBounded('z')).rejects.toThrow(/Channel is closed/);
  });

  test('a server-side close event also rejects pending bounded sends', async () => {
    const socket = new FakeBufferSocket();
    const channel = new GatewayChannel('ch-1', socket);
    socket.bufferedAmount = 8 * 1024 * 1024;
    const pending = channel.sendBounded('x', { lowWaterBytes: 1024, timeoutMs: 10_000 });
    socket.emitClose(); // the gateway (or network) closed the data socket
    await expect(pending).rejects.toThrow(/Channel.*closed/);
    expect(channel.isOpen).toBe(false);
  });

  test('without a reportable buffer it degrades to an ordered immediate send', async () => {
    const socket = new OpaqueSocket();
    const channel = new GatewayChannel('ch-1', socket);
    expect(channel.sendBufferObservable).toBe(false);
    expect(channel.bufferedAmount).toBe(0);
    const order: string[] = [];
    await Promise.all([
      channel.sendBounded('a', { timeoutMs: 100 }).then(() => order.push('a')),
      channel.sendBounded('b', { timeoutMs: 100 }).then(() => order.push('b')),
    ]);
    expect(socket.sent).toEqual(['a', 'b']); // still FIFO
    expect(order).toEqual(['a', 'b']);
  });
});

// ============================================================================
// Real local gateway: text/binary round-trip and a slow (paused) consumer
// ============================================================================

async function canBindLoopback(): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

const describeIfLoopback = (await canBindLoopback()) ? describe : describe.skip;

describeIfLoopback('GatewayChannel.sendBounded (real gateway)', () => {
  const servers: Server[] = [];
  const sockets: WebSocket[] = [];
  const clients: GatewayClient[] = [];
  const backends: GatewayBackend[] = [];

  afterEach(async () => {
    for (const client of clients) client.close();
    for (const backend of backends) backend.close();
    clients.length = 0;
    backends.length = 0;
    for (const ws of sockets) { try { ws.close(1000); } catch { /* already closed */ } }
    sockets.length = 0;
    await Promise.all(servers.map((s) => closeTestServer(s)));
    servers.length = 0;
  });

  test('bounded text and binary sends echo intact through the real gateway', async () => {
    const server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN });
    servers.push(server);
    const { httpUrl } = await listenTestServer(server);
    const backendToken = await issueToken(httpUrl, 'backend', 'bp');

    const backend = new GatewayBackend({
      url: httpUrl, credential: backendToken, namespace: 'bp',
      identity: { instanceId: 'echo-bp' }, heartbeatIntervalMs: 5000,
    });
    backend.onChannel('echo', (channel) => channel.onMessage((message) => channel.send(message.data)));
    backends.push(backend);
    const { backendId } = await backend.connect();

    const client = new GatewayClient({
      url: httpUrl, credential: backendToken, namespace: 'bp',
      identity: { deviceId: 'bp-client' }, reconnect: false,
    });
    clients.push(client);
    await client.connect();
    const channel = await client.openChannel(backendId, 'echo');

    const received: Array<{ data: string | Uint8Array; binary: boolean }> = [];
    channel.onMessage((message) => received.push(message));
    const binary = new Uint8Array(64 * 1024).map((_, i) => i % 251);
    await channel.sendBounded('text-frame', { lowWaterBytes: 1024 });
    await channel.sendBounded(binary, { lowWaterBytes: 1024 });
    await until(() => received.length >= 2);
    expect(received[0]).toMatchObject({ data: 'text-frame', binary: false });
    expect(received[1].binary).toBe(true);
    expect(Buffer.from(received[1].data as Uint8Array).equals(Buffer.from(binary))).toBe(true);
  });

  test('a slow backend consumer stalls the local buffer; bounded sends hold, then drain in order', async () => {
    const server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN });
    servers.push(server);
    const { httpUrl } = await listenTestServer(server);
    const backendToken = await issueToken(httpUrl, 'backend', 'bp');

    // Backend over ws sockets so the test can pause its data socket: the
    // ws package implements addEventListener, satisfying WebSocketLike.
    const backendSockets: WebSocket[] = [];
    const factory = (url: string): WebSocketLike => {
      const ws = new WebSocket(url);
      backendSockets.push(ws);
      sockets.push(ws);
      return ws as unknown as WebSocketLike;
    };
    const backend = new GatewayBackend({
      url: httpUrl, credential: backendToken, namespace: 'bp',
      identity: { instanceId: 'slow-bp' }, heartbeatIntervalMs: 5000,
      socketFactory: factory,
    });
    let dataSocket: WebSocket | null = null;
    let binaryBytes = 0;
    let textFrames = 0;
    backend.onChannel('echo', () => {
      dataSocket = backendSockets[backendSockets.length - 1];
      dataSocket.pause(); // the backend stops reading — a slow consumer
      dataSocket.on('message', (data: Buffer | ArrayBuffer, isBinary: boolean) => {
        // The SDK sets binaryType='arraybuffer', which ws honors: binary
        // frames arrive as ArrayBuffer, not Buffer.
        if (isBinary) binaryBytes += data instanceof ArrayBuffer ? data.byteLength : data.length;
        else textFrames++;
      });
    });
    backends.push(backend);
    const { backendId } = await backend.connect();

    const client = new GatewayClient({
      url: httpUrl, credential: backendToken, namespace: 'bp',
      identity: { deviceId: 'bp-slow-client' }, reconnect: false,
    });
    clients.push(client);
    await client.connect();
    const channel = await client.openChannel(backendId, 'echo');
    await until(() => dataSocket !== null);
    await delay(50); // let the pause take effect on the backend leg

    // 64 MiB of binary + interleaved text, budget 1 MiB: loopback kernel
    // socket buffers absorb several MiB before anything surfaces, so the
    // volume must exceed them — once the gateway's relay backs up (its
    // 4 MiB high-water toward the paused backend), the client's own socket
    // buffer grows and bounded sends must hold.
    const CHUNK = 1024 * 1024;
    const ROUNDS = 64;
    let maxBuffered = 0;
    let waitsAboveZero = 0;
    // The slow consumer recovers on a wall-clock timer: the send loop below
    // may be parked inside sendBounded by then, so the resume must not sit
    // in the loop itself.
    const resumeTimer = setTimeout(() => { dataSocket?.resume(); }, 3000);
    for (let i = 0; i < ROUNDS; i++) {
      const before = channel.bufferedAmount;
      const startedAt = Date.now();
      await channel.sendBounded(new Uint8Array(CHUNK), { lowWaterBytes: CHUNK, timeoutMs: 20_000 });
      const took = Date.now() - startedAt;
      if (took > 20) waitsAboveZero++;
      maxBuffered = Math.max(maxBuffered, before, channel.bufferedAmount);
      if (i % 3 === 0) await channel.sendBounded(`tick-${i}`, { lowWaterBytes: CHUNK, timeoutMs: 20_000 });
    }
    expect(channel.sendBufferObservable).toBe(true);
    expect(maxBuffered).toBeGreaterThan(0); // the stall was observable locally
    expect(waitsAboveZero).toBeGreaterThanOrEqual(1); // at least one send actually held

    // Everything drains after the resume, byte-exact and in order.
    try {
      await until(() => binaryBytes >= CHUNK * ROUNDS && textFrames >= Math.ceil(ROUNDS / 3), 30_000);
    } catch (error) {
      console.error(`[bp-diag] binaryBytes=${binaryBytes} expected=${CHUNK * ROUNDS} textFrames=${textFrames} expected=${Math.ceil(ROUNDS / 3)} clientBuffered=${channel.bufferedAmount} backendSocketState=${dataSocket?.readyState}`);
      throw error;
    }
    expect(binaryBytes).toBe(CHUNK * ROUNDS);
    clearTimeout(resumeTimer);
  }, 60_000);
});
