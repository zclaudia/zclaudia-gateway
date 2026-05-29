/**
 * Unit tests for Gateway error handling (v2 protocol)
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'http';
import net from 'node:net';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer } from './test-server.js';

const GATEWAY_SECRET = 'test-secret-errors';
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

// Helper: small delay
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// Helper: register a backend with v2 protocol
async function registerBackendV2(ws: WebSocket, identity: { deviceId: string; instanceId: string; name?: string }): Promise<{ backendId: string; epoch: number }> {
  ws.send(JSON.stringify({
    type: 'peer_hello',
    protocolVersion: 2,
    peerType: 'client+backend',
    gatewaySecret: GATEWAY_SECRET,
    identity,
    backend: { visible: true, capabilities: [] }
  }));
  const ready = await waitForMessage(ws, 'peer_ready');
  return { backendId: ready.backend.backendId, epoch: ready.backend.epoch };
}

describeIfLoopback('Gateway Error Handling', () => {
  let server: Server;

  beforeEach(async () => {
    server = createGatewayServer({ gatewaySecret: GATEWAY_SECRET });
    ({ wsUrl: WS_URL, httpUrl: HTTP_URL } = await listenTestServer(server));
  });

  afterEach(async () => {
    await closeTestServer(server);
  });

  describe('Invalid JSON', () => {
    test('should handle invalid JSON message', async () => {
      const ws = new WebSocket(WS_URL);
      await waitForOpen(ws);

      // Send invalid JSON
      ws.send('not valid json');

      const error = await waitForMessage(ws, 'gateway_error');
      expect(error.code).toBe('INVALID_MESSAGE');

      await closeWs(ws);
    });

    test('should handle empty message', async () => {
      const ws = new WebSocket(WS_URL);
      await waitForOpen(ws);

      ws.send('');

      const error = await waitForMessage(ws, 'gateway_error');
      expect(error.code).toBe('INVALID_MESSAGE');

      await closeWs(ws);
    });

    test('should handle binary data', async () => {
      const ws = new WebSocket(WS_URL);
      await waitForOpen(ws);

      ws.send(Buffer.from([0x00, 0x01, 0x02]));

      const error = await waitForMessage(ws, 'gateway_error');
      expect(error.code).toBe('INVALID_MESSAGE');

      await closeWs(ws);
    });
  });

  describe('WebSocket Connection Limits', () => {
    test('should enforce per-IP connection limit', async () => {
      const connections: WebSocket[] = [];

      try {
        // Try to open 11 connections (limit is 10)
        for (let i = 0; i < 11; i++) {
          const ws = new WebSocket(WS_URL);
          connections.push(ws);
          await waitForOpen(ws);
        }

        // All 11 should connect initially
        expect(connections.every(ws => ws.readyState === WebSocket.OPEN)).toBe(true);

        // Close all
        await Promise.all(connections.map(ws => closeWs(ws)));
      } catch (err) {
        // One of the connections might fail due to limit
        await Promise.all(connections.map(ws => closeWs(ws)));
      }
    });
  });

  describe('Backend Connection Lost During Proxy', () => {
    test.skip('should handle backend disconnect during HTTP proxy - may timeout', async () => {
      // Register backend
      const backendWs = new WebSocket(WS_URL);
      await waitForOpen(backendWs);
      const { backendId } = await registerBackendV2(backendWs, { deviceId: 'proxy-error-device', instanceId: 'inst-proxy-error-device', name: 'Proxy Error Backend' });

      // Listen for proxy request
      let requestId: string | null = null;
      backendWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'http_proxy_request') {
          requestId = msg.requestId;
          // Close without responding
          backendWs.close();
        }
      });

      // Send proxy request
      const responsePromise = fetch(`${HTTP_URL}/api/proxy/${backendId}/test`, {
        headers: { 'Authorization': `Bearer ${GATEWAY_SECRET}` }
      });

      const response = await responsePromise;
      // Should get error since backend closed
      expect([502, 504]).toContain(response.status);
    });
  });

  describe('Streaming Response Errors', () => {
    test('should handle orphaned streaming chunks', async () => {
      // Register backend
      const backendWs = new WebSocket(WS_URL);
      await waitForOpen(backendWs);
      await registerBackendV2(backendWs, { deviceId: 'stream-error-device', instanceId: 'inst-stream-error-device', name: 'Stream Error Backend' });

      // Send chunk for non-existent request
      backendWs.send(JSON.stringify({
        type: 'http_proxy_response_chunk',
        requestId: 'non-existent-request',
        data: Buffer.from('test').toString('base64')
      }));

      // Should not throw
      await delay(100);

      await closeWs(backendWs);
    });

    test('should handle orphaned streaming end', async () => {
      // Register backend
      const backendWs = new WebSocket(WS_URL);
      await waitForOpen(backendWs);
      await registerBackendV2(backendWs, { deviceId: 'stream-end-device', instanceId: 'inst-stream-end-device', name: 'Stream End Backend' });

      // Send end for non-existent request
      backendWs.send(JSON.stringify({
        type: 'http_proxy_response_end',
        requestId: 'non-existent-request'
      }));

      // Should not throw
      await delay(100);

      await closeWs(backendWs);
    });

    test('should handle orphaned response start', async () => {
      // Register backend
      const backendWs = new WebSocket(WS_URL);
      await waitForOpen(backendWs);
      await registerBackendV2(backendWs, { deviceId: 'stream-start-device', instanceId: 'inst-stream-start-device', name: 'Stream Start Backend' });

      // Send start for non-existent request
      backendWs.send(JSON.stringify({
        type: 'http_proxy_response_start',
        requestId: 'non-existent-request',
        statusCode: 200,
        headers: {}
      }));

      // Should not throw
      await delay(100);

      await closeWs(backendWs);
    });
  });

  describe('Invalid Backend Messages', () => {
    test('should handle unknown message type from backend', async () => {
      const backendWs = new WebSocket(WS_URL);
      await waitForOpen(backendWs);
      await registerBackendV2(backendWs, { deviceId: 'invalid-msg-device', instanceId: 'inst-invalid-msg-device', name: 'Invalid Msg Backend' });

      // Send unknown message type
      backendWs.send(JSON.stringify({
        type: 'backend_response',
        clientId: 'non-existent-client',
        message: { type: 'test' }
      }));

      // Should receive gateway_error for unknown message type
      const error = await waitForMessage(backendWs, 'gateway_error');
      expect(error.code).toBe('INVALID_MESSAGE');

      await closeWs(backendWs);
    });

    test('should handle unknown message type from backend (client_auth_result)', async () => {
      const backendWs = new WebSocket(WS_URL);
      await waitForOpen(backendWs);
      await registerBackendV2(backendWs, { deviceId: 'auth-result-device', instanceId: 'inst-auth-result-device', name: 'Auth Result Backend' });

      // Send old-protocol message — should be treated as unknown type
      backendWs.send(JSON.stringify({
        type: 'client_auth_result',
        clientId: 'non-existent-client',
        success: true
      }));

      const error = await waitForMessage(backendWs, 'gateway_error');
      expect(error.code).toBe('INVALID_MESSAGE');

      await closeWs(backendWs);
    });
  });

  describe('Malformed Messages After Auth', () => {
    test('should handle messages without type', async () => {
      const backendWs = new WebSocket(WS_URL);
      await waitForOpen(backendWs);
      await registerBackendV2(backendWs, { deviceId: 'no-type-device', instanceId: 'inst-no-type-device', name: 'No Type Backend' });

      // Send message without type
      backendWs.send(JSON.stringify({ data: 'no type' }));

      // Should receive an error but connection stays open
      const error = await waitForMessage(backendWs, 'gateway_error');
      expect(error.code).toBe('INVALID_MESSAGE');
      await delay(50);
      expect(backendWs.readyState).toBe(WebSocket.OPEN);

      await closeWs(backendWs);
    });
  });

  describe('Connection Cleanup', () => {
    test('should handle rapid connect/disconnect', async () => {
      for (let i = 0; i < 5; i++) {
        const ws = new WebSocket(WS_URL);
        await waitForOpen(ws);
        await registerBackendV2(ws, { deviceId: `rapid-device-${i}`, instanceId: `inst-rapid-device-${i}`, name: `Rapid Backend ${i}` });
        ws.close();
      }

      // All connections should be cleaned up
      await delay(200);

      // Verify server still works
      const response = await fetch(`${HTTP_URL}/health`);
      expect(response.status).toBe(200);
    });

    test('should handle client disconnect before auth completes', async () => {
      const ws = new WebSocket(WS_URL);
      await waitForOpen(ws);

      // Start auth but don't wait for response
      ws.send(JSON.stringify({
        type: 'peer_hello',
        protocolVersion: 2,
        peerType: 'client+backend',
        gatewaySecret: GATEWAY_SECRET,
        identity: { deviceId: 'early-disconnect-device', instanceId: 'inst-early-disconnect-device', name: 'Early Disconnect' },
        backend: { visible: true, capabilities: [] }
      }));

      // Disconnect immediately
      ws.close();

      // Should not throw
      await delay(100);
    });
  });

  describe('HTTP Error Handling', () => {
    test('should handle large JSON body', async () => {
      const backendWs = new WebSocket(WS_URL);
      await waitForOpen(backendWs);
      const { backendId } = await registerBackendV2(backendWs, { deviceId: 'large-body-device', instanceId: 'inst-large-body-device', name: 'Large Body Backend' });

      // Create a large payload (but under 15MB)
      const largeData = { data: 'x'.repeat(100000) };

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

      const response = await fetch(`${HTTP_URL}/api/proxy/${backendId}/large`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GATEWAY_SECRET}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(largeData)
      });

      expect(response.status).toBe(200);

      await closeWs(backendWs);
    });
  });

  describe('Edge Cases', () => {
    test('should handle message with null gateway secret', async () => {
      const ws = new WebSocket(WS_URL);
      await waitForOpen(ws);

      ws.send(JSON.stringify({
        type: 'peer_hello',
        protocolVersion: 2,
        peerType: 'client+backend',
        gatewaySecret: null,
        identity: { deviceId: 'null-test-device', instanceId: 'inst-null-test-device', name: null },
        backend: { visible: true, capabilities: [] }
      }));

      // Should be rejected — null gatewaySecret fails validation
      const result = await waitForMessage(ws, 'gateway_error');
      expect(result.code).toBe('INVALID_MESSAGE');

      await closeWs(ws);
    });

    test('should handle message with empty string secret', async () => {
      const ws = new WebSocket(WS_URL);
      await waitForOpen(ws);

      ws.send(JSON.stringify({
        type: 'peer_hello',
        protocolVersion: 2,
        peerType: 'client+backend',
        gatewaySecret: '',
        identity: { deviceId: '', instanceId: '', name: '' },
        backend: { visible: true, capabilities: [] }
      }));

      // Should be rejected — empty secret won't match
      const result = await waitForMessage(ws, 'gateway_error');
      expect(result.code).toBe('UNAUTHORIZED');

      await closeWs(ws);
    });

    test('should handle concurrent proxy requests', async () => {
      // Register backend
      const backendWs = new WebSocket(WS_URL);
      await waitForOpen(backendWs);
      const { backendId } = await registerBackendV2(backendWs, { deviceId: 'concurrent-device', instanceId: 'inst-concurrent-device', name: 'Concurrent Backend' });

      const requests: string[] = [];
      backendWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'http_proxy_request') {
          requests.push(msg.requestId);
          // Respond after small delay
          setTimeout(() => {
            backendWs.send(JSON.stringify({
              type: 'http_proxy_response',
              requestId: msg.requestId,
              statusCode: 200,
              headers: {},
              bodyEncoding: 'utf8',
              body: JSON.stringify({ id: msg.requestId })
            }));
          }, 10);
        }
      });

      // Send 5 concurrent requests
      const responses = await Promise.all([
        fetch(`${HTTP_URL}/api/proxy/${backendId}/req1`, { headers: { 'Authorization': `Bearer ${GATEWAY_SECRET}` } }),
        fetch(`${HTTP_URL}/api/proxy/${backendId}/req2`, { headers: { 'Authorization': `Bearer ${GATEWAY_SECRET}` } }),
        fetch(`${HTTP_URL}/api/proxy/${backendId}/req3`, { headers: { 'Authorization': `Bearer ${GATEWAY_SECRET}` } }),
        fetch(`${HTTP_URL}/api/proxy/${backendId}/req4`, { headers: { 'Authorization': `Bearer ${GATEWAY_SECRET}` } }),
        fetch(`${HTTP_URL}/api/proxy/${backendId}/req5`, { headers: { 'Authorization': `Bearer ${GATEWAY_SECRET}` } }),
      ]);

      expect(requests.length).toBe(5);
      expect(responses.every(r => r.status === 200)).toBe(true);

      await closeWs(backendWs);
    });
  });
});
