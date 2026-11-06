import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer, TEST_ADMIN_TOKEN } from './test-server.js';

describe('scoped notification stream', () => {
  let server: Server;
  afterEach(async () => { vi.unstubAllGlobals(); if (server) await closeTestServer(server); });
  it('never returns ntfy secrets and aborts streams on device revoke', async () => {
    server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN, notificationConfig: { enabled: true, ntfyUrl: 'https://ntfy.example.invalid', ntfyTopic: 'alerts', ntfyAuthMode: 'bearer', ntfyPublishToken: 'publish-secret', ntfySubscribeToken: 'read-secret' } });
    const { httpUrl } = await listenTestServer(server);
    const issue = async (body: object) => (await (await fetch(`${httpUrl}/api/admin/credentials`, { method: 'POST', headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()).data;
    const backend = await issue({ type: 'backend', namespace: 'zody', name: 'computer' });
    const other = await issue({ type: 'backend', namespace: 'other', name: 'other' });
    const device = await issue({ type: 'device', namespace: 'zody', name: 'phone', allowedBackends: [backend.backendId] });
    const headers = { Authorization: `Bearer ${device.token}` };
    const path = `/api/notifications/subscription/${backend.backendId}`;
    expect((await fetch(httpUrl + path)).status).toBe(401);
    expect((await fetch(`${httpUrl}/api/notifications/subscription/${other.backendId}`, { headers })).status).toBe(404);
    const config = await (await fetch(httpUrl + path, { headers })).json();
    expect(config.data).toEqual({ version: 1, enabled: true, transportBasePath: '', topic: `push-${backend.backendId}`, authMode: 'bearer' });
    const legacy = await (await fetch(`${httpUrl}/api/notifications/config`, { headers })).json();
    expect(JSON.stringify(legacy)).not.toContain('secret');
    let upstreamSignal: AbortSignal | undefined;
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((url, init) => {
      if (String(url).startsWith('https://ntfy.example.invalid')) {
        upstreamSignal = init?.signal;
        expect(init.headers.Authorization).toBe('Bearer read-secret');
        return Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"event":"open"}\n\n')); upstreamSignal?.addEventListener('abort', () => controller.close()); } })));
      }
      return realFetch(url, init);
    }));
    const stream = await fetch(`${httpUrl}/push-${backend.backendId}/sse`, { headers });
    const reader = stream.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect((await fetch(`${httpUrl}/api/admin/credentials/${device.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` } })).ok).toBe(true);
    expect((await reader.read()).done).toBe(true);
    expect(upstreamSignal?.aborted).toBe(true);
    expect((await fetch(httpUrl + path, { headers })).status).toBe(401);
  });
  it('scopes diagnostic pushes and returns an upstream receipt without task content', async () => {
    server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN, notificationConfig: { enabled: true, ntfyUrl: 'https://ntfy.example.invalid', ntfyTopic: 'alerts' } });
    const { httpUrl } = await listenTestServer(server);
    const issue = async (body: object) => (await (await fetch(`${httpUrl}/api/admin/credentials`, {method:'POST',headers:{Authorization:`Bearer ${TEST_ADMIN_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(body)})).json()).data;
    const backend = await issue({type:'backend',namespace:'zody',name:'computer'});
    const other = await issue({type:'backend',namespace:'other',name:'computer'});
    const device = await issue({type:'device',namespace:'zody',name:'phone',allowedBackends:[backend.backendId]});
    const headers = {Authorization:`Bearer ${device.token}`};
    expect((await fetch(`${httpUrl}/api/notifications/test/${other.backendId}`,{method:'POST',headers})).status).toBe(404);
    expect((await fetch(`${httpUrl}/api/notifications/test`,{method:'POST',headers})).status).toBe(400);
    expect((await fetch(`${httpUrl}/api/notifications/test`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({backendId:other.backendId})})).status).toBe(404);
    let envelope: any;
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((url, init) => {
      if (String(url).startsWith('https://ntfy.example.invalid')) {
        envelope=JSON.parse(init.body);
        return Promise.resolve(new Response('{}',{status:200}));
      }
      return realFetch(url,init);
    }));
    const result = await (await fetch(`${httpUrl}/api/notifications/test/${backend.backendId}`,{method:'POST',headers})).json();
    expect(result).toMatchObject({success:true,data:{status:'accepted'}});
    expect(envelope).toMatchObject({version:1,backendId:backend.backendId,kind:'test'});
    expect(Object.keys(envelope).sort()).toEqual(['backendId','expiresAt','kind','notificationId','version']);
  });

  it('closes an existing peer and ntfy stream when device scope is narrowed', async () => {
    server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN, notificationConfig: { enabled: true, ntfyUrl: 'https://ntfy.example.invalid', ntfyTopic: 'alerts' } });
    const { httpUrl, wsUrl } = await listenTestServer(server);
    const admin = { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` };
    const issue = async (body: object) => (await (await fetch(`${httpUrl}/api/admin/credentials`, { method: 'POST', headers: { ...admin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()).data;
    const allowed = await issue({ type: 'backend', namespace: 'zody', name: 'allowed' });
    const removed = await issue({ type: 'backend', namespace: 'zody', name: 'removed' });
    const device = await issue({ type: 'device', namespace: 'zody', name: 'phone', allowedBackends: [allowed.backendId, removed.backendId] });
    let upstreamSignal: AbortSignal | undefined;
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((url, init) => {
      if (String(url).startsWith('https://ntfy.example.invalid')) {
        upstreamSignal = init?.signal;
        return Promise.resolve(new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {}\\n\\n')); upstreamSignal?.addEventListener('abort', () => c.close()); } })));
      }
      return realFetch(url, init);
    }));
    const stream = await fetch(`${httpUrl}/push-${allowed.backendId}/sse`, { headers: { Authorization: `Bearer ${device.token}` } });
    const reader = stream.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'peer_hello', protocolVersion: 4, namespace: 'zody', clientProtocolVersion: 1, peerType: 'client-only', gatewaySecret: device.token }));
    await new Promise<void>((resolve, reject) => { ws.once('message', (data) => JSON.parse(data.toString()).type === 'peer_ready' ? resolve() : undefined); ws.once('error', reject); });
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    expect((await fetch(`${httpUrl}/api/admin/credentials/${device.id}`, { method: 'PATCH', headers: { ...admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ allowedBackends: [allowed.backendId] }) })).ok).toBe(true);
    expect(await closed).toBe(1008);
    expect((await reader.read()).done).toBe(true);
    expect(upstreamSignal?.aborted).toBe(true);
    expect((await fetch(`${httpUrl}/api/notifications/subscription/${removed.backendId}`, { headers: { Authorization: `Bearer ${device.token}` } })).status).toBe(404);
    ws.terminate();
  });

});
