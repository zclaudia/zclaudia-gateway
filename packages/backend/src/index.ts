/**
 * Gateway Backend SDK (Protocol v4).
 *
 * Registration + lease heartbeat, channel offer handling (dial-is-accept),
 * topic publishing, and an HTTP-over-channel serving helper for adapters.
 */
import {
  CHANNEL_KIND_HTTP,
  GATEWAY_CLOSE_BACKEND_REPLACED,
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
  /**
   * Backend credential: an enrollment token (zgb_) or a backend-access
   * token (zga_). Shared secrets and the admin token are not accepted.
   */
  credential: string;
  /**
   * When the credential is an enrollment token (zgb_*), exchange it for a
   * short-lived access token before connecting so the long-lived secret
   * never travels on the control connection. Default true.
   */
  exchangeEnrollment?: boolean;
  namespace: string;
  /**
   * Descriptive identity reported in `peer_hello`. Optional: with a bound
   * backend credential (ADR-0009) the gateway assigns the `backendId` from
   * the credential, and these fields are display-only (`name` is shown in
   * the registry). A legacy (unbound) backend credential still derives the
   * backendId from `(namespace, instanceId, channel)`, so it needs a stable
   * `instanceId` — never a hostname, pod name or random value — and the
   * gateway rejects its hello without one (`INVALID_MESSAGE`).
   * Only the fields provided are sent; omit it to send no identity at all.
   */
  identity?: { deviceId?: string; instanceId?: string; name?: string; channel?: string };
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

export type BackendErrorCode =
  | 'AUTH_FAILED'
  | 'GATEWAY_REJECTED'
  | 'GATEWAY_UNREACHABLE'
  | 'HANDSHAKE_TIMEOUT'
  | 'PROTOCOL_ERROR'
  | 'CONNECT_FAILED'
  | 'REPLACED';

/**
 * Why the most recent connection attempt failed (`GatewayBackend.lastError`).
 *
 * Safe to log and to show to users: `message` is a fixed description per
 * `code`; raw error text, URLs, headers and credentials never end up here.
 * Branch on `code`, not on `message`.
 *
 * - `AUTH_FAILED` — the gateway refused the credential (`UNAUTHORIZED` during
 *   the handshake, or HTTP 401/403 from the enrollment exchange);
 * - `GATEWAY_REJECTED` — the gateway refused the handshake for another reason
 *   (`gatewayCode` carries its error code when it is a known one);
 * - `GATEWAY_UNREACHABLE` — no usable link: connection refused, DNS or network
 *   failure, the connection dropped mid-handshake, or an unavailable endpoint;
 * - `HANDSHAKE_TIMEOUT` — connected, but `peer_ready` never arrived;
 * - `PROTOCOL_ERROR` — the gateway answered with something the SDK cannot use;
 * - `CONNECT_FAILED` — anything else;
 * - `REPLACED` — not a failed attempt: a newer connection with the same
 *   backend credential took over this backend's identity, so this instance
 *   stopped (state `'closed'`, no reconnect) instead of fighting it.
 */
export interface BackendErrorInfo {
  readonly code: BackendErrorCode;
  readonly message: string;
  readonly gatewayCode?: string;
  /** Wall-clock time of the failed attempt, in epoch milliseconds. */
  readonly occurredAt: number;
}

/**
 * Re-exchange an access token this long before the gateway says it expires,
 * so a reconnect never presents one that dies mid-handshake.
 */
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;

const KNOWN_GATEWAY_ERROR_CODES: ReadonlySet<string> = new Set([
  'INVALID_MESSAGE',
  'PROTOCOL_VERSION_MISMATCH',
  'UNAUTHORIZED',
  'BACKEND_OFFLINE',
  'RATE_LIMITED',
]);

const ERROR_MESSAGES: Record<BackendErrorCode, string> = {
  AUTH_FAILED: 'The gateway refused the credential.',
  GATEWAY_REJECTED: 'The gateway rejected the handshake.',
  GATEWAY_UNREACHABLE: 'The gateway could not be reached.',
  HANDSHAKE_TIMEOUT: 'The gateway did not complete the handshake in time.',
  PROTOCOL_ERROR: 'The gateway sent an unexpected handshake response.',
  CONNECT_FAILED: 'Connecting to the gateway failed.',
  REPLACED: 'Another connection using the same backend credential replaced this one.',
};

/** An attempt failure the SDK can classify; carries the original message for `connect()` callers. */
class AttemptError extends Error {
  constructor(
    readonly code: BackendErrorCode,
    message: string,
    readonly gatewayCode?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AttemptError';
  }
}

function describeFailure(error: unknown): BackendErrorInfo {
  let code: BackendErrorCode = 'CONNECT_FAILED';
  let gatewayCode: string | undefined;
  let message: string | undefined;
  if (error instanceof AttemptError) {
    code = error.code;
    if (error.gatewayCode !== undefined && KNOWN_GATEWAY_ERROR_CODES.has(error.gatewayCode)) {
      gatewayCode = error.gatewayCode;
      if (code === 'GATEWAY_REJECTED') message = `The gateway rejected the handshake (${gatewayCode}).`;
    }
  }
  const info: BackendErrorInfo = {
    code,
    message: message ?? ERROR_MESSAGES[code],
    ...(gatewayCode !== undefined ? { gatewayCode } : {}),
    occurredAt: Date.now(),
  };
  return Object.freeze(info);
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
  private state: GatewayBackendState = 'idle';
  private failure: BackendErrorInfo | null = null;
  private reconnectAttempt = 0;
  /**
   * Access token exchanged from a zgb_ enrollment credential, reused across
   * reconnects until shortly before it expires: every exchange mints a new
   * credential row on the gateway. Kept across close() — the token stays
   * valid server-side either way, and a later connect() should not mint
   * another; a token the gateway no longer accepts is dropped on its first
   * UNAUTHORIZED.
   */
  private accessToken: { token: string; expiresAt: number | null } | null = null;
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

  /**
   * The most recent failed connection attempt, or `null`. Read-only and
   * immutable; see {@link BackendErrorInfo} for the codes. Lifecycle:
   *
   * - **set / updated** by every failed attempt — the first handshake of
   *   `connect()` (which also rejects) and every background reconnect attempt,
   *   whose failures are otherwise silent — so while `connectionState` is
   *   `'connecting'` it describes the latest failure;
   * - **cleared** when a handshake succeeds, before the state becomes
   *   `'connected'`, and when `connect()` begins a fresh run;
   * - **kept** across a plain connection drop (a drop is not a failed attempt)
   *   and by `close()`, which neither sets nor clears it, so a backend closed
   *   after failing still tells why. Nothing is recorded once `close()` has
   *   been called;
   * - **set to `REPLACED`** when the gateway hands this backend's identity to
   *   a newer connection (one credential = one backend, newest wins). The
   *   backend then stops for good — state `'closed'`, no reconnect — because
   *   reconnecting would replace the newer one in turn. Call `connect()` to
   *   take the identity back deliberately.
   */
  get lastError(): BackendErrorInfo | null { return this.failure; }

  onState(handler: (state: GatewayBackendState) => void): () => void {
    this.stateHandlers.push(handler);
    return () => { this.stateHandlers = this.stateHandlers.filter((h) => h !== handler); };
  }

  /**
   * Raw tap on inbound control messages (e.g. the directed
   * `backend_server_message` fallback for incremental migrations). Messages
   * the SDK consumes internally (channel_offer) are still delivered here.
   */
  onMessage(handler: (message: Record<string, unknown>) => void): () => void {
    this.messageHandlers.push(handler);
    return () => { this.messageHandlers = this.messageHandlers.filter((h) => h !== handler); };
  }

  /** Send a raw control message (e.g. the directed fallback path). */
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
    this.failure = null;
    try {
      return await this.establish();
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }
  }

  private recordFailure(error: unknown): void {
    if (this.closed) return; // close() owns the final value; late failures must not change it
    this.failure = describeFailure(error);
  }

  private async establish(): Promise<{ backendId: string; epoch: number }> {
    this.setState('connecting');
    // Resolved on every attempt, but an unexpired exchanged access token is
    // reused rather than minting a new one (see resolveCredential).
    const { credential, cached } = await this.resolveCredential();
    try {
      return await this.attempt(credential);
    } catch (error) {
      // The gateway no longer accepts the cached token (revoked, its database
      // replaced, ...): drop it and exchange afresh within this attempt. A
      // refused enrollment credential still fails the attempt.
      if (!cached || !(error instanceof AttemptError) || error.gatewayCode !== 'UNAUTHORIZED') throw error;
      this.accessToken = null;
      return await this.attempt((await this.resolveCredential()).credential);
    }
  }

  private async attempt(credential: string): Promise<{ backendId: string; epoch: number }> {
    const socket = this.factory(`${this.wsBase}/ws`);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    try {
      return await this.handshake(socket, credential);
    } catch (error) {
      // A failed attempt must not leave a half-open socket behind: the retry
      // loop would otherwise stack one per attempt.
      if (this.socket === socket) this.socket = null;
      try { socket.close(); } catch { /* already closed */ }
      throw error;
    }
  }

  private async handshake(socket: WebSocketLike, credential: string): Promise<{ backendId: string; epoch: number }> {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new AttemptError('GATEWAY_UNREACHABLE', 'WebSocket error')));
    });

    const ready = new Promise<PeerReadyV4>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AttemptError('HANDSHAKE_TIMEOUT', 'peer_ready timeout')), 10_000);
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        const msg = JSON.parse(event.data);
        if (msg.type === 'peer_ready') { clearTimeout(timer); resolve(msg); }
        else if (msg.type === 'gateway_error') {
          clearTimeout(timer);
          const code = String(msg.code);
          reject(new AttemptError(
            code === 'UNAUTHORIZED' ? 'AUTH_FAILED' : 'GATEWAY_REJECTED',
            `${msg.code}: ${msg.message}`,
            code,
          ));
        }
      });
      socket.addEventListener('close', () => {
        clearTimeout(timer);
        reject(new AttemptError('GATEWAY_UNREACHABLE', 'Connection closed before peer_ready'));
      });
    });

    ready.catch(() => { /* surfaced by `await ready` below */ });
    socket.send(JSON.stringify({
      type: 'peer_hello',
      protocolVersion: GATEWAY_PROTOCOL_V4,
      namespace: this.opts.namespace,
      clientProtocolVersion: this.opts.backendProtocolVersion ?? 1,
      peerType: 'client+backend',
      gatewaySecret: credential,
      ...(this.opts.identity ? { identity: this.opts.identity } : {}),
      backend: {
        visible: this.opts.visible ?? true,
        capabilities: this.opts.capabilities ?? [],
        backendProtocolVersion: this.opts.backendProtocolVersion ?? 1,
      },
    }));

    const readyMsg = await ready;
    if (!readyMsg.backend) throw new AttemptError('PROTOCOL_ERROR', 'Gateway did not assign a backend identity');
    this.backendId = readyMsg.backend.backendId;
    this.epoch = readyMsg.backend.epoch;

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let msg: Record<string, unknown> & { type?: string };
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'channel_offer') void this.handleOffer(msg as unknown as ChannelOfferMessage);
      for (const handler of this.messageHandlers) handler(msg);
    });
    socket.addEventListener('close', (event) => this.handleClose(socket, event?.code));

    const interval = this.opts.heartbeatIntervalMs ?? 10_000;
    this.heartbeatTimer = setInterval(() => {
      if (this.socket && this.socket.readyState === 1) {
        this.socket.send(JSON.stringify({ type: 'backend_heartbeat', epoch: this.epoch, observedAt: Date.now() }));
      }
    }, interval);

    this.reconnectAttempt = 0;
    this.failure = null;
    this.setState('connected');
    return { backendId: this.backendId, epoch: this.epoch };
  }

  private handleClose(socket: WebSocketLike, code?: number): void {
    if (this.socket !== socket) return; // stale socket from a previous session
    this.socket = null;
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (code === GATEWAY_CLOSE_BACKEND_REPLACED && !this.closed) {
      // Replaced, not dropped: stand down rather than replace the newer one back.
      this.failure = { code: 'REPLACED', message: ERROR_MESSAGES.REPLACED, occurredAt: Date.now() };
      this.setState('closed');
      return;
    }
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
      this.establish().catch((error: unknown) => {
        this.recordFailure(error);
        this.scheduleReconnect();
      });
    }, delay);
  }

  /** Exchange an enrollment credential for a short-lived access token. */
  /** The credential for the next handshake, and whether it came from the cache. */
  private async resolveCredential(): Promise<{ credential: string; cached: boolean }> {
    if (this.opts.exchangeEnrollment === false || !this.opts.credential.startsWith('zgb_')) {
      return { credential: this.opts.credential, cached: false };
    }
    const held = this.accessToken;
    if (held && (held.expiresAt === null || Date.now() < held.expiresAt - ACCESS_TOKEN_REFRESH_MARGIN_MS)) {
      return { credential: held.token, cached: true };
    }
    this.accessToken = null;
    const httpBase = this.wsBase.replace(/^ws/, 'http');
    let response: Response;
    try {
      response = await fetch(`${httpBase}/api/backend/token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.opts.credential}` },
      });
    } catch (error) {
      throw new AttemptError('GATEWAY_UNREACHABLE', error instanceof Error ? error.message : 'fetch failed', undefined, { cause: error });
    }
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? 'AUTH_FAILED' : 'GATEWAY_UNREACHABLE';
      throw new AttemptError(code, `Enrollment exchange failed: HTTP ${response.status}`);
    }
    const body = await response.json().catch(() => null) as { data?: { token?: unknown; expiresAt?: unknown } } | null;
    const token = body?.data?.token;
    if (typeof token !== 'string' || token === '') {
      throw new AttemptError('PROTOCOL_ERROR', 'Enrollment exchange returned no token');
    }
    const expiresAt = body?.data?.expiresAt;
    this.accessToken = { token, expiresAt: typeof expiresAt === 'number' ? expiresAt : null };
    return { credential: token, cached: false };
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

  publishTopic(topic: string, payload?: unknown, options?: { retain?: boolean }): void {
    if (!this.socket || this.socket.readyState !== 1) throw new Error('Not connected');
    this.socket.send(JSON.stringify({ type: 'topic_publish', topic, payload, retain: options?.retain }));
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
