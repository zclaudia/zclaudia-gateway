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
  'nav.backends': '后端',
  'backends.hint': '网关已知的全部后端身份（ADR-0009）。"已绑定"的身份由后端注册凭证授予：持凭证连接即为该后端，后端 ID 固定不变；轮换时为它签发继承同一后端 ID 的新凭证，再吊销旧凭证。"旧版"身份还没有绑定的凭证，仍由旧版凭证按 instanceId/环境注册；"最近凭证"是最近一次注册它的后端注册凭证，可据此在凭证管理中迁移（原地绑定）。已离线且没有绑定凭证的废弃身份可以删除。',
  'backends.colBinding': '绑定',
  'backends.legacyTitle': '没有绑定的后端凭证，只有旧版凭证能注册到这个身份',
  'backends.deleteTitle': '删除后端身份',
  'backends.deleteConfirm': '将删除后端身份 ',
  'backends.deleteWarning': '仅用于清理 instanceId 漂移遗留的废弃身份。若仍有旧版后端在使用它，该后端下次连接时会得到一个新的后端 ID，配置了旧 ID 的客户端和设备访问范围都会失效。',
  'backends.deleting': '删除中…',
  'backends.online': '在线',
  'backends.offline': '离线',
  'backends.onlineSince': '自 {time} 在线 · epoch {epoch}',
  'backends.searchPlaceholder': '搜索名称 / namespace / instanceId / 后端 ID',
  'backends.colInstance': 'instanceId · 环境',
  'backends.colLastSeen': '最近在线',
  'backends.colLastCredential': '最近凭证',
  'backends.notObserved': '尚未观测',
  'backends.credentialGone': '已删除',
  'backends.noMatch': '没有匹配的后端。',
  'backends.count': '共 {shown} / {total} 个后端。',
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
  'overview.backendIdentities': '已知后端身份',
  'overview.legacyPending': '{count} 张后端凭证待迁移',
  'overview.legacyPendingHint': ' — 在凭证管理中把它们绑定到后端身份（ADR-0009）',
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
  'creds.searchPlaceholder': '搜索名称 / namespace / ID / 后端 ID',
  'creds.hideExpiredAccess': '隐藏已过期的后端访问凭证',
  'creds.unnamed': '（未命名）',
  'creds.neverExpires': '永不过期',
  'creds.neverUsed': '从未',
  'creds.revoke': '吊销',
  'creds.delete': '删除',
  'creds.migrate': '迁移',
  'creds.editScope': '编辑范围',
  'binding.legacy': '旧版',
  'binding.legacyTitle': '尚未绑定后端身份，后端 ID 仍按 instanceId/环境推导（ADR-0009）',
  'binding.bound': '已绑定 {count}',
  'scope.all': '全部后端',
  'scope.count': '{count} 个后端',
  'scope.stale': '已失效',
  'scope.staleCount': '{count} 个已失效',
  'scope.title': '编辑访问范围',
  'scope.disconnectWarning': '保存后会断开该凭证当前的所有在线连接，设备重连后按新范围生效。',
  'scope.save': '保存范围',
  'scope.saving': '保存中…',
  'scope.droppedUnknown': '已从选择中移除 {count} 个已删除的后端，保存后生效。',
  'scope.allOption': '全部后端',
  'scope.specificOption': '指定后端',
  'scope.allHint': '可访问该 namespace 下的全部后端，包括以后新增的后端。',
  'scope.specificHint': '只能访问勾选的后端；以后新增的后端不会自动加入。',
  'identity.new': '新建',
  'identity.inherit': '继承已有身份',
  'identity.newHint': '签发时生成新的后端 ID，会显示在签发结果中，可直接配置到客户端。',
  'identity.inheritHint': '用于轮换与迁移：新凭证沿用所选后端 ID，客户端无需改动。同一后端 ID 同时只有一个连接在线，新连接会顶替旧连接；轮换时签发后再吊销旧凭证。',
  'identity.select': '选择后端身份…',
  'identity.noneInNamespace': '该 namespace 下没有已知的后端身份。',
  'migrate.title': '迁移旧版后端凭证',
  'migrate.intro': '这张凭证尚未绑定后端身份。绑定只是把后端 ID 写到凭证上：token 不变、无需重新部署，后端 ID 也保持不变，客户端无感。',
  'migrate.single': '观测到这张凭证注册过以下后端身份，可直接原地绑定：',
  'migrate.shared': '观测到这张凭证被 {count} 个后端共用。选择一个原地绑定到这张凭证；其余后端各自签发一张继承其后端 ID 的新凭证并替换部署。',
  'migrate.sharedWarning': '建议先完成其余后端的替换部署再绑定：绑定后仍使用这张凭证的其他后端会顶替所选后端。',
  'migrate.issueInheriting': '签发继承凭证',
  'migrate.none': '自开始记录以来，未观测到这张凭证注册过任何后端（后端可能长期离线）。可以暂不处理，等后端连接一次后再迁移；也可以手动选择该 namespace 中的后端身份。',
  'migrate.manualWarning': '手动选择没有观测依据：若选错，使用这张凭证的后端下次连接会顶替所选后端。',
  'migrate.bindTo': '绑定到 {name}',
  'migrate.bind': '绑定',
  'migrate.binding': '绑定中…',
  'creds.purgeRevoked': '清理已吊销（{count}）',
  'purge.title': '清理已吊销凭证',
  'purge.confirmAll': '将永久删除全部 {count} 个已吊销凭证记录。',
  'purge.confirmOne': '将永久删除已吊销凭证 ',
  'purge.warning': '删除后无法恢复，记录也会从列表中消失。这些凭证本来就已失效，不影响任何在线连接。',
  'purge.confirm': '确认删除',
  'purge.purging': '删除中…',
  'creds.actionFailed': '操作失败',
  'col.name': '名称',
  'col.type': '类型',
  'col.namespace': 'Namespace',
  'col.backendScope': '后端 / 范围',
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
  'field.backendIdentity': '后端身份',
  'field.scope': '访问范围',
  'ttl.default': '默认（设备 180 天 / 后端永不过期）',
  'ttl.days': '{days} 天',
  'ttl.never': '永不过期',
  'token.title': '凭证已签发',
  'token.issuedAs': '{type} {namespace} / {name}',
  'token.warning': '⚠️ 令牌只显示这一次，关闭后无法再查看，请立即保存。',
  'token.backendId': '后端 ID（配置到客户端）',
  'token.copy': '复制',
  'token.copied': '已复制 ✓',
  'token.close': '我已保存，关闭',
  'revoke.title': '吊销凭证',
  'revoke.confirmPrefix': '确定吊销 ',
  'revoke.confirmSuffix': '（{type} · {namespace}）？',
  'revoke.warning': '吊销立即生效，使用该凭证的在线连接会被断开；由后端注册凭证换发的访问凭证会一并级联吊销。',
  'revoke.confirm': '确认吊销',
  'revoke.confirmMany': '确定吊销所选的 {count} 个凭证？',
  'revoke.andMore': '……以及另外 {count} 个',
  'revoked.skipped': '{count} 个凭证未找到或已被吊销，已跳过。',
  'bulk.selected': '已选 {count} 项',
  'bulk.revoke': '吊销所选',
  'bulk.clear': '取消选择',
  'bulk.selectAll': '全选当前列表中可吊销的凭证',
  'bulk.selectRow': '选择 {name}',
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
  'nav.backends': 'Backends',
  'backends.hint': 'Every backend identity the gateway knows (ADR-0009). A "bound" identity is granted by backend enrollment credentials: whoever connects with one is that backend, and its backend ID never changes. To rotate, issue a new credential inheriting the same backend ID, then revoke the old one. A "legacy" identity has no bound credential yet and is still registered by legacy credentials via instanceId/environment; "last credential" is the enrollment credential that last registered it — the evidence for migrating (binding in place) under Credentials. Offline identities with no bound credentials can be deleted.',
  'backends.colBinding': 'Binding',
  'backends.legacyTitle': 'No bound backend credentials; only legacy credentials register this identity',
  'backends.deleteTitle': 'Delete backend identity',
  'backends.deleteConfirm': 'This deletes the backend identity ',
  'backends.deleteWarning': 'Meant for cleaning up identities orphaned by instanceId drift. If a legacy backend still uses it, that backend gets a new backend ID on its next connection, and clients configured with the old ID and device scopes listing it stop working.',
  'backends.deleting': 'Deleting…',
  'backends.online': 'Online',
  'backends.offline': 'Offline',
  'backends.onlineSince': 'Online since {time} · epoch {epoch}',
  'backends.searchPlaceholder': 'Search name / namespace / instanceId / backend ID',
  'backends.colInstance': 'instanceId · env',
  'backends.colLastSeen': 'Last seen',
  'backends.colLastCredential': 'Last credential',
  'backends.notObserved': 'Not observed yet',
  'backends.credentialGone': 'Deleted',
  'backends.noMatch': 'No matching backends.',
  'backends.count': '{shown} / {total} backends',
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
  'overview.backendIdentities': 'Known backend identities',
  'overview.legacyPending': '{count} backend credential(s) awaiting migration',
  'overview.legacyPendingHint': ' — bind them to backend identities under Credentials (ADR-0009)',
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
  'creds.searchPlaceholder': 'Search name / namespace / ID / backend ID',
  'creds.hideExpiredAccess': 'Hide expired backend-access tokens',
  'creds.unnamed': '(unnamed)',
  'creds.neverExpires': 'Never expires',
  'creds.neverUsed': 'Never',
  'creds.revoke': 'Revoke',
  'creds.delete': 'Delete',
  'creds.migrate': 'Migrate',
  'creds.editScope': 'Edit scope',
  'binding.legacy': 'Legacy',
  'binding.legacyTitle': 'Not bound to a backend identity yet; its backend ID is still derived from instanceId/environment (ADR-0009)',
  'binding.bound': 'Bound ({count})',
  'scope.all': 'All backends',
  'scope.count': '{count} backend(s)',
  'scope.stale': 'stale',
  'scope.staleCount': '{count} stale',
  'scope.title': 'Edit access scope',
  'scope.disconnectWarning': "Saving disconnects all of this credential's live connections; the new scope applies when the device reconnects.",
  'scope.save': 'Save scope',
  'scope.saving': 'Saving…',
  'scope.droppedUnknown': 'Removed {count} deleted backend(s) from the selection; takes effect on save.',
  'scope.allOption': 'All backends',
  'scope.specificOption': 'Specific backends',
  'scope.allHint': 'Can reach every backend in the namespace, including backends added later.',
  'scope.specificHint': 'Can reach only the checked backends; backends added later are not included.',
  'identity.new': 'New',
  'identity.inherit': 'Inherit existing',
  'identity.newHint': 'A new backend ID is generated at issuance and shown with the token, ready to configure in clients.',
  'identity.inheritHint': 'For rotation and migration: the new credential keeps the selected backend ID, so clients need no change. Only one connection per backend ID is live — a new one replaces the old. When rotating, issue first, then revoke the old credential.',
  'identity.select': 'Select a backend identity…',
  'identity.noneInNamespace': 'No known backend identities in this namespace.',
  'migrate.title': 'Migrate legacy backend credential',
  'migrate.intro': 'This credential is not bound to a backend identity yet. Binding only records the backend ID on the credential: the token stays the same, nothing is redeployed, and the backend ID does not change, so clients are unaffected.',
  'migrate.single': 'This credential was observed registering the following backend identity — bind it in place:',
  'migrate.shared': 'This credential was observed being shared by {count} backends. Pick one to bind to this credential in place; for each of the others, issue a new credential inheriting its backend ID and redeploy that backend with it.',
  'migrate.sharedWarning': 'Redeploy the other backends before binding: afterwards, any other backend still using this credential would replace the selected one.',
  'migrate.issueInheriting': 'Issue inheriting credential',
  'migrate.none': 'This credential has not been observed registering any backend since tracking began (the backend may have been offline for a long time). You can leave it until the backend connects once and migrate then, or pick a backend identity in this namespace by hand.',
  'migrate.manualWarning': 'A manual choice has no observed evidence: if it is wrong, the backend using this credential will replace the selected backend on its next connection.',
  'migrate.bindTo': 'Bind to {name}',
  'migrate.bind': 'Bind',
  'migrate.binding': 'Binding…',
  'creds.purgeRevoked': 'Clean up revoked ({count})',
  'purge.title': 'Clean up revoked credentials',
  'purge.confirmAll': 'This permanently deletes all {count} revoked credential record(s).',
  'purge.confirmOne': 'This permanently deletes the revoked credential ',
  'purge.warning': 'This cannot be undone and the records disappear from the list. They are already invalid, so no live connection is affected.',
  'purge.confirm': 'Confirm delete',
  'purge.purging': 'Deleting…',
  'creds.actionFailed': 'Operation failed',
  'col.name': 'Name',
  'col.type': 'Type',
  'col.namespace': 'Namespace',
  'col.backendScope': 'Backend / scope',
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
  'field.backendIdentity': 'Backend identity',
  'field.scope': 'Access scope',
  'ttl.default': 'Default (device 180 days / backend never expires)',
  'ttl.days': '{days} days',
  'ttl.never': 'Never expires',
  'token.title': 'Credential issued',
  'token.issuedAs': '{type} {namespace} / {name}',
  'token.warning': '⚠️ This token is shown only once — copy and store it now; it cannot be viewed again.',
  'token.backendId': 'Backend ID (configure it in clients)',
  'token.copy': 'Copy',
  'token.copied': 'Copied ✓',
  'token.close': "I've saved it — close",
  'revoke.title': 'Revoke credential',
  'revoke.confirmPrefix': 'Revoke ',
  'revoke.confirmSuffix': ' ({type} · {namespace})?',
  'revoke.warning': 'Revocation takes effect immediately: live connections using the credential are disconnected, and backend-access credentials exchanged from an enrollment credential are revoked along with it.',
  'revoke.confirm': 'Confirm revoke',
  'revoke.confirmMany': 'Revoke the {count} selected credentials?',
  'revoke.andMore': '…and {count} more',
  'revoked.skipped': '{count} credential(s) were not found or already revoked and were skipped.',
  'bulk.selected': '{count} selected',
  'bulk.revoke': 'Revoke selected',
  'bulk.clear': 'Clear selection',
  'bulk.selectAll': 'Select all revocable credentials in this list',
  'bulk.selectRow': 'Select {name}',
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
