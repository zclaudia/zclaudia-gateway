/**
 * Phase 2: v4 Channels — control-plane negotiation, ticket-authenticated
 * data plane, transparent text/binary relay, close propagation, and epoch
 * invalidation. See docs/protocol-v4.md and ADR-0003.
 */
import { describe, test, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'http';
import net from 'node:net';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer } from './test-server.js';

const GATEWAY_SECRET = 'test-secret-channels';

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

/** Wait for the next raw frame on a data-plane socket. */
function waitForFrame(ws: WebSocket, timeoutMs = 5000): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for frame')), timeoutMs);
    ws.once('message', (data: Buffer, isBinary: boolean) => {
      clearTimeout(timer);
      resolve({ data: Buffer.from(data as Buffer), isBinary });
    });
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve(-1);
    const timer = setTimeout(() => reject(new Error('Timeout waiting for close')), timeoutMs);
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describeIfLoopback('Phase 2: v4 Channels', () => {
  const servers: Server[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    await Promise.all(sockets.map((ws) => closeWs(ws)));
    sockets.length = 0;
    await Promise.all(servers.map((s) => closeTestServer(s)));
    servers.length = 0;
  });

  async function startServer(overrides: Partial<Parameters<typeof createGatewayServer>[0]> = {}) {
    const server = createGatewayServer({ gatewaySecret: GATEWAY_SECRET, ...overrides });
    servers.push(server);
    return await listenTestServer(server);
  }

  async function connect(wsUrl: string): Promise<WebSocket> {
    const ws = new WebSocket(wsUrl);
    sockets.push(ws);
    await waitForOpen(ws);
    return ws;
  }

  async function hello(ws: WebSocket, opts: { namespace: string; peerType: 'client-only' | 'client+backend'; instanceId: string; protocolVersion?: number }) {
    const msg: Record<string, unknown> = {
      type: 'peer_hello',
      protocolVersion: opts.protocolVersion ?? 4,
      namespace: opts.namespace,
      clientProtocolVersion: 1,
      peerType: opts.peerType,
      gatewaySecret: GATEWAY_SECRET,
      identity: { deviceId: `dev-${opts.instanceId}`, instanceId: opts.instanceId },
    };
    if (opts.peerType === 'client+backend') {
      msg.backend = { visible: true, capabilities: [], backendProtocolVersion: 1 };
    }
    ws.send(JSON.stringify(msg));
    return await waitForMessage(ws, 'peer_ready');
  }

  /** Full happy-path: open a channel and dial both ends. */
  async function openChannel(wsUrl: string, namespace = 'app-a', instancePrefix = 'ch') {
    const backendCtl = await connect(wsUrl);
    const backendReady = await hello(backendCtl, { namespace, peerType: 'client+backend', instanceId: `${instancePrefix}-backend` });
    const clientCtl = await connect(wsUrl);
    await hello(clientCtl, { namespace, peerType: 'client-only', instanceId: `${instancePrefix}-client` });

    const offerPromise = waitForMessage(backendCtl, 'channel_offer');
    clientCtl.send(JSON.stringify({ type: 'channel_open', target: backendReady.backend.backendId, kind: 'test' }));
    const ready = await waitForMessage(clientCtl, 'channel_ready');
    const offer = await offerPromise;
    expect(offer.channelId).toBe(ready.channelId);
    expect(offer.kind).toBe('test');
    expect(offer.sourcePeerSessionId).toBeDefined();

    const base = wsUrl.replace(/\/ws$/, '');
    const clientData = new WebSocket(`${base}${ready.dataPath}?ticket=${ready.ticket}`);
    const backendData = new WebSocket(`${base}${offer.dataPath}?ticket=${offer.ticket}`);
    sockets.push(clientData, backendData);
    await Promise.all([waitForOpen(clientData), waitForOpen(backendData)]);

    return { backendCtl, clientCtl, clientData, backendData, ready, offer, backendId: backendReady.backend.backendId as string };
  }

  test('text and binary frames relay transparently in both directions', async () => {
    const { wsUrl } = await startServer();
    const { clientData, backendData } = await openChannel(wsUrl);

    // client → backend, text
    const textAtBackend = waitForFrame(backendData);
    clientData.send('{"jsonrpc":"2.0","id":"m1","method":"ping"}');
    const text = await textAtBackend;
    expect(text.isBinary).toBe(false);
    expect(text.data.toString()).toContain('jsonrpc');

    // backend → client, binary (must NOT be coerced to text or base64)
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80]);
    const binaryAtClient = waitForFrame(clientData);
    backendData.send(bytes);
    const binary = await binaryAtClient;
    expect(binary.isBinary).toBe(true);
    expect(Buffer.compare(binary.data, bytes)).toBe(0);
  });

  test('large binary payload survives the relay intact', async () => {
    const { wsUrl } = await startServer();
    const { clientData, backendData } = await openChannel(wsUrl, 'app-a', 'big');

    const payload = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < payload.length; i += 4096) payload[i] = i % 251;
    const received = waitForFrame(backendData, 15000);
    clientData.send(payload);
    const frame = await received;
    expect(frame.isBinary).toBe(true);
    expect(frame.data.length).toBe(payload.length);
    expect(Buffer.compare(frame.data, payload)).toBe(0);
  });

  test('closing one data socket closes the peer socket and notifies control planes', async () => {
    const { wsUrl } = await startServer();
    const { clientCtl, backendCtl, clientData, backendData, ready } = await openChannel(wsUrl, 'app-a', 'close');

    const backendClosed = waitForClose(backendData);
    const clientNotified = waitForMessage(clientCtl, 'channel_closed');
    const backendNotified = waitForMessage(backendCtl, 'channel_closed');
    clientData.close();

    await backendClosed;
    expect((await clientNotified).channelId).toBe(ready.channelId);
    expect((await backendNotified).reason).toBe('closed');
  });

  test('backend control disconnect closes its channels with backend_offline', async () => {
    const { wsUrl } = await startServer();
    const { backendCtl, clientCtl, clientData, ready } = await openChannel(wsUrl, 'app-a', 'offline');

    const dataClosed = waitForClose(clientData);
    const notified = waitForMessage(clientCtl, 'channel_closed');
    backendCtl.close();

    await dataClosed;
    const msg = await notified;
    expect(msg.channelId).toBe(ready.channelId);
    expect(msg.reason).toBe('backend_offline');
  });

  test('tickets are one-time: a second dial with the same ticket is rejected', async () => {
    const { wsUrl } = await startServer();
    const { ready } = await openChannel(wsUrl, 'app-a', 'onetime');

    const base = wsUrl.replace(/\/ws$/, '');
    const replay = new WebSocket(`${base}${ready.dataPath}?ticket=${ready.ticket}`);
    sockets.push(replay);
    const failed = await new Promise<boolean>((resolve) => {
      replay.on('error', () => resolve(true));
      replay.on('open', () => resolve(false));
    });
    expect(failed).toBe(true);
  });

  test('dialing with a bogus ticket or unknown channel is rejected', async () => {
    const { wsUrl } = await startServer();
    await openChannel(wsUrl, 'app-a', 'bogus');
    const base = wsUrl.replace(/\/ws$/, '');
    const bad = new WebSocket(`${base}/channel/deadbeef?ticket=nope`);
    sockets.push(bad);
    const failed = await new Promise<boolean>((resolve) => {
      bad.on('error', () => resolve(true));
      bad.on('open', () => resolve(false));
    });
    expect(failed).toBe(true);
  });

  test('cross-namespace channel_open is rejected like an offline backend', async () => {
    const { wsUrl } = await startServer();
    const backendCtl = await connect(wsUrl);
    const backendReady = await hello(backendCtl, { namespace: 'app-a', peerType: 'client+backend', instanceId: 'xns-backend' });
    const clientCtl = await connect(wsUrl);
    await hello(clientCtl, { namespace: 'app-b', peerType: 'client-only', instanceId: 'xns-client' });

    clientCtl.send(JSON.stringify({ type: 'channel_open', target: backendReady.backend.backendId }));
    const err = await waitForMessage(clientCtl, 'gateway_error');
    expect(err.code).toBe('BACKEND_OFFLINE');
  });

  test('v3 peers cannot open channels', async () => {
    const { wsUrl } = await startServer();
    const backendCtl = await connect(wsUrl);
    const backendReady = await hello(backendCtl, { namespace: 'app-a', peerType: 'client+backend', instanceId: 'v3-backend', protocolVersion: 3 });
    const clientCtl = await connect(wsUrl);
    await hello(clientCtl, { namespace: 'app-a', peerType: 'client-only', instanceId: 'v3-client', protocolVersion: 3 });

    clientCtl.send(JSON.stringify({ type: 'channel_open', target: backendReady.backend.backendId }));
    const err = await waitForMessage(clientCtl, 'gateway_error');
    expect(err.code).toBe('INVALID_MESSAGE');
    expect(err.message).toContain('protocol v4');
  });

  test('backend can reject an offered channel', async () => {
    const { wsUrl } = await startServer();
    const backendCtl = await connect(wsUrl);
    const backendReady = await hello(backendCtl, { namespace: 'app-a', peerType: 'client+backend', instanceId: 'rej-backend' });
    const clientCtl = await connect(wsUrl);
    await hello(clientCtl, { namespace: 'app-a', peerType: 'client-only', instanceId: 'rej-client' });

    const offerPromise = waitForMessage(backendCtl, 'channel_offer');
    clientCtl.send(JSON.stringify({ type: 'channel_open', target: backendReady.backend.backendId }));
    const offer = await offerPromise;
    const closedPromise = waitForMessage(clientCtl, 'channel_closed');
    backendCtl.send(JSON.stringify({ type: 'channel_reject', channelId: offer.channelId, reason: 'policy' }));
    const closed = await closedPromise;
    expect(closed.reason).toBe('rejected');
  });

  test('channel quota per peer is enforced', async () => {
    const { wsUrl } = await startServer({ gatewaySecret: GATEWAY_SECRET, maxChannelsPerPeer: 2 });
    const backendCtl = await connect(wsUrl);
    const backendReady = await hello(backendCtl, { namespace: 'app-a', peerType: 'client+backend', instanceId: 'quota-backend' });
    const clientCtl = await connect(wsUrl);
    await hello(clientCtl, { namespace: 'app-a', peerType: 'client-only', instanceId: 'quota-client' });

    for (let i = 0; i < 2; i++) {
      clientCtl.send(JSON.stringify({ type: 'channel_open', target: backendReady.backend.backendId }));
      await waitForMessage(clientCtl, 'channel_ready');
    }
    clientCtl.send(JSON.stringify({ type: 'channel_open', target: backendReady.backend.backendId }));
    const err = await waitForMessage(clientCtl, 'gateway_error');
    expect(err.code).toBe('RATE_LIMITED');
  });
});
