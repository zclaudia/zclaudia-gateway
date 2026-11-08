/**
 * Connection capacity & slow-consumer verification — a self-contained load
 * harness for the gateway. Boots an isolated gateway (ephemeral port, temp
 * SQLite database, its own admin token and credentials — nothing touches a
 * real deployment), echoes traffic through real SDK backends and clients,
 * and writes a markdown report.
 *
 * Run: pnpm capacity [--duration-ms=12000] [--backends=3] [--devices=6]
 *                    [--channels-per-device=2] [--frame-bytes=65536]
 *                    [--slow-mib=32] [--out=<file>]
 *
 * CI never runs this (bounded behavioral regressions live in
 * src/__tests__/capacity-regression.test.ts). Numbers reported here are
 * samples from one machine and one process — see the report's caveats.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { createGatewayServer } from '../src/server.js';
import { GatewayStorage } from '../src/storage.js';
// Workspace SDKs via source paths: the root package does not depend on them
// (only the gateway server does on the protocol package), and running the
// harness against the current sources is the point.
import { GatewayBackend } from '../packages/backend/src/index.js';
import { GatewayClient, type GatewayChannel } from '../packages/client/src/index.js';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  const match = /^--([a-z-]+)=(.*)$/i.exec(arg);
  if (match) args.set(match[1], match[2]);
}
const num = (name: string, fallback: number): number => {
  const value = Number(args.get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const OPTS = {
  durationMs: num('duration-ms', 12_000),
  backends: num('backends', 3),
  devices: num('devices', 6),
  channelsPerDevice: num('channels-per-device', 2),
  frameBytes: num('frame-bytes', 64 * 1024),
  slowMib: num('slow-mib', 32),
  out: args.get('out'),
};

const ADMIN_TOKEN = `capacity-${Date.now().toString(36)}`;
const NAMESPACE = 'capacity';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Condition not met in time: ${what}`);
    await sleep(20);
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

const fmtBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
};

/** Raw control connection: hello, then wait for peer_ready. `wsUrl` is the base (no path). */
async function rawControlConnect(wsUrl: string, token: string, deviceId: string): Promise<{ ws: WebSocket; peerReady: Record<string, unknown> }> {
  const ws = new WebSocket(`${wsUrl}/ws`);
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const readyPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('raw control handshake timeout')), 5000);
    ws.once('message', (data: Buffer) => {
      clearTimeout(timer);
      const msg = JSON.parse(data.toString());
      if (msg.type === 'peer_ready') resolve(msg);
      else reject(new Error(`expected peer_ready, got ${msg.type}`));
    });
  });
  ws.send(JSON.stringify({
    type: 'peer_hello', protocolVersion: 4, namespace: NAMESPACE, clientProtocolVersion: 1,
    peerType: 'client-only', gatewaySecret: token,
    identity: { deviceId, instanceId: deviceId },
  }));
  const peerReady = await readyPromise;
  return { ws, peerReady };
}

function rawWaitMessage(ws: WebSocket, type: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    const handler = (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) { clearTimeout(timer); ws.off('message', handler); resolve(msg); }
      } catch { /* not JSON */ }
    };
    ws.on('message', handler);
  });
}

// ---------------------------------------------------------------------------
// Monitor: admin-overview counters + process memory, sampled periodically
// ---------------------------------------------------------------------------

interface MonitorSample { t: number; peers: number; channels: number; rss: number; heapUsed: number }

class Monitor {
  readonly samples: MonitorSample[] = [];
  maxPeers = 0;
  maxChannels = 0;
  stopped = false;
  private readonly httpUrl: string;

  constructor(httpUrl: string) { this.httpUrl = httpUrl; }

  start(intervalMs = 500): void {
    const tick = async () => {
      while (!this.stopped) {
        if (!this.stopped) {
          try {
            const res = await fetch(`${this.httpUrl}/api/admin/overview`, {
              headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
            });
            const body = await res.json() as { data: { peers: unknown[]; diagnostics: { channels: number } } };
            const mem = process.memoryUsage();
            this.samples.push({
              t: Date.now(),
              peers: body.data.peers.length,
              channels: body.data.diagnostics.channels,
              rss: mem.rss,
              heapUsed: mem.heapUsed,
            });
            this.maxPeers = Math.max(this.maxPeers, body.data.peers.length);
            this.maxChannels = Math.max(this.maxChannels, body.data.diagnostics.channels);
          } catch { /* server shutting down */ }
        }
        await sleep(intervalMs);
      }
    };
    void tick();
  }

