/**
 * Tests for static notification config exposure and auth.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import type { Server } from 'http';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer } from './test-server.js';

const GATEWAY_SECRET = 'test-secret-notif';
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

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${GATEWAY_SECRET}`,
    'Content-Type': 'application/json',
  };
}

describeIfLoopback('Notification Config', () => {
  let server: Server;

  beforeEach(async () => {
    server = createGatewayServer({
      gatewaySecret: GATEWAY_SECRET,
      notificationConfig: {
        enabled: true,
        ntfyUrl: 'https://ntfy.sh',
        ntfyTopic: 'static-topic',
        ntfyAuthMode: 'bearer',
        ntfyPublishToken: 'publish-token',
        ntfySubscribeToken: 'subscribe-token',
        events: {
          permissionRequest: false,
          promptRequest: true,
          runCompleted: true,
          runFailed: false,
          backgroundPermission: true,
          processLeak: true,
        },
      },
    });
    const urls = await listenTestServer(server);
    HTTP_URL = urls.httpUrl;
  });

  afterEach(async () => {
    await closeTestServer(server);
  });

  describe('GET /api/notifications/config', () => {
    test('returns static config', async () => {
      const res = await fetch(`${HTTP_URL}/api/notifications/config`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({
        enabled: true,
        ntfyUrl: 'https://ntfy.sh',
        ntfyTopic: 'static-topic',
        ntfyAuthMode: 'bearer',
        ntfyPublishToken: 'publish-token',
        ntfySubscribeToken: 'subscribe-token',
      });
      expect(body.data.events.permissionRequest).toBe(false);
      expect(body.data.events.runFailed).toBe(false);
      expect(body.data.events.promptRequest).toBe(true);
    });

    test('requires auth', async () => {
      const res = await fetch(`${HTTP_URL}/api/notifications/config`);
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /api/notifications/config', () => {
    test('is not exposed anymore', async () => {
      const res = await fetch(`${HTTP_URL}/api/notifications/config`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/notifications/test', () => {
    test('requires auth', async () => {
      const res = await fetch(`${HTTP_URL}/api/notifications/test`, { method: 'POST' });
      expect(res.status).toBe(401);
    });
  });
});
