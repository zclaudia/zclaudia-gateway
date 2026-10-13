/**
 * Gateway admin API contracts — public request/response DTOs for
 * /api/admin/session, /api/admin/overview, /api/admin/credentials and
 * /api/admin/backends.
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

/**
 * POST /api/admin/credentials/purge request body. Permanently deletes revoked
 * credentials; ids that are not revoked (or unknown) are ignored.
 */
export interface PurgeCredentialsRequest {
  /** Credential ids to delete; omitted = every revoked credential. */
  ids?: string[];
}

/** POST /api/admin/credentials/purge response: ids actually deleted. */
export interface PurgeCredentialsResponse {
  deleted: string[];
}

// ============================================================================
// Backend identities (ADR-0008)
// ============================================================================

/** One item of the GET /api/admin/backends data array. */
export interface AdminBackendIdentity {
  backendId: string;
  namespace: string;
  name: string;
  /** Legacy identity key components, self-reported by the backend. */
  instanceId: string;
  environment: string;
  createdAt: number;
  /** Last registration or offline transition; null if not seen since tracking began. */
  lastSeenAt: number | null;
  /**
   * Root backend credential (zgb_) last seen registering this identity;
   * null if not seen since tracking began. Migration evidence for binding.
   */
  lastCredentialId: string | null;
  /** null when offline. */
  online: { epoch: number; connectedAt: number } | null;
}
