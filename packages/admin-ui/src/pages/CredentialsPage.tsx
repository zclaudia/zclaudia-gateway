import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, localizeApiError } from '../api.js';
import { formatDateTime, relativeTime } from '../format.js';
import { useI18n, type MsgKey } from '../i18n.js';
import {
  CREDENTIAL_TOKEN_PREFIXES,
  credentialStatus,
  type CredentialRecord,
  type CredentialStatus,
  type CredentialType,
  type IssuedCredential,
} from '../types.js';

type TypeFilter = 'all' | CredentialType;
type StatusFilter = 'all' | CredentialStatus;

/** days === undefined → server default; null → never expires. */
const TTL_CHOICES: Array<{ days: number | null | undefined }> = [
  { days: undefined },
  { days: 30 },
  { days: 90 },
  { days: 180 },
  { days: 365 },
  { days: null },
];

const STATUS_KEYS: Record<CredentialStatus, MsgKey> = {
  active: 'status.active',
  revoked: 'status.revoked',
  expired: 'status.expired',
};

const TYPE_KEYS: Record<CredentialType, MsgKey> = {
  device: 'type.device',
  backend: 'type.backend',
  'backend-access': 'type.backendAccess',
};

function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API can be denied (e.g. insecure origin) — select fallback.
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('token-once-text')!);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button type="button" className="btn btn-secondary" onClick={copy}>
      {copied ? t('token.copied') : t('token.copy')}
    </button>
  );
}

