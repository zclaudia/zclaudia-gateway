/**
 * GatewayBackend.lastError — why the most recent connection attempt failed.
 * Real-gateway cases use the SDK against a live test server; the scripted
 * handshake cases drive the backend through an in-memory socket.
 */
import { describe, test, expect, afterEach } from 'vitest';
import type { Server } from 'http';
import net from 'node:net';
import { createGatewayServer } from '../server.js';
import { listenTestServer, closeTestServer, issueToken, TEST_ADMIN_TOKEN } from './test-server.js';
import { GatewayBackend, type BackendErrorInfo, type GatewayBackendOptions } from '@zclaudia/gateway-backend';
import type { SocketFactory, WebSocketLike } from '@zclaudia/gateway-client';

const SECRET = 'zga_SUPER-secret-credential';

async function canBindLoopback(): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}
const describeIfLoopback = (await canBindLoopback()) ? describe : describe.skip;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Condition not met in time');
    await delay(10);
  }
}

/** Scripted socket: opens at once, then plays `script` after peer_hello arrives. */
class ScriptedSocket implements WebSocketLike {
  binaryType = 'blob';
  readyState = 0;
  private listeners: Record<string, Array<(event: any) => void>> = {};
  constructor(private readonly script: (socket: ScriptedSocket) => void) {
    queueMicrotask(() => { this.readyState = 1; this.emit('open', undefined); });
  }
  addEventListener(type: string, listener: (event: any) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  send(): void { queueMicrotask(() => this.script(this)); }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { code: 1000, reason: '' });
  }
  emit(type: string, event: unknown): void { for (const l of this.listeners[type] ?? []) l(event); }
  say(message: unknown): void { this.emit('message', { data: JSON.stringify(message) }); }
}

