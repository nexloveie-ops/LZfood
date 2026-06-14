import { Outlet, useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useCart } from '../context/CartContext';
import LanguageSwitcher from '../components/LanguageSwitcher';
import { matchBundles, calcBundleTotal, type OfferData } from '../utils/bundleMatcher';
import { useRestaurantConfig } from '../hooks/useRestaurantConfig';
import { useStoreSlug } from '../context/StoreContext';
import { CustomerMenuBootstrapProvider, useCustomerMenuBootstrap } from '../context/CustomerMenuBootstrapContext';
import StorePreloaderGate from '../components/customer/StorePreloaderGate';

const AD_CONTACT_EMAIL = 'info@lztechserve.com';

function CustomerLayoutInner() {
  const { t } = useTranslation();
  const storeSlug = useStoreSlug();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { totalItems, totalAmount, items: cartItems, getItemKey } = useCart();
  const { displayName, config } = useRestaurantConfig();
  const logoUrl = config.restaurant_logo?.trim();
  const table = searchParams.get('table');
  const seat = searchParams.get('seat');
  const qs = searchParams.toString();

  const isCartPage = location.pathname.includes('/cart');

  const [offers, setOffers] = useState<OfferData[]>([]);
  const [menuItemCats, setMenuItemCats] = useState<Record<string, string>>({});
  const menuBootstrap = useCustomerMenuBootstrap();

  useEffect(() => {
    if (!menuBootstrap.ready) return;
    setOffers(menuBootstrap.offers);
    const map: Record<string, string> = {};
    for (const item of menuBootstrap.items) map[item._id] = item.categoryId;
    setMenuItemCats(map);
  }, [menuBootstrap.ready, menuBootstrap.offers, menuBootstrap.items]);

  const finalTotal = useMemo(() => {
    if (offers.length === 0 || cartItems.length === 0) return totalAmount;
    const entries = cartItems.map(ci => ({
      key: getItemKey(ci),
      menuItemId: ci.menuItemId,
      categoryId: menuItemCats[ci.menuItemId] || '',
      basePrice: ci.price,
      optionExtra: (ci.options || []).reduce((s, o) => s + o.extraPrice, 0),
      quantity: ci.quantity,
    }));
    const matched = matchBundles(entries, offers);
    return calcBundleTotal(entries, matched).finalTotal;
  }, [cartItems, offers, menuItemCats, totalAmount, getItemKey]);

  const hasDiscount = finalTotal < totalAmount;

  const onStorePortal = (() => {
    const p = location.pathname.replace(/\/$/, '');
    return p === `/${storeSlug}`;
  })();

  /** Menu page shows store name in red banner — hide duplicate next to header logo */
  const isCustomerMenuPage = location.pathname.includes('/customer/menu');

  const goToCart = () => {
    const p = new URLSearchParams(qs);
    if (onStorePortal) p.set('return', 'store');
    const tail = p.toString() ? `?${p.toString()}` : '';
    navigate(`/${storeSlug}/customer/cart${tail}`);
  };

  const goToStorePortal = () => {
    navigate(`/${storeSlug}`);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', maxWidth: 430, margin: '0 auto', width: '100%', minWidth: 0, background: 'var(--bg-cream)', overflowX: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 16px', background: 'var(--bg-white)',
        borderBottom: '1px solid var(--border-light)', flexShrink: 0,
        gap: 8, minWidth: 0, overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {onStorePortal ? (
            <>
              {logoUrl ? (
                <button
                  type="button"
                  onClick={goToStorePortal}
                  title={t('customer.backToStoreHome', { defaultValue: '返回店铺主页' })}
                  style={{
                    padding: 0, margin: 0, border: 'none', background: 'none', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', flexShrink: 0,
                  }}
                >
                  <img src={logoUrl} alt="" style={{ width: 36, height: 36, borderRadius: 10, objectFit: 'cover', display: 'block', boxShadow: '0 2px 8px rgba(196,30,36,0.12)' }} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={goToStorePortal}
                  title={t('customer.backToStoreHome', { defaultValue: '返回店铺主页' })}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    flexShrink: 0,
                    padding: 0,
                    margin: 0,
                    border: 'none',
                    cursor: 'pointer',
                    background: 'linear-gradient(135deg, var(--red-primary) 0%, #b71c1c 100%)',
                    color: '#fff',
                    fontWeight: 800,
                    fontSize: 16,
                    fontFamily: "'Noto Serif SC', serif",
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: '0 2px 8px rgba(196,30,36,0.25)',
                  }}
                >
                  {(displayName || storeSlug).slice(0, 1)}
                </button>
              )}
            </>
          ) : (
            <>
              {logoUrl ? (
                <button
                  type="button"
                  onClick={goToStorePortal}
                  title={t('customer.backToStoreHome', { defaultValue: '返回店铺主页' })}
                  style={{
                    padding: 0, margin: 0, border: 'none', background: 'none', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', flexShrink: 0,
                  }}
                >
                  <img src={logoUrl} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', display: 'block' }} />
                </button>
              ) : isCustomerMenuPage ? (
                <button
                  type="button"
                  onClick={goToStorePortal}
                  title={t('customer.backToStoreHome', { defaultValue: '返回店铺主页' })}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    flexShrink: 0,
                    padding: 0,
                    margin: 0,
                    border: 'none',
                    cursor: 'pointer',
                    background: 'linear-gradient(135deg, var(--red-primary) 0%, #b71c1c 100%)',
                    color: '#fff',
                    fontWeight: 800,
                    fontSize: 16,
                    fontFamily: "'Noto Serif SC', serif",
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: '0 2px 8px rgba(196,30,36,0.25)',
                  }}
                >
                  {(displayName || storeSlug).slice(0, 1)}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={goToStorePortal}
                  title={t('customer.backToStoreHome', { defaultValue: '返回店铺主页' })}
                  style={{
                    padding: 0, margin: 0, border: 'none', background: 'none', cursor: 'pointer',
                    fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 16, color: 'var(--red-primary)',
                    textAlign: 'left',
                  }}
                >
                  {displayName || storeSlug}
                </button>
              )}
              {logoUrl && !isCustomerMenuPage ? (
                <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 16, color: 'var(--red-primary)' }}>
                  {displayName || storeSlug}
                </span>
              ) : null}
              {table && seat && (
                <span style={{ fontSize: 12, color: 'var(--text-light)' }}>
                  🪑 Table {table} · Seat {seat}
                </span>
              )}
            </>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, minWidth: 0 }}>
          <LanguageSwitcher />
          {!isCartPage && totalItems > 0 && (
            <div onClick={goToCart} style={{
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
              background: 'var(--red-primary)', color: '#fff',
              borderRadius: 20, padding: '5px 12px 5px 8px',
            }}>
              <div style={{ position: 'relative', fontSize: 18 }}>
                🛒
                <span style={{
                  position: 'absolute', top: -6, right: -8,
                  background: '#F9A825', color: '#000',
                  fontSize: 9, fontWeight: 700, width: 16, height: 16,
                  borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>{totalItems}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 4 }}>
                {hasDiscount && (
                  <span style={{ fontSize: 10, textDecoration: 'line-through', opacity: 0.6 }}>€{totalAmount.toFixed(2)}</span>
                )}
                <span style={{ fontSize: 14, fontWeight: 700 }}>€{finalTotal.toFixed(2)}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Content — minHeight:0 so nested pages (e.g. menu) can own vertical scroll; hero hide/show listens on that inner scroller */}
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflowX: 'hidden', overflowY: 'auto', WebkitOverflowScrolling: 'touch', display: 'flex', flexDirection: 'column' }}>
        <Outlet />
      </div>

      <footer style={{
        flexShrink: 0,
        padding: '6px 10px calc(6px + env(safe-area-inset-bottom, 0px))',
        textAlign: 'center',
        fontSize: 10,
        color: 'var(--text-light)',
        lineHeight: 1.3,
        borderTop: '1px solid var(--border-light)',
        background: 'var(--bg-white)',
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
