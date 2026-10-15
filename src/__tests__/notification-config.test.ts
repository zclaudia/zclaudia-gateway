/**
 * Tests for static notification config exposure and auth.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import type { Server } from 'http';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer, issueToken, TEST_ADMIN_TOKEN } from './test-server.js';

// Issued zgb_ token, refreshed for every test server instance.
let GATEWAY_SECRET = '';
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
      adminToken: TEST_ADMIN_TOKEN,
      notificationConfig: {
        enabled: true,
        ntfyUrl: 'https://ntfy.sh',
        ntfyTopic: 'static-topic',
        ntfyAuthMode: 'bearer',
        ntfyPublishToken: 'publish-token',
        ntfySubscribeToken: 'subscribe-token',
        eventAllowlist: ['zclaudia.run'],
        eventDenylist: ['zclaudia.run.failed'],
      },
    });
    const urls = await listenTestServer(server);
    GATEWAY_SECRET = await issueToken(urls.httpUrl, 'backend', 'zclaudia');
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
        eventAllowlist: ['zclaudia.run'],
        eventDenylist: ['zclaudia.run.failed'],
      });
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

    test('publishes to the per-backend topic when backendId is provided', async () => {
      // The test's own HTTP call must keep hitting the real server; only
      // outbound ntfy publishes are intercepted.
      const realFetch = globalThis.fetch.bind(globalThis);
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        String(input).startsWith('https://ntfy.sh')
          ? Promise.resolve({ ok: true, status: 200, statusText: 'OK' })
          : realFetch(input, init)
      );
      vi.stubGlobal('fetch', fetchMock);
      try {
        const res = await fetch(`${HTTP_URL}/api/notifications/test`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ backendId: '550e8400-e29b-41d4-a716-446655440000' }),
        });
        expect(res.status).toBe(200);
        const ntfyCalls = fetchMock.mock.calls.filter(([input]) => String(input).startsWith('https://ntfy.sh'));
        expect(ntfyCalls).toHaveLength(1);
        expect(ntfyCalls[0]?.[0]).toBe('https://ntfy.sh/static-topic-550e8400-e29b-41d4-a716-446655440000');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    test('publishes to the base topic without backendId', async () => {
      const realFetch = globalThis.fetch.bind(globalThis);
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        String(input).startsWith('https://ntfy.sh')
          ? Promise.resolve({ ok: true, status: 200, statusText: 'OK' })
          : realFetch(input, init)
      );
      vi.stubGlobal('fetch', fetchMock);
      try {
        const res = await fetch(`${HTTP_URL}/api/notifications/test`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        const ntfyCalls = fetchMock.mock.calls.filter(([input]) => String(input).startsWith('https://ntfy.sh'));
        expect(ntfyCalls).toHaveLength(1);
        expect(ntfyCalls[0]?.[0]).toBe('https://ntfy.sh/static-topic');
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
