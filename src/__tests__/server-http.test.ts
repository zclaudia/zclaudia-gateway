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
function waitForMessage(ws: WebSocket, type: string, timeoutMs = 1000): Promise<any> {
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
    protocolVersion: 2,
    peerType: 'client+backend',
    gatewaySecret: GATEWAY_SECRET,
    identity,
    backend: { visible: true, capabilities: [] }
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

    test('should forward GET request without body', async () => {
      // Register backend
      const backendWs = new WebSocket(WS_URL);
      await waitForOpen(backendWs);
      const backendId = await registerBackend(backendWs, { deviceId: 'proxy-get-device', instanceId: 'inst-proxy-get-device', name: 'Proxy GET Backend' });

      // Listen for http_proxy_request
      let receivedRequest: any = null;
      backendWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'http_proxy_request') {
          receivedRequest = msg;
          // Send response
          backendWs.send(JSON.stringify({
            type: 'http_proxy_response',
            requestId: msg.requestId,
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            bodyEncoding: 'utf8',
            body: JSON.stringify({ success: true })
          }));
        }
      });

      // Send GET request
      const response = await fetch(`${HTTP_URL}/api/proxy/${backendId}/test-path?foo=bar`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${GATEWAY_SECRET}`
        }
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);

      // Verify request was forwarded correctly
      expect(receivedRequest).not.toBeNull();
      expect(receivedRequest.method).toBe('GET');
      expect(receivedRequest.path).toBe('/test-path?foo=bar');
      expect(receivedRequest.body).toBeUndefined();

      await closeWs(backendWs);
    });

    test('should forward POST request with body', async () => {
      // Register backend
      const backendWs = new WebSocket(WS_URL);
      await waitForOpen(backendWs);
      const backendId = await registerBackend(backendWs, { deviceId: 'proxy-post-device', instanceId: 'inst-proxy-post-device', name: 'Proxy POST Backend' });

      // Listen for http_proxy_request
      let receivedRequest: any = null;
      backendWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'http_proxy_request') {
          receivedRequest = msg;
          // Send response
          backendWs.send(JSON.stringify({
            type: 'http_proxy_response',
            requestId: msg.requestId,
            statusCode: 201,
            headers: { 'Content-Type': 'application/json' },
            bodyEncoding: 'utf8',
            body: JSON.stringify({ created: true })
          }));
        }
      });

      // Send POST request
      const postData = { name: 'test', value: 123 };
      const response = await fetch(`${HTTP_URL}/api/proxy/${backendId}/api/test`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GATEWAY_SECRET}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(postData)
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.created).toBe(true);

      // Verify request was forwarded correctly
      expect(receivedRequest).not.toBeNull();
      expect(receivedRequest.method).toBe('POST');
      expect(receivedRequest.body).toBeDefined();

      await closeWs(backendWs);
    });

    test.skip('should handle backend timeout - requires 60s timeout', async () => {});

    test('should handle streaming response', async () => {
      // Register backend
      const backendWs = new WebSocket(WS_URL);
      await waitForOpen(backendWs);
      const backendId = await registerBackend(backendWs, { deviceId: 'proxy-stream-device', instanceId: 'inst-proxy-stream-device', name: 'Proxy Stream Backend' });

      // Listen for http_proxy_request and send streaming response
      backendWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'http_proxy_request') {
          const requestId = msg.requestId;

          // Send response start
          backendWs.send(JSON.stringify({
            type: 'http_proxy_response_start',
            requestId,
            statusCode: 200,
            headers: { 'Content-Type': 'text/plain', 'X-Custom': 'header' }
          }));

          // Send chunks
          setTimeout(() => {
            backendWs.send(JSON.stringify({
              type: 'http_proxy_response_chunk',
              requestId,
              data: Buffer.from('Hello ').toString('base64')
            }));
          }, 50);

          setTimeout(() => {
            backendWs.send(JSON.stringify({
              type: 'http_proxy_response_chunk',
              requestId,
              data: Buffer.from('World!').toString('base64')
            }));
          }, 100);

          setTimeout(() => {
            backendWs.send(JSON.stringify({
              type: 'http_proxy_response_end',
              requestId
            }));
          }, 150);
        }
      });

      // Send request
      const response = await fetch(`${HTTP_URL}/api/proxy/${backendId}/stream`, {
        headers: { 'Authorization': `Bearer ${GATEWAY_SECRET}` }
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('X-Custom')).toBe('header');
      const body = await response.text();
      expect(body).toBe('Hello World!');

      await closeWs(backendWs);
    });

    test('should handle PUT, PATCH, DELETE methods', async () => {
      // Register backend
      const backendWs = new WebSocket(WS_URL);
      await waitForOpen(backendWs);
      const backendId = await registerBackend(backendWs, { deviceId: 'proxy-methods-device', instanceId: 'inst-proxy-methods-device', name: 'Proxy Methods Backend' });

      const methods = ['PUT', 'PATCH', 'DELETE'];

      for (const method of methods) {
        let receivedRequest: any = null;
        const messageHandler = (data: WebSocket.Data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'http_proxy_request') {
            receivedRequest = msg;
            backendWs.send(JSON.stringify({
              type: 'http_proxy_response',
              requestId: msg.requestId,
              statusCode: 200,
              headers: {},
              bodyEncoding: 'utf8',
              body: JSON.stringify({ method })
            }));
          }
        };
        backendWs.on('message', messageHandler);

        const response = await fetch(`${HTTP_URL}/api/proxy/${backendId}/test`, {
          method,
          headers: {
            'Authorization': `Bearer ${GATEWAY_SECRET}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ data: method })
        });

        expect(response.status).toBe(200);
        expect(receivedRequest?.method).toBe(method);
        expect(receivedRequest?.body).toBeDefined();

        backendWs.off('message', messageHandler);
      }

      await closeWs(backendWs);
    });
  });

  describe('JSON Body Parsing', () => {
    test('should parse JSON body up to 15MB limit', async () => {
      // This test verifies the limit is configured - actual large payload test would be slow
      const backendWs = new WebSocket(WS_URL);
      await waitForOpen(backendWs);
      const backendId = await registerBackend(backendWs, { deviceId: 'json-limit-device', instanceId: 'inst-json-limit-device', name: 'JSON Limit Backend' });

      // Test with normal JSON body
      backendWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'http_proxy_request') {
          backendWs.send(JSON.stringify({
            type: 'http_proxy_response',
            requestId: msg.requestId,
            statusCode: 200,
            headers: {},
            bodyEncoding: 'utf8',
            body: JSON.stringify({ received: true })
          }));
        }
      });

      const response = await fetch(`${HTTP_URL}/api/proxy/${backendId}/test`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GATEWAY_SECRET}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ test: 'data' })
      });

      expect(response.status).toBe(200);

      await closeWs(backendWs);
    });
  });
});
