import type { PushNotificationRequestMessage } from '@zclaudia/protocol/gateway';
import { DEFAULT_NOTIFICATION_CONFIG } from '@zclaudia/protocol/notifications';
import type { NotificationAuthMode, NotificationConfig } from '@zclaudia/protocol/notifications';

type NotifyEvent = PushNotificationRequestMessage['event'];

const EVENT_KEY_MAP: Record<NotifyEvent['type'], keyof NotificationConfig['events']> = {
  permission_request: 'permissionRequest',
  interaction_prompt: 'promptRequest',
  run_completed: 'runCompleted',
  run_failed: 'runFailed',
  background_permission: 'backgroundPermission',
  process_leak: 'processLeak',
};

export class GatewayPushNotificationService {
  private readonly config: NotificationConfig;

  constructor(config?: Partial<NotificationConfig>) {
    this.config = this.normalizeConfig(config);
  }

  getConfig(): NotificationConfig {
    return this.config;
  }

  private normalizeAuthMode(mode: unknown): NotificationAuthMode {
    return mode === 'bearer' || mode === 'basic' ? mode : 'none';
  }

  private normalizeString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private normalizeConfig(config: Partial<NotificationConfig> = {}): NotificationConfig {
    const rawEvents = config.events as Record<string, unknown> | undefined;
    const legacyPromptRequest = rawEvents?.askUserQuestion;

    // Start from defaults, then overlay only valid boolean values
    const events = { ...DEFAULT_NOTIFICATION_CONFIG.events };
    if (typeof legacyPromptRequest === 'boolean') {
      events.promptRequest = legacyPromptRequest;
    }
    if (rawEvents) {
      for (const key of Object.keys(events) as (keyof typeof events)[]) {
        if (typeof rawEvents[key] === 'boolean') {
          events[key] = rawEvents[key] as boolean;
        }
      }
    }

    return {
      ...DEFAULT_NOTIFICATION_CONFIG,
      ...config,
      ntfyAuthMode: this.normalizeAuthMode(config.ntfyAuthMode),
      ntfyPublishToken: this.normalizeString(config.ntfyPublishToken),
      ntfySubscribeToken: this.normalizeString(config.ntfySubscribeToken),
      ntfyUsername: this.normalizeString(config.ntfyUsername),
      ntfyPassword: typeof config.ntfyPassword === 'string' ? config.ntfyPassword : '',
      events,
    };
  }

  private applyPublishAuth(headers: Record<string, string>): void {
    const { ntfyAuthMode, ntfyPublishToken, ntfyUsername, ntfyPassword } = this.config;
    if (ntfyAuthMode === 'bearer' && ntfyPublishToken) {
      headers.Authorization = `Bearer ${ntfyPublishToken}`;
      return;
    }
    if (ntfyAuthMode === 'basic' && ntfyUsername && ntfyPassword) {
      headers.Authorization = `Basic ${Buffer.from(`${ntfyUsername}:${ntfyPassword}`).toString('base64')}`;
    }
  }

  async notify(event: NotifyEvent): Promise<void> {
    const config = this.config;
    if (!config.enabled || !config.ntfyTopic) return;

    const eventKey = EVENT_KEY_MAP[event.type];
    if (!eventKey || !config.events[eventKey]) return;

    const url = `${config.ntfyUrl.replace(/\/$/, '')}/${config.ntfyTopic}`;

    const headers: Record<string, string> = {
      Title: event.title,
      Priority: event.priority || 'default',
    };

    if (event.tags && event.tags.length > 0) {
      headers.Tags = event.tags.join(',');
    }

    if (event.clickUrl) {
      headers.Click = event.clickUrl;
    }
    this.applyPublishAuth(headers);

    try {
      await fetch(url, { method: 'POST', headers, body: event.body });
    } catch (err) {
      console.error('[Gateway/Notification] Failed to send ntfy notification:', err);
    }
  }

  async sendTest(): Promise<void> {
    const config = this.config;
    if (!config.ntfyTopic) {
      throw new Error('ntfy topic is not configured');
    }

    const url = `${config.ntfyUrl.replace(/\/$/, '')}/${config.ntfyTopic}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Title: 'ZClaudia - Test Notification',
        Priority: 'default',
        Tags: 'white_check_mark',
        ...((): Record<string, string> => {
          const authHeaders: Record<string, string> = {};
          this.applyPublishAuth(authHeaders);
          return authHeaders;
        })(),
      },
      body: 'If you see this, notifications are working!',
    });

    if (!response.ok) {
      throw new Error(`ntfy returned ${response.status}: ${response.statusText}`);
    }
  }
}
