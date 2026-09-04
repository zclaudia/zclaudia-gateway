/**
 * Unit tests for Gateway Client message handling (v2 protocol)
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'http';
import net from 'node:net';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer, issueToken, TEST_ADMIN_TOKEN } from './test-server.js';

// Issued zgb_ token, refreshed for every test server instance.
let GATEWAY_SECRET = '';
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
async function registerBackendV2(ws: WebSocket, identity: { deviceId: string; instanceId: string; name?: string }, visible = true): Promise<{ backendId: string; epoch: number }> {
  ws.send(JSON.stringify({
    type: 'peer_hello',
    protocolVersion: 4,
    namespace: 'zclaudia',
    clientProtocolVersion: 1,
    peerType: 'client+backend',
    gatewaySecret: GATEWAY_SECRET,
    identity,
    backend: { visible, capabilities: [], backendProtocolVersion: 1 }
  }));
  const ready = await waitForMessage(ws, 'peer_ready');
  return { backendId: ready.backend.backendId, epoch: ready.backend.epoch };
}

// Helper: register a client with v2 protocol
async function registerClientV2(ws: WebSocket): Promise<{ peerSessionId: string; registrySync: any }> {
  ws.send(JSON.stringify({
    type: 'peer_hello',
    protocolVersion: 4,
    namespace: 'zclaudia',
    clientProtocolVersion: 1,
    peerType: 'client-only',
    gatewaySecret: GATEWAY_SECRET,
    identity: { deviceId: 'client-dev', instanceId: `client-inst-${Date.now()}-${Math.random()}` }
  }));
  const ready = await waitForMessage(ws, 'peer_ready');
  return { peerSessionId: ready.peerSessionId, registrySync: ready.registrySync };
}

describeIfLoopback('Gateway Client Message Handling', () => {
  let server: Server;
  let backendWs: WebSocket;
  let backendId: string;
  let openClients: WebSocket[] = [];

  beforeEach(async () => {
    server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN });
    ({ wsUrl: WS_URL } = await listenTestServer(server));
    GATEWAY_SECRET = await issueToken(WS_URL, 'backend', 'zclaudia');

    // Register a backend
    backendWs = new WebSocket(WS_URL);
    await waitForOpen(backendWs);
    // Attach a collector so backend messages are drained (return value unused)
    createMessageCollector(backendWs);

    const reg = await registerBackendV2(backendWs, { deviceId: 'test-backend-device', instanceId: 'inst-test-backend-device', name: 'Test Backend' });
    backendId = reg.backendId;
  });

  afterEach(async () => {
    await Promise.all(openClients.map(ws => closeWs(ws)));
    openClients = [];
    await closeWs(backendWs);
    await closeTestServer(server);
  });

  async function connectClient(): Promise<{ ws: WebSocket; collector: ReturnType<typeof createMessageCollector>; registrySync: any }> {
    const clientWs = new WebSocket(WS_URL);
    await waitForOpen(clientWs);
    openClients.push(clientWs);
    const collector = createMessageCollector(clientWs);

    const { registrySync } = await registerClientV2(clientWs);

    return { ws: clientWs, collector, registrySync };
  }

  describe('Gateway Auth', () => {
    test('should receive registry snapshot in peer_ready', async () => {
      const { collector, registrySync } = await connectClient();

      const readyMsg = collector.find(m => m.type === 'peer_ready');
      expect(readyMsg).toBeDefined();
      expect(registrySync).toBeDefined();
      expect(registrySync.items).toBeInstanceOf(Array);
      expect(registrySync.items.length).toBeGreaterThanOrEqual(1);
      const backendEntry = registrySync.items.find((b: any) => b.backendId === backendId);
      expect(backendEntry).toBeDefined();
      expect(backendEntry.name).toBe('Test Backend');
    });

    test('should include hidden backends in registry with visible=false', async () => {
      // Register hidden backend
      const hiddenBackendWs = new WebSocket(WS_URL);
      await waitForOpen(hiddenBackendWs);
      await registerBackendV2(hiddenBackendWs, { deviceId: 'hidden-device', instanceId: 'inst-hidden-device', name: 'Hidden Backend' }, false);

      const { registrySync } = await connectClient();

      const hiddenEntry = registrySync.items.find((b: any) => b.name === 'Hidden Backend');
      expect(hiddenEntry).toBeDefined();
      expect(hiddenEntry.visible).toBe(false);
      expect(registrySync.items.find((b: any) => b.name === 'Test Backend')).toBeDefined();

      await closeWs(hiddenBackendWs);
    });
  });

  describe('Registry Resync', () => {
    test('should return registry snapshot on request_registry_snapshot', async () => {
      const { ws: clientWs } = await connectClient();

      clientWs.send(JSON.stringify({ type: 'request_registry_snapshot' }));

      const snapshot = await waitForMessage(clientWs, 'registry_snapshot');
      expect(snapshot.items).toBeInstanceOf(Array);
      expect(snapshot.items.length).toBeGreaterThanOrEqual(1);
      expect(snapshot.items.find((b: any) => b.backendId === backendId)).toBeDefined();
    });

    test('should reflect backend disconnect in registry', async () => {
      const { ws: clientWs } = await connectClient();

      // Register second backend
      const backendWs2 = new WebSocket(WS_URL);
      await waitForOpen(backendWs2);
      await registerBackendV2(backendWs2, { deviceId: 'second-device', instanceId: 'inst-second-device', name: 'Second Backend' });

      // Close second backend
      await closeWs(backendWs2);
      await delay(200);

      // Request registry snapshot — second backend should be gone
      clientWs.send(JSON.stringify({ type: 'request_registry_snapshot' }));
      const snapshot = await waitForMessage(clientWs, 'registry_snapshot');
      expect(snapshot.items.length).toBe(1);
      expect(snapshot.items[0].backendId).toBe(backendId);
    });
  });

  describe('Unknown Message Types', () => {
    test('should return error for unknown message type', async () => {
      const { ws: clientWs } = await connectClient();

      clientWs.send(JSON.stringify({
        type: 'unknown_message_type',
        data: 'test'
      }));

      const error = await waitForMessage(clientWs, 'gateway_error');
      expect(error.code).toBe('INVALID_MESSAGE');
    });
  });

});
