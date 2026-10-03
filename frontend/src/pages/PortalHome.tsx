import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import PortalAuthSection from '../components/portal/PortalAuthSection';
import { portalLogoSrc } from '../constants/portalBrand';
import { persistUserLanguage } from '../i18n';
import './portal-home.css';

const DEMO_SLUG = import.meta.env.VITE_DEFAULT_STORE_SLUG || 'demo';
const CONTACT_EMAIL = 'info@lztechserve.com';

const BENEFIT_KEYS = ['wait', 'addon', 'clarity', 'allergen', 'pricing', 'bundle'] as const;
const FEATURE_KEYS = ['channels', 'menu', 'cashier', 'saas'] as const;
const FREE_PLAN_KEYS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'] as const;
const PRO_PLAN_KEYS = ['p1', 'p2', 'p3', 'p4', 'p5'] as const;
const STEP_KEYS = ['s1', 's2', 's3'] as const;
const STAT_KEYS = ['channels', 'web', 'free', 'realtime'] as const;

const TICKET_TONES = ['dine', 'take', 'del'] as const;

export default function PortalHome() {
  const { t, i18n } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const lang = i18n.language?.startsWith('zh') ? 'zh-CN' : 'en-US';
    document.documentElement.lang = lang;
    document.title = `${t('portal.brandName')} — ${t('portal.tagline')}`;
  }, [i18n.language, t]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    const onMove = (e: PointerEvent) => {
      root.style.setProperty('--spot-x', `${e.clientX}px`);
      root.style.setProperty('--spot-y', `${e.clientY}px`);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  const setLanguage = (lng: string) => {
    void i18n.changeLanguage(lng);
    persistUserLanguage(lng);
  };

  const demoHref = `/${DEMO_SLUG}`;
  const tickerItems = t('portal.ticker', { returnObjects: true });
  const ticker = Array.isArray(tickerItems) ? tickerItems.map(String) : [];
  const tickerLoop = [...ticker, ...ticker];

  return (
    <div className="portal-light" ref={rootRef}>
      <div className="portal-grain" aria-hidden />
      <div className="portal-spot" aria-hidden />

      <header className="portal-light-header">
        <a href="/" className="portal-light-brand">
          <span className="portal-light-logo-wrap">
            <img src={portalLogoSrc()} alt="L&Z Techserve Limited" className="portal-light-logo-img" />
          </span>
          <div className="portal-light-brand-text">
            <strong>{t('portal.brandName')}</strong>
            <span>{t('portal.tagline')}</span>
          </div>
        </a>

        <nav className="portal-light-nav" aria-label="Primary">
          <a href="#get-started">{t('portal.navAuth')}</a>
          <a href="#benefits">{t('portal.navBenefits')}</a>
          <a href="#features">{t('portal.navFeatures')}</a>
          <a href="#plans">{t('portal.navPlans')}</a>
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

      <main className="portal-light-main">
        <section className="portal-light-hero">
          <div>
            <span className="portal-light-pill">{t('portal.pill')}</span>
            <h1 className="portal-light-h1">{t('portal.hero')}</h1>
            <p className="portal-light-h1-alt">{t('portal.heroAlt')}</p>
            <p className="portal-light-lead">{t('portal.lead')}</p>
            <div className="portal-light-hero-cta">
              <a className="portal-light-btn portal-light-btn--primary" href="#get-started">
                {t('portal.ctaStart')}
              </a>
              <a className="portal-light-btn portal-light-btn--ghost" href={demoHref}>
                {t('portal.ctaDemo')}
              </a>
            </div>
          </div>

          <aside className="portal-pos" aria-label={t('portal.previewLabel')}>
            <div className="portal-pos-shell">
              <div className="portal-pos-screen">
                <div className="portal-pos-bar">
                  <span className="portal-pos-live" />
                  {t('portal.previewLabel')}
                  <div className="portal-pos-lang" role="group" aria-label={t('common.language')}>
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
                  <span className="portal-pos-clock">{t('portal.previewClock')}</span>
                </div>
                <ul className="portal-pos-tickets" key={i18n.language}>
                  {TICKET_TONES.map((tone, i) => (
                    <li key={tone} className={`portal-pos-ticket portal-pos-ticket--${tone}`} style={{ animationDelay: `${i * 0.28}s` }}>
                      <div className="portal-pos-ticket-ch">
                        <b>{t(`portal.previewTickets.${tone}.channel`)}</b>
                      </div>
                      <strong>{t(`portal.previewTickets.${tone}.title`)}</strong>
                      <em>{t(`portal.previewTickets.${tone}.meta`)}</em>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="portal-receipt" aria-hidden>
              <div className="portal-receipt-paper">
                <span className="portal-receipt-brand">LZFOOD</span>
                <span>{t('portal.previewReceipt.table')}</span>
                <span>{t('portal.previewReceipt.dish')}</span>
                <span>{t('portal.previewReceipt.side')}</span>
                <i />
                <span>€24.80</span>
              </div>
            </div>
          </aside>
        </section>

        <div className="portal-ticker" aria-hidden>
          <div className="portal-ticker-track">
            {tickerLoop.map((item, i) => (
              <span key={`${item}-${i}`}>{item}</span>
            ))}
          </div>
        </div>

        <section className="portal-light-stats" aria-label={t('portal.statsAria')}>
          {STAT_KEYS.map((key) => (
            <div key={key} className="portal-light-stat">
              <strong>{t(`portal.stats.${key}.value`)}</strong>
              <span>{t(`portal.stats.${key}.label`)}</span>
            </div>
          ))}
        </section>

        <PortalAuthSection />

        <section id="benefits" className="portal-reveal" aria-labelledby="benefits-heading">
          <div className="portal-light-section-head">
            <h2 id="benefits-heading">{t('portal.benefitsTitle')}</h2>
            <p>{t('portal.benefitsSubtitle')}</p>
          </div>
          <div className="portal-light-benefits">
            {BENEFIT_KEYS.map((key, i) => (
              <article key={key} className="portal-light-benefit">
                <div className="portal-light-benefit-icon" aria-hidden>
                  {String(i + 1).padStart(2, '0')}
                </div>
                <h3>{t(`portal.benefits.${key}.title`)}</h3>
                <p>{t(`portal.benefits.${key}.desc`)}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="features" className="portal-reveal" aria-labelledby="features-heading">
          <div className="portal-light-section-head">
            <h2 id="features-heading">{t('portal.featuresTitle')}</h2>
            <p>{t('portal.featuresSubtitle')}</p>
          </div>
          <div className="portal-light-features">
            {FEATURE_KEYS.map((key, i) => (
              <article key={key} className="portal-light-feature">
                <div className="portal-light-feature-icon" aria-hidden>
                  {String(i + 1).padStart(2, '0')}
                </div>
                <div>
                  <h3>{t(`portal.features.${key}.title`)}</h3>
                  <p>{t(`portal.features.${key}.desc`)}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section id="plans" className="portal-reveal" aria-labelledby="plans-heading">
          <div className="portal-light-section-head">
            <h2 id="plans-heading">{t('portal.plansTitle')}</h2>
            <p>{t('portal.plansSubtitle')}</p>
          </div>
          <div className="portal-light-plans">
            <article className="portal-light-plan">
              <div className="portal-light-plan-badge">{t('portal.planFree.badge')}</div>
              <h3>{t('portal.planFree.name')}</h3>
              <p className="portal-light-plan-desc">{t('portal.planFree.desc')}</p>
              <ul>
                {FREE_PLAN_KEYS.map((k) => (
                  <li key={k}>{t(`portal.planFree.items.${k}`)}</li>
                ))}
              </ul>
              <a className="portal-light-btn portal-light-btn--ghost" href="#get-started">
                {t('portal.ctaStart')}
              </a>
            </article>
            <article className="portal-light-plan portal-light-plan--pro">
              <div className="portal-light-plan-badge">{t('portal.planPro.badge')}</div>
              <h3>{t('portal.planPro.name')}</h3>
              <p className="portal-light-plan-desc">{t('portal.planPro.desc')}</p>
              <ul>
                {PRO_PLAN_KEYS.map((k) => (
                  <li key={k}>{t(`portal.planPro.items.${k}`)}</li>
                ))}
              </ul>
              <a className="portal-light-btn portal-light-btn--primary" href={`mailto:${CONTACT_EMAIL}`}>
                {t('portal.ctaPro')}
              </a>
            </article>
          </div>
        </section>

        <section className="portal-reveal" aria-labelledby="steps-heading">
          <div className="portal-light-section-head">
            <h2 id="steps-heading">{t('portal.stepsTitle')}</h2>
            <p>{t('portal.stepsSubtitle')}</p>
          </div>
          <div className="portal-light-steps">
            {STEP_KEYS.map((key, i) => (
              <div key={key} className="portal-light-step">
                <div className="portal-light-step-num">{i + 1}</div>
                <h3>{t(`portal.steps.${key}.title`)}</h3>
                <p>{t(`portal.steps.${key}.desc`)}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="contact" className="portal-light-contact portal-reveal" aria-labelledby="contact-heading">
          <div className="portal-light-contact-inner">
            <div className="portal-light-contact-text">
              <h2 id="contact-heading">{t('portal.contactTitle')}</h2>
              <p>{t('portal.contactDesc')}</p>
              <ul className="portal-light-contact-list">
                <li>{t('portal.contactPoint1')}</li>
                <li>{t('portal.contactPoint2')}</li>
                <li>{t('portal.contactPoint3')}</li>
              </ul>
            </div>
            <div className="portal-light-contact-card">
              <p className="portal-light-contact-label">{t('portal.contactEmailLabel')}</p>
              <a className="portal-light-contact-email" href={`mailto:${CONTACT_EMAIL}`}>
                {CONTACT_EMAIL}
              </a>
              <a className="portal-light-btn portal-light-btn--primary portal-light-contact-btn" href={`mailto:${CONTACT_EMAIL}`}>
                {t('portal.contactSend')}
              </a>
              <p className="portal-light-contact-hint">{t('portal.contactHint')}</p>
            </div>
          </div>
        </section>

        <footer className="portal-light-footer">
          <p>{t('portal.footer')}</p>
        </footer>
      </main>
    </div>
  );
}
