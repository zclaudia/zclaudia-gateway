#!/usr/bin/env node
// Boots the real gateway (from the repo's built dist/) for contract tests.
//
// Usage: node start-gateway.mjs <path-to-dist/server.js> [admin-token]
//
// Prints one JSON line to stdout before serving:
//   {"httpUrl":"http://127.0.0.1:<port>","wsUrl":"ws://127.0.0.1:<port>/ws","adminToken":"..."}
// State goes to a fresh temp dir (ZCLAUDIA_DATA_DIR) so real data is untouched.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const serverModule = resolve(process.argv[2] ?? 'dist/server.js');
const adminToken = process.argv[3] ?? process.env.GATEWAY_ADMIN_TOKEN ?? 'contract-admin-token';

process.env.ZCLAUDIA_DATA_DIR = mkdtempSync(join(tmpdir(), 'gateway-contract-'));

const { createGatewayServer } = await import(pathToFileURL(serverModule).href);

const server = createGatewayServer({ adminToken });

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(
    JSON.stringify({
      httpUrl: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}/ws`,
      adminToken,
    }),
  );
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
