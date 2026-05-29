/**
 * Unit tests for Gateway Backend message handling (v2 protocol)
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'http';
import net from 'node:net';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer } from './test-server.js';

const GATEWAY_SECRET = 'test-secret-backend';
let WS_URL = '';

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

// Helper: create a message collector that tracks all messages
function createMessageCollector(ws: WebSocket) {
  const messages: any[] = [];
  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()));
  });
  return {
    getMessages: () => messages,
    find: (predicate: (m: any) => boolean) => messages.find(predicate),
    findAll: (predicate: (m: any) => boolean) => messages.filter(predicate),
    clear: () => messages.length = 0
  };
}

// Helper: small delay
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// Helper: register a backend with v2 protocol
async function registerBackendV2(ws: WebSocket, identity: { deviceId: string; instanceId: string; name?: string }, visible = true): Promise<{ backendId: string; epoch: number; peerSessionId: string }> {
  ws.send(JSON.stringify({
    type: 'peer_hello',
    protocolVersion: 2,
    peerType: 'client+backend',
    gatewaySecret: GATEWAY_SECRET,
    identity,
    backend: { visible, capabilities: [] }
  }));
  const ready = await waitForMessage(ws, 'peer_ready');
  return { backendId: ready.backend.backendId, epoch: ready.backend.epoch, peerSessionId: ready.peerSessionId };
}

// Helper: register a client with v2 protocol
async function registerClientV2(ws: WebSocket): Promise<{ peerSessionId: string; registrySync: any }> {
  ws.send(JSON.stringify({
    type: 'peer_hello',
    protocolVersion: 2,
    peerType: 'client-only',
    gatewaySecret: GATEWAY_SECRET,
    identity: { deviceId: 'client-dev', instanceId: `client-inst-${Date.now()}-${Math.random()}` }
  }));
  const ready = await waitForMessage(ws, 'peer_ready');
  return { peerSessionId: ready.peerSessionId, registrySync: ready.registrySync };
}

describeIfLoopback('Gateway Backend Message Handling', () => {
  let server: Server;
  let backendWs: WebSocket;
  let backendId: string;
  let backendEpoch: number;
  let backendCollector: ReturnType<typeof createMessageCollector>;
  let openClients: WebSocket[] = [];

  beforeEach(async () => {
    server = createGatewayServer({ gatewaySecret: GATEWAY_SECRET });
    ({ wsUrl: WS_URL } = await listenTestServer(server));

    // Register a backend
    backendWs = new WebSocket(WS_URL);
    await waitForOpen(backendWs);
    backendCollector = createMessageCollector(backendWs);

    const reg = await registerBackendV2(backendWs, { deviceId: 'test-backend-device', instanceId: 'inst-test-backend-device', name: 'Test Backend' });
    backendId = reg.backendId;
    backendEpoch = reg.epoch;
  });

  afterEach(async () => {
    await Promise.all(openClients.map(ws => closeWs(ws)));
    openClients = [];
    await closeWs(backendWs);
    await closeTestServer(server);
  });

  describe('Backend Registration', () => {
    test('should receive registry sync in peer_ready after registration', async () => {
      const readyMsg = backendCollector.find(m => m.type === 'peer_ready');
      expect(readyMsg).toBeDefined();
      expect(readyMsg.registrySync).toBeDefined();
      expect(readyMsg.registrySync.items).toBeInstanceOf(Array);
    });

    test('should generate unique backendId for each device', async () => {
      // Register another backend
      const backendWs2 = new WebSocket(WS_URL);
      await waitForOpen(backendWs2);

      const reg2 = await registerBackendV2(backendWs2, { deviceId: 'different-device', instanceId: 'inst-different-device', name: 'Second Backend' });
      expect(reg2.backendId).not.toBe(backendId);
      expect(reg2.backendId).toMatch(/^[a-f0-9]{8}$/);

      await closeWs(backendWs2);
    });

    test('should support visible=false for hidden backends', async () => {
      const hiddenBackendWs = new WebSocket(WS_URL);
      await waitForOpen(hiddenBackendWs);
      const collector = createMessageCollector(hiddenBackendWs);

      const reg = await registerBackendV2(hiddenBackendWs, { deviceId: 'hidden-device', instanceId: 'inst-hidden-device', name: 'Hidden Backend' }, false);
      expect(reg.backendId).toBeDefined();

      // The hidden backend should appear in registry snapshot with visible: false
      const readyMsg = collector.find(m => m.type === 'peer_ready');
      expect(readyMsg).toBeDefined();
      const hiddenInRegistry = readyMsg.registrySync.items.find((b: any) => b.backendId === reg.backendId);
      expect(hiddenInRegistry).toBeDefined();
      expect(hiddenInRegistry.visible).toBe(false);

      await closeWs(hiddenBackendWs);
    });

    test('should use default name if not provided', async () => {
      const noNameBackendWs = new WebSocket(WS_URL);
      await waitForOpen(noNameBackendWs);

      const reg = await registerBackendV2(noNameBackendWs, { deviceId: 'no-name-device', instanceId: 'inst-no-name-device' });
      expect(reg.backendId).toBeDefined();

      await closeWs(noNameBackendWs);
    });
  });

  describe('Backend Subscriptions', () => {
    test('should subscribe to backend', async () => {
      const clientWs = new WebSocket(WS_URL);
      await waitForOpen(clientWs);
      openClients.push(clientWs);

      await registerClientV2(clientWs);

      // Subscribe to the backend
      clientWs.send(JSON.stringify({
        type: 'subscribe_backend',
        backendId,
      }));

      const subscribed = await waitForMessage(clientWs, 'backend_subscribed');
      expect(subscribed.backendId).toBe(backendId);
      expect(subscribed.epoch).toBe(backendEpoch);
    });

    test('should return error for non-existent backend', async () => {
      const clientWs = new WebSocket(WS_URL);
      await waitForOpen(clientWs);
      openClients.push(clientWs);

      await registerClientV2(clientWs);

      clientWs.send(JSON.stringify({
        type: 'subscribe_backend',
        backendId: 'nonexist1',
      }));

      const error = await waitForMessage(clientWs, 'gateway_error');
      expect(error.code).toBe('BACKEND_OFFLINE');
    });

    test('should forward backend_client_message to backend', async () => {
      const clientWs = new WebSocket(WS_URL);
      await waitForOpen(clientWs);
      openClients.push(clientWs);

      await registerClientV2(clientWs);

      clientWs.send(JSON.stringify({
        type: 'subscribe_backend',
        backendId,
      }));

      await waitForMessage(clientWs, 'backend_subscribed');

      // Send a message from client to backend
      clientWs.send(JSON.stringify({
        type: 'backend_client_message',
        backendId,
        payload: { action: 'test', data: 'hello' }
      }));

      // Backend should receive it
      const msg = await waitForMessage(backendWs, 'backend_client_message');
      expect(msg.backendId).toBe(backendId);
      expect(msg.payload.action).toBe('test');
    });

    test('should forward backend_server_message to subscribed clients', async () => {
      const clientWs = new WebSocket(WS_URL);
      await waitForOpen(clientWs);
      openClients.push(clientWs);

      await registerClientV2(clientWs);

      clientWs.send(JSON.stringify({
        type: 'subscribe_backend',
        backendId,
      }));

      await waitForMessage(clientWs, 'backend_subscribed');

      // Backend sends a backend_server_message
      backendWs.send(JSON.stringify({
        type: 'backend_server_message',
        backendId,
        payload: { action: 'response', data: 'world' }
      }));

      // Client should receive it
      const msg = await waitForMessage(clientWs, 'backend_server_message');
      expect(msg.backendId).toBe(backendId);
      expect(msg.payload.action).toBe('response');
    });

    test('should ignore session_content_patch with mismatched backendId', async () => {
      const clientWs = new WebSocket(WS_URL);
      await waitForOpen(clientWs);
      openClients.push(clientWs);
      const clientCollector = createMessageCollector(clientWs);

      await registerClientV2(clientWs);

      clientWs.send(JSON.stringify({
        type: 'subscribe_backend',
        backendId,
      }));

      await waitForMessage(clientWs, 'backend_subscribed');

      backendWs.send(JSON.stringify({
        type: 'session_content_patch',
        backendId: 'wrong-backend',
        sessionId: 'session-1',
        messages: [],
        latestOffset: 0,
      }));

      await delay(50);
      expect(clientCollector.find((message) => message.type === 'session_content_patch')).toBeUndefined();
    });

    test('should ignore session_content_patch_error with mismatched backendId', async () => {
      const clientWs = new WebSocket(WS_URL);
      await waitForOpen(clientWs);
      openClients.push(clientWs);
      const clientCollector = createMessageCollector(clientWs);

      await registerClientV2(clientWs);

      clientWs.send(JSON.stringify({
        type: 'subscribe_backend',
        backendId,
      }));

      await waitForMessage(clientWs, 'backend_subscribed');

      backendWs.send(JSON.stringify({
        type: 'session_content_patch_error',
        backendId: 'wrong-backend',
        sessionId: 'session-1',
        afterOffset: 0,
        message: 'boom',
      }));

      await delay(50);
      expect(clientCollector.find((message) => message.type === 'session_content_patch_error')).toBeUndefined();
    });
  });

  describe('HTTP Proxy Response', () => {
    test('should handle http_proxy_response', async () => {
      // Just verify it doesn't throw for non-existent request
      backendWs.send(JSON.stringify({
        type: 'http_proxy_response',
        requestId: 'non-existent-request',
        statusCode: 200,
        headers: {},
        bodyEncoding: 'utf8',
        body: '{}'
      }));

      await delay(50);
    });
  });

  describe('Backend Disconnect', () => {
    test('should notify subscribers via backend_unsubscribed when backend disconnects', async () => {
      const clientWs = new WebSocket(WS_URL);
      await waitForOpen(clientWs);
      openClients.push(clientWs);

      await registerClientV2(clientWs);

      // Subscribe to backend
      clientWs.send(JSON.stringify({
        type: 'subscribe_backend',
        backendId,
      }));

      await waitForMessage(clientWs, 'backend_subscribed');

      // Close backend connection
      await closeWs(backendWs);

      // Client should receive backend_unsubscribed
      const unsubscribed = await waitForMessage(clientWs, 'backend_unsubscribed');
      expect(unsubscribed.backendId).toBe(backendId);
    });
  });

  describe('Ping/Pong', () => {
    test('should respond to ping', async () => {
      // WebSocket library handles pong automatically
      // Just verify connection stays alive
      await delay(100);
      expect(backendWs.readyState).toBe(WebSocket.OPEN);
    });
  });

  describe('Heartbeat', () => {
    test('should respond to backend_heartbeat with heartbeat_ack', async () => {
      backendWs.send(JSON.stringify({
        type: 'backend_heartbeat',
        epoch: backendEpoch
      }));

      const ack = await waitForMessage(backendWs, 'heartbeat_ack');
      expect(ack.epoch).toBe(backendEpoch);
    });
  });
});
