import { useMemo, useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useRestaurantConfig } from '../../hooks/useRestaurantConfig';
import { useBusinessStatus } from '../../hooks/useBusinessStatus';
import { useStoreSlug } from '../../context/StoreContext';
import type { OfferData } from '../../utils/bundleMatcher';
import { useCustomerMenuBootstrap } from '../../context/CustomerMenuBootstrapContext';
import MenuView from './MenuView';
import CustomerMenuToolbar from '../../components/customer/CustomerMenuToolbar';
import '../../styles/customer-order-saas.css';

function parseHoursSlots(raw?: string): { start: string; end: string }[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s) => typeof s?.start === 'string' && typeof s?.end === 'string')
      .map((s) => ({ start: s.start, end: s.end }));
  } catch {
    return [];
  }
}

export default function StoreFrontPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const storeSlug = useStoreSlug();
  const [searchParams, setSearchParams] = useSearchParams();
  const { config, displayName, displayNameOther } = useRestaurantConfig();
  const { isOpen, loading: hoursLoading, deliveryEnabled, memberWalletEnabled } = useBusinessStatus();
  const canDelivery = deliveryEnabled !== false;
  const canMemberPortal = memberWalletEnabled !== false;

  const orderType = searchParams.get('type');
  const showMenu = orderType === 'takeout' || (orderType === 'delivery' && canDelivery);

  useEffect(() => {
    if (hoursLoading) return;
    if (orderType === 'delivery' && !canDelivery) {
      const next = new URLSearchParams(searchParams);
      next.delete('type');
      setSearchParams(next, { replace: true });
    }
  }, [orderType, canDelivery, hoursLoading, searchParams, setSearchParams]);

  const phone = (config.restaurant_phone || '').trim();
  const address = (config.restaurant_address || '').trim();
  const email = (config.restaurant_email || '').trim();
  const storeTitle = displayName || storeSlug;
  const slots = useMemo(() => parseHoursSlots(config.business_hours_slots), [config.business_hours_slots]);
  const menuBootstrap = useCustomerMenuBootstrap();
  const [offers, setOffers] = useState<OfferData[]>([]);

  useEffect(() => {
    if (!menuBootstrap.ready) return;
    setOffers(menuBootstrap.offers);
  }, [menuBootstrap.ready, menuBootstrap.offers]);

  const offerTitle = (o: OfferData) => (lang.startsWith('zh') ? o.name : (o.nameEn || o.name));
  const offerDesc = (o: OfferData) => {
    const d = lang.startsWith('zh') ? o.description : (o.descriptionEn || o.description);
    return (d || '').trim();
  };

  const mapHref = address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
    : '';

  const mapEmbedSrc = useMemo(() => {
    const a = address.trim();
    if (!a) return null;
    const qEnc = encodeURIComponent(a);
    const hl = lang.startsWith('zh') ? 'zh-CN' : 'en';
    const embedKey = (import.meta.env.VITE_GOOGLE_MAPS_EMBED_KEY || '').trim();
    if (embedKey) {
      const langParam = lang.startsWith('zh') ? 'zh-CN' : 'en';
      return `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(embedKey)}&q=${qEnc}&language=${encodeURIComponent(langParam)}`;
    }
    return `https://www.google.com/maps?q=${qEnc}&output=embed&z=16&hl=${encodeURIComponent(hl)}`;
  }, [address, lang]);

  const setMode = (type: 'delivery' | 'takeout') => {
    const next = new URLSearchParams(searchParams);
    next.set('type', type);
    setSearchParams(next, { replace: false });
  };

  return (
    <div
      className={showMenu ? undefined : 'store-portal-page'}
      style={{
        display: 'flex',
        flexDirection: 'column',
        ...(showMenu ? { flex: 1, minHeight: 0, height: '100%', overflow: 'hidden' } : {}),
      }}
    >
      {!showMenu ? (
        <>
          <CustomerMenuToolbar />
          <div className="store-portal-scroll">
            <section className="store-portal-hero">
              <div className="store-portal-hero__head">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h1 className="store-portal-hero__title">{storeTitle}</h1>
                  {displayNameOther ? (
                    <div className="store-portal-hero__subtitle">{displayNameOther}</div>
                  ) : null}
                  <p className="store-portal-hero__tagline">{t('customer.storePortalTagline')}</p>
                  <div className="store-portal-hero__meta">
                    {hoursLoading ? (
                      <span className="store-portal-status">{t('customer.storePortalCheckingHours')}</span>
                    ) : (
                      <span className={`store-portal-status${isOpen ? ' store-portal-status--open' : ' store-portal-status--closed'}`}>
                        <span className="store-portal-status__dot" aria-hidden />
                        {isOpen ? t('customer.storePortalOpenNow') : t('customer.storePortalClosedNow')}
                      </span>
                    )}
                    {canMemberPortal ? (
                      <Link to={`/${storeSlug}/customer/member`} className="store-portal-member-link">
                        {t('member.title')} →
                      </Link>
                    ) : null}
                  </div>
                </div>
              </div>
            </section>

            <section className="store-portal-section">
              <div className="store-portal-order-card">
                <h2 className="store-portal-section__title">{t('customer.storePortalChooseTitle')}</h2>
                <div className="store-portal-modes">
                  {canDelivery ? (
                    <button
                      type="button"
                      className="store-portal-mode-btn store-portal-mode-btn--primary"
                      disabled={!isOpen || hoursLoading}
                      onClick={() => setMode('delivery')}
                    >
                      <span className="store-portal-mode-btn__label">🚚 {lang.startsWith('zh') ? '外卖送餐' : 'Delivery'}</span>
                      <span className="store-portal-mode-btn__hint">{t('customer.storePortalDeliveryHint')}</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={`store-portal-mode-btn${canDelivery ? '' : ' store-portal-mode-btn--primary'}`}
                    disabled={!isOpen || hoursLoading}
                    onClick={() => setMode('takeout')}
                  >
                    <span className="store-portal-mode-btn__label">🥡 {lang.startsWith('zh') ? '到店自取' : 'Pickup'}</span>
                    <span className="store-portal-mode-btn__hint">{t('customer.storePortalPickupHint')}</span>
                  </button>
                </div>
                {!isOpen && !hoursLoading ? (
                  <div className="store-portal-closed-note">
                    {lang.startsWith('zh') ? '当前非营业时间，暂无法下单。' : 'Ordering is unavailable while closed.'}
                  </div>
                ) : null}
              </div>
            </section>

            {offers.length > 0 ? (
              <section className="store-portal-section">
                <h2 className="store-portal-section__title">{t('customer.storePortalOffersTitle')}</h2>
                <p className="store-portal-section__hint">{t('customer.storePortalOfferHint')}</p>
                <div className="store-portal-offers-list">
                  {offers.map((offer) => (
                    <div key={offer._id} className="store-portal-offer-card">
                      <div className="store-portal-offer-card__badge">
                        🎁 {lang.startsWith('zh') ? '套餐优惠' : 'Bundle'}
                      </div>
                      <div className="store-portal-offer-card__title">{offerTitle(offer)}</div>
                      {offerDesc(offer) ? (
                        <div className="store-portal-offer-card__desc">{offerDesc(offer)}</div>
                      ) : null}
                      <div className="store-portal-offer-card__foot">
                        <span style={{ fontSize: 11, color: 'var(--co-muted)', fontWeight: 600 }}>
                          {t('customer.storePortalOfferPriceLabel')}
                        </span>
                        <span className="store-portal-offer-card__price">€{offer.bundlePrice.toFixed(2)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {(slots.length > 0 || phone || address || email) ? (
              <section className="store-portal-section">
                <h2 className="store-portal-section__title">{t('customer.storePortalAbout')}</h2>
                <div className="store-portal-info-list">
                  {slots.length > 0 ? (
                    <div className="store-portal-info-card">
                      <span className="store-portal-info-card__icon" aria-hidden>🕐</span>
                      <div>
                        <span className="store-portal-info-card__label">{lang.startsWith('zh') ? '营业时间' : 'Hours'}</span>
                        <span className="store-portal-info-card__value">
                          {slots.map((s, i) => (
                            <span key={i}>
                              {i > 0 ? ' · ' : ''}{s.start}–{s.end}
                            </span>
                          ))}
                        </span>
                      </div>
                    </div>
                  ) : null}
                  {phone ? (
                    <a href={`tel:${phone.replace(/\s/g, '')}`} className="store-portal-info-card">
                      <span className="store-portal-info-card__icon" aria-hidden>📞</span>
                      <div>
                        <span className="store-portal-info-card__label">{lang.startsWith('zh') ? '电话' : 'Phone'}</span>
                        <span className="store-portal-info-card__value store-portal-info-card__value--link">{phone}</span>
                      </div>
                    </a>
                  ) : null}
                  {email ? (
                    <a href={`mailto:${email}`} className="store-portal-info-card">
                      <span className="store-portal-info-card__icon" aria-hidden>✉️</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span className="store-portal-info-card__label">{lang.startsWith('zh') ? '邮箱' : 'Email'}</span>
                        <span className="store-portal-info-card__value store-portal-info-card__value--link" style={{ wordBreak: 'break-all' }}>{email}</span>
                      </div>
                    </a>
                  ) : null}
                  {address ? (
                    <div className="store-portal-info-card">
                      <span className="store-portal-info-card__icon" aria-hidden>📍</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span className="store-portal-info-card__label">{lang.startsWith('zh') ? '地址' : 'Address'}</span>
                        <div className="store-portal-info-card__value">
                          {mapHref ? (
                            <a href={mapHref} target="_blank" rel="noopener noreferrer" className="store-portal-info-card__value--link">
                              {address}
                            </a>
                          ) : address}
                        </div>
                        {mapEmbedSrc ? (
                          <div className="store-portal-map">
                            <iframe
                              title={t('customer.storePortalMapEmbedTitle')}
                              src={mapEmbedSrc}
                              loading="lazy"
                              referrerPolicy="no-referrer-when-downgrade"
                            />
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </section>
            ) : null}
          </div>
        </>
      ) : null}

      {showMenu ? <MenuView storeFrontEmbed /> : null}
    </div>
  );
}
