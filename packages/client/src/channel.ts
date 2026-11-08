import { normalizeMessageData, waitForSocketOpen, type SocketFactory, type WaitForOpenOptions, type WebSocketLike } from './socket.js';

export interface ChannelMessage {
  data: string | Uint8Array;
  binary: boolean;
}

/** Options for {@link GatewayChannel.sendBounded}. */
export interface ChannelSendOptions {
  /**
   * Send budget in bytes: wait until the socket's `bufferedAmount` is at or
   * below this value before queueing the data. Default 4 MiB, matching the
   * gateway's per-channel relay high-water mark, so a sender that respects
   * the budget stays in step with the gateway's own backpressure.
   */
  lowWaterBytes?: number;
  /**
   * Bound the wait for buffer space. Rejects with an Error on expiry and the
   * data is never queued. Default 10 s.
   */
  timeoutMs?: number;
  /** Cancels the wait; rejects with the signal's reason, data never queued. */
  signal?: AbortSignal;
}

/** Default {@link ChannelSendOptions.lowWaterBytes}: the gateway relay's high-water mark. */
const DEFAULT_LOW_WATER_BYTES = 4 * 1024 * 1024;
/** Default {@link ChannelSendOptions.timeoutMs}. */
const DEFAULT_SEND_TIMEOUT_MS = 10_000;

