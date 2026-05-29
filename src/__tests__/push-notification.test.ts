import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayPushNotificationService } from '../push-notification.js';

describe('GatewayPushNotificationService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses bearer auth for publish and test requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', fetchMock);

    const service = new GatewayPushNotificationService({
      enabled: true,
      ntfyUrl: 'https://ntfy.example.com',
      ntfyTopic: 'alerts',
      ntfyAuthMode: 'bearer',
      ntfyPublishToken: 'tk_publish',
      events: {
        permissionRequest: true,
        promptRequest: true,
        runCompleted: true,
        runFailed: true,
        backgroundPermission: true,
        processLeak: true,
      },
    });

    await service.notify({ type: 'run_failed', title: 'Title', body: 'Body' });
    await service.sendTest();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer tk_publish' }),
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer tk_publish' }),
    });
  });

  it('uses basic auth for publish requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', fetchMock);

    const service = new GatewayPushNotificationService({
      enabled: true,
      ntfyUrl: 'https://ntfy.example.com',
      ntfyTopic: 'alerts',
      ntfyAuthMode: 'basic',
      ntfyUsername: 'alice',
      ntfyPassword: 'secret',
      events: {
        permissionRequest: true,
        promptRequest: true,
        runCompleted: true,
        runFailed: true,
        backgroundPermission: true,
        processLeak: true,
      },
    });

    await service.notify({ type: 'run_completed', title: 'Title', body: 'Body' });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: `Basic ${Buffer.from('alice:secret').toString('base64')}`,
      }),
    });
  });
});