function TokenOnceModal({ issued, onClose }: { issued: IssuedCredential; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>{t('token.title')}</h3>
        <p className="muted">
          {t('token.issuedAs', {
            type: t(TYPE_KEYS[issued.type]),
            namespace: issued.namespace,
            name: issued.name || issued.id,
          })}
        </p>
        <p className="token-warning">{t('token.warning')}</p>
        <code id="token-once-text" className="token-once">{issued.token}</code>
        <div className="modal-actions">
          <CopyButton text={issued.token} />
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {t('token.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

function IssueDialog({
  namespaces,
  onClose,
  onIssued,
  onError,
}: {
  namespaces: string[];
  onClose: () => void;
  onIssued: (issued: IssuedCredential) => void;
  onError: (err: unknown) => void;
}) {
  const { t } = useI18n();
  const [type, setType] = useState<'device' | 'backend'>('device');
  const [namespace, setNamespace] = useState('');
  const [name, setName] = useState('');
  const [ttlChoice, setTtlChoice] = useState<number>(0);
  const [busy, setBusy] = useState(false);

  function ttlLabel(index: number): string {
    const choice = TTL_CHOICES[index];
    if (choice.days === undefined) return t('ttl.default');
    if (choice.days === null) return t('ttl.never');
    return t('ttl.days', { days: choice.days });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!namespace.trim() || busy) return;
    setBusy(true);
    try {
      const ttl = TTL_CHOICES[ttlChoice];
      const issued = await api.issueCredential({
        type,
        namespace: namespace.trim(),
        name: name.trim() || undefined,
        ttlDays: ttl.days === undefined ? undefined : ttl.days,
      });
      onIssued(issued);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={handleSubmit}>
        <h3>{t('issue.title')}</h3>
        <label className="field">
          <span>{t('field.type')}</span>
          <select className="input" value={type} onChange={(e) => setType(e.target.value as 'device' | 'backend')}>
            <option value="device">{t('issue.deviceOption')}</option>
            <option value="backend">{t('issue.backendOption')}</option>
          </select>
        </label>
        <label className="field">
          <span>{t('field.namespaceRequired')}</span>
          <input
            className="input"
            list="namespace-options"
            value={namespace}
            placeholder={t('issue.namespacePlaceholder')}
            autoFocus
            onChange={(e) => setNamespace(e.target.value)}
          />
          <datalist id="namespace-options">
            {namespaces.map((ns) => <option key={ns} value={ns} />)}
          </datalist>
        </label>
        <label className="field">
          <span>{t('field.nameOptional')}</span>
          <input
            className="input"
            value={name}
            placeholder={t('issue.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          <span>{t('field.ttl')}</span>
          <select className="input" value={ttlChoice} onChange={(e) => setTtlChoice(Number(e.target.value))}>
            {TTL_CHOICES.map((choice, i) => <option key={i} value={i}>{ttlLabel(i)}</option>)}
          </select>
        </label>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !namespace.trim()}>
            {busy ? t('issue.submitting') : t('issue.submit')}
          </button>
        </div>
      </form>
    </div>
  );
}

function RevokeDialog({
  credential,
  onClose,
  onRevoked,
  onError,
}: {
  credential: CredentialRecord;
  onClose: () => void;
  onRevoked: (revokedIds: string[]) => void;
  onError: (err: unknown) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    try {
      const { revoked } = await api.revokeCredential(credential.id);
      onRevoked(revoked);
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
        <p>
          {t('revoke.confirmPrefix')}
          <strong>{credential.name || credential.id}</strong>
          {t('revoke.confirmSuffix', {
            type: t(TYPE_KEYS[credential.type]),
            namespace: credential.namespace,
          })}
        </p>
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

function RevokedResultModal({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>{t('revoked.title', { count: ids.length })}</h3>
        {ids.length > 1 && <p className="muted">{t('revoked.cascadeHint')}</p>}
        <ul className="revoked-ids">
          {ids.map((id) => <li key={id}><code>{id}</code></li>)}
        </ul>
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
  // Raw errors, localized at render so text follows locale switches.
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [namespaceFilter, setNamespaceFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const [revoking, setRevoking] = useState<CredentialRecord | null>(null);
  const [revokedIds, setRevokedIds] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.listCredentials();
      setCredentials(list.sort((a, b) => b.createdAt - a.createdAt));
      setError(null);
    } catch (err) {
      setError(err);
      onSessionLost(err);
    }
  }, [onSessionLost]);

  useEffect(() => { load(); }, [load]);

  const namespaces = useMemo(
    () => [...new Set((credentials ?? []).map((c) => c.namespace))].sort(),
    [credentials],
  );

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
        || c.id.toLowerCase().includes(q));
    }
    return list;
  }, [credentials, typeFilter, statusFilter, namespaceFilter, search]);

  function showActionError(err: unknown) {
    setActionError(err);
    onSessionLost(err);
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
          <button type="button" className="btn btn-primary" onClick={() => setIssuing(true)}>
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

      <div className="panel">
        <table className="table">
          <thead>
            <tr>
              <th>{t('col.name')}</th>
              <th>{t('col.type')}</th>
              <th>{t('col.namespace')}</th>
              <th>{t('col.status')}</th>
              <th>{t('col.createdAt')}</th>
              <th>{t('col.expiresAt')}</th>
              <th>{t('col.lastUsed')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="muted table-empty">{t('creds.noMatch')}</td></tr>
            )}
            {filtered.map((c) => {
              const status = credentialStatus(c);
              return (
                <tr key={c.id} className={status === 'revoked' || status === 'expired' ? 'row-inactive' : ''}>
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
                  <td><span className={`badge badge-status-${status}`}>{t(STATUS_KEYS[status])}</span></td>
                  <td title={formatDateTime(c.createdAt)}>{relativeTime(c.createdAt)}</td>
                  <td>{c.expiresAt === null ? t('creds.neverExpires') : <span title={formatDateTime(c.expiresAt)}>{relativeTime(c.expiresAt)}</span>}</td>
                  <td>{c.lastUsedAt === null ? t('creds.neverUsed') : <span title={formatDateTime(c.lastUsedAt)}>{relativeTime(c.lastUsedAt)}</span>}</td>
                  <td>
                    {status === 'active' && (
                      <button type="button" className="btn btn-small btn-danger" onClick={() => setRevoking(c)}>
                        {t('creds.revoke')}
                      </button>
                    )}
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
          onClose={() => setIssuing(false)}
          onIssued={(item) => { setIssuing(false); setIssued(item); load(); }}
          onError={showActionError}
        />
      )}
      {issued && <TokenOnceModal issued={issued} onClose={() => setIssued(null)} />}
      {revoking && (
        <RevokeDialog
          credential={revoking}
          onClose={() => setRevoking(null)}
          onRevoked={(ids) => { setRevoking(null); setRevokedIds(ids); load(); }}
          onError={showActionError}
        />
      )}
      {revokedIds && <RevokedResultModal ids={revokedIds} onClose={() => setRevokedIds(null)} />}
    </div>
  );
}
