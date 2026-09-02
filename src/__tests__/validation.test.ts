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
    expect(validateGatewayMessage({ type: 'subscribe_backend' })).toContain('backendId');
    expect(validateGatewayMessage({ type: 'backend_client_message', message: {} })).toContain('backendId');
    expect(validateGatewayMessage({ type: 'catch_up_content', backendId: 'b', contentStreamId: 's' })).toContain('afterOffset');
    expect(validateGatewayMessage({ type: 'http_proxy_response_chunk', requestId: 'r' })).toContain('data');
  });

  test('rejects wrong field types', () => {
    expect(validateGatewayMessage({ type: 'subscribe_backend', backendId: 42 })).toContain('non-empty string');
    expect(validateGatewayMessage({ type: 'http_proxy_response_chunk', requestId: 'r', data: 123 })).toContain('string');
    expect(validateGatewayMessage({ type: 'backend_heartbeat', epoch: 'one' })).toContain('number');
    expect(validateGatewayMessage({ type: 'http_proxy_response', requestId: 'r', statusCode: 999 })).toContain('status code');
    expect(validateGatewayMessage({ type: 'backend_server_message', backendId: 'b', targetPeerSessionId: 5 })).toContain('string');
  });

  test('accepts real v3 traffic shapes (leniency contract)', () => {
    // Snapshot with sessions/projects instead of resources
    expect(validateGatewayMessage({ type: 'backend_resource_snapshot', sessions: [], projects: [] })).toBeNull();
    // Event with app-specific op and item
    expect(validateGatewayMessage({ type: 'backend_resource_event', op: 'session_upsert', item: {} })).toBeNull();
    // Client message using payload instead of message
    expect(validateGatewayMessage({ type: 'backend_client_message', backendId: 'b', payload: {} })).toBeNull();
    // Unknown extra fields are always allowed
    expect(validateGatewayMessage({ type: 'subscribe_backend', backendId: 'b', futureField: true })).toBeNull();
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
      protocolVersion: 3,
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

    ws.send(JSON.stringify({ type: 'subscribe_backend' }));
    const err = await waitForMessage(ws, 'gateway_error');
    expect(err.code).toBe('INVALID_MESSAGE');
    expect(err.message).toContain('backendId');

    // Connection must remain usable afterwards
    ws.send(JSON.stringify({ type: 'ping', ts: 42 }));
    const pong = await waitForMessage(ws, 'pong');
    expect(pong.ts).toBe(42);
  });

  test('buffered proxy response headers are filtered, request headers are allowlisted', async () => {
    const { wsUrl, httpUrl } = await startServer();
    const { ws, backendId } = await connectBackend(wsUrl, 'inst-headers');

    let seenRequestHeaders: Record<string, string> = {};
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'http_proxy_request') {
        seenRequestHeaders = msg.headers;
        ws.send(JSON.stringify({
          type: 'http_proxy_response', requestId: msg.requestId,
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json',
            'ETag': '"v1"',
            'Set-Cookie': 'local-session=secret',
            'X-Powered-By': 'Express',
          },
          bodyEncoding: 'utf8', body: '{}',
        }));
      }
    });

    const response = await fetch(`${httpUrl}/api/proxy/${backendId}/data`, {
      headers: {
        Authorization: `Bearer ${GATEWAY_SECRET}`,
        Range: 'bytes=0-99',
        Cookie: 'client-cookie=value',
        'X-Internal-Header': 'should-not-forward',
      },
    });

    expect(response.status).toBe(200);
    // Response side: allowlisted pass, session material and fingerprints dropped
    expect(response.headers.get('etag')).toBe('"v1"');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-powered-by')).toBeNull();
    // Request side: allowlisted forwarded, everything else dropped
    expect(seenRequestHeaders['range']).toBe('bytes=0-99');
    expect(seenRequestHeaders['cookie']).toBeUndefined();
    expect(seenRequestHeaders['authorization']).toBeUndefined();
    expect(seenRequestHeaders['x-internal-header']).toBeUndefined();
  });
});
