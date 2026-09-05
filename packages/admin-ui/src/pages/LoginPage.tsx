import { useState, type FormEvent } from 'react';
import { api, ApiError, localizeApiError } from '../api.js';
import { useI18n } from '../i18n.js';
import { LangSwitch } from '../LangSwitch.js';

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const { t } = useI18n();
  const [token, setToken] = useState('');
  // Keep the raw error and localize at render time so the message follows
  // locale switches instead of freezing in the language at throw time.
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  function errorMessage(err: unknown): string {
    if (err instanceof ApiError && err.code === 'UNAUTHORIZED') return t('login.invalidToken');
    if (err instanceof ApiError && err.code === 'RATE_LIMITED') return t('login.rateLimited');
    return localizeApiError(err) || t('login.failed');
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(token.trim());
      setToken('');
      onLoggedIn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="lang-row">
          <LangSwitch />
        </div>
        <h1 className="login-title">zclaudia-gateway</h1>
        <p className="login-sub">{t('login.subtitle')}</p>
        <input
          type="password"
          className="input"
          placeholder="GATEWAY_ADMIN_TOKEN"
          value={token}
          autoFocus
          onChange={(e) => setToken(e.target.value)}
        />
        {error !== null && <p className="form-error">{errorMessage(error)}</p>}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !token.trim()}>
          {busy ? t('login.submitting') : t('login.submit')}
        </button>
        <p className="login-hint">{t('login.hint')}</p>
      </form>
    </div>
  );
}
