/**
 * Phase 1: runtime message validation and proxy header hygiene.
 *
 * Unit tests cover the validator's leniency contract (real v3 traffic must
 * pass); integration tests cover rejection behavior and header filtering.
 */
import { describe, test, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'http';
import net from 'node:net';
import { createGatewayServer } from '../server.js';
import { validateGatewayMessage, filterProxyResponseHeaders } from '../validation.js';
import { closeTestServer, listenTestServer } from './test-server.js';

const GATEWAY_SECRET = 'test-secret-validation';

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

describe('validateGatewayMessage (unit)', () => {
  test('rejects missing routing fields', () => {
    expect(validateGatewayMessage({ type: 'channel_open' })).toContain('target');
    expect(validateGatewayMessage({ type: 'topic_subscribe', topic: 't' })).toContain('backendId');
    expect(validateGatewayMessage({ type: 'backend_server_message' })).toContain('backendId');
  });

  test('rejects wrong field types', () => {
    expect(validateGatewayMessage({ type: 'topic_subscribe', backendId: 42, topic: 't' })).toContain('non-empty string');
    expect(validateGatewayMessage({ type: 'backend_heartbeat', epoch: 'one' })).toContain('number');
    expect(validateGatewayMessage({ type: 'backend_server_message', backendId: 'b', targetPeerSessionId: 5 })).toContain('string');
  });

  test('leniency contract: payloads stay opaque, unknown extras allowed', () => {
    expect(validateGatewayMessage({ type: 'topic_publish', topic: 't', payload: { anything: true } })).toBeNull();
    expect(validateGatewayMessage({ type: 'backend_server_message', backendId: 'b', payload: {} })).toBeNull();
    expect(validateGatewayMessage({ type: 'channel_open', target: 'b', futureField: true })).toBeNull();
  });

  test('leaves unknown message types to the router', () => {
    expect(validateGatewayMessage({ type: 'some_future_type', anything: 1 })).toBeNull();
  });
});

describe('filterProxyResponseHeaders (unit)', () => {
  test('drops session material and fingerprints, keeps content headers', () => {
    const filtered = filterProxyResponseHeaders({
      'Content-Type': 'application/json',
      'ETag': '"abc"',
      'Set-Cookie': 'session=secret',
      'X-Powered-By': 'Express',
      'Connection': 'keep-alive',
      'Content-Disposition': 'attachment; filename="f.bin"',
    });
    expect(filtered).toEqual({
      'Content-Type': 'application/json',
      'ETag': '"abc"',
      'Content-Disposition': 'attachment; filename="f.bin"',
    });
  });
});

describeIfLoopback('Phase 1: validation & header hygiene (integration)', () => {
  const servers: Server[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    await Promise.all(sockets.map((ws) => new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.on('close', () => resolve());
      ws.close();
    })));
    sockets.length = 0;
    await Promise.all(servers.map((s) => closeTestServer(s)));
    servers.length = 0;
  });

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

  async function startServer() {
    const server = createGatewayServer({ gatewaySecret: GATEWAY_SECRET });
    servers.push(server);
    return await listenTestServer(server);
  }

  async function connectBackend(wsUrl: string, instanceId: string) {
    const ws = new WebSocket(wsUrl);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.send(JSON.stringify({
      type: 'peer_hello',
      protocolVersion: 4,
      namespace: 'zclaudia',
      clientProtocolVersion: 1,
      peerType: 'client+backend',
      gatewaySecret: GATEWAY_SECRET,
      identity: { deviceId: `dev-${instanceId}`, instanceId },
      backend: { visible: true, capabilities: [], backendProtocolVersion: 1 },
    }));
    const ready = await waitForMessage(ws, 'peer_ready');
    return { ws, backendId: ready.backend.backendId as string };
  }

  test('invalid message gets INVALID_MESSAGE and the connection survives', async () => {
    const { wsUrl } = await startServer();
    const { ws } = await connectBackend(wsUrl, 'inst-invalid');

    ws.send(JSON.stringify({ type: 'channel_open' }));
    const err = await waitForMessage(ws, 'gateway_error');
    expect(err.code).toBe('INVALID_MESSAGE');
    expect(err.message).toContain('target');

    // Connection must remain usable afterwards
    ws.send(JSON.stringify({ type: 'ping', ts: 42 }));
    const pong = await waitForMessage(ws, 'pong');
    expect(pong.ts).toBe(42);
  });

});
