/**
 * Gateway credential contracts — public metadata and exchange DTOs only.
 *
 * The gateway is the sole issuer; tokens are opaque to clients. Storage,
 * hashing, and issuance implementation stay inside the gateway server and
 * are deliberately not exported here.
 */

/** Credential kinds minted by the gateway. */
export type GatewayCredentialType = 'device' | 'backend' | 'backend-access';

/** Wire-visible token prefixes. Prefixes signal intent only; validity is decided server-side. */
export const GATEWAY_CREDENTIAL_TOKEN_PREFIXES: Record<GatewayCredentialType, string> = {
  device: 'zgd_',
  backend: 'zgb_',
  'backend-access': 'zga_',
};

/**
 * Public view of a credential as returned by the admin APIs: everything
 * except the token hash — and never the token itself after issuance.
 */
export interface GatewayCredentialInfo {
  id: string;
  type: GatewayCredentialType;
  namespace: string;
  name: string;
  /** Issuing credential id for exchanged tokens (backend-access). */
  parentId: string | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

/**
 * POST /api/backend/token response: exchange a backend enrollment credential
 * (zgb_) for a short-lived backend-access credential (zga_). Authenticated
 * with `Authorization: Bearer <zgb_…>`; the namespace is inherited from the
 * enrollment credential.
 */
export interface BackendTokenExchangeResponse {
  token: string;
  expiresAt: number | null;
  namespace: string;
}
