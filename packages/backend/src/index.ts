/**
 * Gateway Backend SDK (Protocol v4).
 *
 * Registration + lease heartbeat, channel offer handling (dial-is-accept),
 * topic publishing, and an HTTP-over-channel serving helper for adapters.
 */
import {
  CHANNEL_KIND_HTTP,
  GATEWAY_PROTOCOL_V4,
  type ChannelOfferMessage,
  type HttpRequestFrame,
  type PeerReadyV4,
} from '@zclaudia/gateway-protocol';
import {
  defaultSocketFactory,
  dialChannel,
  GatewayChannel,
  toWsBase,
  type SocketFactory,
  type WebSocketLike,
} from '@zclaudia/gateway-client';

export interface GatewayBackendOptions {
  url: string;
  /** Credential token (zgb_*) or the legacy shared secret. */
  credential: string;
  /**
   * When the credential is an enrollment token (zgb_*), exchange it for a
   * short-lived access token before connecting so the long-lived secret
   * never travels on the control connection. Default true.
   */
  exchangeEnrollment?: boolean;
  namespace: string;
  identity: { deviceId: string; instanceId: string; name?: string; channel?: string };
  visible?: boolean;
  capabilities?: string[];
  backendProtocolVersion?: number;
  socketFactory?: SocketFactory;
  heartbeatIntervalMs?: number;
  /** Auto-reconnect with backoff after unexpected disconnects. Default true. */
  reconnect?: boolean;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

export type GatewayBackendState = 'idle' | 'connecting' | 'connected' | 'closed';

export interface ChannelOfferInfo {
  channelId: string;
  kind?: string;
  sourcePeerSessionId?: string;
}

export type ChannelHandler = (channel: GatewayChannel, info: ChannelOfferInfo) => void;

export interface HttpServeRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface HttpServeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}

export type HttpHandler = (request: HttpServeRequest) => Promise<HttpServeResponse> | HttpServeResponse;

export class GatewayBackend {
  private readonly opts: GatewayBackendOptions;
  private readonly factory: SocketFactory;
  private readonly wsBase: string;
  private socket: WebSocketLike | null = null;
  private backendId = '';
  private epoch = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private channelHandlers = new Map<string, ChannelHandler>();
  private defaultChannelHandler: ChannelHandler | null = null;
  private closed = false;
  private state: GatewayBackendState = 'idle';
  private reconnectAttempt = 0;
  private stateHandlers: Array<(state: GatewayBackendState) => void> = [];
  private messageHandlers: Array<(message: Record<string, unknown>) => void> = [];

  constructor(options: GatewayBackendOptions) {
    this.opts = options;
    this.factory = options.socketFactory ?? defaultSocketFactory;
    this.wsBase = toWsBase(options.url);
  }

  get id(): string { return this.backendId; }
  get currentEpoch(): number { return this.epoch; }
  get connectionState(): GatewayBackendState { return this.state; }

  onState(handler: (state: GatewayBackendState) => void): () => void {
    this.stateHandlers.push(handler);
    return () => { this.stateHandlers = this.stateHandlers.filter((h) => h !== handler); };
  }

  /**
   * Raw tap on inbound control messages (v3 message flow passthrough for
   * incremental migrations). Messages the SDK consumes internally
   * (channel_offer) are still delivered here.
   */
  onMessage(handler: (message: Record<string, unknown>) => void): () => void {
    this.messageHandlers.push(handler);
    return () => { this.messageHandlers = this.messageHandlers.filter((h) => h !== handler); };
  }

