import { getActiveLocale, type Locale } from './i18n.js';

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600_000],
  ['month', 30 * 24 * 3600_000],
  ['day', 24 * 3600_000],
  ['hour', 3600_000],
  ['minute', 60_000],
];

const rtfCache = new Map<Locale, Intl.RelativeTimeFormat>();

function relativeFormatter(): Intl.RelativeTimeFormat {
  const locale = getActiveLocale();
  let formatter = rtfCache.get(locale);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    rtfCache.set(locale, formatter);
  }
  return formatter;
}

/** "3 天前" / "3 days ago"; null (never) renders as "—". */
export function relativeTime(ts: number | null): string {
  if (ts === null) return '—';
  const delta = ts - Date.now();
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (Math.abs(delta) >= ms) {
      return relativeFormatter().format(Math.round(delta / ms), unit);
    }
  }
  return getActiveLocale() === 'zh-CN' ? '刚刚' : 'just now';
}

export function formatDateTime(ts: number | null): string {
  if (ts === null) return '—';
  return new Date(ts).toLocaleString(getActiveLocale(), {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
}

export function formatUptime(sec: number): string {
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (getActiveLocale() === 'zh-CN') {
    if (days > 0) return `${days} 天 ${hours} 小时`;
    if (hours > 0) return `${hours} 小时 ${minutes} 分`;
    return `${minutes} 分钟`;
  }
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
