/**
 * Integration tests for Gateway v2 catalog subscriptions and channel communication.
 *
 * Tests the real createGatewayServer with mock backend/client WebSocket connections.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'http';
import net from 'node:net';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer } from './test-server.js';

const GATEWAY_SECRET = 'test-secret-broadcast';

async function canBindLoopback(): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

const testIfLoopback = (await canBindLoopback()) ? test : test.skip;

/**
 * MessageCollector - collects all messages and provides async waiting.
 * Avoids race conditions by starting collection immediately on registration.
 */
class MessageCollector {
  /** All messages received (never modified — used by findAll) */
  private allMessages: any[] = [];
  /** Unconsumed messages (consumed by waitFor) */
  private unconsumed: any[] = [];
  private waiters: Array<{ type: string; resolve: (msg: any) => void; timer: NodeJS.Timeout }> = [];

  constructor(ws: WebSocket) {
    ws.on('message', (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString());
      this.allMessages.push(msg);

      // Check if any waiter matches — consume directly without adding to unconsumed
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i].type === msg.type) {
          const waiter = this.waiters.splice(i, 1)[0];
          clearTimeout(waiter.timer);
          waiter.resolve(msg);
          return; // consumed by waiter
        }
      }

      // No waiter matched — add to unconsumed queue
      this.unconsumed.push(msg);
    });
  }

  /** Wait for and consume a message of the given type */
  waitFor(type: string, timeoutMs = 1000): Promise<any> {
    // Check if already in unconsumed queue
    const idx = this.unconsumed.findIndex(m => m.type === type);
    if (idx !== -1) {
      return Promise.resolve(this.unconsumed.splice(idx, 1)[0]);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex(w => w.type === type && w.timer === timer);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error(`Timeout waiting for '${type}'. Unconsumed: [${this.unconsumed.map(m => m.type).join(', ')}]`));
      }, timeoutMs);
      this.waiters.push({ type, resolve, timer });
    });
  }

  /** Find all messages (including consumed ones) matching a predicate */
  findAll(predicate: (msg: any) => boolean): any[] {
    return this.allMessages.filter(predicate);
  }
}

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

// Helper: small delay
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const DELIVERY_SETTLE_MS = 20;
const UNSUBSCRIBE_SETTLE_MS = 5;

