import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  checkPortalSlugAvailable,
  completePortalRegistration,
  resolvePortalLogin,
  sendPortalRegistrationCode,
} from '../../api/portal';

type AuthTab = 'login' | 'register';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export default function PortalAuthSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [tab, setTab] = useState<AuthTab>('login');

  const [loginSlug, setLoginSlug] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');

  const [displayName, setDisplayName] = useState('');
  const [slug, setSlug] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [registerError, setRegisterError] = useState('');
  const [registerLoading, setRegisterLoading] = useState(false);
  const [codeSending, setCodeSending] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [slugHint, setSlugHint] = useState<'idle' | 'checking' | 'ok' | 'bad'>('idle');
  const [registerSuccess, setRegisterSuccess] = useState<{
    slug: string;
    loginPath: string;
  } | null>(null);

  useEffect(() => {
    const normalized = slug.trim().toLowerCase();
    if (!normalized) {
      setSlugHint('idle');
      return;
    }
    if (!SLUG_PATTERN.test(normalized)) {
      setSlugHint('bad');
      return;
    }
    setSlugHint('checking');
    const timer = window.setTimeout(() => {
      void checkPortalSlugAvailable(normalized)
        .then((r) => setSlugHint(r.available ? 'ok' : 'bad'))
        .catch(() => setSlugHint('idle'));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [slug]);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoginError('');
    setLoginLoading(true);
    try {
      const result = await resolvePortalLogin(loginSlug);
      navigate(result.loginPath);
    } catch (err: unknown) {
      setLoginError(err instanceof Error ? err.message : t('portal.auth.errorGeneric'));
    } finally {
      setLoginLoading(false);
    }
  };

  const handleSendCode = async () => {
    setRegisterError('');
    setCodeSending(true);
    try {
      await sendPortalRegistrationCode(email);
      setCodeSent(true);
    } catch (err: unknown) {
      setRegisterError(err instanceof Error ? err.message : t('portal.auth.errorGeneric'));
    } finally {
      setCodeSending(false);
    }
  };

  const handleRegister = async (e: FormEvent) => {
    e.preventDefault();
    setRegisterError('');
    setRegisterLoading(true);
    try {
      const result = await completePortalRegistration({
        displayName,
        slug: slug.trim().toLowerCase(),
        email,
        code,
        username,
        password,
      });
      setRegisterSuccess({ slug: result.slug, loginPath: result.loginPath });
    } catch (err: unknown) {
      setRegisterError(err instanceof Error ? err.message : t('portal.auth.errorGeneric'));
    } finally {
      setRegisterLoading(false);
    }
  };

  const switchTab = useCallback((next: AuthTab) => {
    setTab(next);
    setLoginError('');
    setRegisterError('');
    setRegisterSuccess(null);
  }, []);

  if (registerSuccess) {
    return (
      <section id="get-started" className="portal-light-auth" aria-labelledby="auth-heading">
        <div className="portal-light-auth-inner portal-light-auth-success">
          <h2 id="auth-heading">{t('portal.auth.successTitle')}</h2>
          <p>{t('portal.auth.successDesc', { slug: registerSuccess.slug })}</p>
          <button
            type="button"
            className="portal-light-btn portal-light-btn--primary"
            onClick={() => navigate(registerSuccess.loginPath)}
          >
            {t('portal.auth.goLogin')}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section id="get-started" className="portal-light-auth" aria-labelledby="auth-heading">
      <div className="portal-light-auth-inner">
        <div className="portal-light-auth-intro">
          <h2 id="auth-heading">{t('portal.auth.title')}</h2>
          <p>{t('portal.auth.subtitle')}</p>
          <ul className="portal-light-auth-points">
            <li>{t('portal.auth.point1')}</li>
            <li>{t('portal.auth.point2')}</li>
            <li>{t('portal.auth.point3')}</li>
          </ul>
        </div>

        <div className="portal-light-auth-card">
          <div className="portal-light-auth-tabs" role="tablist" aria-label={t('portal.auth.title')}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'login'}
              className={tab === 'login' ? 'is-active' : ''}
              onClick={() => switchTab('login')}
            >
              {t('portal.auth.tabLogin')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'register'}
              className={tab === 'register' ? 'is-active' : ''}
              onClick={() => switchTab('register')}
            >
              {t('portal.auth.tabRegister')}
            </button>
          </div>

          {tab === 'login' ? (
            <form className="portal-light-auth-form" onSubmit={handleLogin}>
              <label className="portal-light-field">
                <span>{t('portal.auth.loginSlugLabel')}</span>
                <input
                  type="text"
                  value={loginSlug}
                  onChange={(e) => setLoginSlug(e.target.value)}
                  placeholder={t('portal.auth.loginSlugPlaceholder')}
                  autoComplete="off"
                  required
                />
              </label>
              <p className="portal-light-field-hint">{t('portal.auth.loginSlugHint')}</p>
              {loginError ? <p className="portal-light-auth-error" role="alert">{loginError}</p> : null}
              <button
                type="submit"
                className="portal-light-btn portal-light-btn--primary portal-light-auth-submit"
                disabled={loginLoading}
              >
                {loginLoading ? t('portal.auth.loading') : t('portal.auth.loginSubmit')}
              </button>
            </form>
          ) : (
            <form className="portal-light-auth-form" onSubmit={handleRegister}>
              <label className="portal-light-field">
                <span>{t('portal.auth.storeName')}</span>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  required
                />
              </label>

              <label className="portal-light-field">
                <span>{t('portal.auth.slug')}</span>
                <div className="portal-light-slug-row">
                  <span className="portal-light-slug-prefix">/</span>
                  <input
                    type="text"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value.toLowerCase())}
                    placeholder={t('portal.auth.slugPlaceholder')}
                    autoComplete="off"
                    required
                  />
                </div>
              </label>
              {slug.trim() ? (
                <p
                  className={`portal-light-slug-status portal-light-slug-status--${slugHint}`}
                  aria-live="polite"
                >
                  {slugHint === 'checking' && t('portal.auth.slugChecking')}
                  {slugHint === 'ok' && t('portal.auth.slugAvailable')}
                  {slugHint === 'bad' && t('portal.auth.slugUnavailable')}
                </p>
              ) : null}

              <label className="portal-light-field">
                <span>{t('portal.auth.email')}</span>
                <div className="portal-light-email-row">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setCodeSent(false);
                    }}
                    autoComplete="email"
                    required
                  />
                  <button
                    type="button"
                    className="portal-light-btn portal-light-btn--ghost"
                    disabled={codeSending || !email.trim()}
                    onClick={() => void handleSendCode()}
                  >
                    {codeSending
                      ? t('portal.auth.sendingCode')
                      : codeSent
                        ? t('portal.auth.resendCode')
                        : t('portal.auth.sendCode')}
                  </button>
                </div>
              </label>

              <label className="portal-light-field">
                <span>{t('portal.auth.code')}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  required
                />
              </label>

              <label className="portal-light-field">
                <span>{t('portal.auth.username')}</span>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  required
                />
              </label>

              <label className="portal-light-field">
                <span>{t('portal.auth.password')}</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={6}
                  required
                />
              </label>

              <p className="portal-light-field-hint">{t('portal.auth.registerHint')}</p>
              {registerError ? <p className="portal-light-auth-error" role="alert">{registerError}</p> : null}
              <button
                type="submit"
                className="portal-light-btn portal-light-btn--primary portal-light-auth-submit"
                disabled={registerLoading || slugHint === 'bad'}
              >
                {registerLoading ? t('portal.auth.loading') : t('portal.auth.registerSubmit')}
              </button>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
