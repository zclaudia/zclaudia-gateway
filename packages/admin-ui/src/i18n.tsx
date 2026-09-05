/**
 * Minimal i18n (zh-CN / en) — no external deps, matching the repo's
 * zero-dependency ethos. Locale auto-detects from the browser on first
 * visit, persists to localStorage, and is switchable at runtime.
 *
 * React components use I18nProvider + useI18n(); non-React modules (api.ts,
 * format.ts) read getActiveLocale()/formatMessage() directly.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Locale = 'zh-CN' | 'en';

const STORAGE_KEY = 'zclaudia_admin_locale';

const zh = {
  'app.checking': '正在检查会话…',
  'app.docTitle': 'zclaudia-gateway 管理控制台',
  'nav.consoleSubtitle': 'gateway 管理控制台',
  'nav.overview': '概览',
  'nav.credentials': '凭证管理',
  'nav.logout': '退出登录',
  'login.subtitle': '管理控制台 · 输入管理员令牌登录',
  'login.submit': '登录',
  'login.submitting': '登录中…',
  'login.hint': '令牌只在服务端换取会话 Cookie，不会保存在浏览器里。连续失败 10 次会触发限速。',
  'login.invalidToken': '管理员令牌无效',
  'login.rateLimited': '失败次数过多，请稍后再试',
  'login.failed': '登录失败',
  'overview.updatedAt': '更新于 {time} · 每 30 秒刷新',
  'overview.backends': '在线后端',
  'overview.connections': '在线连接',
  'overview.activeCreds': '活跃凭证',
  'overview.revokedCreds': '已吊销凭证',
  'overview.expiredCreds': '已过期凭证',
  'overview.uptime': '运行时长',
  'overview.typeDistribution': '凭证类型分布',
  'overview.onlinePeers': '在线连接（{count}）',
  'overview.noPeers': '当前没有在线连接。',
  'overview.deviceId': '设备 ID',
  'overview.protocolVersion': '协议版本',
  'overview.backendId': '后端 ID',
  'peer.clientOnly': '仅客户端',
  'peer.clientBackend': '客户端+后端',
  'creds.refresh': '刷新',
  'creds.issue': '签发凭证',
  'creds.noMatch': '没有匹配的凭证。',
  'creds.count': '共 {shown} / {total} 条凭证。',
  'creds.allTypes': '全部类型',
  'creds.allStatus': '全部状态',
  'creds.allNamespaces': '全部 Namespace',
  'creds.searchPlaceholder': '搜索名称 / namespace / ID',
  'creds.unnamed': '（未命名）',
  'creds.neverExpires': '永不过期',
  'creds.neverUsed': '从未',
  'creds.revoke': '吊销',
  'creds.actionFailed': '操作失败',
  'col.name': '名称',
  'col.type': '类型',
  'col.namespace': 'Namespace',
  'col.status': '状态',
  'col.createdAt': '创建于',
  'col.expiresAt': '过期时间',
  'col.lastUsed': '最近使用',
  'type.device': '设备',
  'type.backend': '后端注册',
  'type.backendAccess': '后端访问',
  'status.active': '活跃',
  'status.revoked': '已吊销',
  'status.expired': '已过期',
  'issue.title': '签发凭证',
  'issue.deviceOption': '设备凭证（zgd_）',
  'issue.backendOption': '后端注册凭证（zgb_）',
  'issue.submit': '签发',
  'issue.submitting': '签发中…',
  'issue.namespacePlaceholder': '例如 zclaudia',
  'issue.namePlaceholder': '例如 我的手机',
  'field.type': '类型',
  'field.namespaceRequired': 'Namespace（必填）',
  'field.nameOptional': '名称（可选）',
  'field.ttl': '有效期',
  'ttl.default': '默认（设备 180 天 / 后端永不过期）',
  'ttl.days': '{days} 天',
  'ttl.never': '永不过期',
  'token.title': '凭证已签发',
  'token.issuedAs': '{type} {namespace} / {name}',
  'token.warning': '⚠️ 令牌只显示这一次，关闭后无法再查看，请立即保存。',
  'token.copy': '复制',
  'token.copied': '已复制 ✓',
  'token.close': '我已保存，关闭',
  'revoke.title': '吊销凭证',
  'revoke.confirmPrefix': '确定吊销 ',
  'revoke.confirmSuffix': '（{type} · {namespace}）？',
  'revoke.warning': '吊销立即生效，使用该凭证的在线连接会被断开；由后端注册凭证换发的访问凭证会一并级联吊销。',
  'revoke.confirm': '确认吊销',
  'revoke.revoking': '吊销中…',
  'revoked.title': '已吊销 {count} 项',
  'revoked.cascadeHint': '包含级联吊销的派生凭证：',
  'common.loading': '加载中…',
  'common.loadFailed': '加载失败',
  'common.cancel': '取消',
  'common.close': '关闭',
  'api.networkError': '无法连接网关',
  'api.badResponse': '网关返回了无法解析的响应（{status}）',
  'api.requestFailed': '请求失败（{status}）',
  'api.rateLimited': '请求过于频繁，请稍后再试',
  'api.forbidden': 'Origin 校验失败',
  'api.unauthorized': '会话已失效，请重新登录',
} as const;

export type MsgKey = keyof typeof zh;

const en: Record<MsgKey, string> = {
  'app.checking': 'Checking session…',
  'app.docTitle': 'zclaudia-gateway Admin Console',
  'nav.consoleSubtitle': 'gateway admin console',
  'nav.overview': 'Overview',
  'nav.credentials': 'Credentials',
  'nav.logout': 'Sign out',
  'login.subtitle': 'Admin console · Sign in with the admin token',
  'login.submit': 'Sign in',
  'login.submitting': 'Signing in…',
  'login.hint': 'The token is exchanged for a server-side session cookie and is never stored in the browser. 10 consecutive failures trigger rate limiting.',
  'login.invalidToken': 'Invalid admin token',
  'login.rateLimited': 'Too many failed attempts — try again later',
  'login.failed': 'Sign-in failed',
  'overview.updatedAt': 'Updated {time} · refreshes every 30s',
  'overview.backends': 'Online backends',
  'overview.connections': 'Online connections',
  'overview.activeCreds': 'Active credentials',
  'overview.revokedCreds': 'Revoked credentials',
  'overview.expiredCreds': 'Expired credentials',
  'overview.uptime': 'Uptime',
  'overview.typeDistribution': 'Credentials by type',
  'overview.onlinePeers': 'Online connections ({count})',
  'overview.noPeers': 'No online connections.',
  'overview.deviceId': 'Device ID',
  'overview.protocolVersion': 'Protocol',
  'overview.backendId': 'Backend ID',
  'peer.clientOnly': 'Client only',
  'peer.clientBackend': 'Client + backend',
  'creds.refresh': 'Refresh',
  'creds.issue': 'Issue credential',
  'creds.noMatch': 'No matching credentials.',
  'creds.count': '{shown} / {total} credentials',
  'creds.allTypes': 'All types',
  'creds.allStatus': 'All statuses',
  'creds.allNamespaces': 'All namespaces',
  'creds.searchPlaceholder': 'Search name / namespace / ID',
  'creds.unnamed': '(unnamed)',
  'creds.neverExpires': 'Never expires',
  'creds.neverUsed': 'Never',
  'creds.revoke': 'Revoke',
  'creds.actionFailed': 'Operation failed',
  'col.name': 'Name',
  'col.type': 'Type',
  'col.namespace': 'Namespace',
  'col.status': 'Status',
  'col.createdAt': 'Created',
  'col.expiresAt': 'Expires',
  'col.lastUsed': 'Last used',
  'type.device': 'Device',
  'type.backend': 'Backend enrollment',
  'type.backendAccess': 'Backend access',
  'status.active': 'Active',
  'status.revoked': 'Revoked',
  'status.expired': 'Expired',
  'issue.title': 'Issue credential',
  'issue.deviceOption': 'Device credential (zgd_)',
  'issue.backendOption': 'Backend enrollment credential (zgb_)',
  'issue.submit': 'Issue',
  'issue.submitting': 'Issuing…',
  'issue.namespacePlaceholder': 'e.g. zclaudia',
  'issue.namePlaceholder': 'e.g. my phone',
  'field.type': 'Type',
  'field.namespaceRequired': 'Namespace (required)',
  'field.nameOptional': 'Name (optional)',
  'field.ttl': 'Validity',
  'ttl.default': 'Default (device 180 days / backend never expires)',
  'ttl.days': '{days} days',
  'ttl.never': 'Never expires',
  'token.title': 'Credential issued',
  'token.issuedAs': '{type} {namespace} / {name}',
  'token.warning': '⚠️ This token is shown only once — copy and store it now; it cannot be viewed again.',
  'token.copy': 'Copy',
  'token.copied': 'Copied ✓',
  'token.close': "I've saved it — close",
  'revoke.title': 'Revoke credential',
  'revoke.confirmPrefix': 'Revoke ',
  'revoke.confirmSuffix': ' ({type} · {namespace})?',
  'revoke.warning': 'Revocation takes effect immediately: live connections using the credential are disconnected, and backend-access credentials exchanged from an enrollment credential are revoked along with it.',
  'revoke.confirm': 'Confirm revoke',
  'revoke.revoking': 'Revoking…',
  'revoked.title': 'Revoked {count} item(s)',
  'revoked.cascadeHint': 'Includes cascade-revoked derived credentials:',
  'common.loading': 'Loading…',
  'common.loadFailed': 'Load failed',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'api.networkError': 'Cannot reach the gateway',
  'api.badResponse': 'Unparseable response from the gateway ({status})',
  'api.requestFailed': 'Request failed ({status})',
  'api.rateLimited': 'Too many requests — try again later',
  'api.forbidden': 'Origin check failed',
  'api.unauthorized': 'Session expired — sign in again',
};

const messages: Record<Locale, Record<MsgKey, string>> = {
  'zh-CN': zh,
  en,
};

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh-CN' || saved === 'en') return saved;
  } catch {
    // localStorage unavailable (privacy mode etc.) — fall through to detection
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')
    ? 'zh-CN'
    : 'en';
}

let activeLocale: Locale = detectLocale();

export function getActiveLocale(): Locale {
  return activeLocale;
}

/** Keep the module-level locale in sync for non-React consumers (api.ts, format.ts). */
export function setActiveLocale(locale: Locale): void {
  activeLocale = locale;
}

export function formatMessage(
  locale: Locale,
  key: MsgKey,
  params?: Record<string, string | number>,
): string {
  const template = messages[locale][key] ?? zh[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] !== undefined ? String(params[name]) : match);
}

export interface I18n {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MsgKey, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(activeLocale);

  const setLocale = useCallback((next: Locale) => {
    setActiveLocale(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // persistence is best-effort
    }
    setLocaleState(next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = formatMessage(locale, 'app.docTitle');
  }, [locale]);

  const value = useMemo<I18n>(() => ({
    locale,
    setLocale,
    t: (key, params) => formatMessage(locale, key, params),
  }), [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}
