/**
 * Minimal WHATWG-shaped WebSocket abstraction. Works with browser/WebView
 * WebSocket, Node >= 21 native WebSocket, and the `ws` package (which also
 * implements addEventListener). Inject a custom factory for anything else.
 */

export interface WebSocketLike {
  binaryType: string;
  readyState: number;
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

export function waitForSocketOpen(socket: WebSocketLike): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', (err) => reject(err instanceof Error ? err : new Error('WebSocket error')));
  });
}

/** Derive the ws(s) base URL (no path) from a gateway URL of any scheme. */
export function toWsBase(url: string): string {
  const parsed = new URL(url);
  const scheme = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 'wss:' : 'ws:';
  return `${scheme}//${parsed.host}`;
}
