import { useState, useEffect, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useStoreSlug } from '../context/StoreContext';
import { useTranslation } from 'react-i18next';
import { useRestaurantConfig } from '../hooks/useRestaurantConfig';
import {
  completeOwnerPasswordReset,
  sendOwnerPasswordResetCode,
} from '../api/portal';
import { portalLogoSrc } from '../constants/portalBrand';
import './portal-home.css';
import './store-login.css';

type LoginView = 'signin' | 'forgot' | 'forgotDone';

export default function LoginPage() {
  const { login, user, isAuthenticated, isStoreStaffSessionReady } = useAuth();
  const storeSlug = useStoreSlug();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { displayName, displayNameOther, config } = useRestaurantConfig();
  const [view, setView] = useState<LoginView>('signin');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [resetEmail, setResetEmail] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resetError, setResetError] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [codeSending, setCodeSending] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [resetUsername, setResetUsername] = useState('');

  const titleMain = displayName || storeSlug;
  const logoUrl = config.restaurant_logo?.trim();

  useEffect(() => {
    const lang = i18n.language?.startsWith('zh') ? 'zh-CN' : 'en-US';
    document.documentElement.lang = lang;
    document.title = titleMain
      ? `${titleMain} — ${t('storeLogin.pageTitle')}`
      : t('storeLogin.pageTitle');
  }, [i18n.language, t, titleMain]);

  useEffect(() => {
    if (!isAuthenticated || !user || !isStoreStaffSessionReady) return;
    const isAdmin = user.role === 'owner' || user.role === 'platform_owner';
    navigate(isAdmin ? '../admin' : '../cashier', { replace: true, relative: 'path' });
  }, [isAuthenticated, user, isStoreStaffSessionReady, navigate]);

  const setLanguage = (lng: string) => {
    void i18n.changeLanguage(lng);
    localStorage.setItem('language', lng);
  };

  const switchView = (next: LoginView) => {
    setView(next);
    setError('');
    setResetError('');
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username, password, storeSlug);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('login.failed'));
    } finally {
      setLoading(false);
    }
  };

  const handleSendResetCode = async () => {
    setResetError('');
    if (!resetEmail.trim()) {
      setResetError(t('storeLogin.forgotNeedEmail'));
      return;
    }
    setCodeSending(true);
    try {
      await sendOwnerPasswordResetCode(storeSlug, resetEmail);
      setCodeSent(true);
    } catch (err: unknown) {
      setResetError(err instanceof Error ? err.message : t('login.failed'));
    } finally {
      setCodeSending(false);
    }
  };

  const handleResetSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setResetError('');
    if (newPassword !== confirmPassword) {
      setResetError(t('storeLogin.forgotPasswordMismatch'));
      return;
    }
    setResetLoading(true);
    try {
      const result = await completeOwnerPasswordReset({
        slug: storeSlug,
        email: resetEmail,
        code: resetCode,
        newPassword,
      });
      setResetUsername(result.username);
      setView('forgotDone');
    } catch (err: unknown) {
      setResetError(err instanceof Error ? err.message : t('login.failed'));
    } finally {
      setResetLoading(false);
    }
  };

  return (
    <div className="portal-light store-login-page">
      <header className="portal-light-header">
        <a href="/" className="portal-light-brand">
          <span className="portal-light-logo-wrap">
            <img src={portalLogoSrc()} alt="" className="portal-light-logo-img" />
          </span>
          <div className="portal-light-brand-text">
            <strong>{t('portal.brandName')}</strong>
            <span>{t('portal.tagline')}</span>
          </div>
        </a>

        <nav className="portal-light-nav" aria-label="Store login">
          <a href="/">{t('storeLogin.backPortal')}</a>
          <div className="portal-light-lang" role="group" aria-label={t('common.language')}>
            <button
              type="button"
              className={i18n.language?.startsWith('en') ? 'is-active' : ''}
              onClick={() => setLanguage('en-US')}
            >
              {t('portal.langEn')}
            </button>
            <button
              type="button"
              className={i18n.language?.startsWith('zh') ? 'is-active' : ''}
              onClick={() => setLanguage('zh-CN')}
            >
              {t('portal.langZh')}
            </button>
          </div>
        </nav>
      </header>

      <main className="portal-light-main store-login-main">
        <div className="store-login-card">
          <div className="store-login-store-head">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="store-login-avatar" />
            ) : (
              <div className="store-login-avatar store-login-avatar--fallback" aria-hidden>
                {titleMain.slice(0, 2).toUpperCase()}
              </div>
            )}
            <h1 className="store-login-title">{titleMain}</h1>
            {displayNameOther ? (
              <p className="store-login-name-other">{displayNameOther}</p>
            ) : null}
            <p className="store-login-subtitle">
              {view === 'forgot' || view === 'forgotDone'
                ? t('storeLogin.forgotSubtitle')
                : t('storeLogin.subtitle')}
            </p>
            <span className="store-login-slug-badge">/{storeSlug}</span>
          </div>

          {view === 'forgotDone' ? (
            <div className="store-login-forgot-done">
              <p>{t('storeLogin.forgotSuccess')}</p>
              {resetUsername ? (
                <p className="store-login-forgot-username">
                  {t('login.username')}: <strong>{resetUsername}</strong>
                </p>
              ) : null}
              <button
                type="button"
                className="portal-light-btn portal-light-btn--primary portal-light-auth-submit"
                onClick={() => {
                  setNewPassword('');
                  setConfirmPassword('');
                  setResetCode('');
                  switchView('signin');
                }}
              >
                {t('storeLogin.forgotBackToSignIn')}
              </button>
            </div>
          ) : (
            <>
              <div className="portal-light-auth-tabs store-login-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'signin'}
                  className={view === 'signin' ? 'is-active' : ''}
                  onClick={() => switchView('signin')}
                >
                  {t('login.submit')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'forgot'}
                  className={view === 'forgot' ? 'is-active' : ''}
                  onClick={() => switchView('forgot')}
                >
                  {t('storeLogin.forgotTab')}
                </button>
              </div>

              {view === 'signin' ? (
                <form className="store-login-form portal-light-auth-form" onSubmit={handleSubmit}>
                  <label className="portal-light-field">
                    <span>{t('login.username')}</span>
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      autoComplete="username"
                      required
                    />
                  </label>
                  <label className="portal-light-field">
                    <span>{t('login.password')}</span>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      required
                    />
                  </label>
                  {error ? (
                    <p className="portal-light-auth-error" role="alert">
                      {error}
                    </p>
                  ) : null}
                  <button
                    type="submit"
                    className="portal-light-btn portal-light-btn--primary portal-light-auth-submit"
                    disabled={loading}
                  >
                    {loading ? t('common.loading') : t('login.submit')}
                  </button>
                </form>
              ) : (
                <form className="store-login-form portal-light-auth-form" onSubmit={handleResetSubmit}>
                  <p className="portal-light-field-hint">{t('storeLogin.forgotHint')}</p>
                  <label className="portal-light-field">
                    <span>{t('portal.auth.email')}</span>
                    <div className="portal-light-email-row">
                      <input
                        type="email"
                        value={resetEmail}
                        onChange={(e) => {
                          setResetEmail(e.target.value);
                          setCodeSent(false);
                        }}
                        autoComplete="email"
                        required
                      />
                      <button
                        type="button"
                        className="portal-light-btn portal-light-btn--ghost"
                        disabled={codeSending || !resetEmail.trim()}
                        onClick={() => void handleSendResetCode()}
                      >
                        {codeSending
                          ? t('portal.auth.sendingCode')
                          : codeSent
                            ? t('portal.auth.resendCode')
                            : t('portal.auth.sendCode')}
                      </button>
                    </div>
                  </label>
                  <p className="portal-light-field-hint">{t('storeLogin.forgotCodeSentHint')}</p>
                  <label className="portal-light-field">
                    <span>{t('portal.auth.code')}</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={resetCode}
                      onChange={(e) => setResetCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="000000"
                      required
                    />
                  </label>
                  <label className="portal-light-field">
                    <span>{t('storeLogin.forgotNewPassword')}</span>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      autoComplete="new-password"
                      minLength={6}
                      required
                    />
                  </label>
                  <label className="portal-light-field">
                    <span>{t('storeLogin.forgotConfirmPassword')}</span>
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      autoComplete="new-password"
                      minLength={6}
                      required
                    />
                  </label>
                  {resetError ? (
                    <p className="portal-light-auth-error" role="alert">
                      {resetError}
                    </p>
                  ) : null}
                  <button
                    type="submit"
                    className="portal-light-btn portal-light-btn--primary portal-light-auth-submit"
                    disabled={resetLoading}
                  >
                    {resetLoading ? t('common.loading') : t('storeLogin.forgotSubmit')}
                  </button>
                </form>
              )}
            </>
          )}

          <footer className="store-login-footer">
            <Link to={`/${storeSlug}`}>{t('storeLogin.viewStorefront')}</Link>
            <a href="/#get-started">{t('storeLogin.wrongStore')}</a>
            <p className="store-login-powered">
              {t('storeLogin.poweredBy')} <strong>{t('portal.brandName')}</strong>
            </p>
          </footer>
        </div>
      </main>
    </div>
  );
}
