/**
 * Gateway Client SDK (Protocol v4).
 *
 * Control connection + channels + topics + reconnect. Designed for WHATWG
 * WebSocket environments (WebView / browser / Node >= 21); inject a
 * socketFactory otherwise. Channels follow the fast-reopen model: they die
 * with the connection and are reopened by the application, not resumed.
 */
import {
  GATEWAY_PROTOCOL_V4,
  type BackendPresenceV4,
  type ChannelClosedReason,
  type PeerReadyV4,
} from '@zclaudia/gateway-protocol';
import {
  defaultSocketFactory,
  normalizeMessageData,
  toHttpBase,
  toWsBase,
  waitForSocketOpen,
  type SocketFactory,
  type WebSocketLike,
} from './socket.js';
import { defaultFetch, type FetchLike } from './fetch.js';
import { dialChannel, GatewayChannel } from './channel.js';

export { GatewayChannel, dialChannel } from './channel.js';
export type { ChannelMessage } from './channel.js';
export { defaultSocketFactory, toHttpBase, toWsBase } from './socket.js';
export type { SocketFactory, WebSocketLike } from './socket.js';
export { defaultFetch } from './fetch.js';
export type { FetchLike, FetchResponseLike } from './fetch.js';

/** One backend a credential can address (GET /api/discovery/backends). */
export interface GatewayDiscoveryBackend {
  backendId: string;
  /** The credential's name until the backend first connects, then the backend's self-reported name. */
  name: string;
  /** Whether the backend currently holds a lease on the gateway. */
  online: boolean;
  /** Last heartbeat (online) or last registration/offline transition; null if it never connected. */
  lastSeenAt: number | null;
}

export interface GatewayClientOptions {
  /** Gateway base URL (http(s):// or ws(s)://). */
  url: string;
  /** Issued credential token (zgd_ device credential or an exchanged zga_ access token). Shared secrets and the admin token are not accepted. */
  credential: string;
  namespace: string;
  /** Descriptive only (display/diagnostics); never used for authorization. Omit to send no identity. */
  identity?: { deviceId?: string; instanceId?: string; name?: string };
  clientProtocolVersion?: number;
  socketFactory?: SocketFactory;
  /** HTTP implementation for `discoverBackends`; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Auto-reconnect with backoff after unexpected disconnects. Default true. */
  reconnect?: boolean;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

export type GatewayClientState = 'idle' | 'connecting' | 'connected' | 'closed';

type Pending = { resolve: (msg: never) => void; reject: (err: Error) => void };

export class GatewayClient {
  private readonly opts: Required<Pick<GatewayClientOptions, 'reconnect' | 'reconnectMinMs' | 'reconnectMaxMs' | 'clientProtocolVersion'>> & GatewayClientOptions;
  private readonly factory: SocketFactory;
  private readonly fetchImpl: FetchLike;
  private readonly wsBase: string;
  private readonly httpBase: string;
  private socket: WebSocketLike | null = null;
  private state: GatewayClientState = 'idle';
  private peerSessionId = '';
  private registryItems: BackendPresenceV4[] = [];
  private reconnectAttempt = 0;
  private userClosed = false;

  /**
   * The protocol has no request-correlation ids yet, so control operations
   * (channel_open / topic_(un)subscribe) run strictly one at a time and are
   * matched FIFO against replies and gateway_error. TODO(protocol): add an
   * additive `ref` field to remove the serialization.
   */
  private opQueue: Promise<unknown> = Promise.resolve();
  private pendingOp: { expect: string[]; settle: Pending } | null = null;

  private topicHandlers = new Map<string, Set<(payload: unknown) => void>>();
  private stateHandlers: Array<(state: GatewayClientState) => void> = [];
  private registryHandlers: Array<(items: BackendPresenceV4[]) => void> = [];
  private channels = new Map<string, GatewayChannel>();

  constructor(options: GatewayClientOptions) {
    this.opts = {
      reconnect: true,
      reconnectMinMs: 1000,
      reconnectMaxMs: 30_000,
      clientProtocolVersion: 1,
      ...options,
    };
    this.factory = options.socketFactory ?? defaultSocketFactory;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.wsBase = toWsBase(options.url);
    this.httpBase = toHttpBase(options.url);
  }

  get connectionState(): GatewayClientState { return this.state; }
  get sessionId(): string { return this.peerSessionId; }
  get registry(): BackendPresenceV4[] { return [...this.registryItems]; }

  onState(handler: (state: GatewayClientState) => void): () => void {
    this.stateHandlers.push(handler);
    return () => { this.stateHandlers = this.stateHandlers.filter((h) => h !== handler); };
  }

  onRegistry(handler: (items: BackendPresenceV4[]) => void): () => void {
    this.registryHandlers.push(handler);
    return () => { this.registryHandlers = this.registryHandlers.filter((h) => h !== handler); };
  }

