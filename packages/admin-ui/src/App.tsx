import { useCallback, useEffect, useState } from 'react';
import { api, UnauthorizedError } from './api.js';
import { I18nProvider, useI18n } from './i18n.js';
import { LangSwitch } from './LangSwitch.js';
import { LoginPage } from './pages/LoginPage.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { CredentialsPage } from './pages/CredentialsPage.js';

type AuthState = 'checking' | 'login' | 'ready';

type View = 'overview' | 'credentials';

function currentView(): View {
  return window.location.hash === '#/credentials' ? 'credentials' : 'overview';
}

function AppInner() {
  const { t } = useI18n();
  const [auth, setAuth] = useState<AuthState>('checking');
  const [view, setView] = useState<View>(currentView);

  useEffect(() => {
    api.checkSession()
      .then(() => setAuth('ready'))
      .catch(() => setAuth('login'));
  }, []);

  useEffect(() => {
    const onHashChange = () => setView(currentView());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const handleSessionLost = useCallback((err: unknown) => {
    if (err instanceof UnauthorizedError) {
      setAuth('login');
    }
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setAuth('login');
    }
  }, []);

  if (auth === 'checking') {
    return (
      <div className="app-loading">
        <p>{t('app.checking')}</p>
      </div>
    );
  }

  if (auth === 'login') {
    return (
      <LoginPage
        onLoggedIn={() => setAuth('ready')}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-brand">
          <span className="brand-mark">zclaudia</span>
          <span className="brand-sub">{t('nav.consoleSubtitle')}</span>
        </div>
        <nav className="topbar-nav">
          <button
            type="button"
            className={view === 'overview' ? 'nav-item active' : 'nav-item'}
            onClick={() => { window.location.hash = '#/overview'; setView('overview'); }}
          >
            {t('nav.overview')}
          </button>
          <button
            type="button"
            className={view === 'credentials' ? 'nav-item active' : 'nav-item'}
            onClick={() => { window.location.hash = '#/credentials'; setView('credentials'); }}
          >
            {t('nav.credentials')}
          </button>
        </nav>
        <LangSwitch />
        <button type="button" className="btn btn-ghost" onClick={handleLogout}>
          {t('nav.logout')}
        </button>
      </header>
      <main className="content">
        {view === 'overview'
          ? <OverviewPage onSessionLost={handleSessionLost} />
          : <CredentialsPage onSessionLost={handleSessionLost} />}
      </main>
    </div>
  );
}

export function App() {
  return (
    <I18nProvider>
      <AppInner />
    </I18nProvider>
  );
}
