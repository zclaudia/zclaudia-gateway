import net from 'node:net';
import { defineConfig } from 'vitest/config';

async function canBindLoopback(): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = net.createServer();
    const finish = (result: boolean) => {
      clearTimeout(timer);
      probe.removeAllListeners('error');
      try {
        probe.close();
      } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), 200);
    probe.once('error', () => finish(false));
    probe.listen(0, '127.0.0.1', () => {
      probe.close(() => finish(true));
    });
  });
}

export default defineConfig(async () => {
  const loopbackAvailable = await canBindLoopback();
  if (!loopbackAvailable) {
    console.warn('[vitest] Loopback sockets unavailable, skipping gateway integration tests');
  }

  return {
    test: {
      globals: true,
      environment: 'node',
      setupFiles: ['./vitest.setup.ts'],
      testTimeout: 15000,
      hookTimeout: 15000,
      exclude: loopbackAvailable ? [] : [
        'src/__tests__/broadcast-subscription.test.ts',
        'src/__tests__/handshake-v2.test.ts',
        'src/__tests__/proxy-streaming-v2.test.ts',
        'src/__tests__/server-auth.test.ts',
        'src/__tests__/server-backend.test.ts',
        'src/__tests__/server-client.test.ts',
        'src/__tests__/server-errors.test.ts',
        'src/__tests__/server-http.test.ts',
      ],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html'],
        thresholds: {
          statements: 80,
          branches: 70,
          functions: 65,
          lines: 80,
        },
      },
    },
  };
});
