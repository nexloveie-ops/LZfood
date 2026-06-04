import { Outlet, NavLink, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from 'react-i18next';
import { useState, useEffect, useCallback } from 'react';
import { connectStoreSocket } from '../api/storeSocket';
import { playDineInSound, playTakeoutSound, unlockAudio } from '../utils/orderSound';
import { printHtmlReceipt } from '../utils/posPrint';
import LanguageSwitcher from '../components/LanguageSwitcher';
import { useRestaurantConfig } from '../hooks/useRestaurantConfig';
import { apiFetch } from '../api/client';
import './cashier-shell.css';

export default function CashierLayout() {
  const { user, logout, token, hasFeature } = useAuth();
  const canRestockTab = hasFeature('inventory.tracking');
  const { storeSlug } = useParams<{ storeSlug: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { displayName } = useRestaurantConfig();
  const [showSettle, setShowSettle] = useState(false);
  const [settling, setSettling] = useState(false);
  const [toasts, setToasts] = useState<{ id: string; text: string }[]>([]);

  useEffect(() => {
    const check = () => {
      const now = new Date();
      const h = now.getHours();
      const m = now.getMinutes();
      setShowSettle(h > 20 || (h === 20 && m >= 30));
    };
    check();
    const id = setInterval(check, 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const handler = () => unlockAudio();
    document.addEventListener('click', handler, { once: true });
    document.addEventListener('touchstart', handler, { once: true });
    return () => {
      document.removeEventListener('click', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, []);

  useEffect(() => {
    const query = user?.storeId ? { storeId: user.storeId } : {};
    const socket = connectStoreSocket(query);
    socket.on('order:new', (order: { type?: string }) => {
      const text = `新订单：${order?.type || 'unknown'} · ${new Date().toLocaleTimeString()}`;
      const id = `${Date.now()}-${Math.random()}`;
      setToasts((prev) => [...prev, { id, text }]);
      setTimeout(() => setToasts((prev) => prev.filter((t2) => t2.id !== id)), 5000);
      if (order?.type === 'takeout') playTakeoutSound();
      else playDineInSound();
    });
    return () => {
      socket.disconnect();
    };
  }, [user?.storeId]);

  const handleLogout = () => {
    logout();
    navigate(`/${storeSlug}/login`);
  };

  const handleSettle = useCallback(async () => {
    setSettling(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const [statsRes, configRes] = await Promise.all([
        apiFetch(`/api/reports/detailed?startDate=${today}&endDate=${today}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        apiFetch('/api/admin/config'),
      ]);
      if (!statsRes.ok) {
        alert(t('cashier.settlementReportFailed'));
        return;
      }
      const stats = await statsRes.json();
      const config = configRes.ok ? await configRes.json() : {};

      const name = config.restaurant_name_en || config.restaurant_name_zh || '';
      const addr = config.restaurant_address || '';
      const now = new Date();
      const dateStr = now.toLocaleDateString('en-GB');
      const timeStr = now.toLocaleTimeString('en-GB');

      let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family:Arial,Helvetica,sans-serif; font-size:15px; font-weight:bold; color:#000; max-width:420px; margin:0 auto; padding:14px; }
        .center { text-align:center; }
        .divider { border-top:2px dashed #000; margin:10px 0; }
        .row { display:flex; justify-content:space-between; margin:4px 0; }
        .big { font-size:18px; margin:6px 0; }
        @media print { body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } @page { margin:0; size:80mm auto; } }
      </style></head><body>`;

      html += `<div class="center">`;
      if (name) html += `<div style="font-size:18px;margin-bottom:4px">${name}</div>`;
      if (addr) html += `<div style="font-size:13px">${addr}</div>`;
      html += `<div class="big">DAILY SETTLEMENT</div>`;
      html += `<div style="font-size:13px">${dateStr} ${timeStr}</div>`;
      html += `</div><div class="divider"></div>`;

      html += `<div class="row" style="font-size:16px"><span>Cash</span><span>€${(stats.cashTotal ?? 0).toFixed(2)}</span></div>`;
      html += `<div class="row" style="font-size:16px"><span>Card</span><span>€${(stats.cardTotal ?? 0).toFixed(2)}</span></div>`;
      html += `<div class="row" style="font-size:16px"><span>Member</span><span>€${(stats.memberTotal ?? 0).toFixed(2)}</span></div>`;

      html += `<div class="divider"></div>`;
      html += `<div class="center" style="font-size:12px;margin-top:4px">Printed by ${user?.username || ''} at ${timeStr}</div>`;
      html += `</body></html>`;

      void printHtmlReceipt({ html, copies: 1 });
    } catch {
      alert(t('cashier.settlementFailed'));
    } finally {
      setSettling(false);
    }
  }, [token, user, t]);

  const tabClass = ({ isActive }: { isActive: boolean }) =>
    `cashier-saas-tab${isActive ? ' is-active' : ''}`;

  return (
    <div className="cashier-saas">
      <header className="cashier-saas-header">
        <div className="cashier-saas-brand">
          <strong>{displayName || storeSlug}</strong>
          {storeSlug ? <span className="cashier-saas-slug">/{storeSlug}</span> : null}
          <span className="cashier-saas-role">{t('cashier.title')}</span>
        </div>
        <div className="cashier-saas-actions">
          {showSettle && (
            <button
              type="button"
              className="btn cashier-saas-settle"
              onClick={handleSettle}
              disabled={settling}
              title={t('cashier.dailySettlementHint')}
            >
              {settling ? '...' : `💰 ${t('cashier.dailySettlement')}`}
            </button>
          )}
          <LanguageSwitcher />
          <span className="cashier-saas-user">{user?.username}</span>
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

      <nav className="cashier-saas-tabs" aria-label={t('cashier.title')}>
        <NavLink to="." end className={tabClass}>
          {t('cashier.orderCenter')}
        </NavLink>
        <NavLink to="order" className={tabClass}>
          {t('cashier.newOrder', '点单')}
        </NavLink>
        <NavLink to="reprint" className={tabClass}>
          {t('cashier.reprint', '重印小票')}
        </NavLink>
        <NavLink to="inventory" className={tabClass}>
          {t('admin.inventory', '库存')}
        </NavLink>
        {canRestockTab && (
          <NavLink to="restock" className={tabClass}>
            📦 {t('cashier.restockTab', '进货')}
          </NavLink>
        )}
      </nav>

      <main className="cashier-saas-content">
        <Outlet />
      </main>

      <div className="cashier-saas-toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="cashier-saas-toast">
            {toast.text}
          </div>
        ))}
      </div>
    </div>
  );
}
