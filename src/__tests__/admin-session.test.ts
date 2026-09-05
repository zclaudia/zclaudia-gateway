/**
 * Admin web UI session login, dual-channel requireAdmin, overview endpoint,
 * and optional /admin static hosting (ADR-0005).
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import type { Server } from 'http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer, issueToken, TEST_ADMIN_TOKEN } from './test-server.js';

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

/** Extract the session id from a Set-Cookie header of the login response. */
function sessionCookieFrom(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  const match = setCookie!.match(/zclaudia_admin_session=([^;]+)/);
  expect(match).toBeTruthy();
  return `zclaudia_admin_session=${match![1]}`;
}

async function login(httpUrl: string, token: string = TEST_ADMIN_TOKEN): Promise<Response> {
  return await fetch(`${httpUrl}/api/admin/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

describeIfLoopback('Admin session login (ADR-0005)', () => {
  let server: Server;
  let httpUrl: string;

  beforeEach(async () => {
    server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN });
    ({ httpUrl } = await listenTestServer(server));
  });

  afterEach(async () => {
    await closeTestServer(server);
  });

  test('correct token issues an HttpOnly SameSite=Strict session cookie', async () => {
    const response = await login(httpUrl);
    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; data: { expiresAt: number } };
    expect(body.success).toBe(true);
    expect(body.data.expiresAt).toBeGreaterThan(Date.now());

    const setCookie = response.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    // Plain-http test server: no Secure flag (would break local dev).
    expect(setCookie).not.toContain('Secure');
  });

  test('wrong token is rejected and counts toward the auth-fail rate limit', async () => {
    for (let i = 0; i < 10; i++) {
      const response = await login(httpUrl, 'wrong-token');
      expect(response.status).toBe(401);
    }
    const limited = await login(httpUrl, 'wrong-token');
    expect(limited.status).toBe(429);
    const body = await limited.json() as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  test('session cookie grants access to the admin credentials API', async () => {
    const loginResponse = await login(httpUrl);
    const cookie = sessionCookieFrom(loginResponse);

    const response = await fetch(`${httpUrl}/api/admin/credentials`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; data: unknown[] };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('GET /api/admin/session reports the active session', async () => {
    const cookie = sessionCookieFrom(await login(httpUrl));
    const response = await fetch(`${httpUrl}/api/admin/session`, { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; data: { expiresAt: number } };
    expect(body.data.expiresAt).toBeGreaterThan(Date.now());
  });

  test('logout destroys the session server-side', async () => {
    const cookie = sessionCookieFrom(await login(httpUrl));

    const logout = await fetch(`${httpUrl}/api/admin/session`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(logout.status).toBe(200);

    const after = await fetch(`${httpUrl}/api/admin/credentials`, { headers: { Cookie: cookie } });
    expect(after.status).toBe(401);
  });

  test('unknown session cookie is rejected on the admin API', async () => {
    const response = await fetch(`${httpUrl}/api/admin/credentials`, {
      headers: { Cookie: 'zclaudia_admin_session=forged-session-id' },
    });
    expect(response.status).toBe(401);
  });

  test('expired sessions are rejected', async () => {
    await closeTestServer(server);
    server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN, adminSessionTtlMs: 50 });
    ({ httpUrl } = await listenTestServer(server));
    const cookie = sessionCookieFrom(await login(httpUrl));

    await new Promise((resolve) => setTimeout(resolve, 120));

    const response = await fetch(`${httpUrl}/api/admin/credentials`, { headers: { Cookie: cookie } });
    expect(response.status).toBe(401);
  });
});

describeIfLoopback('Admin dual-channel auth and CSRF defense (ADR-0005)', () => {
  let server: Server;
  let httpUrl: string;
  let host: string;

  beforeEach(async () => {
    server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN });
    ({ httpUrl } = await listenTestServer(server));
    host = new URL(httpUrl).host;
  });

  afterEach(async () => {
    await closeTestServer(server);
  });

  test('Bearer admin token path still works (CLI compatibility)', async () => {
    const response = await fetch(`${httpUrl}/api/admin/credentials`, {
      headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(response.status).toBe(200);
  });

  test('cookie-authenticated mutation with cross-origin Origin is rejected', async () => {
    const cookie = sessionCookieFrom(await login(httpUrl));
    const response = await fetch(`${httpUrl}/api/admin/credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: 'https://evil.example.com',
      },
      body: JSON.stringify({ type: 'device', namespace: 'zclaudia' }),
    });
    expect(response.status).toBe(403);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  test('cookie-authenticated mutation with same-origin Origin is allowed', async () => {
    const cookie = sessionCookieFrom(await login(httpUrl));
    const response = await fetch(`${httpUrl}/api/admin/credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: `http://${host}`,
      },
      body: JSON.stringify({ type: 'device', namespace: 'zclaudia', name: 'from-web-ui' }),
    });
    expect(response.status).toBe(201);
  });

  test('cookie-authenticated mutation without Origin is rejected (browsers always send it)', async () => {
    const cookie = sessionCookieFrom(await login(httpUrl));
    const response = await fetch(`${httpUrl}/api/admin/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ type: 'device', namespace: 'zclaudia' }),
    });
    expect(response.status).toBe(403);
  });

  test('Bearer mutations do not require an Origin header', async () => {
    const response = await fetch(`${httpUrl}/api/admin/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: JSON.stringify({ type: 'device', namespace: 'zclaudia', name: 'from-cli' }),
    });
    expect(response.status).toBe(201);
  });
});

