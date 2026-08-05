import type { PushNotificationRequestMessage } from '@zclaudia/protocol/gateway';
import { DEFAULT_NOTIFICATION_CONFIG } from '@zclaudia/protocol/notifications';
import type { NotificationAuthMode, NotificationConfig, NotificationSeverity } from '@zclaudia/protocol/notifications';

type NotifyEvent = PushNotificationRequestMessage['event'];

const SEVERITY_ORDER: Record<NotificationSeverity, number> = {
  info: 0,
  success: 1,
  warning: 2,
  error: 3,
};

/** ntfy priority per event severity. */
const SEVERITY_PRIORITY: Record<NotificationSeverity, string> = {
  info: 'default',
  success: 'default',
  warning: 'high',
  error: 'urgent',
};

/** Entry matches when equal to the event name or a dot-prefix of it
 *  (e.g. `zclaudia.run` matches `zclaudia.run.completed`). */
function matchesEntry(eventName: string, entry: string): boolean {
  return eventName === entry || eventName.startsWith(`${entry}.`);
}

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

  private normalizeList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
  }

  private normalizeConfig(config: Partial<NotificationConfig> = {}): NotificationConfig {
    return {
      ...DEFAULT_NOTIFICATION_CONFIG,
      ...config,
      ntfyAuthMode: this.normalizeAuthMode(config.ntfyAuthMode),
      ntfyPublishToken: this.normalizeString(config.ntfyPublishToken),
      ntfySubscribeToken: this.normalizeString(config.ntfySubscribeToken),
      ntfyUsername: this.normalizeString(config.ntfyUsername),
      ntfyPassword: typeof config.ntfyPassword === 'string' ? config.ntfyPassword : '',
      eventAllowlist: this.normalizeList(config.eventAllowlist),
      eventDenylist: this.normalizeList(config.eventDenylist),
      minSeverity:
        config.minSeverity && config.minSeverity in SEVERITY_ORDER ? config.minSeverity : undefined,
    };
  }

  /** Denylist wins; empty allowlist allows everything; minSeverity floors. */
  private shouldNotify(event: NotifyEvent): boolean {
    const { eventAllowlist, eventDenylist, minSeverity } = this.config;
    if (eventDenylist.some((entry) => matchesEntry(event.name, entry))) return false;
    if (eventAllowlist.length > 0 && !eventAllowlist.some((entry) => matchesEntry(event.name, entry))) {
      return false;
    }
    if (minSeverity) {
      const severity = event.severity ?? 'info';
      if (SEVERITY_ORDER[severity] < SEVERITY_ORDER[minSeverity]) return false;
    }
    return true;
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
    if (!this.shouldNotify(event)) return;

    const url = `${config.ntfyUrl.replace(/\/$/, '')}/${config.ntfyTopic}`;

    const headers: Record<string, string> = {
      Title: event.title,
      Priority: SEVERITY_PRIORITY[event.severity ?? 'info'],
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
