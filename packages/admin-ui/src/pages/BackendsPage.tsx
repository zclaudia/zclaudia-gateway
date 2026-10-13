import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, localizeApiError } from '../api.js';
import { formatDateTime, relativeTime } from '../format.js';
import { useI18n } from '../i18n.js';
import { credentialStatus, type BackendIdentity, type CredentialRecord } from '../types.js';

type OnlineFilter = 'all' | 'online' | 'offline';

/**
 * Read-only list of known backend identities (ADR-0008 step 1). The "last
 * credential" column is the migration evidence later used to bind legacy
 * backend credentials to their backendId.
 */
export function BackendsPage({ onSessionLost }: { onSessionLost: (err: unknown) => void }) {
  const { t } = useI18n();
  const [backends, setBackends] = useState<BackendIdentity[] | null>(null);
  const [credentials, setCredentials] = useState<CredentialRecord[]>([]);
  // Raw error, localized at render so the text follows locale switches.
  const [error, setError] = useState<unknown>(null);
  const [namespaceFilter, setNamespaceFilter] = useState('all');
  const [onlineFilter, setOnlineFilter] = useState<OnlineFilter>('all');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    try {
      const [backendList, credentialList] = await Promise.all([api.listBackends(), api.listCredentials()]);
      setBackends(backendList);
      setCredentials(credentialList);
      setError(null);
    } catch (err) {
      setError(err);
      onSessionLost(err);
    }
  }, [onSessionLost]);

  useEffect(() => { load(); }, [load]);

  const credentialsById = useMemo(() => new Map(credentials.map((c) => [c.id, c])), [credentials]);

  const namespaces = useMemo(
    () => [...new Set((backends ?? []).map((b) => b.namespace))].sort(),
    [backends],
  );

  const filtered = useMemo(() => {
    let list = backends ?? [];
    if (namespaceFilter !== 'all') list = list.filter((b) => b.namespace === namespaceFilter);
    if (onlineFilter !== 'all') list = list.filter((b) => (b.online !== null) === (onlineFilter === 'online'));
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((b) =>
        b.name.toLowerCase().includes(q)
        || b.namespace.toLowerCase().includes(q)
        || b.instanceId.toLowerCase().includes(q)
        || b.backendId.toLowerCase().includes(q));
    }
    return list;
  }, [backends, namespaceFilter, onlineFilter, search]);

  function renderLastCredential(id: string | null) {
    if (id === null) return <span className="muted">{t('backends.notObserved')}</span>;
    const credential = credentialsById.get(id);
    if (!credential) {
      return <span className="muted" title={id}>{t('backends.credentialGone')} <code>{id.slice(0, 8)}…</code></span>;
    }
    const status = credentialStatus(credential);
    return (
      <>
        <div className="cell-name">{credential.name || <span className="muted">{t('creds.unnamed')}</span>}</div>
        <div className="cell-id">
          <code>{credential.id.slice(0, 8)}…</code>
          {status !== 'active' && <> <span className={`badge badge-status-${status}`}>{t(status === 'revoked' ? 'status.revoked' : 'status.expired')}</span></>}
        </div>
      </>
    );
  }

  if (error !== null && !backends) {
    return <p className="page-error">{localizeApiError(error)}</p>;
  }
  if (!backends) {
    return <p className="page-loading">{t('common.loading')}</p>;
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>{t('nav.backends')}</h2>
        <div className="page-head-actions">
          <button type="button" className="btn btn-ghost" onClick={load}>{t('creds.refresh')}</button>
        </div>
      </div>

      <p className="muted">{t('backends.hint')}</p>

      <div className="filter-bar">
        <select className="input input-compact" value={namespaceFilter} onChange={(e) => setNamespaceFilter(e.target.value)}>
          <option value="all">{t('creds.allNamespaces')}</option>
          {namespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
        </select>
        <select className="input input-compact" value={onlineFilter} onChange={(e) => setOnlineFilter(e.target.value as OnlineFilter)}>
          <option value="all">{t('creds.allStatus')}</option>
          <option value="online">{t('backends.online')}</option>
          <option value="offline">{t('backends.offline')}</option>
        </select>
        <input
          className="input input-compact filter-search"
          placeholder={t('backends.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="panel">
        <table className="table">
          <thead>
            <tr>
              <th>{t('col.name')}</th>
              <th>{t('col.namespace')}</th>
              <th>{t('backends.colInstance')}</th>
              <th>{t('col.status')}</th>
              <th>{t('backends.colLastSeen')}</th>
              <th>{t('backends.colLastCredential')}</th>
              <th>{t('col.createdAt')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="muted table-empty">{t('backends.noMatch')}</td></tr>
            )}
            {filtered.map((b) => (
              <tr key={b.backendId} className={b.online ? '' : 'row-inactive'}>
                <td>
                  <div className="cell-name">{b.name || <span className="muted">{t('creds.unnamed')}</span>}</div>
                  <div className="cell-id"><code title={b.backendId}>{b.backendId}</code></div>
                </td>
                <td><code>{b.namespace}</code></td>
                <td><code>{b.instanceId || '—'}</code> <span className="muted">· {b.environment}</span></td>
                <td>
                  {b.online
                    ? <span className="badge badge-status-active" title={t('backends.onlineSince', { time: formatDateTime(b.online.connectedAt), epoch: b.online.epoch })}>{t('backends.online')}</span>
                    : <span className="badge">{t('backends.offline')}</span>}
                </td>
                <td title={formatDateTime(b.online?.connectedAt ?? b.lastSeenAt)}>
                  {b.online ? relativeTime(b.online.connectedAt) : relativeTime(b.lastSeenAt)}
                </td>
                <td>{renderLastCredential(b.lastCredentialId)}</td>
                <td title={formatDateTime(b.createdAt)}>{relativeTime(b.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted table-foot">{t('backends.count', { shown: filtered.length, total: backends.length })}</p>
      </div>
    </div>
  );
}