describeIfLoopback('Admin overview endpoint (ADR-0005)', () => {
  let server: Server;
  let httpUrl: string;

  beforeEach(async () => {
    server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN });
    ({ httpUrl } = await listenTestServer(server));
  });

  afterEach(async () => {
    await closeTestServer(server);
  });

  test('returns credential counters and peer list', async () => {
    // The vitest setup shares one SQLite dir across the whole run, so other
    // test files' credentials may still be in the DB — assert deltas.
    const before = await (await fetch(`${httpUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    })).json() as { data: { credentials: { total: number; active: number; revoked: number; expired: number } } };

    await issueToken(httpUrl, 'device', 'zclaudia');
    await issueToken(httpUrl, 'backend', 'other-ns');

    const response = await fetch(`${httpUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      success: boolean;
      data: {
        backends: number;
        peers: unknown[];
        credentials: { total: number; active: number; revoked: number; expired: number; byType: Record<string, number> };
        uptimeSec: number;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.backends).toBe(0);
    expect(body.data.peers).toEqual([]);
    expect(body.data.credentials.total).toBe(before.data.credentials.total + 2);
    expect(body.data.credentials.active).toBe(before.data.credentials.active + 2);
    expect(body.data.credentials.revoked).toBe(before.data.credentials.revoked);
    expect(body.data.credentials.expired).toBe(before.data.credentials.expired);
    expect(body.data.credentials.byType.device).toBeGreaterThanOrEqual(1);
    expect(body.data.credentials.byType.backend).toBeGreaterThanOrEqual(1);
    expect(body.data.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  test('requires admin auth', async () => {
    const response = await fetch(`${httpUrl}/api/admin/overview`);
    expect(response.status).toBe(401);
  });
});

describeIfLoopback('Admin web UI static hosting (ADR-0005)', () => {
  let staticDir: string;

  beforeEach(() => {
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-admin-ui-'));
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>admin-ui-test</title>');
  });

  afterEach(() => {
    fs.rmSync(staticDir, { recursive: true, force: true });
  });

  test('serves the SPA entry at /admin and redirects / to /admin', async () => {
    const server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN, adminStaticDir: staticDir });
    const { httpUrl } = await listenTestServer(server);
    try {
      const entry = await fetch(`${httpUrl}/admin`);
      expect(entry.status).toBe(200);
      expect(entry.headers.get('content-type')).toContain('text/html');
      expect(await entry.text()).toContain('admin-ui-test');

      const redirect = await fetch(`${httpUrl}/`, { redirect: 'manual' });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get('location')).toBe('/admin');
    } finally {
      await closeTestServer(server);
    }
  });

  test('/admin stays a JSON 404 when adminStaticDir is unset', async () => {
    const server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN });
    const { httpUrl } = await listenTestServer(server);
    try {
      const response = await fetch(`${httpUrl}/admin`);
      expect(response.status).toBe(404);
      const body = await response.json() as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    } finally {
      await closeTestServer(server);
    }
  });
});
