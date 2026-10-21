import { useState } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { useRestaurantConfig } from '../hooks/useRestaurantConfig';
import LanguageSwitcher from '../components/LanguageSwitcher';
import { portalLogoSrc } from '../constants/portalBrand';
import './admin-shell.css';

const navItems = [
  { path: '.', end: true, icon: '📋', key: 'purchasing.navSheet' },
  { path: 'catalog', icon: '📂', key: 'purchasing.navCatalog' },
  { path: 'suppliers', icon: '🚚', key: 'purchasing.navSuppliers' },
  { path: 'orders', icon: '🖨️', key: 'purchasing.navOrders' },
];

export default function PurchasingLayout() {
  const { user, logout, hasFeature } = useAuth();
  const { storeSlug } = useParams<{ storeSlug: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { displayName } = useRestaurantConfig();
  const [collapsed, setCollapsed] = useState(false);
  const featureOn = hasFeature('purchasing.page');
  const isOwner = user?.role === 'owner' || user?.role === 'platform_owner';

  const handleLogout = () => {
    logout();
    navigate(`/${storeSlug}/login`);
  };

  return (
    <div className="admin-saas">
      <aside className={`admin-saas-sidebar${collapsed ? ' is-collapsed' : ''}`}>
        <div className="admin-saas-brand">
          {!collapsed ? (
            <>
              <div className="admin-saas-brand-title">{displayName || storeSlug}</div>
              {storeSlug ? <div className="admin-saas-brand-slug">/{storeSlug}</div> : null}
              <div className="admin-saas-brand-sub">{t('purchasing.title')}</div>
            </>
          ) : (
            <span className="admin-saas-brand-initial">{(displayName || storeSlug || '?').charAt(0)}</span>
          )}
        </div>
        <nav className="admin-saas-nav" aria-label={t('purchasing.title')}>
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.end}
              title={collapsed ? t(item.key) : undefined}
              className={({ isActive }) => `admin-saas-nav-link${isActive ? ' is-active' : ''}`}
            >
              <span className="admin-saas-nav-icon" aria-hidden>{item.icon}</span>
              {!collapsed && t(item.key)}
            </NavLink>
          ))}
          {isOwner ? (
            <NavLink
              to={`/${storeSlug}/admin`}
              className="admin-saas-nav-link"
              title={t('admin.title')}
            >
              <span className="admin-saas-nav-icon" aria-hidden>⚙️</span>
              {!collapsed && t('admin.title')}
            </NavLink>
          ) : null}
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
            <span className="admin-saas-slug">{t('purchasing.roleBadge')}</span>
          </div>
          <div className="admin-saas-topbar-actions">
            <span className="admin-saas-user">{user?.username}</span>
            <LanguageSwitcher />
            <button type="button" className="btn btn-outline" style={{ padding: '6px 14px', fontSize: 12 }} onClick={handleLogout}>
              {t('login.logout')}
            </button>
          </div>
        </header>
        <main className="admin-saas-content">
          {!featureOn ? (
            <div className="card" style={{ padding: 20 }}>
              {t('purchasing.featureOff')}
              {isOwner ? (
                <div style={{ marginTop: 12 }}>
                  <button type="button" className="btn btn-primary" onClick={() => navigate(`/${storeSlug}/admin`)}>
                    {t('admin.title')}
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <Outlet />
          )}
        </main>
      </div>
    </div>
  );
}
