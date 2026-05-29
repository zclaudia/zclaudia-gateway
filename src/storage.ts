import Database from 'better-sqlite3';
import crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

interface MemoryStorageState {
  devices: Map<string, DeviceMapping>;
  instances: Map<string, InstanceMapping>;
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

export interface DeviceMapping {
  deviceId: string;
  backendId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface InstanceMapping {
  instanceId: string;
  deviceId: string;
  backendId: string;
  channel: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export function initDatabase(dbPath: string = getDbPath()): Database.Database {
  const db = new Database(dbPath);

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_mappings (
      device_id TEXT PRIMARY KEY,
      backend_id TEXT UNIQUE NOT NULL,
      name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_backend_id ON device_mappings(backend_id);

    CREATE TABLE IF NOT EXISTS instance_mappings (
      instance_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      backend_id TEXT UNIQUE NOT NULL,
      channel TEXT,
      name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_instance_backend_id ON instance_mappings(backend_id);
    CREATE INDEX IF NOT EXISTS idx_instance_device_id ON instance_mappings(device_id);

    -- v2: monotonic counters for epoch and registry revision
    CREATE TABLE IF NOT EXISTS counters (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );

    -- Initialize counters if not present
    INSERT OR IGNORE INTO counters (key, value) VALUES ('max_epoch', 0);
    INSERT OR IGNORE INTO counters (key, value) VALUES ('registry_revision', 0);

  `);

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
          devices: new Map(),
          instances: new Map(),
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

  /**
   * Get or create a backendId for a deviceId
   * If the deviceId already exists, return the existing backendId
   * If not, create a new backendId and store the mapping
   */
  getOrCreateBackendId(deviceId: string, name?: string): string {
    if (this.memoryState) {
      const existing = this.memoryState.devices.get(deviceId);
      if (existing) {
        if (name && name !== existing.name) {
          existing.name = name;
          existing.updatedAt = Date.now();
        }
        return existing.backendId;
      }

      const backendId = this.generateBackendId();
      const now = Date.now();
      this.memoryState.devices.set(deviceId, {
        deviceId,
        backendId,
        name: name || '',
        createdAt: now,
        updatedAt: now,
      });
      return backendId;
    }

    const existing = this.sqlite.prepare(`
      SELECT backend_id, name FROM device_mappings WHERE device_id = ?
    `).get(deviceId) as { backend_id: string; name: string } | undefined;

    if (existing) {
      // Update name if provided and different
      if (name && name !== existing.name) {
        this.sqlite.prepare(`
          UPDATE device_mappings SET name = ?, updated_at = ? WHERE device_id = ?
        `).run(name, Date.now(), deviceId);
      }
      return existing.backend_id;
    }

    // Generate a new backendId (short, URL-safe)
    const backendId = this.generateBackendId();
    const now = Date.now();

    this.sqlite.prepare(`
      INSERT INTO device_mappings (device_id, backend_id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(deviceId, backendId, name || null, now, now);

    return backendId;
  }

  /**
   * Get or create a backendId by instanceId (supports same device with multiple channels)
   * If instanceId exists in instance_mappings, return existing backendId.
   * If not, try to migrate from device_mappings (one-time migration for existing devices).
   * Otherwise, generate a new backendId.
   */
  getOrCreateBackendIdByInstance(instanceId: string, deviceId: string, channel?: string, name?: string): string {
    if (this.memoryState) {
      const existing = this.memoryState.instances.get(instanceId);
      if (existing) {
        if (name && name !== existing.name) {
          existing.name = name;
          existing.updatedAt = Date.now();
        }
        return existing.backendId;
      }

      const ch = channel || 'prod';
      if (ch === 'prod') {
        const legacy = this.memoryState.devices.get(deviceId);
        const alreadyMigrated = legacy
          ? Array.from(this.memoryState.instances.values()).find((instance) => instance.backendId === legacy.backendId)
          : null;
        if (legacy && !alreadyMigrated) {
          const now = Date.now();
          this.memoryState.instances.set(instanceId, {
            instanceId,
            deviceId,
            backendId: legacy.backendId,
            channel: ch,
            name: name || legacy.name || '',
            createdAt: now,
            updatedAt: now,
          });
          return legacy.backendId;
        }
      }

      const backendId = this.generateBackendId();
      const now = Date.now();
      this.memoryState.instances.set(instanceId, {
        instanceId,
        deviceId,
        backendId,
        channel: ch,
        name: name || '',
        createdAt: now,
        updatedAt: now,
      });
      return backendId;
    }

    const existing = this.sqlite.prepare(`
      SELECT backend_id, name FROM instance_mappings WHERE instance_id = ?
    `).get(instanceId) as { backend_id: string; name: string } | undefined;

    if (existing) {
      if (name && name !== existing.name) {
        this.sqlite.prepare(`
          UPDATE instance_mappings SET name = ?, updated_at = ? WHERE instance_id = ?
        `).run(name, Date.now(), instanceId);
      }
      return existing.backend_id;
    }

    // Try to migrate from device_mappings (one-time migration for the default channel)
    const ch = channel || 'prod';
    if (ch === 'prod') {
      const legacy = this.sqlite.prepare(`
        SELECT backend_id, name FROM device_mappings WHERE device_id = ?
      `).get(deviceId) as { backend_id: string; name: string } | undefined;

      // Only migrate if this backendId is not already claimed by another instance
      if (legacy) {
        const alreadyMigrated = this.sqlite.prepare(`
          SELECT 1 FROM instance_mappings WHERE backend_id = ?
        `).get(legacy.backend_id);

        if (!alreadyMigrated) {
          const now = Date.now();
          this.sqlite.prepare(`
            INSERT INTO instance_mappings (instance_id, device_id, backend_id, channel, name, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(instanceId, deviceId, legacy.backend_id, ch, name || legacy.name || null, now, now);
          return legacy.backend_id;
        }
      }
    }

    // Generate new backendId
    const backendId = this.generateBackendId();
    const now = Date.now();
    this.sqlite.prepare(`
      INSERT INTO instance_mappings (instance_id, device_id, backend_id, channel, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(instanceId, deviceId, backendId, ch, name || null, now, now);

    return backendId;
  }

  /**
   * Get instance info by backendId
   */
  getInstanceByBackendId(backendId: string): InstanceMapping | undefined {
    if (this.memoryState) {
      return Array.from(this.memoryState.instances.values()).find((instance) => instance.backendId === backendId);
    }
    return this.sqlite.prepare(`
      SELECT instance_id as instanceId, device_id as deviceId, backend_id as backendId,
             channel, name, created_at as createdAt, updated_at as updatedAt
      FROM instance_mappings WHERE backend_id = ?
    `).get(backendId) as InstanceMapping | undefined;
  }

  /**
   * Get device info by backendId
   */
  getDeviceByBackendId(backendId: string): DeviceMapping | undefined {
    if (this.memoryState) {
      return Array.from(this.memoryState.devices.values()).find((device) => device.backendId === backendId);
    }
    const row = this.sqlite.prepare(`
      SELECT device_id as deviceId, backend_id as backendId, name,
             created_at as createdAt, updated_at as updatedAt
      FROM device_mappings WHERE backend_id = ?
    `).get(backendId) as DeviceMapping | undefined;

    return row;
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

  /**
   * Generate a short, URL-safe backendId
   */
  private generateBackendId(): string {
    return crypto.randomBytes(4).toString('hex');
  }

  close(): void {
    this.db?.close();
  }
}
