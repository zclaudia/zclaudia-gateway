/**
 * Unit tests for Gateway authentication and rate limiting
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'http';
import net from 'node:net';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer, issueToken, TEST_ADMIN_TOKEN } from './test-server.js';

// Issued zgb_ token, refreshed for every test server instance.
let GATEWAY_SECRET = '';

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

// Helper: send a v2 backend peer_hello
function sendBackendHello(ws: WebSocket, secret: string | null, identity: { deviceId: string; instanceId: string; name?: string }, visible = true) {
  ws.send(JSON.stringify({
    type: 'peer_hello',
    protocolVersion: 4,
    namespace: 'zclaudia',
    clientProtocolVersion: 1,
    peerType: 'client+backend',
    gatewaySecret: secret,
    identity,
    backend: { visible, capabilities: [], backendProtocolVersion: 1 }
  }));
}

// Helper: send a v2 client peer_hello
function sendClientHello(ws: WebSocket, secret: string | null) {
  ws.send(JSON.stringify({
    type: 'peer_hello',
    protocolVersion: 4,
    namespace: 'zclaudia',
    clientProtocolVersion: 1,
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
    server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN });
    ({ wsUrl, httpUrl } = await listenTestServer(server));
    GATEWAY_SECRET = await issueToken(httpUrl, 'backend', 'zclaudia');
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
      expect(result.backend.backendId).toMatch(/^[0-9a-f-]{36}$/);

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


    // Token format regression tests: both HTTP auth paths must accept the same
    // formats — only issued credential tokens are accepted; the legacy
    // clientId:secret composite is gone with the shared secret.
    describe('Bearer token formats', () => {
      test('legacy clientId:token composite is rejected', async () => {
        const response = await fetch(`${httpUrl}/api/proxy/nonexistent-backend/some-path`, {
          headers: { 'Authorization': `Bearer client-123:${GATEWAY_SECRET}` }
        });
        expect(response.status).toBe(401);
      });

      test('proxy route rejects token where only the pre-colon prefix matches the secret', async () => {
        const response = await fetch(`${httpUrl}/api/proxy/nonexistent-backend/some-path`, {
          headers: { 'Authorization': `Bearer ${GATEWAY_SECRET}:extra` }
        });
        expect(response.status).toBe(401);
      });

      test('notification config route rejects token where only the pre-colon prefix matches', async () => {
        const response = await fetch(`${httpUrl}/api/notifications/config`, {
          headers: { 'Authorization': `Bearer ${GATEWAY_SECRET}:extra` }
        });
        expect(response.status).toBe(401);
      });
    });
  });
});

describe('Gateway Rate Limiting', () => {
  let server: Server;
  let httpUrl: string;

  beforeEach(async () => {
    server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN });
    ({ httpUrl } = await listenTestServer(server));
    GATEWAY_SECRET = await issueToken(httpUrl, 'backend', 'zclaudia');
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
    server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN });
    ({ wsUrl } = await listenTestServer(server));
    GATEWAY_SECRET = await issueToken(wsUrl, 'backend', 'zclaudia');
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
    server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN });
    await listenTestServer(server);
  });

  afterEach(async () => {
    await closeTestServer(server);
  });

  test.skip('should close unauthenticated connection after timeout - requires 10s', async () => {});
});
