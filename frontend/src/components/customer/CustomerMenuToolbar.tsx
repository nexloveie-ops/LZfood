import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from '../LanguageSwitcher';
import { useCart } from '../../context/CartContext';
import { useRestaurantConfig } from '../../hooks/useRestaurantConfig';
import { useStoreSlug } from '../../context/StoreContext';
import { useCustomerMenuBootstrap } from '../../context/CustomerMenuBootstrapContext';
import { matchBundles, calcBundleTotal } from '../../utils/bundleMatcher';
import { isDineInCustomerFlow } from '../../utils/qrCode';

type Props = {
  /** full: logo + actions; actions: language + cart only (sticky fallback) */
  variant?: 'full' | 'actions';
};

export default function CustomerMenuToolbar({ variant = 'full' }: Props) {
  const { t } = useTranslation();
  const storeSlug = useStoreSlug();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { totalItems, totalAmount, items: cartItems, getItemKey } = useCart();
  const { displayName, config } = useRestaurantConfig();
  const logoUrl = config.restaurant_logo?.trim();
  const menuBootstrap = useCustomerMenuBootstrap();
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

  const goToStorePortal = () => {
    navigate(`/${storeSlug}`);
  };

  const goToCart = () => {
    const p = new URLSearchParams(qs);
    // 堂食桌码：返回应回菜单，不要 return=store（否则会跳到门户主页）
    if (!isDineInCustomerFlow(p)) {
      p.set('return', 'store');
    }
    const tail = p.toString() ? `?${p.toString()}` : '';
    navigate(`/${storeSlug}/customer/cart${tail}`);
  };

  return (
    <div className="menu-hero-toolbar">
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
        </div>
      ) : (
        <div className="menu-hero-toolbar__left" />
      )}
      <div className="menu-hero-toolbar__right">
        <LanguageSwitcher />
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