  /**
   * Resolve with the backend's presence once `backendId` is in the registry
   * (immediately if it already is). A backend's id is fixed when its
   * credential is issued (ADR-0009), so clients can be configured with it and
   * simply wait for it to come online — no picking from the registry.
   *
   * Waits across reconnects. Rejects after `timeoutMs` (default: wait
   * indefinitely) or when `signal` aborts. A backend outside this
   * credential's namespace or backend scope never appears, exactly like an
   * offline one — set a timeout if that is possible (or use
   * `discoverBackends` to tell the two apart).
   */
  waitForBackend(backendId: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<BackendPresenceV4> {
    const present = this.registryItems.find((item) => item.backendId === backendId);
    if (present) return Promise.resolve(present);
    const { timeoutMs, signal } = options;
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => { cleanup(); reject(signal!.reason); };
      const unsubscribe = this.onRegistry((items) => {
        const found = items.find((item) => item.backendId === backendId);
        if (found) { cleanup(); resolve(found); }
      });
      function cleanup() {
        unsubscribe();
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Backend ${backendId} did not come online within ${timeoutMs}ms`));
        }, timeoutMs);
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * List the backends this credential can address, offline ones included
   * (GET /api/discovery/backends). Made for pairing: show the list, persist
   * the picked `backendId`, then use `waitForBackend` — ids are stable
   * (ADR-0009), so discovery is a one-time step, not the steady state.
   *
   * Unlike the registry this is not a liveness view: an out-of-scope backend
   * never appears (same as nonexistent), while an in-scope one that is merely
   * offline is listed with `online: false`. Works before `connect()`.
   */
  async discoverBackends(): Promise<GatewayDiscoveryBackend[]> {
    const res = await this.fetchImpl(`${this.httpBase}/api/discovery/backends`, {
      headers: { Authorization: `Bearer ${this.opts.credential}` },
    });
    const body = await res.json().catch(() => null) as
      { success?: boolean; error?: { code?: string; message?: string }; data?: { items?: GatewayDiscoveryBackend[] } } | null;
    if (!res.ok || !body?.success) {
      const err = body?.error;
      throw new Error(`discoverBackends failed: ${err?.code ? `${err.code}: ${err.message}` : `HTTP ${res.status}`}`);
    }
    return body.data?.items ?? [];
  }

  private setState(state: GatewayClientState): void {
    this.state = state;
    for (const handler of this.stateHandlers) handler(state);
  }

  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') return;
    this.userClosed = false;
    await this.establish();
  }

  private async establish(): Promise<void> {
    this.setState('connecting');
    const socket = this.factory(`${this.wsBase}/ws`);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    await waitForSocketOpen(socket);

    const ready = new Promise<PeerReadyV4>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('peer_ready timeout')), 10_000);
      const handler = (event: { data: unknown }) => {
        const data = normalizeMessageData(event.data);
        if (typeof data !== 'string') return;
        const msg = JSON.parse(data);
        if (msg.type === 'peer_ready') { clearTimeout(timer); resolve(msg); }
        else if (msg.type === 'gateway_error') { clearTimeout(timer); reject(new Error(`${msg.code}: ${msg.message}`)); }
      };
      socket.addEventListener('message', handler);
    });

    socket.send(JSON.stringify({
      type: 'peer_hello',
      protocolVersion: GATEWAY_PROTOCOL_V4,
      namespace: this.opts.namespace,
      clientProtocolVersion: this.opts.clientProtocolVersion,
      peerType: 'client-only',
      gatewaySecret: this.opts.credential,
      ...(this.opts.identity ? { identity: this.opts.identity } : {}),
    }));

    const readyMsg = await ready;
    this.peerSessionId = readyMsg.peerSessionId;
    this.registryItems = readyMsg.registrySync.items;

    socket.addEventListener('message', (event) => this.routeMessage(event.data));
    socket.addEventListener('close', () => this.handleClose());

    this.reconnectAttempt = 0;
    this.setState('connected');
    for (const handler of this.registryHandlers) handler(this.registry);
    await this.resubscribeTopics();
  }

  private routeMessage(raw: unknown): void {
    const data = normalizeMessageData(raw);
    if (typeof data !== 'string') return;
    let msg: Record<string, unknown> & { type?: string };
    try { msg = JSON.parse(data); } catch { return; }
    switch (msg.type) {
      case 'registry_snapshot':
        this.registryItems = (msg as { items: BackendPresenceV4[] }).items;
        for (const handler of this.registryHandlers) handler(this.registry);
        break;
      case 'topic_message': {
        const m = msg as { backendId: string; topic: string; payload?: unknown };
        const handlers = this.topicHandlers.get(topicKey(m.backendId, m.topic));
        if (handlers) for (const handler of handlers) handler(m.payload);
        break;
      }
      case 'channel_closed': {
        const m = msg as unknown as { channelId: string; reason: ChannelClosedReason };
        const channel = this.channels.get(m.channelId);
        if (channel) { this.channels.delete(m.channelId); channel.close(); }
        break;
      }
      case 'channel_ready':
      case 'topic_subscribed':
      case 'topic_unsubscribed':
        this.settlePending(msg.type, msg);
        break;
      case 'gateway_error':
        // FIFO correlation: an error while an op is pending fails that op.
        if (this.pendingOp) {
          const m = msg as { code?: string; message?: string };
          this.failPending(new Error(`${m.code}: ${m.message}`));
        }
        break;
    }
  }

  private settlePending(type: string, msg: unknown): void {
    if (this.pendingOp && this.pendingOp.expect.includes(type)) {
      const settle = this.pendingOp.settle;
      this.pendingOp = null;
      (settle.resolve as (value: unknown) => void)(msg);
    }
  }

  private failPending(error: Error): void {
    if (this.pendingOp) {
      const settle = this.pendingOp.settle;
      this.pendingOp = null;
      settle.reject(error);
    }
  }

  /** Run a control op exclusively, matching the reply FIFO. */
  private controlOp<T>(send: () => void, expect: string[]): Promise<T> {
    const run = () => new Promise<T>((resolve, reject) => {
      if (!this.socket || this.state !== 'connected') {
        reject(new Error('Not connected'));
        return;
      }
      const timer = setTimeout(() => {
        if (this.pendingOp?.settle.reject === wrappedReject) this.pendingOp = null;
        reject(new Error('Control operation timeout'));
      }, 10_000);
      const wrappedResolve = (value: unknown) => { clearTimeout(timer); resolve(value as T); };
      const wrappedReject = (err: Error) => { clearTimeout(timer); reject(err); };
      this.pendingOp = { expect, settle: { resolve: wrappedResolve as never, reject: wrappedReject } };
      send();
    });
    const next = this.opQueue.then(run, run);
    this.opQueue = next.catch(() => undefined);
    return next;
  }

  /** Open a channel to a backend; resolves once the data socket is up. */
  async openChannel(target: string, kind?: string): Promise<GatewayChannel> {
    const ready = await this.controlOp<{ channelId: string; ticket: string; dataPath: string }>(
      () => this.socket!.send(JSON.stringify({ type: 'channel_open', target, kind })),
      ['channel_ready'],
    );
    const channel = await dialChannel(this.wsBase, ready.dataPath, ready.ticket, ready.channelId, this.factory, kind);
    this.channels.set(ready.channelId, channel);
    channel.onClose(() => this.channels.delete(ready.channelId));
    return channel;
  }

  /** Subscribe to a backend topic. Returns an unsubscribe function. */
  async subscribeTopic(backendId: string, topic: string, handler: (payload: unknown) => void): Promise<() => Promise<void>> {
    await this.controlOp(
      () => this.socket!.send(JSON.stringify({ type: 'topic_subscribe', backendId, topic })),
      ['topic_subscribed'],
    );
    const key = topicKey(backendId, topic);
    let handlers = this.topicHandlers.get(key);
    if (!handlers) { handlers = new Set(); this.topicHandlers.set(key, handlers); }
    handlers.add(handler);
    return async () => {
      const set = this.topicHandlers.get(key);
      set?.delete(handler);
      if (set && set.size === 0) {
        this.topicHandlers.delete(key);
        await this.controlOp(
          () => this.socket!.send(JSON.stringify({ type: 'topic_unsubscribe', backendId, topic })),
          ['topic_unsubscribed'],
        ).catch(() => undefined);
      }
    };
  }

  private async resubscribeTopics(): Promise<void> {
    for (const key of this.topicHandlers.keys()) {
      const [backendId, topic] = key.split('\x1f');
      await this.controlOp(
        () => this.socket!.send(JSON.stringify({ type: 'topic_subscribe', backendId, topic })),
        ['topic_subscribed'],
      ).catch(() => undefined);
    }
  }

  private handleClose(): void {
    const wasConnected = this.state === 'connected';
    this.socket = null;
    this.failPending(new Error('Connection closed'));
    // Fast-reopen model: channels die with the control connection.
    for (const channel of this.channels.values()) channel.close();
    this.channels.clear();
    if (this.userClosed || !this.opts.reconnect) {
      this.setState('closed');
      return;
    }
    if (wasConnected || this.state === 'connecting') {
      this.setState('connecting');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(this.opts.reconnectMinMs * 2 ** this.reconnectAttempt, this.opts.reconnectMaxMs);
    this.reconnectAttempt += 1;
    setTimeout(() => {
      if (this.userClosed) return;
      this.establish().catch(() => this.scheduleReconnect());
    }, delay);
  }

  close(): void {
    this.userClosed = true;
    this.setState('closed');
    for (const channel of this.channels.values()) channel.close();
    this.channels.clear();
    this.socket?.close(1000);
    this.socket = null;
  }
}

function topicKey(backendId: string, topic: string): string {
  return `${backendId}\x1f${topic}`;
}
