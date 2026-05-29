/**
 * Unit tests for Gateway authentication and rate limiting
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'http';
import net from 'node:net';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer } from './test-server.js';

const GATEWAY_SECRET = 'test-secret-auth';

async function canBindLoopback(): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = net.createServer();
    const finish = (result: boolean) => {
      clearTimeout(timer);
      probe.removeAllListeners('error');
      try {
        probe.close();
      } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), 200);
    probe.once('error', () => finish(false));
    probe.listen(0, '127.0.0.1', () => {
      probe.close(() => finish(true));
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

// Helper: send a v2 backend peer_hello
function sendBackendHello(ws: WebSocket, secret: string | null, identity: { deviceId: string; instanceId: string; name?: string }, visible = true) {
  ws.send(JSON.stringify({
    type: 'peer_hello',
    protocolVersion: 2,
    peerType: 'client+backend',
    gatewaySecret: secret,
    identity,
    backend: { visible, capabilities: [] }
  }));
}

// Helper: send a v2 client peer_hello
function sendClientHello(ws: WebSocket, secret: string | null) {
  ws.send(JSON.stringify({
    type: 'peer_hello',
    protocolVersion: 2,
    peerType: 'client-only',
    gatewaySecret: secret,
    identity: { deviceId: 'client-dev', instanceId: 'client-inst' }
  }));
}

describeIfLoopback('Gateway Authentication', () => {
  let server: Server;
  let wsUrl: string;
  let httpUrl: string;

  beforeEach(async () => {
    server = createGatewayServer({ gatewaySecret: GATEWAY_SECRET });
    ({ wsUrl, httpUrl } = await listenTestServer(server));
  });

  afterEach(async () => {
    await closeTestServer(server);
  });

  describe('Backend Registration', () => {
    test('should reject backend registration with invalid secret', async () => {
      const ws = new WebSocket(wsUrl);
      await waitForOpen(ws);

      sendBackendHello(ws, 'wrong-secret', { deviceId: 'test-device', instanceId: 'inst-test-device', name: 'Test Backend' });

      const result = await waitForMessage(ws, 'gateway_error');
      expect(result.code).toBe('UNAUTHORIZED');
      expect(result.message).toContain('Invalid');

      await closeWs(ws);
    });

    test('should accept backend registration with valid secret', async () => {
      const ws = new WebSocket(wsUrl);
      await waitForOpen(ws);

      sendBackendHello(ws, GATEWAY_SECRET, { deviceId: 'test-device-valid', instanceId: 'inst-test-device-valid', name: 'Test Backend' });

      const result = await waitForMessage(ws, 'peer_ready');
      expect(result.backend).toBeDefined();
      expect(result.backend.backendId).toMatch(/^[a-f0-9]{8}$/);

      await closeWs(ws);
    });

    test('should handle backend reconnection', async () => {
      const ws1 = new WebSocket(wsUrl);
      await waitForOpen(ws1);

      sendBackendHello(ws1, GATEWAY_SECRET, { deviceId: 'test-device-reconnect', instanceId: 'inst-test-device-reconnect', name: 'Test Backend' });

      const result1 = await waitForMessage(ws1, 'peer_ready');
      expect(result1.backend).toBeDefined();
      const backendId = result1.backend.backendId;

      // Connect second WebSocket with same instanceId
      const ws2 = new WebSocket(wsUrl);
      await waitForOpen(ws2);

      sendBackendHello(ws2, GATEWAY_SECRET, { deviceId: 'test-device-reconnect', instanceId: 'inst-test-device-reconnect', name: 'Test Backend' });

      const result2 = await waitForMessage(ws2, 'peer_ready');
      expect(result2.backend).toBeDefined();
      expect(result2.backend.backendId).toBe(backendId);

      // First connection should be closed
      await new Promise<void>((resolve) => {
        ws1.on('close', () => resolve());
      });

      await closeWs(ws2);
    });

    test('should reject non-string secrets in safeCompare', async () => {
      const ws = new WebSocket(wsUrl);
      await waitForOpen(ws);

      // Send peer_hello with null secret — validation rejects non-string gatewaySecret
      sendBackendHello(ws, null, { deviceId: 'test-device-null', instanceId: 'inst-test-device-null', name: 'Test Backend' });

      const result = await waitForMessage(ws, 'gateway_error');
      expect(result.code).toBe('INVALID_MESSAGE');

      await closeWs(ws);
    });
  });

  describe('Client Authentication', () => {
    test('should reject client with invalid gateway secret', async () => {
      const ws = new WebSocket(wsUrl);
      await waitForOpen(ws);

      sendClientHello(ws, 'wrong-secret');

      const result = await waitForMessage(ws, 'gateway_error');
      expect(result.code).toBe('UNAUTHORIZED');
      expect(result.message).toContain('Invalid');

      await closeWs(ws);
    });

    test('should accept client with valid gateway secret', async () => {
      const ws = new WebSocket(wsUrl);
      await waitForOpen(ws);

      sendClientHello(ws, GATEWAY_SECRET);

      const result = await waitForMessage(ws, 'peer_ready');
      expect(result.registrySync).toBeDefined();

      await closeWs(ws);
    });
  });

  describe('HTTP Authentication', () => {
    test('should reject request without authorization header', async () => {
      const response = await fetch(`${httpUrl}/api/proxy/test-id/some-path`);
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    test('should reject request with invalid bearer token', async () => {
      const response = await fetch(`${httpUrl}/api/proxy/test-id/some-path`, {
        headers: {
          'Authorization': 'Bearer wrong-secret'
        }
      });
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    test('should reject request with invalid authorization format', async () => {
      const response = await fetch(`${httpUrl}/api/proxy/test-id/some-path`, {
        headers: {
          'Authorization': 'Basic wrong-format'
        }
      });
      expect(response.status).toBe(401);
    });

    test('should accept request with valid bearer token', async () => {
      // First register a backend
      const backendWs = new WebSocket(wsUrl);
      await waitForOpen(backendWs);
      sendBackendHello(backendWs, GATEWAY_SECRET, { deviceId: 'http-test-device', instanceId: 'inst-http-test-device', name: 'HTTP Test Backend' });
      const regResult = await waitForMessage(backendWs, 'peer_ready');
      const backendId = regResult.backend.backendId;

      // Handle proxy request - respond immediately
      backendWs.once('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'http_proxy_request') {
          backendWs.send(JSON.stringify({
            type: 'http_proxy_response',
            requestId: msg.requestId,
            statusCode: 200,
            headers: {},
            bodyEncoding: 'utf8',
            body: JSON.stringify({ success: true })
          }));
        }
      });

      // Now try HTTP proxy
      const response = await fetch(`${httpUrl}/api/proxy/${backendId}/test-path`, {
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

    test.skip('should accept clientId:gatewaySecret format - has side effects', async () => {
      // Skipped due to test isolation issues
    });
  });
});

describe('Gateway Rate Limiting', () => {
  let server: Server;
  let httpUrl: string;

  beforeEach(async () => {
    server = createGatewayServer({ gatewaySecret: GATEWAY_SECRET });
    ({ httpUrl } = await listenTestServer(server));
  });

  afterEach(async () => {
    await closeTestServer(server);
  });

  test('should rate limit after 10 failed attempts', async () => {
    // Make 10 failed requests first
    for (let i = 0; i < 10; i++) {
      const response = await fetch(`${httpUrl}/api/proxy/test-id/path`, {
        headers: {
          'Authorization': 'Bearer wrong-secret'
        }
      });
      expect(response.status).toBe(401);
    }

    // 11th request should be rate limited
    const response = await fetch(`${httpUrl}/api/proxy/test-id/path`, {
      headers: {
        'Authorization': 'Bearer wrong-secret'
      }
    });
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error.code).toBe('RATE_LIMITED');
  });
});

describe('Invalid First Messages', () => {
  let server: Server;
  let wsUrl: string;

  beforeEach(async () => {
    server = createGatewayServer({ gatewaySecret: GATEWAY_SECRET });
    ({ wsUrl } = await listenTestServer(server));
  });

  afterEach(async () => {
    await closeTestServer(server);
  });

  test('should reject unknown first message type', async () => {
    const ws = new WebSocket(wsUrl);
    await waitForOpen(ws);

    ws.send(JSON.stringify({
      type: 'unknown_type'
    }));

    const error = await waitForMessage(ws, 'gateway_error');
    expect(error.code).toBe('INVALID_MESSAGE');

    await closeWs(ws);
  });

  test('should close connection after invalid first message', async () => {
    const ws = new WebSocket(wsUrl);
    await waitForOpen(ws);

    ws.send(JSON.stringify({
      type: 'invalid'
    }));

    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
    });
  });
});

describe('Connection Timeout', () => {
  let server: Server;

  beforeEach(async () => {
    server = createGatewayServer({ gatewaySecret: GATEWAY_SECRET });
    await listenTestServer(server);
  });

  afterEach(async () => {
    await closeTestServer(server);
  });

  test.skip('should close unauthenticated connection after timeout - requires 10s', async () => {});
});
