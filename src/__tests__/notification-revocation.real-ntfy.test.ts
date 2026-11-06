import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer, TEST_ADMIN_TOKEN } from './test-server.js';

// Explicit opt-in: this test uses a real case-owned ntfy instance, never a fetch stub.
const ntfyUrl = process.env.ZODY_P8_REAL_NTFY_URL;
describe.runIf(Boolean(ntfyUrl))('real ntfy credential revocation', () => {
  let server: Server | undefined;
  const sockets: WebSocket[] = [];
  const streams: AbortController[] = [];
  afterEach(async () => {
    streams.forEach(s => s.abort());
    sockets.forEach(s => s.terminate());
    if (server) await closeTestServer(server);
  });

  it('cuts old streams/peers on narrowing and revoke while retained scope can reconnect', async () => {
    expect((await fetch(`${ntfyUrl}/v1/health`)).ok).toBe(true);
    server = createGatewayServer({
      adminToken: TEST_ADMIN_TOKEN,
      notificationConfig: { enabled: true, ntfyUrl, ntfyTopic: `p8-${randomUUID().slice(0, 8)}`, ntfyAuthMode: 'none' },
    });
    const { httpUrl, wsUrl } = await listenTestServer(server);
    const admin = { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, 'Content-Type': 'application/json' };
    const issue = async (body: object) => {
      const response = await fetch(`${httpUrl}/api/admin/credentials`, {method:'POST',headers:admin,body:JSON.stringify(body)});
      expect(response.ok).toBe(true);
      return (await response.json()).data;
    };
    const a = await issue({type:'backend',namespace:'p8',name:'retained'});
    const b = await issue({type:'backend',namespace:'p8',name:'removed'});
    const device = await issue({type:'device',namespace:'p8',name:'phone',allowedBackends:[a.backendId,b.backendId]});
    const headers = {Authorization:`Bearer ${device.token}`};

    async function stream(backendId: string) {
      const abort = new AbortController(); streams.push(abort);
      const response = await fetch(`${httpUrl}/push-${backendId}/json`, {headers,signal:abort.signal});
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder(); let buffer = '';
      return { async next(): Promise<{done:boolean; value?: any}> {
        for (;;) {
          const newline=buffer.indexOf('\n');
          if (newline>=0) {
            const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
            if (line.trim()) return {done:false,value:JSON.parse(line)};
          } else {
            const chunk=await reader.read();
            if(chunk.done)return {done:true};
            buffer+=decoder.decode(chunk.value,{stream:true});
          }
        }
      }};
    }
    async function peer() {
      const ws=new WebSocket(wsUrl); sockets.push(ws);
      await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
      const reply=new Promise<any>((resolve,reject)=>{ws.once('message',d=>resolve(JSON.parse(d.toString())));ws.once('error',reject);});
      const close=new Promise<number>(resolve=>ws.once('close',code=>resolve(code)));
      ws.send(JSON.stringify({type:'peer_hello',protocolVersion:4,namespace:'p8',clientProtocolVersion:1,peerType:'client-only',gatewaySecret:device.token}));
      return {ws,reply:await reply,close};
    }
    async function publish(backendId: string) {
      const r=await fetch(`${httpUrl}/api/notifications/test/${backendId}`,{method:'POST',headers});
      expect(r.status).toBe(200);expect((await r.json()).data.status).toBe('accepted');
    }
    const oldPeer=await peer();expect(oldPeer.reply.type).toBe('peer_ready');
    const sa=await stream(a.backendId);const sb=await stream(b.backendId);
    expect((await sa.next()).value.event).toBe('open');expect((await sb.next()).value.event).toBe('open');
    await publish(a.backendId);await publish(b.backendId);
    expect(JSON.parse((await sa.next()).value.message)).toMatchObject({backendId:a.backendId,kind:'test'});
    expect(JSON.parse((await sb.next()).value.message)).toMatchObject({backendId:b.backendId,kind:'test'});

    expect((await fetch(`${httpUrl}/api/admin/credentials/${device.id}`,{method:'PATCH',headers:admin,body:JSON.stringify({allowedBackends:[a.backendId]})})).ok).toBe(true);
    expect(await oldPeer.close).toBe(1008);
    expect((await sa.next()).done).toBe(true);expect((await sb.next()).done).toBe(true);
    expect((await fetch(`${httpUrl}/api/notifications/subscription/${b.backendId}`,{headers})).status).toBe(404);
    expect((await fetch(`${httpUrl}/push-${b.backendId}/json`,{headers})).status).toBe(404);
    expect((await fetch(`${httpUrl}/api/notifications/test/${b.backendId}`,{method:'POST',headers})).status).toBe(404);
    const kept=await stream(a.backendId);expect((await kept.next()).value.event).toBe('open');
    const newPeer=await peer();expect(newPeer.reply.type).toBe('peer_ready');
    await publish(a.backendId);
    expect(JSON.parse((await kept.next()).value.message)).toMatchObject({backendId:a.backendId,kind:'test'});

    expect((await fetch(`${httpUrl}/api/admin/credentials/${device.id}`,{method:'DELETE',headers:admin})).ok).toBe(true);
    expect(await newPeer.close).toBe(1008);expect((await kept.next()).done).toBe(true);
    for(const path of [`/api/notifications/subscription/${a.backendId}`,`/push-${a.backendId}/json`]) {
      expect((await fetch(httpUrl+path,{headers})).status).toBe(401);
    }
    expect((await fetch(`${httpUrl}/api/notifications/test/${a.backendId}`,{method:'POST',headers})).status).toBe(401);
    // 新握手按现有协议先返回 UNAUTHORIZED 再无状态码关闭；1008 属于存量 peer 撤权。
    const rejected=await peer();
    expect(rejected.reply).toMatchObject({type:'gateway_error',code:'UNAUTHORIZED'});
    expect(await rejected.close).toBe(1005);
  }, 60000);
});
