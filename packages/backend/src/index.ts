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
  namespace: string;
  identity: { deviceId: string; instanceId: string; name?: string; channel?: string };
  visible?: boolean;
  capabilities?: string[];
  backendProtocolVersion?: number;
  socketFactory?: SocketFactory;
  heartbeatIntervalMs?: number;
}

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

  constructor(options: GatewayBackendOptions) {
    this.opts = options;
    this.factory = options.socketFactory ?? defaultSocketFactory;
    this.wsBase = toWsBase(options.url);
  }

  get id(): string { return this.backendId; }
  get currentEpoch(): number { return this.epoch; }

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
      gatewaySecret: this.opts.credential,
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
      let msg: { type?: string };
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'channel_offer') void this.handleOffer(msg as unknown as ChannelOfferMessage);
    });

    const interval = this.opts.heartbeatIntervalMs ?? 10_000;
    this.heartbeatTimer = setInterval(() => {
      if (this.socket && this.socket.readyState === 1) {
        this.socket.send(JSON.stringify({ type: 'backend_heartbeat', epoch: this.epoch, observedAt: Date.now() }));
      }
    }, interval);

    return { backendId: this.backendId, epoch: this.epoch };
  }

  private async handleOffer(offer: ChannelOfferMessage): Promise<void> {
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
