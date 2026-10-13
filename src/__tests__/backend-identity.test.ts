/**
 * ADR-0009 step 2: backend identity granted by the backend credential
 * (incl. legacy credentials and in-place binding), device backend scope,
 * and admin cleanup of backend identities.
 */
import { describe, test, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { createGatewayServer } from '../server.js';
import { GatewayStorage } from '../storage.js';
import { closeTestServer, listenTestServer, TEST_ADMIN_TOKEN } from './test-server.js';

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

const ADMIN = { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, 'Content-Type': 'application/json' };

function waitForMessage(ws: WebSocket, type: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for message type: ${type}`)), timeoutMs);
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

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on('close', () => resolve());
    ws.close();
  });
}

describeIfLoopback('ADR-0009: credential-bound backend identity and device scope', () => {
  const servers: Server[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    await Promise.all(sockets.map((ws) => closeWs(ws)));
    sockets.length = 0;
    await Promise.all(servers.map((s) => closeTestServer(s)));
    servers.length = 0;
  });

  async function startServer(storage?: GatewayStorage) {
    const server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN, storage });
    servers.push(server);
    return listenTestServer(server);
  }

  async function api(httpUrl: string, method: string, pathname: string, body?: unknown) {
    const res = await fetch(`${httpUrl}${pathname}`, {
      method,
      headers: ADMIN,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  }

  async function issue(httpUrl: string, body: Record<string, unknown>) {
    const res = await api(httpUrl, 'POST', '/api/admin/credentials', body);
    expect(res.status).toBe(201);
    return res.body.data as { id: string; token: string; backendId: string | null; allowedBackends: string[] | null };
  }

  async function connect(wsUrl: string): Promise<WebSocket> {
    const ws = new WebSocket(wsUrl);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    return ws;
  }

  /** Hello as a backend; `identity` undefined omits it entirely. */
  async function helloBackend(wsUrl: string, token: string, namespace: string, identity?: Record<string, string>) {
    const ws = await connect(wsUrl);
    ws.send(JSON.stringify({
      type: 'peer_hello', protocolVersion: 4, namespace, clientProtocolVersion: 1, peerType: 'client+backend',
      gatewaySecret: token, ...(identity ? { identity } : {}),
      backend: { visible: true, capabilities: [], backendProtocolVersion: 1 },
    }));
    return ws;
  }

  async function registerBackend(wsUrl: string, token: string, namespace: string, identity?: Record<string, string>) {
    const ws = await helloBackend(wsUrl, token, namespace, identity);
    const ready = await waitForMessage(ws, 'peer_ready');
    return { ws, backendId: ready.backend.backendId as string, ready };
  }

  async function connectClient(wsUrl: string, token: string, namespace: string) {
    const ws = await connect(wsUrl);
    ws.send(JSON.stringify({
      type: 'peer_hello', protocolVersion: 4, namespace, clientProtocolVersion: 1, peerType: 'client-only', gatewaySecret: token,
    }));
    const ready = await waitForMessage(ws, 'peer_ready');
    return { ws, ready };
  }

  /** A gateway on its own database plus a raw handle to fake pre-ADR-0009 (legacy) rows. */
  async function startWithDb() {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-adr8-')), 'gateway.db');
    const urls = await startServer(new GatewayStorage(dbPath));
    const raw = new Database(dbPath);
    /** Issue a backend credential, then strip its binding as if issued before ADR-0009. */
    const issueLegacy = async (namespace: string, name: string) => {
      const credential = await issue(urls.httpUrl, { type: 'backend', namespace, name });
      raw.prepare('DELETE FROM backend_identities WHERE backend_id = ?').run(credential.backendId);
      raw.prepare('UPDATE credentials SET backend_id = NULL WHERE id = ?').run(credential.id);
      return credential;
    };
    return { ...urls, issueLegacy };
  }

  describe('backend identity', () => {
    test('a backend credential is its backend: id fixed at issuance, identity optional', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const credential = await issue(httpUrl, { type: 'backend', namespace: 'bind-ns', name: 'svc' });
      expect(credential.backendId).toMatch(/^[0-9a-f-]{36}$/);

      const { backendId, ready } = await registerBackend(wsUrl, credential.token, 'bind-ns');
      expect(backendId).toBe(credential.backendId);
      expect(ready.backend.epoch).toBeGreaterThan(0);

      // Listed before and after going online, with the issuance name
      const backends = await api(httpUrl, 'GET', '/api/admin/backends');
      expect(backends.body.data.find((b: any) => b.backendId === backendId))
        .toMatchObject({ name: 'svc', boundCredentials: 1, online: { epoch: ready.backend.epoch } });
    });

    test('instanceId no longer matters, and the newest connection wins', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const credential = await issue(httpUrl, { type: 'backend', namespace: 'bind-ns' });
      const first = await registerBackend(wsUrl, credential.token, 'bind-ns', { instanceId: 'host-a' });
      const firstClosed = new Promise<void>((resolve) => first.ws.on('close', () => resolve()));

      const second = await registerBackend(wsUrl, credential.token, 'bind-ns', { instanceId: 'host-b' });
      expect(second.backendId).toBe(first.backendId);
      expect(second.ready.backend.epoch).toBeGreaterThan(first.ready.backend.epoch);
      await firstClosed;
    });

    test('exchanged access tokens inherit the backendId', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const credential = await issue(httpUrl, { type: 'backend', namespace: 'bind-ns' });
      const res = await fetch(`${httpUrl}/api/backend/token`, { method: 'POST', headers: { Authorization: `Bearer ${credential.token}` } });
      const access = (await res.json()).data;
      const { backendId } = await registerBackend(wsUrl, access.token, 'bind-ns');
      expect(backendId).toBe(credential.backendId);
    });

    test('rotation: a new credential can inherit an existing identity', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const old = await issue(httpUrl, { type: 'backend', namespace: 'bind-ns' });
      const rotated = await issue(httpUrl, { type: 'backend', namespace: 'bind-ns', backendId: old.backendId });
      expect(rotated.backendId).toBe(old.backendId);
      await api(httpUrl, 'DELETE', `/api/admin/credentials/${old.id}`);
      const { backendId } = await registerBackend(wsUrl, rotated.token, 'bind-ns');
      expect(backendId).toBe(old.backendId);

      // Unknown or cross-namespace identities, or backendId on a device, are rejected
      const other = await issue(httpUrl, { type: 'backend', namespace: 'other-ns' });
      for (const body of [
        { type: 'backend', namespace: 'bind-ns', backendId: 'nope' },
        { type: 'backend', namespace: 'bind-ns', backendId: other.backendId },
        { type: 'device', namespace: 'bind-ns', backendId: old.backendId },
      ]) {
        expect((await api(httpUrl, 'POST', '/api/admin/credentials', body)).status).toBe(400);
      }
    });

    test('legacy credentials keep the instanceId mapping and require an instanceId', async () => {
      const { wsUrl, issueLegacy } = await startWithDb();
      const legacy = await issueLegacy('legacy-ns', 'old-host');

      const a = await registerBackend(wsUrl, legacy.token, 'legacy-ns', { instanceId: 'inst-1' });
      await closeWs(a.ws);
      const again = await registerBackend(wsUrl, legacy.token, 'legacy-ns', { instanceId: 'inst-1' });
      expect(again.backendId).toBe(a.backendId);
      const other = await registerBackend(wsUrl, legacy.token, 'legacy-ns', { instanceId: 'inst-2' });
      expect(other.backendId).not.toBe(a.backendId);

      const missing = await helloBackend(wsUrl, legacy.token, 'legacy-ns');
      expect((await waitForMessage(missing, 'gateway_error')).code).toBe('INVALID_MESSAGE');
    });

    test('binding a legacy credential in place keeps its backendId', async () => {
      const { wsUrl, httpUrl, issueLegacy } = await startWithDb();
      const legacy = await issueLegacy('legacy-ns', 'old-host');
      const before = await registerBackend(wsUrl, legacy.token, 'legacy-ns', { instanceId: 'inst-1' });
      await closeWs(before.ws);

      // Evidence points at the legacy credential; the identity is not bound yet
      const listed = (await api(httpUrl, 'GET', '/api/admin/backends')).body.data.find((b: any) => b.backendId === before.backendId);
      expect(listed).toMatchObject({ lastCredentialId: legacy.id, boundCredentials: 0 });
      const overview = (await api(httpUrl, 'GET', '/api/admin/overview')).body.data;
      expect(overview.legacyBackendCredentials).toBe(1);

      expect((await api(httpUrl, 'POST', `/api/admin/credentials/${legacy.id}/bind`, { backendId: 'nope' })).status).toBe(400);
      const bound = await api(httpUrl, 'POST', `/api/admin/credentials/${legacy.id}/bind`, { backendId: before.backendId });
      expect(bound.status).toBe(200);
      expect(bound.body.data.backendId).toBe(before.backendId);
      expect((await api(httpUrl, 'POST', `/api/admin/credentials/${legacy.id}/bind`, { backendId: before.backendId })).status).toBe(409);

      // Same token, now credential-bound: instanceId is irrelevant
      const after = await registerBackend(wsUrl, legacy.token, 'legacy-ns', { instanceId: 'something-else' });
      expect(after.backendId).toBe(before.backendId);
      expect((await api(httpUrl, 'GET', '/api/admin/overview')).body.data.legacyBackendCredentials).toBe(0);
    });
  });

  describe('device backend scope', () => {
    async function twoBackends(wsUrl: string, httpUrl: string) {
      const a = await issue(httpUrl, { type: 'backend', namespace: 'scope-ns', name: 'a' });
      const b = await issue(httpUrl, { type: 'backend', namespace: 'scope-ns', name: 'b' });
      const backendA = await registerBackend(wsUrl, a.token, 'scope-ns');
      const backendB = await registerBackend(wsUrl, b.token, 'scope-ns');
      return { a: a.backendId!, b: b.backendId!, backendA, backendB };
    }

    test('a scoped device sees and reaches only its backends', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const { a, b } = await twoBackends(wsUrl, httpUrl);
      const device = await issue(httpUrl, { type: 'device', namespace: 'scope-ns', allowedBackends: [a] });
      expect(device.allowedBackends).toEqual([a]);

      const { ws, ready } = await connectClient(wsUrl, device.token, 'scope-ns');
      expect(ready.registrySync.items.map((i: any) => i.backendId)).toEqual([a]);

      ws.send(JSON.stringify({ type: 'request_registry_snapshot' }));
      expect((await waitForMessage(ws, 'registry_snapshot')).items.map((i: any) => i.backendId)).toEqual([a]);

      ws.send(JSON.stringify({ type: 'channel_open', target: b }));
      expect((await waitForMessage(ws, 'gateway_error')).code).toBe('BACKEND_OFFLINE');
      ws.send(JSON.stringify({ type: 'topic_subscribe', backendId: b, topic: 't' }));
      expect((await waitForMessage(ws, 'gateway_error')).code).toBe('BACKEND_OFFLINE');
      ws.send(JSON.stringify({ type: 'topic_subscribe', backendId: a, topic: 't' }));
      expect((await waitForMessage(ws, 'topic_subscribed')).backendId).toBe(a);

      const proxied = await fetch(`${httpUrl}/api/proxy/${b}/x`, { headers: { Authorization: `Bearer ${device.token}` } });
      expect(proxied.status).toBe(502);
      expect((await proxied.json()).error.code).toBe('BACKEND_OFFLINE');

      // An unscoped device in the same namespace still sees both
      const open = await issue(httpUrl, { type: 'device', namespace: 'scope-ns' });
      const unscoped = await connectClient(wsUrl, open.token, 'scope-ns');
      expect(unscoped.ready.registrySync.items.map((i: any) => i.backendId).sort()).toEqual([a, b].sort());
    });

    test('scope is validated at issuance', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const { a } = await twoBackends(wsUrl, httpUrl);
      const other = await issue(httpUrl, { type: 'backend', namespace: 'other-ns' });
      for (const body of [
        { type: 'device', namespace: 'scope-ns', allowedBackends: [] },
        { type: 'device', namespace: 'scope-ns', allowedBackends: ['nope'] },
        { type: 'device', namespace: 'scope-ns', allowedBackends: [other.backendId] },
        { type: 'device', namespace: 'scope-ns', allowedBackends: 'all' },
        { type: 'backend', namespace: 'scope-ns', allowedBackends: [a] },
      ]) {
        expect((await api(httpUrl, 'POST', '/api/admin/credentials', body)).status).toBe(400);
      }
    });

    test('changing the scope disconnects the device so the new scope applies', async () => {
      const { wsUrl, httpUrl } = await startServer();
      const { a, b } = await twoBackends(wsUrl, httpUrl);
      const device = await issue(httpUrl, { type: 'device', namespace: 'scope-ns', allowedBackends: [a] });
      const { ws } = await connectClient(wsUrl, device.token, 'scope-ns');
      const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));

      const patched = await api(httpUrl, 'PATCH', `/api/admin/credentials/${device.id}`, { allowedBackends: null });
      expect(patched.status).toBe(200);
      expect(patched.body.data.allowedBackends).toBeNull();
      expect(await closed).toBe(1008);

      const again = await connectClient(wsUrl, device.token, 'scope-ns');
      expect(again.ready.registrySync.items.map((i: any) => i.backendId).sort()).toEqual([a, b].sort());

      const backendCred = (await api(httpUrl, 'GET', '/api/admin/credentials')).body.data.find((c: any) => c.backendId === a);
      expect((await api(httpUrl, 'PATCH', `/api/admin/credentials/${backendCred.id}`, { allowedBackends: null })).status).toBe(409);
      expect((await api(httpUrl, 'PATCH', `/api/admin/credentials/${device.id}`, {})).status).toBe(400);
    });
  });

  describe('backend identity cleanup', () => {
    test('deleting is refused while anything may still resolve to the identity', async () => {
      const { wsUrl, httpUrl, issueLegacy } = await startWithDb();
      const credential = await issue(httpUrl, { type: 'backend', namespace: 'gc-ns' });
      const { ws, backendId } = await registerBackend(wsUrl, credential.token, 'gc-ns');

      expect((await api(httpUrl, 'DELETE', '/api/admin/backends/nope')).status).toBe(404);
      expect((await api(httpUrl, 'DELETE', `/api/admin/backends/${backendId}`)).status).toBe(409); // online
      await closeWs(ws);
      await new Promise((r) => setTimeout(r, 50));
      expect((await api(httpUrl, 'DELETE', `/api/admin/backends/${backendId}`)).status).toBe(409); // bound credential
      await api(httpUrl, 'DELETE', `/api/admin/credentials/${credential.id}`);
      expect((await api(httpUrl, 'DELETE', `/api/admin/backends/${backendId}`)).status).toBe(200);
      expect((await api(httpUrl, 'GET', '/api/admin/backends')).body.data.some((b: any) => b.backendId === backendId)).toBe(false);

      // A legacy identity whose last registering credential is still active is kept
      const legacy = await issueLegacy('gc-ns', 'old');
      const legacyBackend = await registerBackend(wsUrl, legacy.token, 'gc-ns', { instanceId: 'drift-1' });
      await closeWs(legacyBackend.ws);
      await new Promise((r) => setTimeout(r, 50));
      expect((await api(httpUrl, 'DELETE', `/api/admin/backends/${legacyBackend.backendId}`)).status).toBe(409);
    });
  });
});
