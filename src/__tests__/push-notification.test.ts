import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayPushNotificationService } from '../push-notification.js';

const BACKEND_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('GatewayPushNotificationService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes backend events to the per-backend topic with bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', fetchMock);

    const service = new GatewayPushNotificationService({
      enabled: true,
      ntfyUrl: 'https://ntfy.example.com',
      ntfyTopic: 'alerts',
      ntfyAuthMode: 'bearer',
      ntfyPublishToken: 'tk_publish',
    });

    await service.notify({ name: 'zclaudia.run.failed', severity: 'error', title: 'Title', body: 'Body' }, BACKEND_ID);
    await service.sendTest(BACKEND_ID);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://ntfy.example.com/alerts-${BACKEND_ID}`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer tk_publish' }),
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`https://ntfy.example.com/alerts-${BACKEND_ID}`);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer tk_publish' }),
    });
  });

  it('uses the base topic when no backendId is given (test pings)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', fetchMock);

    const service = new GatewayPushNotificationService({
      enabled: true,
      ntfyUrl: 'https://ntfy.example.com',
      ntfyTopic: 'alerts',
      ntfyAuthMode: 'bearer',
      ntfyPublishToken: 'tk_publish',
    });

    await service.notify({ name: 'zclaudia.run.completed', title: 'Title', body: 'Body' });
    await service.sendTest();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://ntfy.example.com/alerts');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://ntfy.example.com/alerts');
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
    });

    await service.notify({ name: 'zclaudia.run.completed', severity: 'warning', title: 'Title', body: 'Body' }, BACKEND_ID);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://ntfy.example.com/alerts-${BACKEND_ID}`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: `Basic ${Buffer.from('alice:secret').toString('base64')}`,
      }),
    });
  });

  it('maps severity to ntfy priority and forwards tags and click url', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', fetchMock);

    const service = new GatewayPushNotificationService({
      enabled: true,
      ntfyUrl: 'https://ntfy.example.com',
      ntfyTopic: 'alerts',
    });

    await service.notify(
      {
        name: 'zclaudia.permission.request',
        severity: 'error',
        title: 'Title',
        body: 'Body',
        tags: ['permission_request'],
        clickUrl: 'https://app.example.com/?sessionId=s1',
      },
      BACKEND_ID
    );

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: 'Body',
      headers: expect.objectContaining({
        Title: 'Title',
        Priority: 'urgent',
        Tags: 'permission_request',
        Click: 'https://app.example.com/?sessionId=s1',
      }),
    });
  });
});