  /** Send a raw control message (v3 message flow passthrough). */
  send(message: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== 1) throw new Error('Not connected');
    this.socket.send(JSON.stringify(message));
  }

  private setState(state: GatewayBackendState): void {
    this.state = state;
    for (const handler of this.stateHandlers) handler(state);
  }

  /** Register a handler for a specific channel kind (e.g. 'rpc'). */
  onChannel(kind: string, handler: ChannelHandler): void {
    this.channelHandlers.set(kind, handler);
  }

  /** Fallback handler for kinds without a specific handler. */
  onAnyChannel(handler: ChannelHandler): void {
    this.defaultChannelHandler = handler;
  }

  /**
   * Serve HTTP-over-channel requests (gateway /api/proxy for v4 backends).
   * The handler receives the buffered request and returns the response;
   * the SDK does the frame plumbing (docs/protocol-v4.md §7).
   */
  serveHttp(handler: HttpHandler): void {
    this.onChannel(CHANNEL_KIND_HTTP, (channel) => {
      let meta: HttpRequestFrame | null = null;
      const chunks: Uint8Array[] = [];
      channel.onMessage((message) => {
        if (message.binary) {
          chunks.push(message.data as Uint8Array);
          return;
        }
        const frame = JSON.parse(message.data as string);
        if (frame.type === 'http_request') {
          meta = frame;
        } else if (frame.type === 'http_request_end' && meta) {
          void (async () => {
            try {
              const response = await handler({
                method: meta!.method,
                path: meta!.path,
                headers: meta!.headers,
                body: concat(chunks),
              });
              channel.send(JSON.stringify({ type: 'http_response', status: response.status, headers: response.headers ?? {} }));
              if (response.body !== undefined) {
                const body = typeof response.body === 'string' ? new TextEncoder().encode(response.body) : response.body;
                if (body.byteLength > 0) channel.send(body);
              }
            } catch {
              channel.send(JSON.stringify({ type: 'http_response', status: 500, headers: {} }));
            } finally {
              channel.close();
            }
          })();
        }
      });
    });
  }

  async connect(): Promise<{ backendId: string; epoch: number }> {
    this.closed = false;
    return this.establish();
  }

  private async establish(): Promise<{ backendId: string; epoch: number }> {
    this.setState('connecting');
    // Re-resolve on every attempt: an exchanged access token may have
    // expired while we were disconnected.
    const credential = await this.resolveCredential();
    const socket = this.factory(`${this.wsBase}/ws`);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', (err) => reject(err instanceof Error ? err : new Error('WebSocket error')));
    });

    const ready = new Promise<PeerReadyV4>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('peer_ready timeout')), 10_000);
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        const msg = JSON.parse(event.data);
        if (msg.type === 'peer_ready') { clearTimeout(timer); resolve(msg); }
        else if (msg.type === 'gateway_error') { clearTimeout(timer); reject(new Error(`${msg.code}: ${msg.message}`)); }
      });
    });

    socket.send(JSON.stringify({
      type: 'peer_hello',
      protocolVersion: GATEWAY_PROTOCOL_V4,
      namespace: this.opts.namespace,
      clientProtocolVersion: this.opts.backendProtocolVersion ?? 1,
      peerType: 'client+backend',
      gatewaySecret: credential,
      identity: this.opts.identity,
      backend: {
        visible: this.opts.visible ?? true,
        capabilities: this.opts.capabilities ?? [],
        backendProtocolVersion: this.opts.backendProtocolVersion ?? 1,
      },
    }));

    const readyMsg = await ready;
    if (!readyMsg.backend) throw new Error('Gateway did not assign a backend identity');
    this.backendId = readyMsg.backend.backendId;
    this.epoch = readyMsg.backend.epoch;

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let msg: Record<string, unknown> & { type?: string };
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'channel_offer') void this.handleOffer(msg as unknown as ChannelOfferMessage);
      for (const handler of this.messageHandlers) handler(msg);
    });
    socket.addEventListener('close', () => this.handleClose(socket));

    const interval = this.opts.heartbeatIntervalMs ?? 10_000;
    this.heartbeatTimer = setInterval(() => {
      if (this.socket && this.socket.readyState === 1) {
        this.socket.send(JSON.stringify({ type: 'backend_heartbeat', epoch: this.epoch, observedAt: Date.now() }));
      }
    }, interval);

    this.reconnectAttempt = 0;
    this.setState('connected');
    return { backendId: this.backendId, epoch: this.epoch };
  }

  private handleClose(socket: WebSocketLike): void {
    if (this.socket !== socket) return; // stale socket from a previous session
    this.socket = null;
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.closed || this.opts.reconnect === false) {
      this.setState('closed');
      return;
    }
    this.setState('connecting');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const minMs = this.opts.reconnectMinMs ?? 1000;
    const maxMs = this.opts.reconnectMaxMs ?? 30_000;
    const delay = Math.min(minMs * 2 ** this.reconnectAttempt, maxMs);
    this.reconnectAttempt += 1;
    setTimeout(() => {
      if (this.closed) return;
      this.establish().catch(() => this.scheduleReconnect());
    }, delay);
  }

  /** Exchange an enrollment credential for a short-lived access token. */
  private async resolveCredential(): Promise<string> {
    if (this.opts.exchangeEnrollment === false || !this.opts.credential.startsWith('zgb_')) {
      return this.opts.credential;
    }
    const httpBase = this.wsBase.replace(/^ws/, 'http');
    const response = await fetch(`${httpBase}/api/backend/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.credential}` },
    });
    if (!response.ok) {
      throw new Error(`Enrollment exchange failed: HTTP ${response.status}`);
    }
    const body = await response.json() as { data: { token: string } };
    return body.data.token;
  }

  private async handleOffer(offer: ChannelOfferMessage): Promise<void> {
    if (this.closed) return;
    const handler = (offer.kind && this.channelHandlers.get(offer.kind)) ?? this.defaultChannelHandler;
    if (!handler) {
      this.socket?.send(JSON.stringify({ type: 'channel_reject', channelId: offer.channelId, reason: 'no_handler' }));
      return;
    }
    try {
      const channel = await dialChannel(this.wsBase, offer.dataPath, offer.ticket, offer.channelId, this.factory, offer.kind);
      handler(channel, { channelId: offer.channelId, kind: offer.kind, sourcePeerSessionId: offer.sourcePeerSessionId });
    } catch {
      this.socket?.send(JSON.stringify({ type: 'channel_reject', channelId: offer.channelId, reason: 'dial_failed' }));
    }
  }

  publishTopic(topic: string, payload?: unknown): void {
    if (!this.socket || this.socket.readyState !== 1) throw new Error('Not connected');
    this.socket.send(JSON.stringify({ type: 'topic_publish', topic, payload }));
  }

  close(): void {
    this.closed = true;
    this.setState('closed');
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.socket?.close(1000);
    this.socket = null;
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}
