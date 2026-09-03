/**
 * Unit tests for GatewayStorage: v4 backend identity and epoch allocation.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GatewayStorage } from '../storage.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('GatewayStorage', () => {
  let testDataDir: string;
  let dbPath: string;
  let storage: GatewayStorage;

  beforeEach(() => {
    testDataDir = path.join(os.tmpdir(), `gateway-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDataDir, { recursive: true });
    dbPath = path.join(testDataDir, 'test.db');
  });

  afterEach(() => {
    if (storage) storage.close();
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  describe('v4 backend identity', () => {
    test('mints a UUID and keeps it stable for the same identity tuple', () => {
      storage = new GatewayStorage(dbPath);
      const id1 = storage.getOrCreateBackendIdV4({ namespace: 'zclaudia', instanceId: 'inst-1', environment: 'prod' });
      expect(id1).toMatch(UUID_RE);
      const id2 = storage.getOrCreateBackendIdV4({ namespace: 'zclaudia', instanceId: 'inst-1', environment: 'prod' });
      expect(id2).toBe(id1);
    });

    test('any component of (namespace, instance, environment) differing yields a distinct backend', () => {
      storage = new GatewayStorage(dbPath);
      const base = storage.getOrCreateBackendIdV4({ namespace: 'a', instanceId: 'i', environment: 'prod' });
      const otherNs = storage.getOrCreateBackendIdV4({ namespace: 'b', instanceId: 'i', environment: 'prod' });
      const otherInst = storage.getOrCreateBackendIdV4({ namespace: 'a', instanceId: 'j', environment: 'prod' });
      const otherEnv = storage.getOrCreateBackendIdV4({ namespace: 'a', instanceId: 'i', environment: 'dev' });
      expect(new Set([base, otherNs, otherInst, otherEnv]).size).toBe(4);
    });

    test('identity survives reopening the database', () => {
      storage = new GatewayStorage(dbPath);
      const id1 = storage.getOrCreateBackendIdV4({ namespace: 'zclaudia', instanceId: 'persist', environment: 'prod' });
      storage.close();
      storage = new GatewayStorage(dbPath);
      const id2 = storage.getOrCreateBackendIdV4({ namespace: 'zclaudia', instanceId: 'persist', environment: 'prod' });
      expect(id2).toBe(id1);
    });

    test('name updates do not change the backendId', () => {
      storage = new GatewayStorage(dbPath);
      const id1 = storage.getOrCreateBackendIdV4({ namespace: 'a', instanceId: 'named', environment: 'prod', name: 'First' });
      const id2 = storage.getOrCreateBackendIdV4({ namespace: 'a', instanceId: 'named', environment: 'prod', name: 'Renamed' });
      expect(id2).toBe(id1);
    });
  });

  describe('epoch allocation', () => {
    test('allocates monotonically increasing epochs', () => {
      storage = new GatewayStorage(dbPath);
      const e1 = storage.allocateEpoch();
      const e2 = storage.allocateEpoch();
      expect(e2).toBeGreaterThan(e1);
      expect(storage.getMaxEpoch()).toBe(e2);
    });

    test('epochs survive reopening the database', () => {
      storage = new GatewayStorage(dbPath);
      const e1 = storage.allocateEpoch();
      storage.close();
      storage = new GatewayStorage(dbPath);
      expect(storage.allocateEpoch()).toBeGreaterThan(e1);
    });
  });
});
