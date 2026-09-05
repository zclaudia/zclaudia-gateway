import { useEffect, useState } from 'react';
import { api, localizeApiError } from '../api.js';
import { formatUptime } from '../format.js';
import { useI18n, type MsgKey } from '../i18n.js';
import type { CredentialType, Overview } from '../types.js';

const REFRESH_MS = 30_000;

const CREDENTIAL_TYPES: CredentialType[] = ['device', 'backend', 'backend-access'];

const TYPE_KEYS: Record<CredentialType, MsgKey> = {
  device: 'type.device',
  backend: 'type.backend',
  'backend-access': 'type.backendAccess',
};

export function OverviewPage({ onSessionLost }: { onSessionLost: (err: unknown) => void }) {
  const { t } = useI18n();
  const [overview, setOverview] = useState<Overview | null>(null);
  // Raw error, localized at render so the text follows locale switches.
  const [error, setError] = useState<unknown>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await api.overview();
        if (cancelled) return;
        setOverview(data);
        setUpdatedAt(Date.now());
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err);
        onSessionLost(err);
      }
    }

    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [onSessionLost]);

  if (error !== null && !overview) {
    return <p className="page-error">{localizeApiError(error)}</p>;
  }
  if (!overview) {
    return <p className="page-loading">{t('common.loading')}</p>;
  }

  const onlinePeers = overview.peers;

  return (
    <div className="page">
      <div className="page-head">
        <h2>{t('nav.overview')}</h2>
        <span className="muted">
          {updatedAt ? t('overview.updatedAt', { time: new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) }) : ''}
        </span>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-value">{overview.backends}</div>
          <div className="stat-label">{t('overview.backends')}</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{onlinePeers.length}</div>
          <div className="stat-label">{t('overview.connections')}</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{overview.credentials.active}</div>
          <div className="stat-label">{t('overview.activeCreds')}</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{overview.credentials.revoked}</div>
          <div className="stat-label">{t('overview.revokedCreds')}</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{overview.credentials.expired}</div>
          <div className="stat-label">{t('overview.expiredCreds')}</div>
        </div>
        <div className="stat-card">
          <div className="stat-value stat-value-small">{formatUptime(overview.uptimeSec)}</div>
          <div className="stat-label">{t('overview.uptime')}</div>
        </div>
      </div>

      <section className="panel">
        <h3>{t('overview.typeDistribution')}</h3>
        <div className="badge-row">
          {CREDENTIAL_TYPES.map((type) => (
            <span key={type} className={`badge badge-type-${type.replace('+', '-')}`}>
              {t(TYPE_KEYS[type])} · {overview.credentials.byType[type] ?? 0}
            </span>
          ))}
        </div>
      </section>

      <section className="panel">
        <h3>{t('overview.onlinePeers', { count: onlinePeers.length })}</h3>
        {onlinePeers.length === 0 ? (
          <p className="muted">{t('overview.noPeers')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('col.name')}</th>
                <th>{t('col.type')}</th>
                <th>{t('col.namespace')}</th>
                <th>{t('overview.deviceId')}</th>
                <th>{t('overview.protocolVersion')}</th>
                <th>{t('overview.backendId')}</th>
              </tr>
            </thead>
            <tbody>
              {onlinePeers.map((peer) => (
                <tr key={peer.peerSessionId}>
                  <td>{peer.name || '—'}</td>
                  <td>
                    <span className={`badge badge-peer-${peer.peerType.replace('+', '-')}`}>
                      {peer.peerType === 'client+backend' ? t('peer.clientBackend') : t('peer.clientOnly')}
                    </span>
                  </td>
                  <td><code>{peer.namespace}</code></td>
                  <td><code>{peer.deviceId}</code></td>
                  <td>v{peer.protocolVersion}</td>
                  <td>{peer.backendId ? <code>{peer.backendId.slice(0, 8)}…</code> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
