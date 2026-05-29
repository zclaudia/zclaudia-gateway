import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Server } from 'http';
import net from 'node:net';
import WebSocket from 'ws';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer } from './test-server.js';

const GATEWAY_SECRET = 'test-secret-handshake-v2';

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

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function waitForMessage<T = unknown>(ws: WebSocket, type: string, timeoutMs = 1000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout waiting for message type: ${type}`));
    }, timeoutMs);

    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type !== type) return;
      clearTimeout(timer);
      ws.off('message', handler);
      resolve(msg);
    };

    ws.on('message', handler);
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 1000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for websocket close')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

describe('Gateway handshake v2', () => {
  let server: Server;
  let wsUrl: string;
  const sockets = new Set<WebSocket>();

  beforeEach(async () => {
    server = createGatewayServer({ gatewaySecret: GATEWAY_SECRET, authTimeoutMs: 500 });
    ({ wsUrl } = await listenTestServer(server));
  });

  afterEach(async () => {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    }
    sockets.clear();
    await closeTestServer(server);
  });

  testIfLoopback('closes malformed peer_hello instead of leaving the socket unauthenticated', async () => {
    const ws = new WebSocket(wsUrl);
    sockets.add(ws);
    await waitForOpen(ws);

    ws.send(JSON.stringify({
      type: 'peer_hello',
      protocolVersion: 2,
      peerType: 'client+backend',
      gatewaySecret: null,
      identity: { deviceId: 'device-a', instanceId: 'instance-a' },
      backend: { visible: true, capabilities: [] },
    }));

    const error = await waitForMessage<{ type: 'gateway_error'; message: string }>(ws, 'gateway_error');
    expect(error.message).toContain('gatewaySecret');

    const close = await waitForClose(ws);
    expect(close.code).toBe(1008);
  });

  testIfLoopback('accepts valid peer_hello and replies with peer_ready', async () => {
    const ws = new WebSocket(wsUrl);
    sockets.add(ws);
    await waitForOpen(ws);

    ws.send(JSON.stringify({
      type: 'peer_hello',
      protocolVersion: 2,
      peerType: 'client+backend',
      gatewaySecret: GATEWAY_SECRET,
      identity: {
        deviceId: 'device-valid',
        instanceId: 'instance-valid',
        channel: 'test',
        name: 'Valid Backend',
      },
      backend: { visible: true, capabilities: [] },
    }));

    const ready = await waitForMessage<{ type: 'peer_ready'; backend?: { backendId: string } }>(ws, 'peer_ready');
    expect(ready.backend?.backendId).toBeTruthy();

    ws.close();
    await waitForClose(ws);
  });
});
