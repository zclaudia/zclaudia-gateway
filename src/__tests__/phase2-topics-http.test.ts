/**
 * Phase 2: Topic broadcast primitive and v4 HTTP streaming proxy
 * (docs/protocol-v4.md §6–7).
 */
import { describe, test, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'http';
import net from 'node:net';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer } from './test-server.js';

const GATEWAY_SECRET = 'test-secret-p2';

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

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIfLoopback('Phase 2: Topics & HTTP streaming', () => {
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

  // ==========================================================================
  // Topics
  // ==========================================================================

  describe('Topic broadcast', () => {
    async function setupTopic(wsUrl: string, prefix: string) {
      const backendCtl = await connect(wsUrl);
      const ready = await hello(backendCtl, { namespace: 'app-a', peerType: 'client+backend', instanceId: `${prefix}-backend` });
      return { backendCtl, backendId: ready.backend.backendId as string };
    }

    async function subscribe(wsUrl: string, backendId: string, topic: string, instanceId: string) {
      const ws = await connect(wsUrl);
      await hello(ws, { namespace: 'app-a', peerType: 'client-only', instanceId });
      ws.send(JSON.stringify({ type: 'topic_subscribe', backendId, topic }));
      await waitForMessage(ws, 'topic_subscribed');
      return ws;
    }

    test('publish fans out one copy to each subscriber', async () => {
      const { wsUrl } = await startServer();
      const { backendCtl, backendId } = await setupTopic(wsUrl, 't1');
      const sub1 = await subscribe(wsUrl, backendId, 'resources', 't1-c1');
      const sub2 = await subscribe(wsUrl, backendId, 'resources', 't1-c2');

      const received1: any[] = [];
      const received2: any[] = [];
      sub1.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'topic_message') received1.push(m); });
      sub2.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'topic_message') received2.push(m); });

      backendCtl.send(JSON.stringify({ type: 'topic_publish', topic: 'resources', payload: { rev: 7 } }));
      await delay(200);

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
      expect(received1[0].backendId).toBe(backendId);
      expect(received1[0].payload).toEqual({ rev: 7 });
    });

    test('unsubscribe stops delivery, other topics unaffected', async () => {
      const { wsUrl } = await startServer();
      const { backendCtl, backendId } = await setupTopic(wsUrl, 't2');
      const sub = await subscribe(wsUrl, backendId, 'a', 't2-c1');
      sub.send(JSON.stringify({ type: 'topic_subscribe', backendId, topic: 'b' }));
      await waitForMessage(sub, 'topic_subscribed');

      sub.send(JSON.stringify({ type: 'topic_unsubscribe', backendId, topic: 'a' }));
      await waitForMessage(sub, 'topic_unsubscribed');

      const received: any[] = [];
      sub.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'topic_message') received.push(m); });
      backendCtl.send(JSON.stringify({ type: 'topic_publish', topic: 'a', payload: 1 }));
      backendCtl.send(JSON.stringify({ type: 'topic_publish', topic: 'b', payload: 2 }));
      await delay(200);

      expect(received).toHaveLength(1);
      expect(received[0].topic).toBe('b');
    });

    test('cross-namespace subscribe is denied, non-owner publish is dropped', async () => {
      const { wsUrl } = await startServer();
      const { backendId } = await setupTopic(wsUrl, 't3');
      const sub = await subscribe(wsUrl, backendId, 'x', 't3-legit');

      // Cross-namespace subscriber
      const foreign = await connect(wsUrl);
      await hello(foreign, { namespace: 'app-b', peerType: 'client-only', instanceId: 't3-foreign' });
      foreign.send(JSON.stringify({ type: 'topic_subscribe', backendId, topic: 'x' }));
      const err = await waitForMessage(foreign, 'gateway_error');
      expect(err.code).toBe('BACKEND_OFFLINE');

      // A client (non-owner) publishing must be silently dropped
      const received: any[] = [];
      sub.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'topic_message') received.push(m); });
      sub.send(JSON.stringify({ type: 'topic_publish', topic: 'x', payload: 'forged' }));
      await delay(200);
      expect(received).toHaveLength(0);
    });
  });

  // ==========================================================================
  // v4 HTTP streaming proxy
  // ==========================================================================

  describe('v4 HTTP streaming proxy', () => {
    type HttpHandler = (meta: any, body: Buffer, socket: WebSocket) => void;

    /** v4 backend that serves internal http channels with the given handler. */
    async function startV4HttpBackend(wsUrl: string, instanceId: string, handler: HttpHandler, opts: { reject?: boolean; silent?: boolean } = {}) {
      const ctl = await connect(wsUrl);
      const ready = await hello(ctl, { namespace: 'app-a', peerType: 'client+backend', instanceId });
      const base = wsUrl.replace(/\/ws$/, '');
      ctl.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== 'channel_offer' || msg.kind !== 'http') return;
        if (opts.reject) {
          ctl.send(JSON.stringify({ type: 'channel_reject', channelId: msg.channelId, reason: 'policy' }));
          return;
        }
        const data = new WebSocket(`${base}${msg.dataPath}?ticket=${msg.ticket}`);
        sockets.push(data);
        let meta: any = null;
        const chunks: Buffer[] = [];
        data.on('message', (d: Buffer, isBinary: boolean) => {
          if (isBinary) { chunks.push(Buffer.from(d)); return; }
          const frame = JSON.parse(d.toString());
          if (frame.type === 'http_request') meta = frame;
          else if (frame.type === 'http_request_end' && !opts.silent) handler(meta, Buffer.concat(chunks), data);
        });
      });
      return { ctl, backendId: ready.backend.backendId as string };
    }

    test('GET streams status, filtered headers, and chunked body to the client', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const { backendId } = await startV4HttpBackend(wsUrl, 'http-get', (meta, _body, socket) => {
        expect(meta.method).toBe('GET');
        expect(meta.path).toBe('/files/hello.txt');
        socket.send(JSON.stringify({
          type: 'http_response', status: 200,
          headers: { 'Content-Type': 'text/plain', 'ETag': '"v9"', 'Set-Cookie': 'leak=no' },
        }));
        socket.send(Buffer.from('Hello '), { binary: true });
        socket.send(Buffer.from('Streaming!'), { binary: true });
        socket.close();
      });

      const response = await fetch(`${httpUrl}/api/proxy/${backendId}/files/hello.txt`, {
        headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('etag')).toBe('"v9"');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await response.text()).toBe('Hello Streaming!');
    });

    test('POST body streams to the backend without buffering or base64', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const payload = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < payload.length; i += 251) payload[i] = i % 256;

      const { backendId } = await startV4HttpBackend(wsUrl, 'http-post', (meta, body, socket) => {
        socket.send(JSON.stringify({ type: 'http_response', status: 200, headers: { 'Content-Type': 'application/json' } }));
        socket.send(Buffer.from(JSON.stringify({
          received: body.length,
          intact: Buffer.compare(body, payload) === 0,
          contentType: meta.headers['content-type'],
        })), { binary: true });
        socket.close();
      });

      const response = await fetch(`${httpUrl}/api/proxy/${backendId}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${GATEWAY_SECRET}`, 'Content-Type': 'application/octet-stream' },
        body: payload,
      });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.received).toBe(payload.length);
      expect(result.intact).toBe(true);
      expect(result.contentType).toBe('application/octet-stream');
    });

    test('backend that never responds yields 504', async () => {
      const { wsUrl, httpUrl } = await startServer({ gatewaySecret: GATEWAY_SECRET, proxyRequestTimeoutMs: 400 });
      const { backendId } = await startV4HttpBackend(wsUrl, 'http-504', () => {}, { silent: true });

      const response = await fetch(`${httpUrl}/api/proxy/${backendId}/never`, {
        headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
      });
      expect(response.status).toBe(504);
      const body = await response.json();
      expect(body.error.code).toBe('GATEWAY_TIMEOUT');
    });

    test('backend rejecting the channel yields 502', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const { backendId } = await startV4HttpBackend(wsUrl, 'http-rej', () => {}, { reject: true });

      const response = await fetch(`${httpUrl}/api/proxy/${backendId}/denied`, {
        headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
      });
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body.error.code).toBe('BACKEND_OFFLINE');
    });

    test('binary response bytes survive the bridge intact', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const blob = Buffer.alloc(256 * 1024);
      for (let i = 0; i < blob.length; i++) blob[i] = i % 256;

      const { backendId } = await startV4HttpBackend(wsUrl, 'http-bin', (_meta, _body, socket) => {
        socket.send(JSON.stringify({ type: 'http_response', status: 200, headers: { 'Content-Type': 'application/octet-stream' } }));
        // Send in several chunks to exercise streaming
        for (let offset = 0; offset < blob.length; offset += 64 * 1024) {
          socket.send(blob.subarray(offset, offset + 64 * 1024), { binary: true });
        }
        socket.close();
      });

      const response = await fetch(`${httpUrl}/api/proxy/${backendId}/blob`, {
        headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
      });
      expect(response.status).toBe(200);
      const received = Buffer.from(await response.arrayBuffer());
      expect(received.length).toBe(blob.length);
      expect(Buffer.compare(received, blob)).toBe(0);
    });
  });
});