  snapshot(): { peers: number; channels: number } {
    const last = this.samples[this.samples.length - 1];
    return last ? { peers: last.peers, channels: last.channels } : { peers: -1, channels: -1 };
  }

  stop(): void { this.stopped = true; }
}

// ---------------------------------------------------------------------------
// Traffic: one channel running text/binary echo with RTT probes
// ---------------------------------------------------------------------------

interface ChannelStats { messages: number; bytes: number; rtts: number[] }

/** Traffic phases: 'sustained' pumps, 'paused' holds, 'stopped' ends the pump timers. */
type Phase = 'sustained' | 'paused' | 'stopped';

function runEchoTraffic(channel: GatewayChannel, frameBytes: number, phase: () => Phase): ChannelStats {
  const stats: ChannelStats = { messages: 0, bytes: 0, rtts: [] };
  const binary = new Uint8Array(frameBytes);
  let seq = 0;
  const pending = new Map<number, number>(); // probe seq -> send time
  channel.onMessage((message) => {
    stats.messages++;
    if (message.binary) {
      stats.bytes += (message.data as Uint8Array).byteLength;
    } else {
      stats.bytes += message.data.length;
      try {
        const probe = JSON.parse(message.data as string) as { p?: number };
        if (probe.p !== undefined && pending.has(probe.p)) {
          stats.rtts.push(performance.now() - pending.get(probe.p)!);
          pending.delete(probe.p);
        }
      } catch { /* non-probe text frame */ }
    }
  });
  const pump = () => {
    // Free-running but cooperative: burst while allowed, then yield. The
    // timer chain ends for good once the phase turns 'stopped'.
    if (phase() === 'stopped') return;
    for (let i = 0; i < 16 && phase() === 'sustained'; i++) {
      if (seq % 20 === 10) {
        pending.set(seq, performance.now());
        channel.send(JSON.stringify({ p: seq, t: performance.now() }));
      } else if (seq % 2 === 0) {
        channel.send(binary);
      } else {
        channel.send(JSON.stringify({ seq }));
      }
      seq++;
    }
    setTimeout(pump, 5);
  };
  pump();
  return stats;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // The in-process gateway writes [audit] lines via console.log; keep
  // stdout clean so it carries only the report.
  console.log = (...values: unknown[]) => { console.error(...values); };
  const conditions = {
    date: new Date().toISOString(),
    node: process.version,
    platform: `${os.platform()} ${os.arch()} · ${os.cpus()[0]?.model ?? 'unknown cpu'} · ${os.cpus().length} cores`,
    opts: { ...OPTS },
    gateway: {
      inProcess: true,
      maxWsConnectionsPerIp: 0, // harness-only: this script holds many control connections itself
      maxChannelsPerPeer: 32,   // gateway default
      perChannelHighWater: '4 MiB (server.ts wireChannel)',
      wsMaxPayload: '50 MiB (control) / 64 MiB (channel)',
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zclaudia-capacity-'));
  const storage = new GatewayStorage(path.join(tmpDir, 'gateway.db'));
  const server = createGatewayServer({ adminToken: ADMIN_TOKEN, storage, maxWsConnectionsPerIp: 0 });
  const backends: GatewayBackend[] = [];
  const clients: GatewayClient[] = [];
  const rawSockets: WebSocket[] = [];
  let monitor: Monitor | null = null;

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no listen address');
    const httpUrl = `http://127.0.0.1:${address.port}`;
    const wsUrl = `ws://127.0.0.1:${address.port}`;
    console.error(`[capacity] gateway on ${httpUrl} (temp db: ${tmpDir})`);

    const admin = { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' };
    const issue = async (type: 'device' | 'backend', name: string): Promise<{ token: string; backendId?: string }> => {
      const res = await fetch(`${httpUrl}/api/admin/credentials`, {
        method: 'POST', headers: admin, body: JSON.stringify({ type, namespace: NAMESPACE, name }),
      });
      if (!res.ok) throw new Error(`credential issue failed: ${res.status}`);
      return (await res.json()).data;
    };

    // --- Independent echo backends ---
    const backendIds: string[] = [];
    for (let i = 0; i < OPTS.backends; i++) {
      const { token } = await issue('backend', `echo-${i}`);
      const backend = new GatewayBackend({
        url: httpUrl, credential: token, namespace: NAMESPACE,
        identity: { instanceId: `echo-${i}`, name: `echo-${i}` },
        heartbeatIntervalMs: 5000,
      });
      backend.onChannel('echo', (channel) => {
        channel.onMessage((message) => channel.send(message.data));
      });
      backends.push(backend);
      const { backendId } = await backend.connect();
      backendIds.push(backendId);
    }
    console.error(`[capacity] ${backends.length} echo backends online`);

    const deviceCred = await issue('device', 'capacity-devices');
    monitor = new Monitor(httpUrl);
    monitor.start();

    // --- Devices × channels, sustained echo traffic ---
    const channels: GatewayChannel[] = [];
    const stats: ChannelStats[] = [];
    let phase: Phase = 'sustained';
    const phaseRef = () => phase;
    for (let d = 0; d < OPTS.devices; d++) {
      const client = new GatewayClient({
        url: httpUrl, credential: deviceCred.token, namespace: NAMESPACE,
        identity: { deviceId: `device-${d}`, name: `device-${d}` },
      });
      clients.push(client);
      await client.connect();
      for (let c = 0; c < OPTS.channelsPerDevice; c++) {
        const backendId = backendIds[(d * OPTS.channelsPerDevice + c) % backendIds.length];
        const channel = await client.openChannel(backendId, 'echo');
        channels.push(channel);
        stats.push(runEchoTraffic(channel, OPTS.frameBytes, phaseRef));
      }
    }
    console.error(`[capacity] ${OPTS.devices} devices · ${channels.length} channels ready`);

    const sustainedStart = performance.now();
    await sleep(OPTS.durationMs);
    phase = 'paused';
    const sustainedMs = performance.now() - sustainedStart;

    const sustainedTotals = stats.reduce((acc, s) => ({
      messages: acc.messages + s.messages, bytes: acc.bytes + s.bytes, rtts: [...acc.rtts, ...s.rtts],
    }), { messages: 0, bytes: 0, rtts: [] as number[] });
    const sustainedRtts = sustainedTotals.rtts.slice().sort((a, b) => a - b);
    const sustainedMsgsPerSec = sustainedTotals.messages / (sustainedMs / 1000);
    console.error(`[capacity] sustained: ${sustainedTotals.messages} msgs, ${fmtBytes(sustainedTotals.bytes)}, rtt p50=${percentile(sustainedRtts, 50).toFixed(1)}ms`);

    // --- Slow consumer: a raw client whose data socket never reads ---
    console.error('[capacity] slow-consumer: dialing control connection');
    const slowCtl = (await rawControlConnect(wsUrl, deviceCred.token, 'slow-consumer')).ws;
    rawSockets.push(slowCtl);
    console.error('[capacity] slow-consumer: control connected, opening channel');
    slowCtl.send(JSON.stringify({ type: 'channel_open', target: backendIds[0], kind: 'echo' }));
    const slowReady = await rawWaitMessage(slowCtl, 'channel_ready') as { channelId: string; ticket: string; dataPath: string };
    console.error('[capacity] slow-consumer: channel_ready received, dialing data socket');
    const slowSocket = new WebSocket(`${wsUrl}${slowReady.dataPath}?ticket=${slowReady.ticket}`);
    rawSockets.push(slowSocket);
    await new Promise<void>((resolve, reject) => { slowSocket.once('open', resolve); slowSocket.once('error', reject); });
    slowSocket.pause(); // the consumer stops reading
    console.error('[capacity] slow-consumer: paused, injecting backlog');

    const SLOW_BYTES = OPTS.slowMib * 1024 * 1024;
    const slowFrame = Buffer.alloc(1024 * 1024, 0xab);
    for (let i = 0; i < SLOW_BYTES / slowFrame.length; i++) slowSocket.send(slowFrame);
    let slowReceived = 0;
    slowSocket.on('message', (data: Buffer) => { slowReceived += data.length; });

    // Normal traffic keeps running through the stall window.
    const beforeStall = stats.map((s) => ({ messages: s.messages, bytes: s.bytes }));
    phase = 'sustained';
    const stallStart = performance.now();
    await sleep(3000);
    const stallMs = performance.now() - stallStart;
    phase = 'paused';
    const stalled = slowReceived < SLOW_BYTES;
    const duringStallTotals = stats.reduce((acc, s, i) => ({
      messages: acc.messages + (s.messages - beforeStall[i].messages),
      bytes: acc.bytes + (s.bytes - beforeStall[i].bytes),
    }), { messages: 0, bytes: 0 });
    const stallMsgsPerSec = duringStallTotals.messages / (stallMs / 1000);
    const backlogBytes = SLOW_BYTES - slowReceived;
    console.error(`[capacity] slow consumer: stalled=${stalled}, backlog=${fmtBytes(backlogBytes)} after ${stallMs.toFixed(0)}ms`);

    // Resume and drain.
    const drainStart = performance.now();
    slowSocket.resume();
    await until(() => slowReceived >= SLOW_BYTES, 30_000, 'slow channel drain');
    const drainMs = performance.now() - drainStart;
    slowSocket.close(1000);
    slowCtl.close(1000);
    await sleep(500);

    // --- Churn: repeated connect → open → cancel → disconnect ---
    const churnStart = performance.now();
    for (let round = 0; round < 5; round++) {
      const churn = new GatewayClient({
        url: httpUrl, credential: deviceCred.token, namespace: NAMESPACE,
        identity: { deviceId: `churn-${round}`, name: `churn-${round}` },
      });
      clients.push(churn);
      await churn.connect();
      const c1 = await churn.openChannel(backendIds[round % backendIds.length], 'echo');
      const c2 = await churn.openChannel(backendIds[(round + 1) % backendIds.length], 'echo');
      c1.close(); // active cancel mid-traffic
      c2.close();
      churn.close(); // full disconnect
    }
    const churnMs = performance.now() - churnStart;

    // --- Teardown and recovery ---
    const teardownStart = performance.now();
    phase = 'stopped'; // end the traffic pump timers for good
    for (const client of clients) client.close();
    for (const backend of backends) backend.close();
    await until(() => monitor.snapshot().channels === 0, 15_000, 'channels back to 0');
    await until(() => monitor.snapshot().peers === 0, 15_000, 'peers back to 0');
    const teardownMs = performance.now() - teardownStart;
    await sleep(1500); // let allocations settle a beat
    const memEnd = process.memoryUsage();

    // --- Report ---
    const memPeak = monitor.samples.reduce((peak, s) => ({
      rss: Math.max(peak.rss, s.rss), heapUsed: Math.max(peak.heapUsed, s.heapUsed),
    }), { rss: 0, heapUsed: 0 });
    const memStart = monitor.samples[0] ?? { rss: memEnd.rss, heapUsed: memEnd.heapUsed };
    const rtt = (p: number): string => `${percentile(sustainedRtts, p).toFixed(1)} ms`;
    const stallRatio = (100 * stallMsgsPerSec / sustainedMsgsPerSec).toFixed(0);

    const report = `# 连接容量与慢消费者验证报告

> 由 \`scripts/capacity-verify.ts\` 生成；按"复现命令"可在任意环境重跑。

## 结果性质（先读）

- 本报告数字是**单机、单进程（网关与全部 SDK 端点同进程回环）的一次采样**，用于相对比较与回归参考，**不是**对任何部署形态的容量承诺或 SLA。
- 唯一的**严格保证**来自实现内建的边界（每 Channel 4 MiB 高水位背压、消息尺寸上限、每 IP 控制连接限额、每 peer Channel 配额），由 CI 行为测试固定（\`capacity-regression.test.ts\`、\`phase2-channels.test.ts\`），与本报告的采样数字无关。
- 生产容量取决于部署硬件、TLS 终止、真实网络 RTT 与负载形态，应在目标环境用同一脚本复测。

## 测试条件

| 项 | 值 |
| --- | --- |
| 时间 | ${conditions.date} |
| 运行环境 | ${conditions.platform} |
| Node | ${conditions.node} |
| 拓扑 | ${OPTS.backends} Echo Backend × ${OPTS.devices} 设备 × ${OPTS.devices * OPTS.channelsPerDevice} Channel（round-robin） |
| 负载 | 双向 echo，text（小 JSON）与 binary（${fmtBytes(OPTS.frameBytes)}）交替，每 10 个 text 帧含 1 个 RTT 探测 |
| 持续负载时长 | ${(OPTS.durationMs / 1000).toFixed(0)} s（free-running 饱和发送） |
| 慢消费者 | 专用 Channel 的客户端 \`pause()\`，注入 ${OPTS.slowMib} MiB 后观察 ${(stallMs / 1000).toFixed(1)} s |
| 网关配置 | in-process、临时 SQLite；maxWsConnectionsPerIp=0（仅本脚本自身多连接）；每 Channel 高水位 4 MiB |

## 吞吐与延迟（采样）

| 指标 | 值 |
| --- | --- |
| 持续阶段 echo 完成消息数 | ${sustainedTotals.messages.toLocaleString()} msgs / ${(sustainedMs / 1000).toFixed(1)} s |
| 持续阶段吞吐（回环确认口径） | ${sustainedMsgsPerSec.toFixed(0)} msgs/s · ${fmtBytes((sustainedTotals.bytes / sustainedMs) * 1000)}/s |
| RTT p50 / p95 / p99 / max | ${rtt(50)} / ${rtt(95)} / ${rtt(99)} / ${sustainedRtts.length ? sustainedRtts[sustainedRtts.length - 1].toFixed(1) + ' ms' : '—'} |

## 慢消费者隔离（行为证据）

| 观测 | 结果 |
| --- | --- |
| 暂停的消费者在 ${(stallMs / 1000).toFixed(1)} s 内停止接收 | ${stalled ? '是（停滞，符合背压预期）' : '否（未观察到停滞）'} |
| 停滞时该 Channel 积压（发送 − 已收） | ${fmtBytes(backlogBytes)}（有界：受每 Channel 4 MiB 高水位约束） |
| 停滞窗口内其他 Channel 吞吐 | ${stallMsgsPerSec.toFixed(0)} msgs/s（持续阶段均值的 ${stallRatio}%） |
| resume 后积压排空 | ${drainMs.toFixed(0)} ms 内 ${fmtBytes(SLOW_BYTES)} 全部送达（无死锁） |

## 连接与队列峰值（采样，经 /api/admin/overview 诊断计数）

| 指标 | 峰值 | 结束 |
| --- | --- | --- |
| 在线 peer（控制连接） | ${monitor.maxPeers} | ${monitor.snapshot().peers} |
| 跟踪中的 Channel | ${monitor.maxChannels} | ${monitor.snapshot().channels} |

## 内存趋势（采样，网关同进程）

| 指标 | 起点 | 峰值 | 结束 |
| --- | --- | --- | --- |
| RSS | ${fmtBytes(memStart.rss)} | ${fmtBytes(memPeak.rss)} | ${fmtBytes(memEnd.rss)} |
| 堆已用 | ${fmtBytes(memStart.heapUsed)} | ${fmtBytes(memPeak.heapUsed)} | ${fmtBytes(memEnd.heapUsed)} |

采样点共 ${monitor.samples.length} 个（每 0.5 s 一个）。峰值与结束值受 V8 GC 时机影响，仅作趋势参考。

## 恢复验证（行为证据）

| 项 | 结果 |
| --- | --- |
| 取消/断线 churn（5 轮：连接 → 2 Channel → 主动取消 → 断开） | ${churnMs.toFixed(0)} ms 完成 |
| 全部端点关闭后资源回落 | ${teardownMs.toFixed(0)} ms 内 channels=0、peers=0（轮询诊断计数确认） |

## 复现命令

\`\`\`bash
pnpm capacity                                  # 默认参数（本报告）
pnpm capacity --duration-ms=60000 --devices=12 --backends=6 --channels-per-device=3 --slow-mib=64
pnpm capacity --out=capacity-report.md         # 报告写入文件
\`\`\`
`;

    if (OPTS.out) {
      fs.mkdirSync(path.dirname(path.resolve(OPTS.out)), { recursive: true });
      fs.writeFileSync(OPTS.out, report);
      console.error(`[capacity] report written to ${OPTS.out}`);
    }
    process.stdout.write(report);
  } finally {
    monitor?.stop();
    for (const ws of rawSockets) { try { ws.close(1000); } catch { /* already closed */ } }
    for (const client of clients) client.close();
    for (const backend of backends) backend.close();
    // server.close waits for every connection, including the fetch agent's
    // keep-alive sockets that only undici owns — race it and exit explicitly.
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      sleep(3000),
    ]);
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  // Everything (including the finally cleanup above) has run: exit despite
  // any surviving keep-alive timers.
  process.exit(0);
}

main().catch(async (error) => {
  console.error('[capacity] failed:', error);
  process.exitCode = 1;
  // The finally-cleanup above ran via main(); give sockets a beat, then go.
  await sleep(500);
  process.exit(1);
});
