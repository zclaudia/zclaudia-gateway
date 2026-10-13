import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, localizeApiError } from '../api.js';
import {
  IssueDialog,
  ScopeFields,
  shortId,
  TokenOnceModal,
  TYPE_KEYS,
  type IssueDialogInitial,
  type ScopeMode,
} from '../credentialDialogs.js';
import { formatDateTime, relativeTime } from '../format.js';
import { useI18n, type MsgKey } from '../i18n.js';
import {
  CREDENTIAL_TOKEN_PREFIXES,
  credentialStatus,
  identityLabel,
  identityReachable,
  type BackendIdentity,
  type CredentialRecord,
  type CredentialStatus,
  type CredentialType,
  type IssuedCredential,
  type RevokeCredentialsResponse,
} from '../types.js';

type TypeFilter = 'all' | CredentialType;
type StatusFilter = 'all' | CredentialStatus;

const STATUS_KEYS: Record<CredentialStatus, MsgKey> = {
  active: 'status.active',
  revoked: 'status.revoked',
  expired: 'status.expired',
};

function IdentitySummary({ backend }: { backend: BackendIdentity }) {
  const { t } = useI18n();
  return (
    <span className="identity-summary" title={backend.backendId}>
      <strong>{identityLabel(backend)}</strong>
      <code className="muted">{shortId(backend.backendId)}</code>
      {backend.online
        ? <span className="badge badge-status-active">{t('backends.online')}</span>
        : <span className="badge" title={formatDateTime(backend.lastSeenAt)}>{t('backends.offline')}</span>}
      {backend.boundCredentials > 0 && (
        <span className="badge badge-status-active">{t('binding.bound', { count: backend.boundCredentials })}</span>
      )}
    </span>
  );
}

/**
 * ADR-0008 step 3 for one legacy backend credential: bind it in place to the
 * identity it was observed registering, split a shared credential, or pick an
 * identity by hand when nothing was observed.
 */