describe('Gateway v2 backend data relay', () => {
  let server: Server;
  let backendWs: WebSocket;
  let backendCollector: MessageCollector;
  let backendId: string;
  let backendEpoch: number;
  let wsUrl: string;
  let openClients: WebSocket[] = [];

  beforeEach(async () => {
    server = createGatewayServer({ gatewaySecret: GATEWAY_SECRET });
    ({ wsUrl } = await listenTestServer(server));

    // Register a backend
    backendWs = new WebSocket(wsUrl);
    await waitForOpen(backendWs);
    backendCollector = new MessageCollector(backendWs);
    backendWs.send(JSON.stringify({
      type: 'peer_hello',
      protocolVersion: 2,
      peerType: 'client+backend',
      gatewaySecret: GATEWAY_SECRET,
      identity: { deviceId: 'test-device-broadcast', instanceId: 'inst-test-device-broadcast', name: 'Test Backend' },
      backend: { visible: true, capabilities: [] }
    }));
    const regResult = await backendCollector.waitFor('peer_ready');
    backendId = regResult.backend.backendId;
    backendEpoch = regResult.backend.epoch;
  });

  afterEach(async () => {
    await Promise.all(openClients.map(ws => closeWs(ws)));
    openClients = [];
    await closeWs(backendWs);
    await closeTestServer(server);
  });

  async function connectAndSubscribeClient(): Promise<{ ws: WebSocket; collector: MessageCollector }> {
    const clientWs = new WebSocket(wsUrl);
    await waitForOpen(clientWs);
    openClients.push(clientWs);
    const collector = new MessageCollector(clientWs);

    clientWs.send(JSON.stringify({
      type: 'peer_hello',
      protocolVersion: 2,
      peerType: 'client-only',
      gatewaySecret: GATEWAY_SECRET,
      identity: { deviceId: 'client-dev', instanceId: `client-inst-${Date.now()}-${Math.random()}` }
    }));
    await collector.waitFor('peer_ready');

    // Subscribe to backend
    clientWs.send(JSON.stringify({ type: 'subscribe_backend', backendId }));
    await collector.waitFor('backend_subscribed');

    // Backend receives request_backend_data_snapshot — respond with snapshot
    const snapshotRequest = await backendCollector.waitFor('request_backend_data_snapshot');
    expect(snapshotRequest.targetPeerSessionId).toBeTruthy();
    backendWs.send(JSON.stringify({
      type: 'backend_data_snapshot',
      sessions: [{ sessionId: 'sess-1', title: 'Session 1', createdAt: Date.now(), updatedAt: Date.now(), runStatus: 'idle' }],
      projects: [],
    }));
    await collector.waitFor('backend_data_snapshot');

    return { ws: clientWs, collector };
  }

  testIfLoopback('backend_data_snapshot is relayed to subscribers', async () => {
    const clientA = await connectAndSubscribeClient();

    // Backend publishes another snapshot
    backendWs.send(JSON.stringify({
      type: 'backend_data_snapshot',
      sessions: [
        { sessionId: 'sess-1', title: 'Session 1', createdAt: Date.now(), updatedAt: Date.now(), runStatus: 'idle' },
        { sessionId: 'sess-2', title: 'Session 2', createdAt: Date.now(), updatedAt: Date.now(), runStatus: 'running' },
      ],
      projects: [],
    }));

    const snapshot = await clientA.collector.waitFor('backend_data_snapshot');
    expect(snapshot.backendId).toBe(backendId);
    expect(snapshot.sessions).toBeInstanceOf(Array);
    expect(snapshot.sessions.length).toBe(2);
    expect(snapshot.sessions[0].sessionId).toBe('sess-1');
  });

  testIfLoopback('backend_data_event is relayed to subscribers', async () => {
    const clientA = await connectAndSubscribeClient();
    const clientB = await connectAndSubscribeClient();

    // Backend publishes a data event
    backendWs.send(JSON.stringify({
      type: 'backend_data_event',
      op: 'session_upsert',
      item: { sessionId: 'sess-2', title: 'Session 2', createdAt: Date.now(), updatedAt: Date.now(), runStatus: 'idle' },
    }));

    const eventA = await clientA.collector.waitFor('backend_data_event');
    expect(eventA.backendId).toBe(backendId);
    expect(eventA.op).toBe('session_upsert');
    expect(eventA.item.sessionId).toBe('sess-2');

    const eventB = await clientB.collector.waitFor('backend_data_event');
    expect(eventB.backendId).toBe(backendId);
    expect(eventB.op).toBe('session_upsert');
  });

  testIfLoopback('late subscriber receives targeted state heartbeat immediately after snapshot replay', async () => {
    const existingClient = await connectAndSubscribeClient();

    const lateClientWs = new WebSocket(wsUrl);
    await waitForOpen(lateClientWs);
    openClients.push(lateClientWs);
    const lateCollector = new MessageCollector(lateClientWs);

    lateClientWs.send(JSON.stringify({
      type: 'peer_hello',
      protocolVersion: 2,
      peerType: 'client-only',
      gatewaySecret: GATEWAY_SECRET,
      identity: { deviceId: 'late-client-dev', instanceId: `late-client-inst-${Date.now()}-${Math.random()}` }
    }));
    await lateCollector.waitFor('peer_ready');

    lateClientWs.send(JSON.stringify({ type: 'subscribe_backend', backendId }));
    await lateCollector.waitFor('backend_subscribed');

    const snapshotRequest = await backendCollector.waitFor('request_backend_data_snapshot');
    expect(snapshotRequest.targetPeerSessionId).toBeTruthy();

    backendWs.send(JSON.stringify({
      type: 'backend_data_snapshot',
      sessions: [{ sessionId: 'sess-late', title: 'Late Session', createdAt: Date.now(), updatedAt: Date.now(), runStatus: 'waiting' }],
      projects: [],
    }));

    backendWs.send(JSON.stringify({
      type: 'backend_server_message',
      backendId,
      targetPeerSessionId: snapshotRequest.targetPeerSessionId,
      message: {
        type: 'state_heartbeat',
        activeRuns: [],
        pendingPermissions: [],
        pendingQuestions: [{
          requestId: 'ask-late-1',
          sessionId: 'sess-late',
          questions: [{
            header: 'Confirm',
            question: 'Use late replay?',
            options: [
              { label: 'Yes', description: 'Accept' },
              { label: 'No', description: 'Reject' },
            ],
          }],
        }],
      },
    }));

    const snapshot = await lateCollector.waitFor('backend_data_snapshot');
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].sessionId).toBe('sess-late');

    const heartbeat = await lateCollector.waitFor('backend_server_message');
    expect(heartbeat.targetPeerSessionId).toBe(snapshotRequest.targetPeerSessionId);
    expect(heartbeat.message.type).toBe('state_heartbeat');
    expect(heartbeat.message.pendingQuestions).toHaveLength(1);
    expect(heartbeat.message.pendingQuestions[0].requestId).toBe('ask-late-1');

    await delay(DELIVERY_SETTLE_MS);

    const existingHeartbeats = existingClient.collector.findAll(
      (msg) => msg.type === 'backend_server_message'
        && msg.message?.type === 'state_heartbeat'
        && msg.message?.pendingQuestions?.[0]?.requestId === 'ask-late-1'
    );
    expect(existingHeartbeats).toHaveLength(0);
  });

  testIfLoopback('project backend_data_event is relayed to subscribers', async () => {
    const client = await connectAndSubscribeClient();

    backendWs.send(JSON.stringify({
      type: 'backend_data_event',
      op: 'project_upsert',
      item: { projectId: 'proj-2', name: 'Project 2', createdAt: Date.now(), updatedAt: Date.now() },
    }));

    const event = await client.collector.waitFor('backend_data_event');
    expect(event.backendId).toBe(backendId);
    expect(event.op).toBe('project_upsert');
    expect(event.item.projectId).toBe('proj-2');
  });

  testIfLoopback('unsubscribed clients do not receive backend data events', async () => {
    const clientA = await connectAndSubscribeClient();

    // Client B just connects but does NOT subscribe to the backend
    const clientBWs = new WebSocket(wsUrl);
    await waitForOpen(clientBWs);
    openClients.push(clientBWs);
    const clientBCollector = new MessageCollector(clientBWs);
    clientBWs.send(JSON.stringify({
      type: 'peer_hello',
      protocolVersion: 2,
      peerType: 'client-only',
      gatewaySecret: GATEWAY_SECRET,
      identity: { deviceId: 'client-dev', instanceId: `client-inst-nosub-${Date.now()}` }
    }));
    await clientBCollector.waitFor('peer_ready');

    // Backend publishes a data event
    backendWs.send(JSON.stringify({
      type: 'backend_data_event',
      op: 'session_upsert',
      item: { sessionId: 'sess-2', title: 'Session 2', createdAt: Date.now(), updatedAt: Date.now(), runStatus: 'idle' },
    }));

    await delay(DELIVERY_SETTLE_MS);

    const eventsA = clientA.collector.findAll(m => m.type === 'backend_data_event');
    const eventsB = clientBCollector.findAll(m => m.type === 'backend_data_event');

    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(0);
  });

  testIfLoopback('unsubscribe_backend stops backend data event delivery', async () => {
    const client = await connectAndSubscribeClient();

    // Unsubscribe from backend
    client.ws.send(JSON.stringify({ type: 'unsubscribe_backend', backendId }));
    await client.collector.waitFor('backend_unsubscribed');

    await delay(UNSUBSCRIBE_SETTLE_MS);

    // Backend publishes a data event
    backendWs.send(JSON.stringify({
      type: 'backend_data_event',
      op: 'session_upsert',
      item: { sessionId: 'sess-2', title: 'Session 2', createdAt: Date.now(), updatedAt: Date.now(), runStatus: 'idle' },
    }));

    await delay(DELIVERY_SETTLE_MS);

    // Should not have received the event after the initial snapshot
    const events = client.collector.findAll(m => m.type === 'backend_data_event');
    expect(events).toHaveLength(0);
  });
});