describeIfLoopback('GatewayBackend.lastError', () => {
  const servers: Server[] = [];
  const backends: GatewayBackend[] = [];

  afterEach(async () => {
    for (const backend of backends) backend.close();
    backends.length = 0;
    await Promise.all(servers.map((s) => closeTestServer(s)));
    servers.length = 0;
  });

  function make(overrides: Partial<GatewayBackendOptions> & { url: string }): GatewayBackend {
    const backend = new GatewayBackend({
      credential: SECRET,
      namespace: 'last-error',
      identity: { deviceId: 'dev-1', instanceId: 'inst-1' },
      exchangeEnrollment: false,
      reconnectMinMs: 20,
      reconnectMaxMs: 50,
      heartbeatIntervalMs: 2000,
      ...overrides,
    });
    backends.push(backend);
    return backend;
  }

  async function startServer(): Promise<{ httpUrl: string; token: string }> {
    const server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN });
    servers.push(server);
    const { httpUrl } = await listenTestServer(server);
    return { httpUrl, token: await issueToken(httpUrl, 'backend', 'last-error') };
  }

  async function deadUrl(): Promise<string> {
    return await new Promise((resolve) => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(`http://127.0.0.1:${port}`));
      });
    });
  }

  const scripted = (script: (socket: ScriptedSocket) => void): SocketFactory => () => new ScriptedSocket(script);
  const text = (error: BackendErrorInfo | null) => JSON.stringify(error);

  test('is null before any attempt and after a successful connect', async () => {
    const { httpUrl, token } = await startServer();
    const backend = make({ url: httpUrl, credential: token });
    expect(backend.lastError).toBeNull();
    await backend.connect();
    expect(backend.lastError).toBeNull();
  });

  test('a refused access credential rejects connect() and records AUTH_FAILED', async () => {
    const { httpUrl } = await startServer();
    const backend = make({ url: httpUrl });
    await expect(backend.connect()).rejects.toThrow(/UNAUTHORIZED/);
    expect(backend.lastError).toMatchObject({ code: 'AUTH_FAILED', gatewayCode: 'UNAUTHORIZED' });
    expect(backend.lastError?.message).toBeTruthy();
    expect(backend.lastError?.occurredAt).toBeGreaterThan(0);
    expect(text(backend.lastError)).not.toContain(SECRET);
  });

  test('a refused enrollment credential (exchange HTTP 401) is AUTH_FAILED too', async () => {
    const { httpUrl } = await startServer();
    const backend = make({ url: httpUrl, credential: 'zgb_bogus-enrollment', exchangeEnrollment: true });
    await expect(backend.connect()).rejects.toThrow(/Enrollment exchange failed: HTTP 401/);
    expect(backend.lastError?.code).toBe('AUTH_FAILED');
    expect(text(backend.lastError)).not.toContain('zgb_bogus');
  });

  test('an unreachable gateway is GATEWAY_UNREACHABLE (WebSocket and exchange paths)', async () => {
    const url = await deadUrl();
    const direct = make({ url });
    await expect(direct.connect()).rejects.toThrow();
    expect(direct.lastError?.code).toBe('GATEWAY_UNREACHABLE');

    const exchanged = make({ url, credential: 'zgb_whatever', exchangeEnrollment: true });
    await expect(exchanged.connect()).rejects.toThrow();
    expect(exchanged.lastError?.code).toBe('GATEWAY_UNREACHABLE');
  });

  test('background reconnect failures are recorded, updated, and cleared on success', async () => {
    const { httpUrl, token } = await startServer();
    const dead = await deadUrl();
    let target = httpUrl;
    const factory: SocketFactory = (url) => new WebSocket(url.replace(httpUrl.replace('http', 'ws'), target.replace('http', 'ws'))) as unknown as WebSocketLike;
    const backend = make({ url: httpUrl, credential: token, socketFactory: factory });
    await backend.connect();
    expect(backend.lastError).toBeNull();

    target = dead;
    (backend as unknown as { socket: WebSocketLike }).socket.close(4000); // a plain drop
    await until(() => backend.connectionState === 'connecting');
    expect(backend.lastError).toBeNull(); // a drop alone is not a failed attempt

    await until(() => backend.lastError !== null);
    const first = backend.lastError!;
    expect(first.code).toBe('GATEWAY_UNREACHABLE');
    await until(() => backend.lastError !== first); // later attempts keep refreshing it
    expect(backend.connectionState).toBe('connecting');

    target = httpUrl;
    const states: Array<[string, boolean]> = [];
    backend.onState((s) => states.push([s, backend.lastError === null]));
    await until(() => backend.connectionState === 'connected', 10_000);
    expect(backend.lastError).toBeNull();
    expect(states).toContainEqual(['connected', true]); // already clear when announced
  });

  test('a new connect() run starts clean', async () => {
    const { httpUrl, token } = await startServer();
    const backend = make({ url: httpUrl });
    await expect(backend.connect()).rejects.toThrow();
    expect(backend.lastError).not.toBeNull();
    (backend as unknown as { opts: { credential: string } }).opts.credential = token;
    await backend.connect();
    expect(backend.lastError).toBeNull();
  });

  test('close() keeps the last failure and nothing is recorded afterwards', async () => {
    const backend = make({ url: await deadUrl(), reconnectMinMs: 10, reconnectMaxMs: 10 });
    await expect(backend.connect()).rejects.toThrow();
    const before = backend.lastError;
    backend.close();
    expect(backend.connectionState).toBe('closed');
    expect(backend.lastError).toBe(before);
    await delay(100);
    expect(backend.lastError).toBe(before);
  });

  test('close() after a successful run leaves it null', async () => {
    const { httpUrl, token } = await startServer();
    const backend = make({ url: httpUrl, credential: token });
    await backend.connect();
    backend.close();
    expect(backend.lastError).toBeNull();
  });

  test('is read-only and immutable', async () => {
    const backend = make({ url: await deadUrl() });
    await expect(backend.connect()).rejects.toThrow();
    expect(() => { (backend as unknown as { lastError: null }).lastError = null; }).toThrow();
    expect(Object.isFrozen(backend.lastError)).toBe(true);
  });

  test('other gateway refusals are GATEWAY_REJECTED; unknown codes are not passed through', async () => {
    const rejected = make({
      url: 'http://gateway.test',
      socketFactory: scripted((s) => s.say({ type: 'gateway_error', code: 'RATE_LIMITED', message: 'slow down' })),
    });
    await expect(rejected.connect()).rejects.toThrow(/RATE_LIMITED/);
    expect(rejected.lastError).toMatchObject({ code: 'GATEWAY_REJECTED', gatewayCode: 'RATE_LIMITED' });
    expect(rejected.lastError?.message).toContain('RATE_LIMITED');

    const unknown = make({
      url: 'http://gateway.test',
      socketFactory: scripted((s) => s.say({ type: 'gateway_error', code: `NEW_${SECRET}`, message: `Bearer ${SECRET}` })),
    });
    await expect(unknown.connect()).rejects.toThrow();
    expect(unknown.lastError?.code).toBe('GATEWAY_REJECTED');
    expect(unknown.lastError?.gatewayCode).toBeUndefined();
    expect(text(unknown.lastError)).not.toContain(SECRET);
  });

  test('a connection closed before peer_ready is GATEWAY_UNREACHABLE; a peer_ready without identity is PROTOCOL_ERROR', async () => {
    const dropped = make({ url: 'http://gateway.test', socketFactory: scripted((s) => s.close()) });
    await expect(dropped.connect()).rejects.toThrow(/closed before peer_ready/);
    expect(dropped.lastError?.code).toBe('GATEWAY_UNREACHABLE');

    const bare = make({
      url: 'http://gateway.test',
      socketFactory: scripted((s) => s.say({ type: 'peer_ready', protocolVersion: 4 })),
    });
    await expect(bare.connect()).rejects.toThrow(/backend identity/);
    expect(bare.lastError?.code).toBe('PROTOCOL_ERROR');
  });

  test('a failed attempt closes its socket instead of leaking it', async () => {
    const sockets: ScriptedSocket[] = [];
    const backend = make({
      url: 'http://gateway.test',
      socketFactory: () => {
        const socket = new ScriptedSocket((s) => s.say({ type: 'gateway_error', code: 'UNAUTHORIZED', message: 'no' }));
        sockets.push(socket);
        return socket;
      },
    });
    await expect(backend.connect()).rejects.toThrow();
    expect(sockets[0].readyState).toBe(3);
  });
});
