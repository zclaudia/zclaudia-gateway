import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFICATION_CONFIG } from '@zclaudia/protocol/notifications';
import type { BackendClientMessage } from '@zclaudia/protocol/gateway';

describe('@zclaudia/protocol boundary', () => {
  it('exposes gateway protocol types without depending on shared app messages', () => {
    const message: BackendClientMessage = {
      type: 'backend_client_message',
      backendId: 'backend-1',
      message: { appSpecific: true },
    };

    expect(message.message).toEqual({ appSpecific: true });
  });

  it('exposes notification defaults for gateway runtime configuration', () => {
    expect(DEFAULT_NOTIFICATION_CONFIG).toMatchObject({
      enabled: false,
      ntfyUrl: 'https://ntfy.sh',
      ntfyAuthMode: 'none',
    });
  });
});
