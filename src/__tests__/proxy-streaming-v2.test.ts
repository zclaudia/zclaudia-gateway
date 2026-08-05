import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Server } from 'http';
import net from 'node:net';
import WebSocket from 'ws';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer } from './test-server.js';

const GATEWAY_SECRET = 'test-secret-stream-v2';

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

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', () => resolve());
    ws.close();
  });
}

function waitForMessage<T = any>(ws: WebSocket, type: string, timeoutMs = 1000): Promise<T> {
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

async function registerBackend(ws: WebSocket, name: string) {
  ws.send(JSON.stringify({
    type: 'peer_hello',
    protocolVersion: 3,
    namespace: 'zclaudia',
    clientProtocolVersion: 1,
    peerType: 'client+backend',
    gatewaySecret: GATEWAY_SECRET,
    identity: {
      deviceId: `device-${name}`,
      instanceId: `instance-${name}`,
      channel: 'test',
      name,
    },
    backend: {
      visible: true,
      capabilities: [],
      backendProtocolVersion: 1,
    },
  }));

  const ready = await waitForMessage<{
    type: 'peer_ready';
    backend?: { backendId: string };
  }>(ws, 'peer_ready');

  expect(ready.backend?.backendId).toBeTruthy();
  return ready.backend!.backendId;
}

describe('Gateway Proxy Streaming V2', () => {
  let server: Server;
  let dataDir: string;
  let wsUrl: string;
  let httpUrl: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    previousDataDir = process.env.ZCLAUDIA_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-proxy-v2-'));
    process.env.ZCLAUDIA_DATA_DIR = dataDir;
    server = createGatewayServer({
      gatewaySecret: GATEWAY_SECRET,
      proxyStreamingTimeoutMs: 100,
    });
    ({ wsUrl, httpUrl } = await listenTestServer(server));
  });

  afterEach(async () => {
    await closeTestServer(server);
    if (previousDataDir === undefined) {
      delete process.env.ZCLAUDIA_DATA_DIR;
    } else {
      process.env.ZCLAUDIA_DATA_DIR = previousDataDir;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  testIfLoopback('does not return 502 after http_proxy_response_start begins streaming', async () => {
    const backendWs = new WebSocket(wsUrl);
    await waitForOpen(backendWs);
    const backendId = await registerBackend(backendWs, 'stream-backend');

    backendWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type !== 'http_proxy_request') return;

      backendWs.send(JSON.stringify({
        type: 'http_proxy_response_start',
        requestId: msg.requestId,
        statusCode: 200,
        headers: {
          'content-type': 'text/plain',
        },
      }));
      backendWs.send(JSON.stringify({
        type: 'http_proxy_response_chunk',
        requestId: msg.requestId,
        data: Buffer.from('Hello ').toString('base64'),
      }));
      backendWs.send(JSON.stringify({
        type: 'http_proxy_response_chunk',
        requestId: msg.requestId,
        data: Buffer.from('Gateway').toString('base64'),
      }));
      backendWs.send(JSON.stringify({
        type: 'http_proxy_response_end',
        requestId: msg.requestId,
      }));
    });

    const response = await fetch(`${httpUrl}/api/proxy/${backendId}/stream`, {
      headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('Hello Gateway');

    await closeWs(backendWs);
  });

  testIfLoopback('preserves attachment headers and binary body for streamed downloads', async () => {
    const backendWs = new WebSocket(wsUrl);
    await waitForOpen(backendWs);
    const backendId = await registerBackend(backendWs, 'download-backend');

    backendWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type !== 'http_proxy_request') return;

      backendWs.send(JSON.stringify({
        type: 'http_proxy_response_start',
        requestId: msg.requestId,
        statusCode: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="archive.bin"',
        },
      }));
      backendWs.send(JSON.stringify({
        type: 'http_proxy_response_chunk',
        requestId: msg.requestId,
        data: Buffer.from([0x00, 0x01, 0xfe]).toString('base64'),
      }));
      backendWs.send(JSON.stringify({
        type: 'http_proxy_response_chunk',
        requestId: msg.requestId,
        data: Buffer.from([0xff, 0x41]).toString('base64'),
      }));
      backendWs.send(JSON.stringify({
        type: 'http_proxy_response_end',
        requestId: msg.requestId,
      }));
    });

    const response = await fetch(`${httpUrl}/api/proxy/${backendId}/download`, {
      headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="archive.bin"');
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x41])
    );

    await closeWs(backendWs);
  });

  testIfLoopback('preserves binary request bodies when proxying uploads', async () => {
    const backendWs = new WebSocket(wsUrl);
    await waitForOpen(backendWs);
    const backendId = await registerBackend(backendWs, 'upload-backend');

    const requestPromise = waitForMessage<{
      type: 'http_proxy_request';
      bodyEncoding?: 'utf8' | 'base64';
      body?: string;
    }>(backendWs, 'http_proxy_request');

    const uploadBody = new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x41]);
    const responsePromise = fetch(`${httpUrl}/api/proxy/${backendId}/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GATEWAY_SECRET}`,
        'content-type': 'application/octet-stream',
      },
      body: uploadBody,
    });

    const request = await requestPromise;
    expect(request.bodyEncoding).toBe('base64');
    expect(request.body).toBe(Buffer.from(uploadBody).toString('base64'));

    backendWs.send(JSON.stringify({
      type: 'http_proxy_response',
      requestId: request.requestId,
      statusCode: 204,
      headers: {},
      bodyEncoding: 'utf8',
      body: '',
    }));

    const response = await responsePromise;
    expect(response.status).toBe(204);

    await closeWs(backendWs);
  });

  testIfLoopback('fails the client request when a streaming response stalls after start', async () => {
    const backendWs = new WebSocket(wsUrl);
    await waitForOpen(backendWs);
    const backendId = await registerBackend(backendWs, 'stalled-stream-backend');

    backendWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type !== 'http_proxy_request') return;

      backendWs.send(JSON.stringify({
        type: 'http_proxy_response_start',
        requestId: msg.requestId,
        statusCode: 200,
        headers: {
          'content-type': 'text/plain',
        },
      }));
      backendWs.send(JSON.stringify({
        type: 'http_proxy_response_chunk',
        requestId: msg.requestId,
        data: Buffer.from('partial').toString('base64'),
      }));
      // Intentionally do NOT send http_proxy_response_end — stream stalls
    });

    // fetch() itself resolves (headers arrived), but reading the body should fail
    // because the server destroys the stream after proxyStreamingTimeoutMs (100ms)
    const response = await fetch(`${httpUrl}/api/proxy/${backendId}/stall`, {
      headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
    });
    expect(response.status).toBe(200);

    await expect(response.text()).rejects.toThrow();

    await closeWs(backendWs);
  });
});
