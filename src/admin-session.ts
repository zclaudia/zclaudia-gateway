/**
 * Admin web UI session store (ADR-0005).
 *
 * The admin web UI authenticates by exchanging GATEWAY_ADMIN_TOKEN once for
 * an opaque session cookie, so the long-lived admin token never lives in the
 * browser. Sessions are in-memory only: restarting the gateway logs every
 * admin session out — the accepted trade-off for a single-instance,
 * single-operator deployment. Sessions have a fixed expiry (no sliding
 * renewal): re-login at the same cadence as the TTL is the intended posture.
 */

import crypto from 'crypto';
import type { Request } from 'express';

export const ADMIN_SESSION_COOKIE = 'zclaudia_admin_session';

export interface IssuedAdminSession {
  id: string;
  expiresAt: number;
}

export class AdminSessionStore {
  private readonly sessions = new Map<string, { expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly sweeper: NodeJS.Timeout;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
    this.sweeper = setInterval(() => this.sweep(), 5 * 60_000);
  }

  create(): IssuedAdminSession {
    const id = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + this.ttlMs;
    this.sessions.set(id, { expiresAt });
    return { id, expiresAt };
  }

  validate(id: string): boolean {
    const entry = this.sessions.get(id);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.sessions.delete(id);
      return false;
    }
    return true;
  }

  expiresAt(id: string): number | null {
    const entry = this.sessions.get(id);
    if (!entry) return null;
    return entry.expiresAt;
  }

  destroy(id: string): void {
    this.sessions.delete(id);
  }

  sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now > entry.expiresAt) this.sessions.delete(id);
    }
  }

  dispose(): void {
    clearInterval(this.sweeper);
    this.sessions.clear();
  }
}

/** Read a named cookie from the request without pulling in a parser dep. */
export function readSessionCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === name) {
      return decodeURIComponent(pair.slice(eq + 1).trim());
    }
  }
  return null;
}
