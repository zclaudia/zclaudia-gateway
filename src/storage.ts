import Database from 'better-sqlite3';
import crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

interface MemoryStorageState {
  credentials: Map<string, CredentialRecord>;
  /** v4: composite identity key → backend UUID */
  backendIdentities: Map<string, BackendIdentity>;
  maxEpoch: number;
}

const memoryStorageStates = new Map<string, MemoryStorageState>();

function isVitestProcess(): boolean {
  return process.argv.some((arg) => arg.includes('vitest'))
    || process.env.VITEST_POOL_ID !== undefined
    || process.env.VITEST_WORKER_ID !== undefined;
}

function getDataDir(): string {
  if (!process.env.ZCLAUDIA_DATA_DIR && process.argv.some((arg) => arg.includes('vitest'))) {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'zclaudia-gateway-test-'));
  }
  return process.env.ZCLAUDIA_DATA_DIR
    ? path.resolve(process.env.ZCLAUDIA_DATA_DIR, 'gateway')
    : path.join(os.homedir(), '.zclaudia', 'gateway');
}

function getDbPath(): string {
  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, 'gateway.db');
}

/**
 * Backends are keyed by (namespace, instanceId, environment) — with a
 * reserved tenant slot, always '' until multi-tenancy is actually needed —
 * and identified by a 128-bit UUID.
 */
export interface BackendIdentity {
  backendId: string;
  tenant: string;
  namespace: string;
  instanceId: string;
  environment: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Root credential (zgb_; a zga_ resolves to its parent) last seen
   * registering this identity — migration evidence for ADR-0008.
   */
  lastCredentialId: string | null;
  /** Last registration or offline transition. */
  lastSeenAt: number | null;
}

export function backendIdentityKey(namespace: string, instanceId: string, environment: string, tenant = ''): string {
  // \x1f (unit separator) cannot appear in these fields via JSON string
  // values in practice; prevents ambiguous concatenations.
  return [tenant, namespace, instanceId, environment].join('\x1f');
}

// ============================================================================
// Credentials (ADR-0002: gateway-native minimal auth)
// ============================================================================

/**
 * 'device' — client-only credential for user devices; cannot register a backend.
 * 'backend' — enrollment credential for a machine running an application backend.
 * 'backend-access' — short-lived credential exchanged from an enrollment
 *   credential (POST /api/backend/token); dies with its parent.
 */
export type CredentialType = 'device' | 'backend' | 'backend-access';

export const CREDENTIAL_TOKEN_PREFIXES: Record<CredentialType, string> = {
  device: 'zgd_',
  backend: 'zgb_',
  'backend-access': 'zga_',
};

/** Default TTL for device credentials (matches comfy gateway precedent). */
export const DEFAULT_DEVICE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** Default TTL for exchanged backend access credentials. */
export const DEFAULT_BACKEND_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;

export interface CredentialRecord {
  id: string;
  type: CredentialType;
  /** SHA-256 hex digest of the full token. Plaintext is never stored. */
  tokenHash: string;
  namespace: string;
  name: string;
  /** Issuing credential id for exchanged tokens (backend-access). */
  parentId: string | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
  /**
   * ADR-0008: the backend this credential *is* (backend and backend-access).
   * null = legacy backend credential, identity derived from the hello's
   * (namespace, instanceId, environment); always null for devices.
   */
  backendId: string | null;
  /**
   * ADR-0008: backends a device credential may reach. null = the whole
   * namespace (including backends added later); always null for backends.
   */
  allowedBackends: string[] | null;
}

/** Public view of a credential — everything except the token hash. */
export type CredentialInfo = Omit<CredentialRecord, 'tokenHash'>;

export function hashCredentialToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const CREDENTIAL_COLUMNS = `id, type, namespace, name, parent_id as parentId,
  created_at as createdAt, expires_at as expiresAt,
  revoked_at as revokedAt, last_used_at as lastUsedAt,
  backend_id as backendId, allowed_backends as allowedBackendsJson`;

type CredentialRow = Omit<CredentialRecord, 'allowedBackends'> & { allowedBackendsJson: string | null };

function credentialFromRow<T extends Partial<CredentialRow>>(row: T): Omit<T, 'allowedBackendsJson'> & { allowedBackends: string[] | null } {
  const { allowedBackendsJson, ...rest } = row;
  return { ...rest, allowedBackends: allowedBackendsJson ? JSON.parse(allowedBackendsJson) as string[] : null };
}

