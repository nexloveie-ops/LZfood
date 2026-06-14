import { useMemo, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useRestaurantConfig } from '../../hooks/useRestaurantConfig';
import { useBusinessStatus } from '../../hooks/useBusinessStatus';
import { useStoreSlug } from '../../context/StoreContext';
import type { OfferData } from '../../utils/bundleMatcher';
import { useCustomerMenuBootstrap } from '../../context/CustomerMenuBootstrapContext';
import MenuView from './MenuView';
import BannerPlatformCredit from '../../components/customer/BannerPlatformCredit';

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

  const infoCardStyle: CSSProperties = {
    background: 'var(--bg-white)',
    borderRadius: 12,
    padding: '12px 14px',
    border: '1px solid rgba(232,213,184,0.55)',
    boxShadow: '0 2px 12px rgba(196,30,36,0.06)',
    display: 'flex',
    gap: 10,
    alignItems: 'flex-start',
  };

  const titleFont = "'Noto Serif SC', serif";

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100%',
        ...(showMenu ? { flex: 1, minHeight: 0, height: '100%', overflow: 'hidden' } : { flexShrink: 0 }),
      }}
    >
      {!showMenu ? (
        <div
          style={{
            flex: 1,
            position: 'relative',
            overflow: 'hidden',
            background: 'linear-gradient(165deg, #fff5f0 0%, #ffe8e0 28%, #fff9f5 55%, #faf6f0 100%)',
          }}
        >
          <div
            aria-hidden
            style={{
              position: 'absolute',
              width: 260,
              height: 260,
              borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(196,30,36,0.12) 0%, transparent 70%)',
              top: -100,
              right: -80,
              pointerEvents: 'none',
            }}
          />
          <div
            aria-hidden
            style={{
              position: 'absolute',
              width: 200,
              height: 200,
              borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(212,168,83,0.18) 0%, transparent 68%)',
              bottom: 120,
              left: -90,
              pointerEvents: 'none',
            }}
          />

          <div style={{ position: 'relative', zIndex: 1, padding: '18px 14px 40px' }}>
            {/* Brand hero */}
            <div
              style={{
                position: 'relative',
                borderRadius: 20,
                overflow: 'hidden',
                background: 'linear-gradient(135deg, #8B1A1A 0%, #C41E24 50%, #D4342A 100%)',
                boxShadow: '0 14px 44px rgba(196,30,36,0.32)',
                padding: '48px 18px 26px',
              }}
            >
              <BannerPlatformCredit variant="onGradient" />
              <div style={{ position: 'relative', zIndex: 1, paddingRight: 'min(96px, 26vw)' }}>
                <h1
                  style={{
                    fontFamily: titleFont,
                    fontSize: 26,
                    fontWeight: 700,
                    margin: 0,
                    color: '#fff',
                    letterSpacing: lang.startsWith('zh') ? 3 : 0,
                    lineHeight: 1.2,
                    ...(lang.startsWith('zh')
                      ? { wordBreak: 'keep-all' as const }
                      : { overflowWrap: 'break-word' as const }),
                  }}
                >
                  {storeTitle}
                </h1>
                {displayNameOther ? (
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 300,
                      letterSpacing: 5,
                      color: '#F0D68A',
                      marginTop: 8,
                      textTransform: 'uppercase',
                    }}
                  >
                    {displayNameOther}
                  </div>
                ) : null}
                <p style={{ margin: '14px 0 0', fontSize: 12, color: 'rgba(255,255,255,0.9)', lineHeight: 1.55 }}>
                  {t('customer.storePortalTagline')}
                </p>
                <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 14px' }}>
                  {hoursLoading ? (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '6px 12px',
                        borderRadius: 999,
                        background: 'rgba(255,255,255,0.12)',
                        color: '#F0D68A',
                        border: '1px solid rgba(240,214,138,0.35)',
                      }}
                    >
                      {t('customer.storePortalCheckingHours')}
                    </span>
                  ) : (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 11,
                        fontWeight: 700,
                        padding: '6px 12px',
                        borderRadius: 999,
                        background: isOpen ? 'rgba(46,125,50,0.28)' : 'rgba(0,0,0,0.22)',
                        color: '#fff',
                        border: `1px solid ${isOpen ? 'rgba(165,214,167,0.55)' : 'rgba(255,255,255,0.28)'}`,
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          background: isOpen ? '#C8E6C9' : '#FFCDD2',
                          flexShrink: 0,
                        }}
                      />
                      {isOpen ? t('customer.storePortalOpenNow') : t('customer.storePortalClosedNow')}
                    </span>
                  )}
                  {canMemberPortal ? (
                    <Link
                      to={`/${storeSlug}/customer/member`}
                      style={{ fontSize: 12, fontWeight: 600, color: '#F0D68A', textDecoration: 'none' }}
                    >
                      {t('member.title')} →
                    </Link>
                  ) : null}
                </div>
              </div>
            </div>

            {/* Order — overlaps hero */}
            <div
              style={{
                marginTop: -16,
                position: 'relative',
                zIndex: 2,
                borderRadius: 18,
                padding: '20px 16px 18px',
                background: 'linear-gradient(180deg, #FFFFFF 0%, #FFFBF7 100%)',
                border: '1px solid rgba(232,213,184,0.65)',
                boxShadow: '0 10px 32px rgba(44,24,16,0.11)',
              }}
            >
              <div
                style={{
                  fontFamily: titleFont,
                  fontSize: 17,
                  fontWeight: 700,
                  color: 'var(--text-dark)',
                  marginBottom: 14,
                  letterSpacing: lang.startsWith('zh') ? 1 : 0,
                }}
              >
                {t('customer.storePortalChooseTitle')}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {canDelivery ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!isOpen || hoursLoading}
                    onClick={() => setMode('delivery')}
                    style={{
                      width: '100%',
                      padding: '15px 16px',
                      fontSize: 16,
                      fontWeight: 700,
                      borderRadius: 14,
                      textAlign: 'left',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'stretch',
                      gap: 4,
                      boxShadow: '0 6px 22px rgba(196,30,36,0.24)',
                    }}
                  >
                    <span>🚚 {lang.startsWith('zh') ? '外卖送餐' : 'Delivery'}</span>
                    <span style={{ fontSize: 12, fontWeight: 500, opacity: 0.92 }}>{t('customer.storePortalDeliveryHint')}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className={canDelivery ? 'btn btn-outline' : 'btn btn-primary'}
                  disabled={!isOpen || hoursLoading}
                  onClick={() => setMode('takeout')}
                  style={{
                    width: '100%',
                    padding: '15px 16px',
                    fontSize: 16,
                    fontWeight: 700,
                    borderRadius: 14,
                    borderWidth: canDelivery ? 2 : undefined,
                    borderColor: canDelivery ? 'rgba(74, 55, 40, 0.35)' : undefined,
                    textAlign: 'left',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'stretch',
                    gap: 4,
                    background: canDelivery ? 'var(--bg-white)' : undefined,
                    color: canDelivery ? 'var(--text-dark)' : undefined,
                    boxShadow: canDelivery ? '0 2px 12px rgba(44, 24, 16, 0.07)' : undefined,
                  }}
                >
                  <span style={{ color: canDelivery ? 'var(--text-dark)' : '#fff' }}>
                    🥡 {lang.startsWith('zh') ? '到店自取' : 'Pickup'}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      lineHeight: 1.4,
                      color: canDelivery ? 'var(--text-body)' : 'rgba(255,255,255,0.95)',
                    }}
                  >
                    {t('customer.storePortalPickupHint')}
                  </span>
                </button>
              </div>
              {!isOpen && !hoursLoading ? (
                <div
                  style={{
                    marginTop: 14,
                    padding: '12px 14px',
                    borderRadius: 12,
                    background: 'rgba(196,30,36,0.06)',
                    border: '1px solid rgba(196,30,36,0.15)',
                    fontSize: 13,
                    color: 'var(--text-secondary)',
                    lineHeight: 1.45,
                  }}
                >
                  {lang.startsWith('zh') ? '当前非营业时间，暂无法下单。' : 'Ordering is unavailable while closed.'}
                </div>
              ) : null}
            </div>

            {/* Offers from /api/offers */}
            {offers.length > 0 ? (
              <div style={{ marginTop: 26 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
                  <h2
                    style={{
                      fontFamily: titleFont,
                      fontSize: 18,
                      fontWeight: 700,
                      margin: 0,
                      color: 'var(--text-dark)',
                      letterSpacing: lang.startsWith('zh') ? 2 : 0,
                    }}
                  >
                    {t('customer.storePortalOffersTitle')}
                  </h2>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-light)' }}>{offers.length}</span>
                </div>
                <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  {t('customer.storePortalOfferHint')}
                </p>
                <div
                  style={{
                    display: 'flex',
                    gap: 12,
                    overflowX: 'auto',
                    paddingBottom: 8,
                    marginLeft: -2,
                    marginRight: -2,
                    paddingLeft: 2,
                    paddingRight: 2,
                    WebkitOverflowScrolling: 'touch',
                    scrollSnapType: 'x mandatory',
                  }}
                >
                  {offers.map((offer) => (
                    <div
                      key={offer._id}
                      style={{
                        flex: '0 0 min(276px, 84vw)',
                        scrollSnapAlign: 'start',
                        borderRadius: 16,
                        padding: '16px 14px 18px',
                        background: 'linear-gradient(155deg, rgba(255,255,255,0.98) 0%, rgba(255,250,242,0.99) 100%)',
                        border: '1px solid rgba(212,168,83,0.5)',
                        boxShadow: '0 6px 22px rgba(139,26,26,0.09)',
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: 0.8,
                          color: 'var(--red-primary)',
                          textTransform: 'uppercase',
                          marginBottom: 10,
                        }}
                      >
                        🎁 {lang.startsWith('zh') ? '套餐优惠' : 'Bundle'}
                      </div>
                      <div
                        style={{
                          fontFamily: titleFont,
                          fontSize: 16,
                          fontWeight: 700,
                          color: 'var(--text-dark)',
                          lineHeight: 1.35,
                          marginBottom: 8,
                        }}
                      >
                        {offerTitle(offer)}
                      </div>
                      {offerDesc(offer) ? (
                        <div
                          style={{
                            fontSize: 12,
                            color: 'var(--text-secondary)',
                            lineHeight: 1.45,
                            display: '-webkit-box',
                            WebkitLineClamp: 3,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}
                        >
                          {offerDesc(offer)}
                        </div>
                      ) : null}
                      <div
                        style={{
                          marginTop: 14,
                          paddingTop: 12,
                          borderTop: '1px solid rgba(232,213,184,0.55)',
                          display: 'flex',
                          alignItems: 'baseline',
                          justifyContent: 'space-between',
                          gap: 8,
                        }}
                      >
                        <span style={{ fontSize: 11, color: 'var(--text-light)', fontWeight: 600 }}>
                          {t('customer.storePortalOfferPriceLabel')}
                        </span>
                        <span style={{ fontFamily: titleFont, fontSize: 21, fontWeight: 700, color: 'var(--red-primary)' }}>
                          €{offer.bundlePrice.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* About / contact */}
            {(slots.length > 0 || phone || address || email) && (
              <div style={{ marginTop: 26 }}>
                <div
                  style={{
                    fontFamily: titleFont,
                    fontSize: 17,
                    fontWeight: 700,
                    color: 'var(--text-dark)',
                    marginBottom: 14,
                    letterSpacing: lang.startsWith('zh') ? 1 : 0,
                  }}
                >
                  {t('customer.storePortalAbout')}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {slots.length > 0 && (
                    <div style={infoCardStyle}>
                      <span style={{ fontSize: 18, lineHeight: 1 }} aria-hidden>🕐</span>
                      <div style={{ fontSize: 13, color: 'var(--text-dark)', lineHeight: 1.5 }}>
                        <span style={{ fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 2 }}>
                          {lang.startsWith('zh') ? '营业时间' : 'Hours'}
                        </span>
                        {slots.map((s, i) => (
                          <span key={i}>
                            {i > 0 && <span style={{ color: 'var(--text-light)' }}> · </span>}
                            {s.start}–{s.end}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {phone ? (
                    <a href={`tel:${phone.replace(/\s/g, '')}`} style={{ ...infoCardStyle, textDecoration: 'none', color: 'inherit' }}>
                      <span style={{ fontSize: 18, lineHeight: 1 }} aria-hidden>📞</span>
                      <div>
                        <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 2 }}>
                          {lang.startsWith('zh') ? '电话' : 'Phone'}
                        </span>
                        <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--red-primary)' }}>{phone}</span>
                      </div>
                    </a>
                  ) : null}
                  {email ? (
                    <a href={`mailto:${email}`} style={{ ...infoCardStyle, textDecoration: 'none', color: 'inherit' }}>
                      <span style={{ fontSize: 18, lineHeight: 1 }} aria-hidden>✉️</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 2 }}>
                          {lang.startsWith('zh') ? '邮箱' : 'Email'}
                        </span>
                        <span
                          style={{
                            fontWeight: 600,
                            fontSize: 14,
                            color: 'var(--blue, #1565c0)',
                            wordBreak: 'break-all' as const,
                          }}
                        >
                          {email}
                        </span>
                      </div>
                    </a>
                  ) : null}
                  {address ? (
                    <div style={infoCardStyle}>
                      <span style={{ fontSize: 18, lineHeight: 1 }} aria-hidden>📍</span>
                      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <div style={{ fontSize: 13, color: 'var(--text-dark)', lineHeight: 1.5 }}>
                          <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 2 }}>
                            {lang.startsWith('zh') ? '地址' : 'Address'}
                          </span>
                          {mapHref ? (
                            <a href={mapHref} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--blue, #1565c0)', fontWeight: 600 }}>
                              {address}
                            </a>
                          ) : (
                            address
                          )}
                        </div>
                        {mapEmbedSrc ? (
                          <div
                            style={{
                              position: 'relative',
                              width: '100%',
                              height: 200,
                              borderRadius: 10,
                              overflow: 'hidden',
                              background: 'rgba(0,0,0,0.06)',
                              border: '1px solid rgba(232,213,184,0.45)',
                            }}
                          >
                            <iframe
                              title={t('customer.storePortalMapEmbedTitle')}
                              src={mapEmbedSrc}
                              loading="lazy"
                              referrerPolicy="no-referrer-when-downgrade"
                              style={{
                                border: 0,
                                display: 'block',
                                width: '100%',
                                height: '100%',
                              }}
                            />
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {showMenu ? <MenuView storeFrontEmbed /> : null}
    </div>
  );
}
