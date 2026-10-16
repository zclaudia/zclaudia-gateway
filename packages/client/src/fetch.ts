/**
 * Minimal WHATWG-shaped fetch abstraction for the gateway's HTTP surface
 * (backend discovery). Works with the global fetch in WebViews and Node
 * >= 18/21 alike; inject a custom implementation for anything else — the
 * same pattern as `SocketFactory`.
 */

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<FetchResponseLike>;

export function defaultFetch(url: string, init?: { headers?: Record<string, string> }): Promise<FetchResponseLike> {
  const impl = (globalThis as { fetch?: FetchLike }).fetch;
  if (!impl) {
    throw new Error('No global fetch available — pass a fetchImpl (e.g. from undici) to use HTTP helpers');
  }
  return impl(url, init);
}