describe('Gateway v2 backend subscriptions', () => {
  let server: Server;
  let backendWsA: WebSocket;
  let backendWsB: WebSocket;
  let backendCollectorA: MessageCollector;
  let backendCollectorB: MessageCollector;
  let backendIdA: string;
  let backendEpochA: number;
  let backendIdB: string;
  let backendEpochB: number;
  let wsUrl: string;
  let openClients: WebSocket[] = [];

  beforeEach(async () => {
    server = createGatewayServer({ gatewaySecret: GATEWAY_SECRET });
    ({ wsUrl } = await listenTestServer(server));

    // Register backend A
    backendWsA = new WebSocket(wsUrl);
    await waitForOpen(backendWsA);
    backendCollectorA = new MessageCollector(backendWsA);
    backendWsA.send(JSON.stringify({
      type: 'peer_hello',
      protocolVersion: 2,
      peerType: 'client+backend',
      gatewaySecret: GATEWAY_SECRET,
      identity: { deviceId: 'device-sub-a', instanceId: 'inst-device-sub-a', name: 'Backend A' },
      backend: { visible: true, capabilities: [] }
    }));
    const regA = await backendCollectorA.waitFor('peer_ready');
    backendIdA = regA.backend.backendId;
    backendEpochA = regA.backend.epoch;

    // Register backend B
    backendWsB = new WebSocket(wsUrl);
    await waitForOpen(backendWsB);
    backendCollectorB = new MessageCollector(backendWsB);
    backendWsB.send(JSON.stringify({
      type: 'peer_hello',
      protocolVersion: 2,
      peerType: 'client+backend',
      gatewaySecret: GATEWAY_SECRET,
      identity: { deviceId: 'device-sub-b', instanceId: 'inst-device-sub-b', name: 'Backend B' },
      backend: { visible: true, capabilities: [] }
    }));
    const regB = await backendCollectorB.waitFor('peer_ready');
    backendIdB = regB.backend.backendId;
    backendEpochB = regB.backend.epoch;
  });

  afterEach(async () => {
    await Promise.all(openClients.map(ws => closeWs(ws)));
    openClients = [];
    await closeWs(backendWsA);
    await closeWs(backendWsB);
    await closeTestServer(server);
  });

  async function connectClientWithSubscription(backendId: string): Promise<{ ws: WebSocket; collector: MessageCollector }> {
    const clientWs = new WebSocket(wsUrl);
    await waitForOpen(clientWs);
    openClients.push(clientWs);
    const collector = new MessageCollector(clientWs);

    clientWs.send(JSON.stringify({
      type: 'peer_hello',
      protocolVersion: 2,
      peerType: 'client-only',
      gatewaySecret: GATEWAY_SECRET,
      identity: { deviceId: 'client-dev', instanceId: `client-inst-${Date.now()}-${Math.random()}` }
    }));
    await collector.waitFor('peer_ready');

    // Subscribe to backend
    clientWs.send(JSON.stringify({
      type: 'subscribe_backend',
      backendId,
    }));
    await collector.waitFor('backend_subscribed');

    return { ws: clientWs, collector };
  }

  testIfLoopback('backend_server_message delivers to all subscribers of that backend', async () => {
    const clientA = await connectClientWithSubscription(backendIdA);
    const clientB = await connectClientWithSubscription(backendIdA);

    // Backend A sends a backend_server_message — should go to ALL subscribers
    backendWsA.send(JSON.stringify({
      type: 'backend_server_message',
      backendId: backendIdA,
      payload: { action: 'test', data: 'for all subscribers' }
    }));

    await delay(DELIVERY_SETTLE_MS);

    const msgsA = clientA.collector.findAll(m => m.type === 'backend_server_message' && m.payload?.data === 'for all subscribers');
    const msgsB = clientB.collector.findAll(m => m.type === 'backend_server_message' && m.payload?.data === 'for all subscribers');

    expect(msgsA).toHaveLength(1);
    expect(msgsB).toHaveLength(1);
  });

  testIfLoopback('subscriptions to different backends are independent', async () => {
    const clientSubA = await connectClientWithSubscription(backendIdA);
    const clientSubB = await connectClientWithSubscription(backendIdB);

    // Backend A sends to its subscribers
    backendWsA.send(JSON.stringify({
      type: 'backend_server_message',
      backendId: backendIdA,
      payload: { from: 'A' }
    }));

    // Backend B sends to its subscribers
    backendWsB.send(JSON.stringify({
      type: 'backend_server_message',
      backendId: backendIdB,
      payload: { from: 'B' }
    }));

    await delay(DELIVERY_SETTLE_MS);

    const fromA = clientSubA.collector.findAll(m => m.type === 'backend_server_message' && m.payload?.from === 'A');
    const fromB = clientSubB.collector.findAll(m => m.type === 'backend_server_message' && m.payload?.from === 'B');
    const crossA = clientSubA.collector.findAll(m => m.type === 'backend_server_message' && m.payload?.from === 'B');
    const crossB = clientSubB.collector.findAll(m => m.type === 'backend_server_message' && m.payload?.from === 'A');

    expect(fromA).toHaveLength(1);
    expect(fromB).toHaveLength(1);
    expect(crossA).toHaveLength(0);
    expect(crossB).toHaveLength(0);
  });

  testIfLoopback('unsubscribe_backend stops message delivery', async () => {
    const client = await connectClientWithSubscription(backendIdA);

    // Unsubscribe from backend
    client.ws.send(JSON.stringify({
      type: 'unsubscribe_backend',
      backendId: backendIdA
    }));
    await client.collector.waitFor('backend_unsubscribed');

    // Backend tries to send — should not be delivered
    backendWsA.send(JSON.stringify({
      type: 'backend_server_message',
      backendId: backendIdA,
      payload: { data: 'should not arrive' }
    }));

    await delay(DELIVERY_SETTLE_MS);

    const msgs = client.collector.findAll(m => m.type === 'backend_server_message' && m.payload?.data === 'should not arrive');
    expect(msgs).toHaveLength(0);
  });

  testIfLoopback('registry events notify all peers when a new backend connects', async () => {
    const clientWs = new WebSocket(wsUrl);
    await waitForOpen(clientWs);
    openClients.push(clientWs);
    const collector = new MessageCollector(clientWs);

    clientWs.send(JSON.stringify({
      type: 'peer_hello',
      protocolVersion: 2,
      peerType: 'client-only',
      gatewaySecret: GATEWAY_SECRET,
      identity: { deviceId: 'reg-client', instanceId: 'reg-client-inst' }
    }));
    await collector.waitFor('peer_ready');

    // Register a new backend C
    const backendWsC = new WebSocket(wsUrl);
    await waitForOpen(backendWsC);
    const collectorC = new MessageCollector(backendWsC);
    backendWsC.send(JSON.stringify({
      type: 'peer_hello',
      protocolVersion: 2,
      peerType: 'client+backend',
      gatewaySecret: GATEWAY_SECRET,
      identity: { deviceId: 'device-c', instanceId: 'inst-device-c', name: 'Backend C' },
      backend: { visible: true, capabilities: [] }
    }));
    await collectorC.waitFor('peer_ready');

    // Client should receive a registry_snapshot containing the new backend
    const snapshot = await collector.waitFor('registry_snapshot');
    expect(snapshot.items).toBeInstanceOf(Array);
    const backendC = snapshot.items.find((b: any) => b.name === 'Backend C');
    expect(backendC).toBeDefined();

    await closeWs(backendWsC);
  });
});
