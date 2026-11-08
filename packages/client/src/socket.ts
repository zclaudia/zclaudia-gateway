/**
 * Minimal WHATWG-shaped WebSocket abstraction. Works with browser/WebView
 * WebSocket, Node >= 21 native WebSocket, and the `ws` package (which also
 * implements addEventListener). Inject a custom factory for anything else.
 */

export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  /**
   * Bytes queued locally but not yet handed to the OS, when the
   * implementation reports it (browser/undici/ws WebSocket all do). No
   * implementation offers a drain event, so this is a poll-only signal;
   * sockets without the property are treated as 0 (unobservable).
   */
  readonly bufferedAmount?: number;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export type SocketFactory = (url: string) => WebSocketLike;

export function defaultSocketFactory(url: string): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (!Ctor) {
    throw new Error('No global WebSocket available — pass a socketFactory (e.g. from the ws package)');
  }
  return new Ctor(url) as WebSocketLike;
}

/** Normalize an inbound message event payload to string | Uint8Array. */
export function normalizeMessageData(data: unknown): string | Uint8Array {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  // ws 'nodebuffer' default or Blob-less environments
  return new Uint8Array(data as ArrayBufferLike);
}

export interface WaitForOpenOptions {
  /**
   * Bound the wait for the open event; rejects with an Error on expiry.
   * Default: unbounded (back-compat for external callers; the SDK always
   * passes a bound).
   */
  timeoutMs?: number;
  /** Rejects with the signal's reason when aborted. */
  signal?: AbortSignal;
}

/**
 * Wait for a socket to open. The socket itself stays the caller's
 * responsibility: on any rejection the caller must close it (the SDK's
 * connect/dial paths do). A close before open settles the wait — some stacks
 * tear a failed connection down without ever firing error.
 */
export function waitForSocketOpen(socket: WebSocketLike, options: WaitForOpenOptions = {}): Promise<void> {
  const { timeoutMs, signal } = options;
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(signal!.reason));
    socket.addEventListener('open', () => finish(resolve));
    socket.addEventListener('error', () => finish(() => reject(new Error('WebSocket error'))));
    socket.addEventListener('close', () => finish(() => reject(new Error('WebSocket closed before open'))));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => finish(() => reject(new Error(`WebSocket open timeout after ${timeoutMs}ms`))), timeoutMs);
    }
  });
}

/** Derive the ws(s) base URL (no path) from a gateway URL of any scheme. */
export function toWsBase(url: string): string {
  const parsed = new URL(url);
  const scheme = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 'wss:' : 'ws:';
  return `${scheme}//${parsed.host}`;
}

/** Derive the http(s) base URL (no path) from a gateway URL of any scheme. */
export function toHttpBase(url: string): string {
  const parsed = new URL(url);
  const scheme = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 'https:' : 'http:';
  return `${scheme}//${parsed.host}`;
}