function MigrateDialog({
  credential,
  backends,
  onClose,
  onBound,
  onIssueInheriting,
  onSessionLost,
}: {
  credential: CredentialRecord;
  backends: BackendIdentity[];
  onClose: () => void;
  onBound: () => void;
  onIssueInheriting: (backendId: string) => void;
  onSessionLost: (err: unknown) => void;
}) {
  const { t } = useI18n();
  const observed = backends.filter((b) => b.lastCredentialId === credential.id);
  const nsIdentities = backends.filter((b) => b.namespace === credential.namespace);
  const [choice, setChoice] = useState(observed.length === 1 ? observed[0].backendId : '');
  const [busy, setBusy] = useState(false);
  // Raw error, localized at render so the text follows locale switches.
  const [error, setError] = useState<unknown>(null);

  const chosen = backends.find((b) => b.backendId === choice) ?? null;

  async function handleBind() {
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.bindCredential(credential.id, chosen.backendId);
      onBound();
    } catch (err) {
      setError(err);
      onSessionLost(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal modal-wide">
        <h3>{t('migrate.title')}</h3>
        <p>
          <strong>{credential.name || credential.id}</strong>
          <span className="muted"> · <code>{credential.namespace}</code></span>
        </p>
        <p className="muted">{t('migrate.intro')}</p>

        {observed.length === 1 && (
          <>
            <p>{t('migrate.single')}</p>
            <div className="option-list">
              <div className="option-item"><IdentitySummary backend={observed[0]} /></div>
            </div>
          </>
        )}

        {observed.length > 1 && (
          <>
            <p>{t('migrate.shared', { count: observed.length })}</p>
            <div className="option-list">
              {observed.map((b) => (
                <div key={b.backendId} className="option-item">
                  <label className="choice">
                    <input type="radio" name="migrate-choice" checked={choice === b.backendId} onChange={() => setChoice(b.backendId)} />
                    <IdentitySummary backend={b} />
                  </label>
                  <button type="button" className="btn btn-small btn-secondary" onClick={() => onIssueInheriting(b.backendId)}>
                    {t('migrate.issueInheriting')}
                  </button>
                </div>
              ))}
            </div>
            <p className="token-warning">{t('migrate.sharedWarning')}</p>
          </>
        )}

        {observed.length === 0 && (
          <>
            <p>{t('migrate.none')}</p>
            {nsIdentities.length === 0 ? (
              <p className="muted">{t('identity.noneInNamespace')}</p>
            ) : (
              <>
                <select className="input" value={choice} onChange={(e) => setChoice(e.target.value)}>
                  <option value="" disabled>{t('identity.select')}</option>
                  {nsIdentities.map((b) => (
                    <option key={b.backendId} value={b.backendId}>
                      {identityLabel(b)} · {shortId(b.backendId)} · {t(b.online ? 'backends.online' : 'backends.offline')}
                    </option>
                  ))}
                </select>
                <p className="token-warning">{t('migrate.manualWarning')}</p>
              </>
            )}
          </>
        )}

        {error !== null && <p className="form-error">{localizeApiError(error)}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button>
          {observed.length === 0 && chosen && (
            <button type="button" className="btn btn-secondary" onClick={() => onIssueInheriting(chosen.backendId)}>
              {t('migrate.issueInheriting')}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={handleBind} disabled={busy || !chosen}>
            {busy ? t('migrate.binding') : chosen ? t('migrate.bindTo', { name: identityLabel(chosen) }) : t('migrate.bind')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ScopeDialog({
  credential,
  backends,
  credentials,
  onClose,
  onSaved,
  onSessionLost,
}: {
  credential: CredentialRecord;
  backends: BackendIdentity[];
  credentials: CredentialRecord[];
  onClose: () => void;
  onSaved: () => void;
  onSessionLost: (err: unknown) => void;
}) {
  const { t } = useI18n();
  const nsIdentities = backends.filter((b) => b.namespace === credential.namespace);
  // Ids of deleted identities can't be saved back (the server rejects unknown
  // backends), so they start out removed from the selection.
  const [droppedUnknown] = useState(
    () => (credential.allowedBackends ?? []).filter((id) => !nsIdentities.some((b) => b.backendId === id)).length,
  );
  const [mode, setMode] = useState<ScopeMode>(credential.allowedBackends === null ? 'all' : 'specific');
  const [selected, setSelected] = useState<string[]>(
    () => (credential.allowedBackends ?? []).filter((id) => nsIdentities.some((b) => b.backendId === id)),
  );
  const [busy, setBusy] = useState(false);
  // Raw error, localized at render so the text follows locale switches.
  const [error, setError] = useState<unknown>(null);

  const credentialsById = useMemo(() => new Map(credentials.map((c) => [c.id, c])), [credentials]);
  const next = mode === 'all' ? null : selected;
  const current = credential.allowedBackends;
  const unchanged = next === null
    ? current === null
    : current !== null && current.length === next.length && next.every((id) => current.includes(id));

  async function handleSave() {
    if (busy || unchanged || (next !== null && next.length === 0)) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateCredentialScope(credential.id, next);
      onSaved();
    } catch (err) {
      setError(err);
      onSessionLost(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>{t('scope.title')}</h3>
        <p>
          <strong>{credential.name || credential.id}</strong>
          <span className="muted"> · {t('type.device')} · <code>{credential.namespace}</code></span>
        </p>
        <ScopeFields
          identities={nsIdentities}
          credentialsById={credentialsById}
          mode={mode}
          selected={selected}
          onModeChange={setMode}
          onSelectedChange={setSelected}
        />
        {mode === 'specific' && droppedUnknown > 0 && (
          <p className="field-hint">{t('scope.droppedUnknown', { count: droppedUnknown })}</p>
        )}
        <p className="token-warning">{t('scope.disconnectWarning')}</p>
        {error !== null && <p className="form-error">{localizeApiError(error)}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            disabled={busy || unchanged || (next !== null && next.length === 0)}
          >
            {busy ? t('scope.saving') : t('scope.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
const REVOKE_LIST_LIMIT = 8;

function RevokeDialog({
  targets,
  onClose,
  onRevoked,
  onError,
}: {
  /** One credential (row action) or several (bulk selection). */
  targets: CredentialRecord[];
  onClose: () => void;
  onRevoked: (result: RevokeCredentialsResponse) => void;
  onError: (err: unknown) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const single = targets.length === 1 ? targets[0] : null;

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    try {
      onRevoked(await api.revokeCredentials(targets.map((c) => c.id)));
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>{t('revoke.title')}</h3>
        {single ? (
          <p>
            {t('revoke.confirmPrefix')}
            <strong>{single.name || single.id}</strong>
            {t('revoke.confirmSuffix', {
              type: t(TYPE_KEYS[single.type]),
              namespace: single.namespace,
            })}
          </p>
        ) : (
          <>
            <p>{t('revoke.confirmMany', { count: targets.length })}</p>
            <ul className="revoked-ids">
              {targets.slice(0, REVOKE_LIST_LIMIT).map((c) => (
                <li key={c.id}>
                  <strong>{c.name || t('creds.unnamed')}</strong>
                  <span className="muted"> · {t(TYPE_KEYS[c.type])} · <code>{c.namespace}</code></span>
                </li>
              ))}
              {targets.length > REVOKE_LIST_LIMIT && (
                <li className="muted">{t('revoke.andMore', { count: targets.length - REVOKE_LIST_LIMIT })}</li>
              )}
            </ul>
          </>
        )}
        <p className="token-warning">{t('revoke.warning')}</p>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-danger" onClick={handleConfirm} disabled={busy}>
            {busy ? t('revoke.revoking') : t('revoke.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

function PurgeDialog({
  ids,
  single,
  onClose,
  onPurged,
  onError,
}: {
  ids: string[];
  /** Set when deleting one row; absent for the bulk clean-up. */
  single: CredentialRecord | null;
  onClose: () => void;
  onPurged: () => void;
  onError: (err: unknown) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    try {
      await api.purgeCredentials(ids);
      onPurged();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>{t('purge.title')}</h3>
        <p>
          {single ? (
            <>
              {t('purge.confirmOne')}
              <strong>{single.name || single.id}</strong>
              {t('revoke.confirmSuffix', { type: t(TYPE_KEYS[single.type]), namespace: single.namespace })}
            </>
          ) : t('purge.confirmAll', { count: ids.length })}
        </p>
        <p className="token-warning">{t('purge.warning')}</p>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-danger" onClick={handleConfirm} disabled={busy}>
            {busy ? t('purge.purging') : t('purge.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

function RevokedResultModal({
  result,
  requested,
  onClose,
}: {
  result: RevokeCredentialsResponse;
  /** How many credentials were selected; more revoked than that means cascades. */
  requested: number;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ids = result.revoked;
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>{t('revoked.title', { count: ids.length })}</h3>
        {ids.length > requested - result.skipped.length && <p className="muted">{t('revoked.cascadeHint')}</p>}
        <ul className="revoked-ids">
          {ids.map((id) => <li key={id}><code>{id}</code></li>)}
        </ul>
        {result.skipped.length > 0 && <p className="muted">{t('revoked.skipped', { count: result.skipped.length })}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  );
}

export function CredentialsPage({ onSessionLost }: { onSessionLost: (err: unknown) => void }) {
  const { t } = useI18n();
  const [credentials, setCredentials] = useState<CredentialRecord[] | null>(null);
  const [backends, setBackends] = useState<BackendIdentity[]>([]);
  // Raw errors, localized at render so text follows locale switches.
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [namespaceFilter, setNamespaceFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [issuing, setIssuing] = useState<{ initial?: IssueDialogInitial } | null>(null);
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const [revoking, setRevoking] = useState<CredentialRecord[] | null>(null);
  const [revokeResult, setRevokeResult] = useState<{ result: RevokeCredentialsResponse; requested: number } | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [purging, setPurging] = useState<{ ids: string[]; single: CredentialRecord | null } | null>(null);
  const [migrating, setMigrating] = useState<CredentialRecord | null>(null);
  const [editingScope, setEditingScope] = useState<CredentialRecord | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, backendList] = await Promise.all([api.listCredentials(), api.listBackends()]);
      setCredentials(list.sort((a, b) => b.createdAt - a.createdAt));
      setBackends(backendList);
      setError(null);
    } catch (err) {
      setError(err);
      onSessionLost(err);
    }
  }, [onSessionLost]);

  useEffect(() => { load(); }, [load]);

  const namespaces = useMemo(
    () => [...new Set([...(credentials ?? []).map((c) => c.namespace), ...backends.map((b) => b.namespace)])].sort(),
    [credentials, backends],
  );

  const backendsById = useMemo(() => new Map(backends.map((b) => [b.backendId, b])), [backends]);
  const credentialsById = useMemo(() => new Map((credentials ?? []).map((c) => [c.id, c])), [credentials]);

  const filtered = useMemo(() => {
    let list = credentials ?? [];
    if (typeFilter !== 'all') list = list.filter((c) => c.type === typeFilter);
    if (statusFilter !== 'all') list = list.filter((c) => credentialStatus(c) === statusFilter);
    if (namespaceFilter !== 'all') list = list.filter((c) => c.namespace === namespaceFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((c) =>
        c.name.toLowerCase().includes(q)
        || c.namespace.toLowerCase().includes(q)
        || c.id.toLowerCase().includes(q)
        || (c.backendId?.toLowerCase().includes(q) ?? false));
    }
    return list;
  }, [credentials, typeFilter, statusFilter, namespaceFilter, search]);

  const revokedAll = useMemo(
    () => (credentials ?? []).filter((c) => credentialStatus(c) === 'revoked'),
    [credentials],
  );

  // Bulk selection acts only on rows that are visible and still revocable,
  // so a filter change or a reload never revokes something off-screen.
  const selectable = useMemo(() => filtered.filter((c) => credentialStatus(c) !== 'revoked'), [filtered]);
  const selectedRows = useMemo(() => selectable.filter((c) => selected.has(c.id)), [selectable, selected]);
  const allSelected = selectable.length > 0 && selectedRows.length === selectable.length;

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectable.map((c) => c.id)));
  }

  function showActionError(err: unknown) {
    setActionError(err);
    onSessionLost(err);
  }

  function renderBackendOrScope(c: CredentialRecord, status: CredentialStatus) {
    if (c.type === 'device') {
      if (c.allowedBackends === null) return <span className="muted">{t('scope.all')}</span>;
      const entries = c.allowedBackends.map((id) => {
        const b = backendsById.get(id);
        const stale = !b || !identityReachable(b, credentialsById);
        return { id, label: b ? identityLabel(b) : shortId(id), stale };
      });
      const staleCount = entries.filter((e) => e.stale).length;
      const title = entries.map((e) => `${e.label} (${e.id})${e.stale ? ` — ${t('scope.stale')}` : ''}`).join('\n');
      return (
        <span title={title}>
          {t('scope.count', { count: entries.length })}
          {staleCount > 0 && <> <span className="badge badge-status-expired">{t('scope.staleCount', { count: staleCount })}</span></>}
        </span>
      );
    }
    if (c.backendId !== null) {
      const b = backendsById.get(c.backendId);
      return (
        <>
          {b && <div className="cell-name">{identityLabel(b)}</div>}
          <div className="cell-id"><code title={c.backendId}>{shortId(c.backendId)}</code></div>
        </>
      );
    }
    if (c.type === 'backend' && status !== 'revoked') {
      return <span className="badge badge-legacy" title={t('binding.legacyTitle')}>{t('binding.legacy')}</span>;
    }
    return <span className="muted">—</span>;
  }

  if (error !== null && !credentials) {
    return <p className="page-error">{localizeApiError(error)}</p>;
  }
  if (!credentials) {
    return <p className="page-loading">{t('common.loading')}</p>;
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>{t('nav.credentials')}</h2>
        <div className="page-head-actions">
          <button type="button" className="btn btn-ghost" onClick={load}>{t('creds.refresh')}</button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={revokedAll.length === 0}
            onClick={() => setPurging({ ids: revokedAll.map((c) => c.id), single: null })}
          >
            {t('creds.purgeRevoked', { count: revokedAll.length })}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setIssuing({})}>
            {t('creds.issue')}
          </button>
        </div>
      </div>

      {actionError !== null && (
        <p className="form-error">
          {localizeApiError(actionError)} <button type="button" className="btn-link" onClick={() => setActionError(null)}>{t('common.close')}</button>
        </p>
      )}

      <div className="filter-bar">
        <select className="input input-compact" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}>
          <option value="all">{t('creds.allTypes')}</option>
          {(Object.keys(TYPE_KEYS) as CredentialType[]).map((ct) => (
            <option key={ct} value={ct}>{t(TYPE_KEYS[ct])}</option>
          ))}
        </select>
        <select className="input input-compact" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
          <option value="all">{t('creds.allStatus')}</option>
          {(Object.keys(STATUS_KEYS) as CredentialStatus[]).map((s) => (
            <option key={s} value={s}>{t(STATUS_KEYS[s])}</option>
          ))}
        </select>
        <select className="input input-compact" value={namespaceFilter} onChange={(e) => setNamespaceFilter(e.target.value)}>
          <option value="all">{t('creds.allNamespaces')}</option>
          {namespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
        </select>
        <input
          className="input input-compact filter-search"
          placeholder={t('creds.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {selectedRows.length > 0 && (
        <div className="bulk-bar">
          <span>{t('bulk.selected', { count: selectedRows.length })}</span>
          <button type="button" className="btn btn-small btn-danger" onClick={() => setRevoking(selectedRows)}>
            {t('bulk.revoke')}
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setSelected(new Set())}>
            {t('bulk.clear')}
          </button>
        </div>
      )}

      <div className="panel">
        <table className="table">
          <thead>
            <tr>
              <th className="cell-check">
                <input
                  type="checkbox"
                  aria-label={t('bulk.selectAll')}
                  checked={allSelected}
                  disabled={selectable.length === 0}
                  ref={(el) => { if (el) el.indeterminate = selectedRows.length > 0 && !allSelected; }}
                  onChange={toggleAll}
                />
              </th>
              <th>{t('col.name')}</th>
              <th>{t('col.type')}</th>
              <th>{t('col.namespace')}</th>
              <th>{t('col.backendScope')}</th>
              <th>{t('col.status')}</th>
              <th>{t('col.createdAt')}</th>
              <th>{t('col.expiresAt')}</th>
              <th>{t('col.lastUsed')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={10} className="muted table-empty">{t('creds.noMatch')}</td></tr>
            )}
            {filtered.map((c) => {
              const status = credentialStatus(c);
              return (
                <tr key={c.id} className={status === 'revoked' || status === 'expired' ? 'row-inactive' : ''}>
                  <td className="cell-check">
                    {status !== 'revoked' && (
                      <input
                        type="checkbox"
                        aria-label={t('bulk.selectRow', { name: c.name || c.id })}
                        checked={selected.has(c.id)}
                        onChange={() => toggleSelected(c.id)}
                      />
                    )}
                  </td>
                  <td>
                    <div className="cell-name">{c.name || <span className="muted">{t('creds.unnamed')}</span>}</div>
                    <div className="cell-id"><code>{c.id.slice(0, 8)}…</code></div>
                  </td>
                  <td>
                    <span className={`badge badge-type-${c.type.replace('+', '-')}`}>
                      {CREDENTIAL_TOKEN_PREFIXES[c.type]} {t(TYPE_KEYS[c.type])}
                    </span>
                  </td>
                  <td><code>{c.namespace}</code></td>
                  <td>{renderBackendOrScope(c, status)}</td>
                  <td><span className={`badge badge-status-${status}`}>{t(STATUS_KEYS[status])}</span></td>
                  <td title={formatDateTime(c.createdAt)}>{relativeTime(c.createdAt)}</td>
                  <td>{c.expiresAt === null ? t('creds.neverExpires') : <span title={formatDateTime(c.expiresAt)}>{relativeTime(c.expiresAt)}</span>}</td>
                  <td>{c.lastUsedAt === null ? t('creds.neverUsed') : <span title={formatDateTime(c.lastUsedAt)}>{relativeTime(c.lastUsedAt)}</span>}</td>
                  <td>
                    <div className="row-actions">
                      {c.type === 'backend' && c.backendId === null && status !== 'revoked' && (
                        <button type="button" className="btn btn-small btn-primary" onClick={() => setMigrating(c)}>
                          {t('creds.migrate')}
                        </button>
                      )}
                      {c.type === 'device' && status !== 'revoked' && (
                        <button type="button" className="btn btn-small btn-secondary" onClick={() => setEditingScope(c)}>
                          {t('creds.editScope')}
                        </button>
                      )}
                      {status !== 'revoked' && (
                        <button type="button" className="btn btn-small btn-danger" onClick={() => setRevoking([c])}>
                          {t('creds.revoke')}
                        </button>
                      )}
                      {status === 'revoked' && (
                        <button type="button" className="btn btn-small btn-danger" onClick={() => setPurging({ ids: [c.id], single: c })}>
                          {t('creds.delete')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted table-foot">{t('creds.count', { shown: filtered.length, total: credentials.length })}</p>
      </div>

      {issuing && (
        <IssueDialog
          namespaces={namespaces}
          backends={backends}
          credentials={credentials}
          initial={issuing.initial}
          onClose={() => setIssuing(null)}
          onIssued={(item) => { setIssuing(null); setIssued(item); load(); }}
          onSessionLost={onSessionLost}
        />
      )}
      {issued && <TokenOnceModal issued={issued} onClose={() => setIssued(null)} />}
      {revoking && (
        <RevokeDialog
          targets={revoking}
          onClose={() => setRevoking(null)}
          onRevoked={(result) => {
            setRevokeResult({ result, requested: revoking.length });
            setRevoking(null);
            setSelected(new Set());
            load();
          }}
          onError={(err) => { setRevoking(null); showActionError(err); }}
        />
      )}
      {purging && (
        <PurgeDialog
          ids={purging.ids}
          single={purging.single}
          onClose={() => setPurging(null)}
          onPurged={() => { setPurging(null); load(); }}
          onError={(err) => { setPurging(null); showActionError(err); }}
        />
      )}
      {migrating && (
        <MigrateDialog
          credential={migrating}
          backends={backends}
          onClose={() => setMigrating(null)}
          onBound={() => { setMigrating(null); load(); }}
          onIssueInheriting={(backendId) => {
            setIssuing({ initial: { type: 'backend', namespace: migrating.namespace, backendId } });
            setMigrating(null);
          }}
          onSessionLost={onSessionLost}
        />
      )}
      {editingScope && (
        <ScopeDialog
          credential={editingScope}
          backends={backends}
          credentials={credentials}
          onClose={() => setEditingScope(null)}
          onSaved={() => { setEditingScope(null); load(); }}
          onSessionLost={onSessionLost}
        />
      )}
      {revokeResult && (
        <RevokedResultModal result={revokeResult.result} requested={revokeResult.requested} onClose={() => setRevokeResult(null)} />
      )}
    </div>
  );
}
