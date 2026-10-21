import { afterEach, expect, test } from 'vitest';
import { createGatewayServer } from '../server.js';
import { closeTestServer, listenTestServer, TEST_ADMIN_TOKEN } from './test-server.js';

const servers: ReturnType<typeof createGatewayServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await closeTestServer(server);
});

test('cached preflights preserve the origin allowlist and request authentication', async () => {
  const origin = 'http://sugaring.localhost';
  const server = createGatewayServer({ adminToken: TEST_ADMIN_TOKEN, allowedOrigins: [origin] });
  servers.push(server);
  const { httpUrl } = await listenTestServer(server);
  const path = `${httpUrl}/api/proxy/unknown/records`;
  const preflight = await fetch(path, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-max-age')).toBe('600');
  expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
  expect((await fetch(path, { headers: { Origin: origin } })).status).toBe(401);
  const refused = await fetch(path, { method: 'OPTIONS', headers: { Origin: 'https://untrusted.test' } });
  expect(refused.headers.get('access-control-allow-origin')).toBeNull();
});
