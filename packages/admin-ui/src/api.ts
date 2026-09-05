import type { CredentialRecord, IssueCredentialRequest, IssuedCredential, Overview } from './types.js';
import { formatMessage, getActiveLocale, type MsgKey } from './i18n.js';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Thrown when the session is gone (expired/logout/restart) — the app shows the login view. */
export class UnauthorizedError extends ApiError {
  constructor() {
    super(401, 'UNAUTHORIZED', 'unauthorized');
  }
}

interface Envelope<T> { success: boolean; data?: T; error?: { code: string; message: string } }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'network error');
  }
  if (res.status === 401) {
    throw new UnauthorizedError();
  }
  let body: Envelope<T>;
  try {
    body = await res.json() as Envelope<T>;
  } catch {
    throw new ApiError(res.status, 'BAD_RESPONSE', `unparseable response (${res.status})`);
  }
  if (!res.ok || !body.success) {
    throw new ApiError(res.status, body.error?.code ?? 'UNKNOWN', body.error?.message ?? `request failed (${res.status})`);
  }
  return body.data as T;
}

/**
 * Map an error to the current locale for display. Known codes translate;
 * server-provided messages (e.g. field validation details) pass through as-is.
 */
export function localizeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    const known: Record<string, MsgKey> = {
      NETWORK_ERROR: 'api.networkError',
      BAD_RESPONSE: 'api.badResponse',
      RATE_LIMITED: 'api.rateLimited',
      FORBIDDEN: 'api.forbidden',
      UNAUTHORIZED: 'api.unauthorized',
    };
    const key = known[err.code];
    if (key) {
      return formatMessage(getActiveLocale(), key, err.status ? { status: err.status } : undefined);
    }
    if (err.code === 'UNKNOWN' && err.status) {
      return formatMessage(getActiveLocale(), 'api.requestFailed', { status: err.status });
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export interface SessionInfo { expiresAt: number }

export const api = {
  async login(token: string): Promise<SessionInfo> {
    return request<SessionInfo>('/api/admin/session', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  },

  async checkSession(): Promise<SessionInfo> {
    return request<SessionInfo>('/api/admin/session');
  },

  async logout(): Promise<void> {
    await request<null>('/api/admin/session', { method: 'DELETE' });
  },

  async overview(): Promise<Overview> {
    return request<Overview>('/api/admin/overview');
  },

  async listCredentials(): Promise<CredentialRecord[]> {
    return request<CredentialRecord[]>('/api/admin/credentials');
  },

  async issueCredential(req: IssueCredentialRequest): Promise<IssuedCredential> {
    return request<IssuedCredential>('/api/admin/credentials', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  },

  async revokeCredential(id: string): Promise<{ revoked: string[] }> {
    return request<{ revoked: string[] }>(`/api/admin/credentials/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },
};
