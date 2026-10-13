/**
 * UI-side aliases of the canonical admin/auth DTOs from
 * @zclaudia/gateway-protocol, plus presentation-only helpers. The wire
 * shapes are owned by the protocol package; this file keeps only what is
 * specific to rendering the admin SPA.
 */

export type {
  AdminCredentialCounters,
  AdminOverview,
  AdminOverviewPeer,
  AdminBackendIdentity as BackendIdentity,
  AdminSessionInfo,
  BindBackendCredentialRequest,
  IssueCredentialRequest,
  IssuedGatewayCredential as IssuedCredential,
  RevokeCredentialsRequest,
  RevokeCredentialsResponse,
  UpdateCredentialRequest,
} from '@zclaudia/gateway-protocol/admin';
export type { AdminOverview as Overview } from '@zclaudia/gateway-protocol/admin';
export type {
  GatewayCredentialInfo as CredentialRecord,
  GatewayCredentialType as CredentialType,
} from '@zclaudia/gateway-protocol/auth';
export { GATEWAY_CREDENTIAL_TOKEN_PREFIXES as CREDENTIAL_TOKEN_PREFIXES } from '@zclaudia/gateway-protocol/auth';
import type { GatewayCredentialInfo as CredentialRecord } from '@zclaudia/gateway-protocol/auth';
import type { AdminBackendIdentity as BackendIdentity } from '@zclaudia/gateway-protocol/admin';

export type CredentialStatus = 'active' | 'revoked' | 'expired';

export function credentialStatus(c: CredentialRecord, now: number = Date.now()): CredentialStatus {
  if (c.revokedAt !== null) return 'revoked';
  if (c.expiresAt !== null && c.expiresAt <= now) return 'expired';
  return 'active';
}

/** Display name of a backend identity: its name, else instanceId, else a short backendId. */
export function identityLabel(b: BackendIdentity): string {
  return b.name || b.instanceId || `${b.backendId.slice(0, 8)}…`;
}

/**
 * Whether some usable backend credential can still reach this identity
 * (ADR-0009: device scopes should only list such identities). Bound
 * credentials or a live connection settle it; otherwise the last observed
 * credential must still be an active, unbound (legacy) one. Identities not
 * observed since tracking began get the benefit of the doubt — the server's
 * validation is authoritative.
 */
export function identityReachable(b: BackendIdentity, credentialsById: ReadonlyMap<string, CredentialRecord>): boolean {
  if (b.boundCredentials > 0 || b.online !== null || b.lastCredentialId === null) return true;
  const last = credentialsById.get(b.lastCredentialId);
  return last !== undefined && credentialStatus(last) === 'active' && last.backendId === null;
}
