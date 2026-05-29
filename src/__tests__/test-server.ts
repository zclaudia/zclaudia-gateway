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
