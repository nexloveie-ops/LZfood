import { Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CustomerMenuBootstrapProvider } from '../context/CustomerMenuBootstrapContext';
import StorePreloaderGate from '../components/customer/StorePreloaderGate';
import '../styles/customer-order-saas.css';

const AD_CONTACT_EMAIL = 'info@lztechserve.com';

function CustomerLayoutInner() {
  const { t } = useTranslation();

  return (
    <div className="customer-order-app" style={{ display: 'flex', flexDirection: 'column', height: '100%', maxWidth: 430, margin: '0 auto', width: '100%', minWidth: 0, overflowX: 'hidden' }}>
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflowX: 'hidden', overflowY: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <Outlet />
      </div>

      <footer className="customer-order-footer" style={{
        flexShrink: 0,
        padding: '6px 10px calc(6px + env(safe-area-inset-bottom, 0px))',
        textAlign: 'center',
        lineHeight: 1.3,
      }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: '4px 6px' }}>
          <span style={{ opacity: 0.92, fontWeight: 600 }}>{t('customer.footerCompany')}</span>
          <span style={{ opacity: 0.35, userSelect: 'none' }} aria-hidden>·</span>
          <span style={{ opacity: 0.92 }}>{t('customer.footerAdContact')}</span>
          <a href={`mailto:${AD_CONTACT_EMAIL}`} style={{ color: 'var(--text-light)', textDecoration: 'none', fontSize: 10 }}>
            {AD_CONTACT_EMAIL}
          </a>
        </div>
      </footer>
    </div>
  );
}

export default function CustomerLayout() {
  const { i18n } = useTranslation();

  return (
    <CustomerMenuBootstrapProvider lang={i18n.language}>
      <StorePreloaderGate>
        <CustomerLayoutInner />
      </StorePreloaderGate>
    </CustomerMenuBootstrapProvider>
  );
}
