/**
 * Gateway admin API contracts — public request/response DTOs for
 * /api/admin/session, /api/admin/overview and /api/admin/credentials.
 *
 * Authentication is the admin token (Bearer) or an admin session cookie
 * issued by POST /api/admin/session. The admin token is an administrative
 * credential only — it must never be used as a peer handshake secret.
 */

import type { GatewayCredentialInfo } from './auth.js';

// ============================================================================
// Admin session (web UI): token-for-cookie exchange, probe, logout
// ============================================================================

/** POST /api/admin/session success body and GET /api/admin/session probe body. */
export interface AdminSessionInfo {
  expiresAt: number;
}

// ============================================================================
// Overview (read-only dashboard data)
// ============================================================================

export interface AdminOverviewPeer {
  peerSessionId: string;
  namespace: string;
  peerType: 'client-only' | 'client+backend';
  name: string;
  deviceId: string;
  protocolVersion: number;
  /** null when the peer is a pure client. */
  backendId: string | null;
}

export interface AdminCredentialCounters {
  total: number;
  active: number;
  revoked: number;
  expired: number;
  byType: Record<string, number>;
}

/** GET /api/admin/overview data body. */
export interface AdminOverview {
  backends: number;
  peers: AdminOverviewPeer[];
  credentials: AdminCredentialCounters;
  uptimeSec: number;
}

// ============================================================================
// Credential management
// ============================================================================

/** POST /api/admin/credentials request body. Only device and backend credentials can be minted here. */
export interface IssueCredentialRequest {
  type: 'device' | 'backend';
  namespace: string;
  name?: string;
  /** Lifetime in days; null = no expiry; omitted = gateway default. */
  ttlDays?: number | null;
}

/** POST /api/admin/credentials response: the public credential plus the one-time plaintext token. */
export type IssuedGatewayCredential = GatewayCredentialInfo & { token: string };

/** DELETE /api/admin/credentials/:id response; revocation also covers tokens exchanged from the credential. */
export interface RevokeCredentialResponse {
  revoked: string[];
}
