import { useState } from 'react';
import { Outlet, NavLink, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from '../components/LanguageSwitcher';
import { useRestaurantConfig } from '../hooks/useRestaurantConfig';
import { portalLogoSrc } from '../constants/portalBrand';
import './admin-shell.css';

const sidebarItems = [
  { path: 'restaurant', icon: '🏪', key: 'admin.restaurantInfo' },
  { path: 'delivery-fees', icon: '🚚', key: 'admin.deliveryFeesNav', featureKey: 'cashier.delivery.page' },
  { path: 'categories', icon: '📂', key: 'admin.categories' },
  { path: 'menu-items', icon: '🍽️', key: 'admin.menuItems' },
  { path: 'option-group-templates', icon: '🧩', key: 'admin.optionGroupTemplatesNav', featureKey: 'admin.optionGroupTemplates.page' },
  { path: 'inventory', icon: '📦', key: 'admin.inventory' },
  { path: 'advanced-inventory', icon: '📊', key: 'admin.advancedInventory', featureKey: 'inventory.tracking' },
  { path: 'allergens', icon: '⚠️', key: 'admin.allergens' },
  { path: 'i18n', icon: '🌐', key: 'admin.i18nEditor' },
  { path: 'qr-codes', icon: '📱', key: 'admin.qrCodes' },
  { path: 'offers', icon: '🎁', key: 'admin.offers', featureKey: 'admin.offers.page' },
  { path: 'coupons', icon: '🎟️', key: 'admin.coupons', featureKey: 'admin.coupons.page' },
  { path: 'members', icon: '👤', key: 'admin.membersNav', featureKey: 'cashier.member.wallet' },
  { path: 'orders', icon: '📋', key: 'admin.orderHistory', featureKey: 'admin.orderHistory.page' },
  { path: 'reports', icon: '📊', key: 'admin.reports' },
  { path: 'business-hours', icon: '🕒', key: 'admin.businessHours' },
  { path: 'users', icon: '👥', key: 'admin.users' },
  { path: 'config', icon: '⚙️', key: 'admin.systemConfig' },
  { path: 'stripe', icon: '💳', key: 'admin.stripeSettings' },
];

export default function AdminLayout() {
  const { user, logout, hasFeature } = useAuth();
  const { storeSlug } = useParams<{ storeSlug: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { displayName } = useRestaurantConfig();
  const [collapsed, setCollapsed] = useState(false);

  const handleLogout = () => {
    logout();
    navigate(`/${storeSlug}/login`);
  };

  const brandInitial = (displayName || storeSlug || '?').charAt(0).toUpperCase();
  const collapsedTitle = [displayName, storeSlug ? `/${storeSlug}` : ''].filter(Boolean).join(' · ');

  return (
    <div className="admin-saas">
      <aside className={`admin-saas-sidebar${collapsed ? ' is-collapsed' : ''}`}>
        <div className="admin-saas-brand">
          {collapsed ? (
            <span className="admin-saas-brand-initial" title={collapsedTitle}>
              {brandInitial}
            </span>
          ) : (
            <>
              <div className="admin-saas-brand-title">{displayName || storeSlug}</div>
              {storeSlug ? <div className="admin-saas-brand-slug">/{storeSlug}</div> : null}
              <div className="admin-saas-brand-sub">{t('admin.title')}</div>
            </>
          )}
        </div>

        <nav className="admin-saas-nav" aria-label={t('admin.title')}>
          {sidebarItems
            .filter((item) => !item.featureKey || hasFeature(item.featureKey))
            .map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                title={collapsed ? t(item.key) : undefined}
                className={({ isActive }) =>
                  `admin-saas-nav-link${isActive ? ' is-active' : ''}`
                }
              >
                <span className="admin-saas-nav-icon" aria-hidden>
                  {item.icon}
                </span>
                {!collapsed && t(item.key)}
              </NavLink>
            ))}
        </nav>

        {!collapsed ? (
          <a href="/" className="admin-saas-portal-link" title={t('portal.brandName')}>
            <img src={portalLogoSrc()} alt="" />
            {t('storeLogin.backPortal')}
          </a>
        ) : (
          <a href="/" className="admin-saas-portal-link" title={t('storeLogin.backPortal')}>
            <img src={portalLogoSrc()} alt="" />
          </a>
        )}

        <button
          type="button"
          className="admin-saas-collapse"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? '»' : '«'}
        </button>
      </aside>

      <div className="admin-saas-main">
        <header className="admin-saas-topbar">
          <div className="admin-saas-topbar-store">
            <strong>{displayName || storeSlug}</strong>
            {storeSlug ? <span className="admin-saas-slug">/{storeSlug}</span> : null}
          </div>
          <div className="admin-saas-topbar-actions">
            <span className="admin-saas-user">{user?.username}</span>
            <LanguageSwitcher />
            <button
              type="button"
              className="btn btn-outline"
              style={{ padding: '6px 14px', fontSize: 12, minHeight: 'auto' }}
              onClick={handleLogout}
            >
              {t('login.logout', '退出')}
            </button>
          </div>
        </header>
        <main className="admin-saas-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