function readBufferedAmount(socket: WebSocketLike): number {
  const value = (socket as WebSocketLike).bufferedAmount;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * A live data-plane channel: a dedicated WebSocket relayed verbatim by the
 * gateway (text/binary flags preserved). Closing it closes the whole
 * channel for both ends.
 */
export class GatewayChannel {
  readonly channelId: string;
  readonly kind?: string;
  private readonly socket: WebSocketLike;
  private messageHandlers: Array<(message: ChannelMessage) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private closed = false;
  private closeInitiated = false;
  /**
   * FIFO chain of in-flight sendBounded calls: bounded sends run strictly
   * one at a time, each observing the live bufferedAmount after the previous
   * one queued its data. Failures don't break the chain.
   */
  private boundedQueue: Promise<void> = Promise.resolve();
  /** The bounded send currently waiting for buffer space, woken on close. */
  private activeBoundedWait: { reject: (error: Error) => void } | null = null;

  constructor(channelId: string, socket: WebSocketLike, kind?: string) {
    this.channelId = channelId;
    this.kind = kind;
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const data = normalizeMessageData(event.data);
      const message: ChannelMessage = typeof data === 'string'
        ? { data, binary: false }
        : { data, binary: true };
      for (const handler of this.messageHandlers) handler(message);
    });
    socket.addEventListener('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.rejectActiveBoundedWait();
      for (const handler of this.closeHandlers) handler();
    });
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === 1;
  }

  /**
   * Bytes queued by the local socket implementation but not yet handed to
   * the OS — a snapshot of the local send buffer. 0 when the socket does not
   * report it (see {@link sendBufferObservable}).
   */
  get bufferedAmount(): number {
    return readBufferedAmount(this.socket);
  }

  /** Whether the socket reports a meaningful bufferedAmount at all. */
  get sendBufferObservable(): boolean {
    return typeof (this.socket as WebSocketLike).bufferedAmount === 'number';
  }

  send(data: string | Uint8Array): void {
    if (typeof data === 'string') this.socket.send(data);
    else this.socket.send(data);
  }

  /**
   * Bounded, ordered send: wait until the local send buffer is at or below
   * `lowWaterBytes` (default 4 MiB), then queue the data — the same
   * fire-and-forget `send()` underneath. Resolves once the bytes were
   * accepted into the *local* socket buffer; that is the only stage it can
   * prove. It does NOT mean the gateway or the peer received the data, nor
   * that any business processing completed — the protocol has no acks, and
   * none were added.
   *
   * Semantics:
   * - `sendBounded` calls are FIFO among themselves (each observes the live
   *   buffer after its predecessor queued); plain `send()` never waits and
   *   is not ordered against them.
   * - On timeout/abort/close the promise rejects and the data is never
   *   queued; nothing is sent partially.
   * - When the socket cannot report `bufferedAmount`, this degrades to an
   *   ordered immediate send (still timeout- and close-bounded).
   * - No busy loop: the drain wait polls on an adaptive timer (10→100 ms),
   *   and close/abort wake the waiter immediately.
   */
  async sendBounded(data: string | Uint8Array, options: ChannelSendOptions = {}): Promise<void> {
    const { lowWaterBytes = DEFAULT_LOW_WATER_BYTES, timeoutMs = DEFAULT_SEND_TIMEOUT_MS, signal } = options;
    if (this.closed || this.closeInitiated) throw new Error('Channel is closed');
    if (signal?.aborted) return Promise.reject(signal.reason);
    const run = this.boundedQueue.then(() => this.waitAndSend(data, lowWaterBytes, timeoutMs, signal));
    this.boundedQueue = run.catch(() => undefined);
    return run;
  }

  private async waitAndSend(
    data: string | Uint8Array,
    lowWaterBytes: number,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (this.closed || this.closeInitiated) throw new Error('Channel is closed');
    await this.waitForBufferSpace(lowWaterBytes, timeoutMs, signal);
    if (this.closed || this.closeInitiated) throw new Error('Channel closed while waiting to send');
    this.send(data);
  }

  /**
   * Wait until the live bufferedAmount is at or below the low-water mark.
   * Adaptive-interval polling (no implementation offers a drain event);
   * timeout, abort and channel close each settle the wait definitively and
   * clean up their timers and listeners.
   */
  private waitForBufferSpace(lowWaterBytes: number, timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
    if (readBufferedAmount(this.socket) <= lowWaterBytes) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined = undefined;
      let interval = 10;
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        if (pollTimer !== undefined) clearTimeout(pollTimer);
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        signal?.removeEventListener('abort', onAbort);
        if (this.activeBoundedWait === holder) this.activeBoundedWait = null;
        settle();
      };
      const holder = { reject: (error: Error) => finish(() => reject(error)) };
      const onAbort = () => holder.reject(signal!.reason instanceof Error ? signal!.reason : new Error(String(signal!.reason)));
      const poll = () => {
        if (settled) return;
        if (this.closed || this.closeInitiated) { holder.reject(new Error('Channel closed while waiting to send')); return; }
        if (readBufferedAmount(this.socket) <= lowWaterBytes) { finish(resolve); return; }
        interval = Math.min(interval * 2, 100);
        pollTimer = setTimeout(poll, interval);
      };
      this.activeBoundedWait = holder;
      deadlineTimer = setTimeout(() => {
        holder.reject(new Error(`sendBounded timed out after ${timeoutMs}ms waiting for buffer space (bufferedAmount=${readBufferedAmount(this.socket)}, lowWaterBytes=${lowWaterBytes})`));
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      // The abort event fires once: if the signal was already aborted while
      // this call sat in the FIFO chain, the listener never saw it.
      if (signal?.aborted) onAbort();
      pollTimer = setTimeout(poll, interval);
    });
  }

  private rejectActiveBoundedWait(): void {
    const waiter = this.activeBoundedWait;
    this.activeBoundedWait = null;
    waiter?.reject(new Error('Channel closed while waiting to send'));
  }

  onMessage(handler: (message: ChannelMessage) => void): () => void {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
    };
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.push(handler);
    return () => {
      this.closeHandlers = this.closeHandlers.filter((h) => h !== handler);
    };
  }

  close(): void {
    // Idempotent: a second close (SDK teardown + application close, or a
    // repeated call) must not touch the socket again.
    if (this.closed || this.closeInitiated) return;
    this.closeInitiated = true;
    this.rejectActiveBoundedWait();
    this.socket.close(1000);
  }
}

/** Dial a channel data socket and wrap it. `options` bound the dial wait. */
export async function dialChannel(
  wsBase: string,
  dataPath: string,
  ticket: string,
  channelId: string,
  factory: SocketFactory,
  kind?: string,
  options?: WaitForOpenOptions,
): Promise<GatewayChannel> {
  const socket = factory(`${wsBase}${dataPath}?ticket=${encodeURIComponent(ticket)}`);
  socket.binaryType = 'arraybuffer';
  try {
    await waitForSocketOpen(socket, options);
  } catch (error) {
    // A failed dial must not leave a half-open socket behind.
    try { socket.close(); } catch { /* already closed */ }
    throw error;
  }
  return new GatewayChannel(channelId, socket, kind);
}
