/**
 * ADR-0011 storage migration: databases written by the old
 * one-row-per-exchange behavior collapse to one backend-access row per
 * enrollment, and a unique index keeps it that way.
 */
import { test, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { GatewayStorage } from '../storage.js';

function freshDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-adr11-')), 'gateway.db');
}

test('duplicate access rows collapse to the unrevoked newest one per enrollment', () => {
  const dbPath = freshDbPath();
  // Bootstrap the schema, then plant pre-ADR-0011 duplicates behind the index's back
  const seed = new GatewayStorage(dbPath);
  const enrollment = seed.createCredential({ type: 'backend', namespace: 'ns', name: 'svc' }).credential;
  const other = seed.createCredential({ type: 'backend', namespace: 'ns', name: 'other' }).credential;
  seed.close();
  const raw = new Database(dbPath);
  raw.exec('DROP INDEX idx_credentials_access_per_parent');
  const insert = raw.prepare(`
    INSERT INTO credentials (id, type, token_hash, namespace, name, parent_id, created_at, expires_at, revoked_at, last_used_at)
    VALUES (?, 'backend-access', ?, 'ns', ?, ?, ?, NULL, ?, NULL)
  `);
  insert.run('old-1', 'h1', 'access:svc', enrollment.id, 1, null);
  insert.run('old-2', 'h2', 'access:svc', enrollment.id, 2, null); // newest unrevoked: kept
  insert.run('old-3', 'h3', 'access:svc', enrollment.id, 3, 3); // newer but revoked
  insert.run('other-1', 'h4', 'access:other', other.id, 1, null);
  raw.close();

  const storage = new GatewayStorage(dbPath);
  const access = storage.listCredentials().filter((c) => c.type === 'backend-access');
  expect(access.map((c) => c.id).sort()).toEqual(['old-2', 'other-1']);

  // Enforced from now on: exchanging rotates the surviving row
  const { credential, rotated } = storage.exchangeAccessCredential(storage.getCredential(enrollment.id)!);
  expect(rotated).toBe(true);
  expect(credential.id).toBe('old-2');
  const db = new Database(dbPath);
  expect(() => db.prepare(`
    INSERT INTO credentials (id, type, token_hash, namespace, name, parent_id, created_at)
    VALUES ('dup', 'backend-access', 'h9', 'ns', 'x', ?, 1)
  `).run(enrollment.id)).toThrow(/UNIQUE/);
  db.close();
  storage.close();
});