/** Identity key for a credential-bound backend; never collides with legacy keys, which start with the empty tenant. */
function boundIdentityKey(backendId: string): string {
  return `bound:${backendId}`;
}

function addColumnIfMissing(db: Database.Database, table: string, columnDef: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch {
    // Column already exists.
  }
}

export function initDatabase(dbPath: string = getDbPath()): Database.Database {
  const db = new Database(dbPath);

  // Create tables
  db.exec(`
    -- v2: monotonic counters for epoch and registry revision
    CREATE TABLE IF NOT EXISTS counters (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );

    -- Initialize counters if not present
    INSERT OR IGNORE INTO counters (key, value) VALUES ('max_epoch', 0);
    INSERT OR IGNORE INTO counters (key, value) VALUES ('registry_revision', 0);

    -- Phase 2 (v4): backend identities keyed by tenant+namespace+instance+environment
    CREATE TABLE IF NOT EXISTS backend_identities (
      identity_key TEXT PRIMARY KEY,
      backend_id TEXT UNIQUE NOT NULL,
      tenant TEXT NOT NULL DEFAULT '',
      namespace TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      environment TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Phase 1: revocable credentials (digests only, never plaintext)
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      namespace TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER,
      last_used_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_credentials_token_hash ON credentials(token_hash);

  `);

  // Additive migrations for pre-existing databases.
  addColumnIfMissing(db, 'credentials', 'parent_id TEXT');
  // ADR-0008: credential-bound backend identity and device backend scope.
  // NULL = legacy backend credential / whole-namespace device credential.
  addColumnIfMissing(db, 'credentials', 'backend_id TEXT');
  addColumnIfMissing(db, 'credentials', 'allowed_backends TEXT');
  addColumnIfMissing(db, 'backend_identities', 'last_credential_id TEXT');
  addColumnIfMissing(db, 'backend_identities', 'last_seen_at INTEGER');

  return db;
}

export class GatewayStorage {
  private db: Database.Database | null = null;
  private memoryState: MemoryStorageState | null = null;

  constructor(dbPath?: string) {
    try {
      this.db = initDatabase(dbPath);
    } catch (error) {
      if (!isVitestProcess()) throw error;
      const key = dbPath ?? getDbPath();
      let state = memoryStorageStates.get(key);
      if (!state) {
        state = {
          credentials: new Map(),
          backendIdentities: new Map(),
          maxEpoch: 0,
        };
        memoryStorageStates.set(key, state);
      }
      this.memoryState = state;
    }
  }

  /** Assert db is available (always true when memoryState is null) */
  private get sqlite(): Database.Database {
    return this.db!;
  }

  // =========================================================================
  // v2: Epoch management
  // =========================================================================

  /**
   * Allocate a new epoch (monotonically increasing).
   * Persisted to survive gateway restarts.
   */
  allocateEpoch(): number {
    if (this.memoryState) {
      this.memoryState.maxEpoch += 1;
      return this.memoryState.maxEpoch;
    }
    this.sqlite.prepare(`
      UPDATE counters SET value = value + 1 WHERE key = 'max_epoch'
    `).run();

    const row = this.sqlite.prepare(`
      SELECT value FROM counters WHERE key = 'max_epoch'
    `).get() as { value: number };

    return row.value;
  }

  /**
   * Get the current max epoch without incrementing.
   */
  getMaxEpoch(): number {
    if (this.memoryState) {
      return this.memoryState.maxEpoch;
    }
    const row = this.sqlite.prepare(`
      SELECT value FROM counters WHERE key = 'max_epoch'
    `).get() as { value: number };
    return row.value;
  }

  // =========================================================================
  // v4 Backend identity
  // =========================================================================

