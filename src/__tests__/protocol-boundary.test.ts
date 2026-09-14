import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BackendServerMessage, GatewayToPeerMessage } from '@zclaudia/gateway-protocol';

/**
 * Protocol boundary: the gateway server and both SDKs consume only
 * @zclaudia/gateway-protocol. The application protocol package
 * (@zclaudia/protocol) is off-limits — its business models must never leak
 * into gateway routing. This file is the single boundary check; it inspects
 * source files and dependency manifests directly.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** Source dirs of the gateway server and both SDKs (admin-ui is a private SPA). */
const SOURCE_DIRS = ['src', 'packages/client/src', 'packages/backend/src'] as const;
/** Manifests that must not declare the app protocol package. */
const MANIFESTS = ['package.json', 'packages/client/package.json', 'packages/backend/package.json', 'packages/protocol/package.json'] as const;

const FORBIDDEN_IMPORT_PREFIXES = [
  '@zclaudia/protocol',
  '@zclaudia/protocol/',
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (/\.(ts|tsx|mts|cts)$/.test(entry)) out.push(full);
  }
  return out;
}

function findForbiddenAppProtocolImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const offenders: string[] = [];
  const importPattern = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (FORBIDDEN_IMPORT_PREFIXES.some((prefix) => specifier === prefix || specifier.startsWith(prefix))) {
      offenders.push(specifier);
    }
  }
  return offenders;
}

describe('protocol boundary (gateway consumes gateway-protocol only)', () => {
  it('gateway server and SDK sources never import the app protocol package', () => {
    const offenders: string[] = [];
    for (const dir of SOURCE_DIRS) {
      for (const file of listTsFiles(join(REPO_ROOT, dir))) {
        for (const specifier of findForbiddenAppProtocolImports(file)) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('gateway manifests never declare the app protocol package as a dependency', () => {
    const offenders: string[] = [];
    for (const manifest of MANIFESTS) {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, manifest), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
        for (const name of Object.keys(pkg[section] ?? {})) {
          if (FORBIDDEN_IMPORT_PREFIXES.includes(name)) {
            offenders.push(`${manifest} [${section}]: ${name}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps application payloads opaque on the gateway-routed paths', () => {
    // Directed fallback: the gateway routes the envelope but must not
    // interpret `message`.
    const fallback: BackendServerMessage = {
      type: 'backend_server_message',
      backendId: 'backend-1',
      targetPeerSessionId: 'peer-1',
      message: { appSpecific: true },
    };
    expect(fallback.message).toEqual({ appSpecific: true });

    // Topic payloads are equally opaque.
    const topicPublish: Extract<GatewayToPeerMessage, { type: 'topic_message' }> = {
      type: 'topic_message',
      backendId: 'backend-1',
      topic: 'resources',
      payload: { zclaudiaBusiness: { sessions: [] } },
    };
    expect(topicPublish.payload).toMatchObject({ zclaudiaBusiness: {} });
  });

  it('declares the gateway protocol workspace package as the only protocol dependency', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['@zclaudia/gateway-protocol']).toMatch(/^workspace:/);
  });
});
