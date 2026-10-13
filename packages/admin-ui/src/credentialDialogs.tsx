/**
 * Credential dialogs shared by the Credentials and Backends pages: issuing
 * (with ADR-0009 backend identity / device scope options), the one-time
 * token view, and the device scope picker.
 */

import { useMemo, useState, type FormEvent } from 'react';
import { api, localizeApiError } from './api.js';
import { useI18n, type MsgKey } from './i18n.js';
import {
  identityLabel,
  identityReachable,
  type BackendIdentity,
  type CredentialRecord,
  type CredentialType,
  type IssueCredentialRequest,
  type IssuedCredential,
} from './types.js';

export const TYPE_KEYS: Record<CredentialType, MsgKey> = {
  device: 'type.device',
  backend: 'type.backend',
  'backend-access': 'type.backendAccess',
};

/** days === undefined → server default; null → never expires. */
const TTL_CHOICES: Array<{ days: number | null | undefined }> = [
  { days: undefined },
  { days: 30 },
  { days: 90 },
  { days: 180 },
  { days: 365 },
  { days: null },
];

export function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

/** Copies `text`; when the Clipboard API is denied, selects the element `targetId` instead. */
export function CopyButton({ text, targetId }: { text: string; targetId: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API can be denied (e.g. insecure origin) — select fallback.
      const target = document.getElementById(targetId);
      if (target) {
        const range = document.createRange();
        range.selectNodeContents(target);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
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

export function TokenOnceModal({ issued, onClose }: { issued: IssuedCredential; onClose: () => void }) {
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
        {issued.backendId && (
          <>
            <span className="field-label">{t('token.backendId')}</span>
            <div className="copy-row">
              <code id="token-once-backend-id" className="token-once">{issued.backendId}</code>
              <CopyButton text={issued.backendId} targetId="token-once-backend-id" />
            </div>
          </>
        )}
        <div className="modal-actions">
          <CopyButton text={issued.token} targetId="token-once-text" />
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {t('token.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

export type ScopeMode = 'all' | 'specific';

/**
 * Device access scope: whole namespace (null) or a checkbox list of backend
 * identities in that namespace. Lists only identities a usable backend
 * credential can still reach, plus anything already selected (marked stale
 * when unreachable so it can be removed). `selected` must only hold ids of
 * known identities — the server rejects unknown ones.
 */
export function ScopeFields({
  identities,
  credentialsById,
  mode,
  selected,
  onModeChange,
  onSelectedChange,
}: {
  /** Backend identities in the credential's namespace. */
  identities: BackendIdentity[];
  credentialsById: ReadonlyMap<string, CredentialRecord>;
  mode: ScopeMode;
  selected: string[];
  onModeChange: (mode: ScopeMode) => void;
  onSelectedChange: (selected: string[]) => void;
}) {
  const { t } = useI18n();
  const candidates = identities.filter((b) => identityReachable(b, credentialsById) || selected.includes(b.backendId));

  function toggle(id: string) {
    onSelectedChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }

  return (
    <div className="field">
      <span>{t('field.scope')}</span>
      <div className="choice-row">
        <label className="choice">
          <input type="radio" name="scope-mode" checked={mode === 'all'} onChange={() => onModeChange('all')} />
          {t('scope.allOption')}
        </label>
        <label className="choice">
          <input type="radio" name="scope-mode" checked={mode === 'specific'} onChange={() => onModeChange('specific')} />
          {t('scope.specificOption')}
        </label>
      </div>
      <p className="field-hint">{t(mode === 'all' ? 'scope.allHint' : 'scope.specificHint')}</p>
      {mode === 'specific' && (
        <div className="check-list">
          {candidates.length === 0 && (
            <p className="muted">{t('identity.noneInNamespace')}</p>
          )}
          {candidates.map((b) => (
            <label key={b.backendId} className="choice" title={b.backendId}>
              <input type="checkbox" checked={selected.includes(b.backendId)} onChange={() => toggle(b.backendId)} />
              <span>{identityLabel(b)}</span>
              <code className="muted">{shortId(b.backendId)}</code>
              {b.online
                ? <span className="badge badge-status-active">{t('backends.online')}</span>
                : <span className="badge">{t('backends.offline')}</span>}
              {!identityReachable(b, credentialsById) && <span className="badge badge-status-expired">{t('scope.stale')}</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** Prefill for the issue dialog, e.g. "issue a credential inheriting this backendId". */
export interface IssueDialogInitial {
  type: 'device' | 'backend';
  namespace: string;
  /** backend only: inherit this identity. */
  backendId?: string;
}

export function IssueDialog({
  namespaces,
  backends,
  credentials,
  initial,
  onClose,
  onIssued,
  onSessionLost,
}: {
  namespaces: string[];
  backends: BackendIdentity[];
  credentials: CredentialRecord[];
  initial?: IssueDialogInitial;
  onClose: () => void;
  onIssued: (issued: IssuedCredential) => void;
  onSessionLost: (err: unknown) => void;
}) {
  const { t } = useI18n();
  const [type, setType] = useState<'device' | 'backend'>(initial?.type ?? 'device');
  const [namespace, setNamespace] = useState(initial?.namespace ?? '');
  const [name, setName] = useState('');
  const [ttlChoice, setTtlChoice] = useState<number>(0);
  const [identityMode, setIdentityMode] = useState<'new' | 'inherit'>(initial?.backendId ? 'inherit' : 'new');
  const [inheritId, setInheritId] = useState(initial?.backendId ?? '');
  const [scopeMode, setScopeMode] = useState<ScopeMode>('all');
  const [allowed, setAllowed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // Raw error, localized at render so the text follows locale switches.
  const [error, setError] = useState<unknown>(null);

  const credentialsById = useMemo(() => new Map(credentials.map((c) => [c.id, c])), [credentials]);
  const trimmedNamespace = namespace.trim();
  const nsIdentities = useMemo(
    () => backends.filter((b) => b.namespace === trimmedNamespace),
    [backends, trimmedNamespace],
  );
  // Selections only count while they belong to the namespace currently typed.
  const effectiveInherit = nsIdentities.some((b) => b.backendId === inheritId) ? inheritId : '';
  const effectiveAllowed = allowed.filter((id) => nsIdentities.some((b) => b.backendId === id));

  const incomplete = !trimmedNamespace
    || (type === 'backend' && identityMode === 'inherit' && !effectiveInherit)
    || (type === 'device' && scopeMode === 'specific' && effectiveAllowed.length === 0);

  function ttlLabel(index: number): string {
    const choice = TTL_CHOICES[index];
    if (choice.days === undefined) return t('ttl.default');
    if (choice.days === null) return t('ttl.never');
    return t('ttl.days', { days: choice.days });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (incomplete || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ttl = TTL_CHOICES[ttlChoice];
      const req: IssueCredentialRequest = {
        type,
        namespace: trimmedNamespace,
        name: name.trim() || undefined,
        ttlDays: ttl.days === undefined ? undefined : ttl.days,
      };
      if (type === 'backend' && identityMode === 'inherit') req.backendId = effectiveInherit;
      if (type === 'device' && scopeMode === 'specific') req.allowedBackends = effectiveAllowed;
      onIssued(await api.issueCredential(req));
    } catch (err) {
      setError(err);
      onSessionLost(err);
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

        {type === 'backend' && (
          <div className="field">
            <span>{t('field.backendIdentity')}</span>
            <div className="choice-row">
              <label className="choice">
                <input type="radio" name="identity-mode" checked={identityMode === 'new'} onChange={() => setIdentityMode('new')} />
                {t('identity.new')}
              </label>
              <label className="choice">
                <input type="radio" name="identity-mode" checked={identityMode === 'inherit'} onChange={() => setIdentityMode('inherit')} />
                {t('identity.inherit')}
              </label>
            </div>
            {identityMode === 'inherit' && (
              nsIdentities.length === 0
                ? <p className="field-hint">{t('identity.noneInNamespace')}</p>
                : (
                  <select className="input" value={effectiveInherit} onChange={(e) => setInheritId(e.target.value)}>
                    <option value="" disabled>{t('identity.select')}</option>
                    {nsIdentities.map((b) => (
                      <option key={b.backendId} value={b.backendId}>
                        {identityLabel(b)} · {shortId(b.backendId)} · {t(b.online ? 'backends.online' : 'backends.offline')}
                      </option>
                    ))}
                  </select>
                )
            )}
            <p className="field-hint">{t(identityMode === 'new' ? 'identity.newHint' : 'identity.inheritHint')}</p>
          </div>
        )}

        {type === 'device' && (
          <ScopeFields
            identities={nsIdentities}
            credentialsById={credentialsById}
            mode={scopeMode}
            selected={effectiveAllowed}
            onModeChange={setScopeMode}
            onSelectedChange={setAllowed}
          />
        )}

        <label className="field">
          <span>{t('field.ttl')}</span>
          <select className="input" value={ttlChoice} onChange={(e) => setTtlChoice(Number(e.target.value))}>
            {TTL_CHOICES.map((choice, i) => <option key={i} value={i}>{ttlLabel(i)}</option>)}
          </select>
        </label>
        {error !== null && <p className="form-error">{localizeApiError(error)}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || incomplete}>
            {busy ? t('issue.submitting') : t('issue.submit')}
          </button>
        </div>
      </form>
    </div>
  );
}
