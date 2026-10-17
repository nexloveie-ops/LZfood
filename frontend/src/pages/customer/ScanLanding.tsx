import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { encodeQRParams, parseQRParams } from '../../utils/qrCode';
import { useRestaurantConfig } from '../../hooks/useRestaurantConfig';
import { useStoreSlug } from '../../context/StoreContext';
import { useBusinessStatus } from '../../hooks/useBusinessStatus';
import BannerPlatformCredit from '../../components/customer/BannerPlatformCredit';

export default function ScanLanding() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();
  const storeSlug = useStoreSlug();
  const { displayName, displayNameOther } = useRestaurantConfig();
  const storeTitle = displayName || storeSlug;
  const { isOpen, reason, loading, deliveryEnabled } = useBusinessStatus();
  const canDelivery = deliveryEnabled !== false;
  const params = parseQRParams(searchParams);

  useEffect(() => {
    if (loading || !isOpen) return;
    if (params.type === 'dine_in') {
      navigate(`menu?${encodeQRParams(params.tableNumber, params.seatNumber)}`, { replace: true });
    } else if (params.type === 'takeout') {
      navigate('menu?type=takeout', { replace: true });
    } else if (params.type === 'delivery') {
      if (canDelivery) {
        navigate('menu?type=delivery', { replace: true });
      } else {
        navigate(`/${storeSlug}`, { replace: true });
      }
    }
  }, [params, navigate, loading, isOpen, canDelivery, storeSlug]);

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>{t('common.loading')}</div>;
  }

  if (!isOpen) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '70vh', padding: 20, textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🕒</div>
        <h2 style={{ marginBottom: 8 }}>{t('customer.storeClosedTitle')}</h2>
        <p style={{ color: 'var(--text-light)', maxWidth: 320 }}>
          {reason === 'closed_date' ? t('customer.storeClosedDate') : t('customer.storeOutsideHours')}
        </p>
      </div>
    );
  }

  if (params.type === 'invalid') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '80vh', padding: 20, textAlign: 'center' }}>
        {/* Hero branding */}
        <div style={{
          background: 'linear-gradient(135deg, #8B1A1A 0%, #C41E24 50%, #D4342A 100%)',
          borderRadius: 16, padding: '40px 32px', marginBottom: 24, width: '100%', maxWidth: 340,
          color: '#fff', position: 'relative', overflow: 'hidden',
        }}>
          <BannerPlatformCredit variant="onGradient" />
          <div style={{ position: 'relative', zIndex: 1, paddingRight: 'min(200px, 46vw)' }}>
            <h1 style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 26, fontWeight: 700, letterSpacing: 3, marginBottom: 4 }}>
              {storeTitle}
            </h1>
            {displayNameOther ? (
              <div style={{ fontSize: 12, fontWeight: 300, letterSpacing: 6, color: '#F0D68A', textTransform: 'uppercase' }}>
                {displayNameOther}
              </div>
            ) : null}
            <div style={{
              display: 'inline-block', marginTop: 10, padding: '4px 14px',
              border: '1px solid #D4A853', color: '#F0D68A', fontSize: 11,
              letterSpacing: 2, borderRadius: 2,
            }}>港式燒臘 · 地道風味</div>
          </div>
        </div>

        <div style={{ fontSize: 48, marginBottom: 16 }}>📱</div>
        <p style={{ color: 'var(--text-light)', fontSize: 14, maxWidth: 280 }}>
          {t('customer.scanPrompt')}
        </p>
        <p style={{ color: 'var(--red-primary)', fontSize: 13, marginTop: 12 }}>
          {t('customer.invalidQR')}
        </p>
      </div>
    );
  }

  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>{t('common.loading')}</div>;
}
