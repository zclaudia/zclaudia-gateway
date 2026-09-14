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
  AdminSessionInfo,
  IssueCredentialRequest,
  IssuedGatewayCredential as IssuedCredential,
} from '@zclaudia/gateway-protocol/admin';
export type { AdminOverview as Overview } from '@zclaudia/gateway-protocol/admin';
export type {
  GatewayCredentialInfo as CredentialRecord,
  GatewayCredentialType as CredentialType,
} from '@zclaudia/gateway-protocol/auth';
export { GATEWAY_CREDENTIAL_TOKEN_PREFIXES as CREDENTIAL_TOKEN_PREFIXES } from '@zclaudia/gateway-protocol/auth';
import type { GatewayCredentialInfo as CredentialRecord } from '@zclaudia/gateway-protocol/auth';

export type CredentialStatus = 'active' | 'revoked' | 'expired';

export function credentialStatus(c: CredentialRecord, now: number = Date.now()): CredentialStatus {
  if (c.revokedAt !== null) return 'revoked';
  if (c.expiresAt !== null && c.expiresAt <= now) return 'expired';
  return 'active';
}
