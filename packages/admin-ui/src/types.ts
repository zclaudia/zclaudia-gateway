/** Mirrors CredentialRecord from gateway src/storage.ts (type is not published). */
export type CredentialType = 'device' | 'backend' | 'backend-access';

export const CREDENTIAL_TOKEN_PREFIXES: Record<CredentialType, string> = {
  device: 'zgd_',
  backend: 'zgb_',
  'backend-access': 'zga_',
};

export interface CredentialRecord {
  id: string;
  type: CredentialType;
  namespace: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export type CredentialStatus = 'active' | 'revoked' | 'expired';

export function credentialStatus(c: CredentialRecord, now: number = Date.now()): CredentialStatus {
  if (c.revokedAt !== null) return 'revoked';
  if (c.expiresAt !== null && c.expiresAt <= now) return 'expired';
  return 'active';
}

export interface IssueCredentialRequest {
  type: 'device' | 'backend';
  namespace: string;
  name?: string;
  ttlDays?: number | null;
}

export interface IssuedCredential extends CredentialRecord {
  /** Plaintext token — returned exactly once at issuance, never again. */
  token: string;
}

export interface OverviewPeer {
  peerSessionId: string;
  namespace: string;
  peerType: 'client-only' | 'client+backend';
  name: string;
  deviceId: string;
  protocolVersion: number;
  backendId: string | null;
}

export interface Overview {
  backends: number;
  peers: OverviewPeer[];
  credentials: {
    total: number;
    active: number;
    revoked: number;
    expired: number;
    byType: Record<string, number>;
  };
  uptimeSec: number;
}
