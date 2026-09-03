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
  toWsBase,
  waitForSocketOpen,
  type SocketFactory,
  type WebSocketLike,
} from './socket.js';
import { dialChannel, GatewayChannel } from './channel.js';

export { GatewayChannel, dialChannel } from './channel.js';
export type { ChannelMessage } from './channel.js';
export { defaultSocketFactory, toWsBase } from './socket.js';
export type { SocketFactory, WebSocketLike } from './socket.js';

export interface GatewayClientOptions {
  /** Gateway base URL (http(s):// or ws(s)://). */
  url: string;
  /** Credential token (zgd_*) or the legacy shared secret. */
  credential: string;
  namespace: string;
  identity: { deviceId: string; instanceId: string; name?: string };
  clientProtocolVersion?: number;
  socketFactory?: SocketFactory;
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
  private readonly wsBase: string;
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
    this.wsBase = toWsBase(options.url);
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
      identity: this.opts.identity,
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
