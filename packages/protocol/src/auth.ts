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
  /**
   * ADR-0009: the backend this credential is (backend and backend-access).
   * null = legacy backend credential whose identity is still derived from
   * the hello's (namespace, instanceId, environment); always null for devices.
   */
  backendId: string | null;
  /**
   * ADR-0009: backends a device credential may reach. null = the whole
   * namespace, including backends added later; always null for backends.
   */
  allowedBackends: string[] | null;
}

/**
 * POST /api/backend/token response: exchange a backend enrollment credential
 * (zgb_) for a short-lived backend-access credential (zga_). Authenticated
 * with `Authorization: Bearer <zgb_…>`; the namespace is inherited from the
 * enrollment credential. Each enrollment has one access credential, rotated
 * in place (ADR-0011): every exchange returns a new secret and the previous
 * one stops working.
 */
export interface BackendTokenExchangeResponse {
  token: string;
  expiresAt: number | null;
  namespace: string;
}
