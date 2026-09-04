import type { Server } from 'http';
import type { AddressInfo } from 'net';

export interface TestServerUrls {
  port: number;
  wsUrl: string;
  httpUrl: string;
}

export async function listenTestServer(server: Server): Promise<TestServerUrls> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('error', onError);
      reject(error);
    };

    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve test server address');
  }

  const { port } = address as AddressInfo;
  return {
    port,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    httpUrl: `http://127.0.0.1:${port}`,
  };
}

export async function closeTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/** Admin token every test gateway is started with (shared secret is gone). */
export const TEST_ADMIN_TOKEN = 'test-admin-token';

/**
 * Issue a credential via the admin API. Accepts the ws or http base URL.
 * Backend (zgb_) tokens can hello as any peerType, so most tests need only
 * this one call per (server, namespace).
 */
export async function issueToken(
  urlBase: string,
  type: 'device' | 'backend',
  namespace: string,
): Promise<string> {
  const httpUrl = urlBase.replace(/^ws/, 'http').replace(/\/ws$/, '');
  const res = await fetch(`${httpUrl}/api/admin/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    body: JSON.stringify({ type, namespace, name: `test-${type}` }),
  });
  const body = await res.json() as { success: boolean; data?: { token: string } };
  if (!body.success || !body.data) throw new Error(`issueToken failed: ${res.status}`);
  return body.data.token;
}