  /**
   * Get or create the stable UUID for a v4 backend identity. Same
   * (namespace, instanceId, environment) always maps to the same UUID;
   * any component differing yields a distinct backend.
   */
  getOrCreateBackendIdV4(input: { namespace: string; instanceId: string; environment: string; name?: string }): string {
    const key = backendIdentityKey(input.namespace, input.instanceId, input.environment);
    const now = Date.now();

    if (this.memoryState) {
      const existing = this.memoryState.backendIdentities.get(key);
      if (existing) {
        if (input.name && input.name !== existing.name) {
          existing.name = input.name;
          existing.updatedAt = now;
        }
        return existing.backendId;
      }
      const identity: BackendIdentity = {
        backendId: crypto.randomUUID(),
        tenant: '',
        namespace: input.namespace,
        instanceId: input.instanceId,
        environment: input.environment,
        name: input.name ?? '',
        createdAt: now,
        updatedAt: now,
        lastCredentialId: null,
        lastSeenAt: null,
      };
      this.memoryState.backendIdentities.set(key, identity);
      return identity.backendId;
    }

    const existing = this.sqlite.prepare(
      'SELECT backend_id as backendId, name FROM backend_identities WHERE identity_key = ?',
    ).get(key) as { backendId: string; name: string } | undefined;
    if (existing) {
      if (input.name && input.name !== existing.name) {
        this.sqlite.prepare('UPDATE backend_identities SET name = ?, updated_at = ? WHERE identity_key = ?')
          .run(input.name, now, key);
      }
      return existing.backendId;
    }
    const backendId = crypto.randomUUID();
    this.sqlite.prepare(`
      INSERT INTO backend_identities (identity_key, backend_id, tenant, namespace, instance_id, environment, name, created_at, updated_at)
      VALUES (?, ?, '', ?, ?, ?, ?, ?, ?)
    `).run(key, backendId, input.namespace, input.instanceId, input.environment, input.name ?? '', now, now);
    return backendId;
  }

  /** Create the identity row for a credential-bound backend; returns its new backendId. */
  private createBoundBackendIdentity(namespace: string, name: string): string {
    const backendId = crypto.randomUUID();
    const now = Date.now();
    if (this.memoryState) {
      this.memoryState.backendIdentities.set(boundIdentityKey(backendId), {
        backendId, tenant: '', namespace, instanceId: '', environment: '', name,
        createdAt: now, updatedAt: now, lastCredentialId: null, lastSeenAt: null,
      });
      return backendId;
    }
    this.sqlite.prepare(`
      INSERT INTO backend_identities (identity_key, backend_id, tenant, namespace, instance_id, environment, name, created_at, updated_at)
      VALUES (?, ?, '', ?, '', '', ?, ?, ?)
    `).run(boundIdentityKey(backendId), backendId, namespace, name, now, now);
    return backendId;
  }

  getBackendIdentity(backendId: string): BackendIdentity | undefined {
    return this.listBackendIdentities().find((identity) => identity.backendId === backendId);
  }

  /** Forget a backend identity row (admin cleanup of drifted/unused identities). */
  deleteBackendIdentity(backendId: string): boolean {
    if (this.memoryState) {
      for (const [key, identity] of this.memoryState.backendIdentities) {
        if (identity.backendId === backendId) {
          this.memoryState.backendIdentities.delete(key);
          return true;
        }
      }
      return false;
    }
    return this.sqlite.prepare('DELETE FROM backend_identities WHERE backend_id = ?').run(backendId).changes > 0;
  }

  /**
   * Record that a backend identity was seen: on registration with the root
   * credential that registered it, on going offline with no credential.
   */
  touchBackendIdentity(backendId: string, rootCredentialId?: string, name?: string): void {
    const now = Date.now();
    if (this.memoryState) {
      for (const identity of this.memoryState.backendIdentities.values()) {
        if (identity.backendId !== backendId) continue;
        identity.lastSeenAt = now;
        if (rootCredentialId) identity.lastCredentialId = rootCredentialId;
        if (name) identity.name = name;
      }
      return;
    }
    this.sqlite.prepare(`
      UPDATE backend_identities
      SET last_seen_at = ?, last_credential_id = COALESCE(?, last_credential_id), name = COALESCE(NULLIF(?, ''), name)
      WHERE backend_id = ?
    `).run(now, rootCredentialId ?? null, name ?? '', backendId);
  }

  /** All known backend identities, newest first. */
  listBackendIdentities(): BackendIdentity[] {
    if (this.memoryState) {
      return Array.from(this.memoryState.backendIdentities.values())
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((identity) => ({ ...identity }));
    }
    return this.sqlite.prepare(`
      SELECT backend_id as backendId, tenant, namespace, instance_id as instanceId,
             environment, name, created_at as createdAt, updated_at as updatedAt,
             last_credential_id as lastCredentialId, last_seen_at as lastSeenAt
      FROM backend_identities ORDER BY created_at DESC
    `).all() as BackendIdentity[];
  }

  // =========================================================================
  // Credentials (ADR-0002)
  // =========================================================================

