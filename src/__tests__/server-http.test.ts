/**
 * Unit tests for Gateway HTTP endpoints
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'http';
import net from 'node:net';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer } from './test-server.js';

const GATEWAY_SECRET = 'test-secret-http';
let WS_URL = '';
let HTTP_URL = '';

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

// Helper: wait for WebSocket to open
function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.on('open', () => resolve());
    ws.on('error', (err) => reject(err));
  });
}

// Helper: close WebSocket and wait for it to finish
function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on('close', () => resolve());
    ws.close();
  });
}

// Helper: collect next message of specific type
function waitForMessage(ws: WebSocket, type: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for message type: ${type}`));
    }, timeoutMs);

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

// Helper: register a v2 backend and return backendId
async function registerBackend(ws: WebSocket, identity: { deviceId: string; instanceId: string; name?: string }): Promise<string> {
  ws.send(JSON.stringify({
    type: 'peer_hello',
    protocolVersion: 4,
    namespace: 'zclaudia',
    clientProtocolVersion: 1,
    peerType: 'client+backend',
    gatewaySecret: GATEWAY_SECRET,
    identity,
    backend: { visible: true, capabilities: [], backendProtocolVersion: 1 }
  }));
  const ready = await waitForMessage(ws, 'peer_ready');
  return ready.backend.backendId;
}

describeIfLoopback('Gateway HTTP Endpoints', () => {
  let server: Server;

  beforeEach(async () => {
    server = createGatewayServer({ gatewaySecret: GATEWAY_SECRET });
    ({ wsUrl: WS_URL, httpUrl: HTTP_URL } = await listenTestServer(server));
  });

  afterEach(async () => {
    await closeTestServer(server);
  });

  describe('Health Check', () => {
    test('should return health status', async () => {
      const response = await fetch(`${HTTP_URL}/health`);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.status).toBe('ok');
      expect(typeof body.backends).toBe('number');
      expect(typeof body.peers).toBe('number');
    });

    test('health check should reflect connected backends', async () => {
      // Register a backend
      const backendWs = new WebSocket(WS_URL);
      await waitForOpen(backendWs);
      await registerBackend(backendWs, { deviceId: 'health-test-device', instanceId: 'inst-health-test-device', name: 'Health Test Backend' });

      // Check health
      const response = await fetch(`${HTTP_URL}/health`);
      const body = await response.json();
      expect(body.backends).toBe(1);

      await closeWs(backendWs);

      // Wait for disconnect to be processed
      await new Promise(r => setTimeout(r, 100));

      const response2 = await fetch(`${HTTP_URL}/health`);
      const body2 = await response2.json();
      expect(body2.backends).toBe(0);
    });
  });

  describe('CORS Headers', () => {
    test('should return CORS headers on all responses', async () => {
      const response = await fetch(`${HTTP_URL}/health`);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
    });

    test('should handle OPTIONS preflight requests', async () => {
      const response = await fetch(`${HTTP_URL}/health`, {
        method: 'OPTIONS'
      });
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    test('should allow all CORS methods', async () => {
      const response = await fetch(`${HTTP_URL}/health`, {
        method: 'OPTIONS'
      });
      const allowMethods = response.headers.get('Access-Control-Allow-Methods');
      expect(allowMethods).toContain('GET');
      expect(allowMethods).toContain('POST');
      expect(allowMethods).toContain('PUT');
      expect(allowMethods).toContain('DELETE');
      expect(allowMethods).toContain('PATCH');
      expect(allowMethods).toContain('OPTIONS');
    });
  });

  describe('404 Handler', () => {
    test('should return 404 for unknown paths', async () => {
      const response = await fetch(`${HTTP_URL}/unknown-path`);
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
    });

    test('should return 404 for unknown API paths', async () => {
      const response = await fetch(`${HTTP_URL}/api/unknown`);
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('HTTP Proxy', () => {
    test('should return 502 when backend not found', async () => {
      const response = await fetch(`${HTTP_URL}/api/proxy/nonexistent-backend/test-path`, {
        headers: {
          'Authorization': `Bearer ${GATEWAY_SECRET}`
        }
      });

      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body.error.code).toBe('BACKEND_OFFLINE');
    });



    test.skip('should handle backend timeout - requires 60s timeout', async () => {});


  });

});
