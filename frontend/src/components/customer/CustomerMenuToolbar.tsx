import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from '../LanguageSwitcher';
import { useCart } from '../../context/CartContext';
import { useRestaurantConfig } from '../../hooks/useRestaurantConfig';
import { useStoreSlug } from '../../context/StoreContext';
import { useCustomerMenuBootstrap } from '../../context/CustomerMenuBootstrapContext';
import { useBusinessStatus } from '../../hooks/useBusinessStatus';
import { matchBundles, calcBundleTotal } from '../../utils/bundleMatcher';
import { isDineInCustomerFlow } from '../../utils/qrCode';

type Props = {
  /** full: logo + mode/lang/cart; actions: sticky fallback when hero hidden (cart + dine-in seat only) */
  variant?: 'full' | 'actions';
};

export default function CustomerMenuToolbar({ variant = 'full' }: Props) {
  const { t } = useTranslation();
  const storeSlug = useStoreSlug();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { totalItems, totalAmount, items: cartItems, getItemKey } = useCart();
  const { displayName, config } = useRestaurantConfig();
  const logoUrl = config.restaurant_logo?.trim();
  const menuBootstrap = useCustomerMenuBootstrap();
  const { loading: statusLoading, deliveryEnabled } = useBusinessStatus();
  const canDelivery = deliveryEnabled !== false;
  const qs = searchParams.toString();

  const menuItemCats = useMemo(() => {
    const map: Record<string, string> = {};
    for (const item of menuBootstrap.items) map[item._id] = item.categoryId;
    return map;
  }, [menuBootstrap.items]);

  const finalTotal = useMemo(() => {
    const offers = menuBootstrap.offers;
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
  }, [cartItems, menuBootstrap.offers, menuItemCats, totalAmount, getItemKey]);

  const hasDiscount = finalTotal < totalAmount;
  const showLogo = variant === 'full';
  const dineInTableSeat = useMemo(() => {
    if (!isDineInCustomerFlow(searchParams)) return null;
    const table = searchParams.get('table');
    const seat = searchParams.get('seat');
    if (!table || !seat) return null;
    return { table, seat };
  }, [searchParams]);

  const isDineIn = isDineInCustomerFlow(searchParams);
  const orderType = searchParams.get('type');
  const showOrderModeSwitch = !isDineIn && canDelivery && !statusLoading && variant === 'full';
  const activeOrderMode = orderType === 'delivery' ? 'delivery' : 'takeout';

  const setOrderMode = (mode: 'takeout' | 'delivery') => {
    if (mode === activeOrderMode) return;
    const next = new URLSearchParams(searchParams);
    next.delete('table');
    next.delete('seat');
    next.delete('return');
    next.set('type', mode);
    setSearchParams(next, { replace: true });
  };

  const renderLeftMeta = () => {
    if (dineInTableSeat) {
      return (
        <span className="menu-hero-toolbar__dine-in-seat" aria-label={t('customer.dineInTableSeatBadge', dineInTableSeat)}>
          {t('customer.dineInTableSeatBadge', dineInTableSeat)}
        </span>
      );
    }
    if (!showOrderModeSwitch) return null;
    return (
      <div
        className="menu-hero-toolbar__mode-switch"
        role="group"
        aria-label={t('customer.orderModeSwitchLabel')}
      >
        <button
          type="button"
          className={`menu-hero-toolbar__mode-btn${activeOrderMode === 'takeout' ? ' menu-hero-toolbar__mode-btn--active menu-hero-toolbar__mode-btn--takeout' : ''}`}
          aria-pressed={activeOrderMode === 'takeout'}
          onClick={() => setOrderMode('takeout')}
        >
          {t('customer.orderModePickup')}
        </button>
        <button
          type="button"
          className={`menu-hero-toolbar__mode-btn${activeOrderMode === 'delivery' ? ' menu-hero-toolbar__mode-btn--active menu-hero-toolbar__mode-btn--delivery' : ''}`}
          aria-pressed={activeOrderMode === 'delivery'}
          onClick={() => setOrderMode('delivery')}
        >
          {t('customer.orderModeDelivery')}
        </button>
      </div>
    );
  };

  const goToStorePortal = () => {
    navigate(`/${storeSlug}`);
  };

  const goToCart = () => {
    const p = new URLSearchParams(qs);
    // 堂食桌码：返回应回菜单，不要 return=store（否则会跳到门户主页）
    if (!isDineInCustomerFlow(p)) {
      p.set('return', 'store');
      if (!p.get('type')) p.set('type', 'takeout');
    }
    const tail = p.toString() ? `?${p.toString()}` : '';
    navigate(`/${storeSlug}/customer/cart${tail}`);
  };

  if (variant === 'actions' && totalItems === 0 && !dineInTableSeat) {
    return null;
  }

  return (
    <div className={`menu-hero-toolbar${variant === 'actions' ? ' menu-hero-toolbar--actions' : ''}`}>
      {showLogo ? (
        <div className="menu-hero-toolbar__left">
          {logoUrl ? (
            <button
              type="button"
              onClick={goToStorePortal}
              title={t('customer.backToStoreHome', { defaultValue: '返回店铺主页' })}
              className="menu-hero-toolbar__logo-btn"
            >
              <img src={logoUrl} alt="" className="menu-hero-toolbar__logo" />
            </button>
          ) : (
            <button
              type="button"
              onClick={goToStorePortal}
              title={t('customer.backToStoreHome', { defaultValue: '返回店铺主页' })}
              className="menu-hero-toolbar__logo-fallback"
            >
              {(displayName || storeSlug).slice(0, 1)}
            </button>
          )}
          {renderLeftMeta()}
        </div>
      ) : (
        <div className="menu-hero-toolbar__left">
          {renderLeftMeta()}
        </div>
      )}
      <div className="menu-hero-toolbar__right">
        {variant === 'full' ? <LanguageSwitcher /> : null}
        {totalItems > 0 ? (
          <button type="button" onClick={goToCart} className="customer-order-cart menu-hero-toolbar__cart">
            <span className="menu-hero-toolbar__cart-icon-wrap" aria-hidden>
              <span className="menu-hero-toolbar__cart-icon">🛒</span>
              <span className="menu-hero-toolbar__cart-badge">{totalItems}</span>
            </span>
            <span className="menu-hero-toolbar__cart-total">
              {hasDiscount ? (
                <span className="menu-hero-toolbar__cart-was">€{totalAmount.toFixed(2)}</span>
              ) : null}
              €{finalTotal.toFixed(2)}
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