  /**
   * Issue a new credential. Returns the record and the plaintext token —
   * the only time the plaintext ever exists; only its digest is stored.
   */
  createCredential(input: {
    type: CredentialType;
    namespace: string;
    name?: string;
    /** null = never expires. Undefined = type default (device 180d, backend-access 24h, backend none). */
    ttlMs?: number | null;
    /** Issuing credential id (backend-access only). */
    parentId?: string;
    /** backend: inherit an existing identity (rotation/migration); omitted = a new one. backend-access: the parent's. */
    backendId?: string | null;
    /** device only: null/omitted = whole namespace. */
    allowedBackends?: string[] | null;
  }): { credential: CredentialInfo; token: string } {
    const token = CREDENTIAL_TOKEN_PREFIXES[input.type] + crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const ttlMs = input.ttlMs === undefined
      ? (input.type === 'device' ? DEFAULT_DEVICE_TTL_MS
        : input.type === 'backend-access' ? DEFAULT_BACKEND_ACCESS_TTL_MS : null)
      : input.ttlMs;
    let backendId: string | null = null;
    if (input.type === 'backend') {
      backendId = input.backendId ?? this.createBoundBackendIdentity(input.namespace, input.name ?? '');
    } else if (input.type === 'backend-access') {
      backendId = input.backendId ?? null;
    }
    const allowedBackends = input.type === 'device' ? input.allowedBackends ?? null : null;
    const record: CredentialRecord = {
      id: crypto.randomUUID(),
      type: input.type,
      tokenHash: hashCredentialToken(token),
      namespace: input.namespace,
      name: input.name ?? '',
      parentId: input.parentId ?? null,
      createdAt: now,
      expiresAt: ttlMs === null ? null : now + ttlMs,
      revokedAt: null,
      lastUsedAt: null,
      backendId,
      allowedBackends,
    };

    if (this.memoryState) {
      this.memoryState.credentials.set(record.id, record);
    } else {
      this.sqlite.prepare(`
        INSERT INTO credentials (id, type, token_hash, namespace, name, parent_id, created_at, expires_at, revoked_at, last_used_at,
                                 backend_id, allowed_backends)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(record.id, record.type, record.tokenHash, record.namespace, record.name,
        record.parentId, record.createdAt, record.expiresAt, record.revokedAt, record.lastUsedAt,
        record.backendId, record.allowedBackends ? JSON.stringify(record.allowedBackends) : null);
    }
    const { tokenHash: _tokenHash, ...credential } = record;
    return { credential, token };
  }

  /**
   * Resolve a presented token to its credential if (and only if) it is
   * valid: known, not revoked, not expired. Touches lastUsedAt on success.
   */
  findValidCredential(token: string): CredentialInfo | null {
    const hash = hashCredentialToken(token);
    const now = Date.now();

    const record = this.getCredentialByHash(hash);
    if (!record) return null;
    if (record.revokedAt !== null) return null;
    if (record.expiresAt !== null && now > record.expiresAt) return null;
    // Exchanged tokens die with their issuing credential.
    if (record.parentId !== null) {
      const parent = this.getCredentialById(record.parentId);
      if (!parent || parent.revokedAt !== null || (parent.expiresAt !== null && now > parent.expiresAt)) {
        return null;
      }
    }

    if (this.memoryState) {
      record.lastUsedAt = now;
    } else {
      this.sqlite.prepare('UPDATE credentials SET last_used_at = ? WHERE id = ?').run(now, record.id);
    }
    const { tokenHash: _tokenHash, ...info } = record;
    return info;
  }

  private getCredentialByHash(hash: string): CredentialRecord | undefined {
    if (this.memoryState) {
      return Array.from(this.memoryState.credentials.values()).find((c) => c.tokenHash === hash);
    }
    const row = this.sqlite.prepare(`SELECT ${CREDENTIAL_COLUMNS}, token_hash as tokenHash FROM credentials WHERE token_hash = ?`)
      .get(hash) as CredentialRow | undefined;
    return row && credentialFromRow(row);
  }

  private getCredentialById(id: string): CredentialRecord | undefined {
    if (this.memoryState) {
      return this.memoryState.credentials.get(id);
    }
    const row = this.sqlite.prepare(`SELECT ${CREDENTIAL_COLUMNS}, token_hash as tokenHash FROM credentials WHERE id = ?`)
      .get(id) as CredentialRow | undefined;
    return row && credentialFromRow(row);
  }

  /** List all credentials (revoked and expired included), newest first. */
  listCredentials(): CredentialInfo[] {
    if (this.memoryState) {
      return Array.from(this.memoryState.credentials.values())
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((record) => {
          const { tokenHash: _tokenHash, ...info } = record;
          return info;
        });
    }
    const rows = this.sqlite.prepare(`SELECT ${CREDENTIAL_COLUMNS} FROM credentials ORDER BY created_at DESC`)
      .all() as Array<Omit<CredentialRow, 'tokenHash'>>;
    return rows.map(credentialFromRow);
  }

  /** Public view of one credential, or undefined. */
  getCredential(id: string): CredentialInfo | undefined {
    const record = this.getCredentialById(id);
    if (!record) return undefined;
    const { tokenHash: _tokenHash, ...info } = record;
    return info;
  }

  /**
   * Bind a legacy backend credential, and the access tokens exchanged from
   * it, to an existing backend identity (ADR-0008 in-place migration).
   * Returns false if the credential is not an unrevoked, unbound backend credential.
   */
  bindBackendCredential(id: string, backendId: string): boolean {
    if (this.memoryState) {
      const record = this.memoryState.credentials.get(id);
      if (!record || record.type !== 'backend' || record.revokedAt !== null || record.backendId !== null) return false;
      for (const c of this.memoryState.credentials.values()) {
        if ((c.id === id || c.parentId === id) && c.revokedAt === null) c.backendId = backendId;
      }
      return true;
    }
    const bound = this.sqlite.prepare(`
      UPDATE credentials SET backend_id = ?
      WHERE id = ? AND type = 'backend' AND revoked_at IS NULL AND backend_id IS NULL
    `).run(backendId, id);
    if (bound.changes === 0) return false;
    this.sqlite.prepare('UPDATE credentials SET backend_id = ? WHERE parent_id = ? AND revoked_at IS NULL')
      .run(backendId, id);
    return true;
  }

  /** Replace a device credential's backend scope (null = whole namespace). */
  setAllowedBackends(id: string, allowedBackends: string[] | null): boolean {
    if (this.memoryState) {
      const record = this.memoryState.credentials.get(id);
      if (!record || record.type !== 'device' || record.revokedAt !== null) return false;
      record.allowedBackends = allowedBackends;
      return true;
    }
    return this.sqlite.prepare(`
      UPDATE credentials SET allowed_backends = ? WHERE id = ? AND type = 'device' AND revoked_at IS NULL
    `).run(allowedBackends ? JSON.stringify(allowedBackends) : null, id).changes > 0;
  }

  /**
   * Revoke a credential by id, cascading to credentials exchanged from it.
   * Returns the ids actually revoked (empty = unknown or already revoked).
   */
  revokeCredential(id: string): string[] {
    const now = Date.now();
    if (this.memoryState) {
      const record = this.memoryState.credentials.get(id);
      if (!record || record.revokedAt !== null) return [];
      record.revokedAt = now;
      const revoked = [id];
      for (const child of this.memoryState.credentials.values()) {
        if (child.parentId === id && child.revokedAt === null) {
          child.revokedAt = now;
          revoked.push(child.id);
        }
      }
      return revoked;
    }
    const self = this.sqlite.prepare(
      'UPDATE credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    ).run(now, id);
    if (self.changes === 0) return [];
    const children = this.sqlite.prepare(
      'SELECT id FROM credentials WHERE parent_id = ? AND revoked_at IS NULL',
    ).all(id) as Array<{ id: string }>;
    this.sqlite.prepare(
      'UPDATE credentials SET revoked_at = ? WHERE parent_id = ? AND revoked_at IS NULL',
    ).run(now, id);
    return [id, ...children.map((c) => c.id)];
  }

  /**
   * Permanently delete revoked credentials — all of them, or only `ids`.
   * Credentials that are not revoked are never touched, whatever the ids say.
   * Safe for tokens: a revoked or missing row both fail authentication, and
   * exchanged tokens whose parent row is gone are rejected too.
   * Returns the ids actually deleted.
   */
  purgeRevokedCredentials(ids?: string[]): string[] {
    const wanted = ids ? new Set(ids) : null;
    if (this.memoryState) {
      const deleted: string[] = [];
      for (const record of this.memoryState.credentials.values()) {
        if (record.revokedAt !== null && (!wanted || wanted.has(record.id))) deleted.push(record.id);
      }
      for (const id of deleted) this.memoryState.credentials.delete(id);
      return deleted;
    }
    // Single statement, so the revoked check and the delete are atomic.
    const rows = (wanted
      ? this.sqlite.prepare(
        'DELETE FROM credentials WHERE revoked_at IS NOT NULL AND id IN (SELECT value FROM json_each(?)) RETURNING id',
      ).all(JSON.stringify([...wanted]))
      : this.sqlite.prepare('DELETE FROM credentials WHERE revoked_at IS NOT NULL RETURNING id').all()
    ) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  close(): void {
    this.db?.close();
  }
}
