import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { useStoreSlug } from '../../context/StoreContext';
import { refreshRestaurantConfig } from '../../hooks/useRestaurantConfig';
import { apiFetch } from '../../api/client';
import DeliveryCustomerPanel from '../../components/DeliveryCustomerPanel';
import {
  DELIVERY_FEE_RULES_CONFIG_KEY,
  type DeliveryFeeTier,
  parseDeliveryFeeRulesJson,
} from '../../utils/deliveryFeeRules';
import './delivery-management.css';

type DeliveryTab = 'fees' | 'customers';

type Row = { localId: string; uptoKm: string; feeEuro: string; isUnlimited: boolean };

let rid = 0;
function nextId() {
  return `df-${++rid}`;
}

function tiersToRows(tiers: DeliveryFeeTier[]): Row[] {
  return tiers.map((t) => ({
    localId: nextId(),
    uptoKm: t.uptoKm == null ? '' : String(t.uptoKm),
    feeEuro: String(t.feeEuro),
    isUnlimited: t.uptoKm == null,
  }));
}

function rowsToTiers(rows: Row[]): DeliveryFeeTier[] | null {
  const tiers: DeliveryFeeTier[] = [];
  for (const r of rows) {
    const fee = parseFloat(r.feeEuro);
    if (!Number.isFinite(fee) || fee < 0) return null;
    if (r.isUnlimited) {
      tiers.push({ uptoKm: null, feeEuro: fee });
      continue;
    }
    const km = parseFloat(r.uptoKm);
    if (!Number.isFinite(km) || km <= 0) return null;
    tiers.push({ uptoKm: km, feeEuro: fee });
  }
  const normalized = parseDeliveryFeeRulesJson(JSON.stringify(tiers));
  return normalized.length === tiers.length ? normalized : null;
}

export default function DeliveryFeeSettings() {
  const { t } = useTranslation();
  const { token } = useAuth();
  const storeSlug = useStoreSlug();
  const [tab, setTab] = useState<DeliveryTab>('fees');
  const [rows, setRows] = useState<Row[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState('');

  const fetchConfig = useCallback(async () => {
    setLoadError('');
    try {
      const res = await apiFetch('/api/admin/config', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setLoadError(t('admin.deliveryFeeLoadFailed'));
        return;
      }
      const data: Record<string, string> = await res.json();
      const raw = data[DELIVERY_FEE_RULES_CONFIG_KEY];
      const tiers = typeof raw === 'string' ? parseDeliveryFeeRulesJson(raw) : [];
      setRows(tiers.length ? tiersToRows(tiers) : []);
    } catch {
      setLoadError(t('admin.deliveryFeeLoadFailed'));
    }
  }, [token, t]);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      { localId: nextId(), uptoKm: prev.length === 0 ? '3' : '5', feeEuro: '0', isUnlimited: false },
    ]);
    setSaved(false);
  };

  const removeRow = (localId: string) => {
    setRows((prev) => prev.filter((r) => r.localId !== localId));
    setSaved(false);
  };

  const updateRow = (localId: string, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.localId === localId ? { ...r, ...patch } : r)));
    setSaved(false);
  };

  const handleSave = async () => {
    const tiers = rowsToTiers(rows);
    if (!tiers) {
      alert(t('admin.deliveryFeeInvalid'));
      return;
    }
    setSaving(true);
    setSaved(false);
    try {
      const value = tiers.length === 0 ? '' : JSON.stringify(tiers);
      const res = await apiFetch('/api/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ [DELIVERY_FEE_RULES_CONFIG_KEY]: value }),
      });
      if (res.ok) {
        setSaved(true);
        await refreshRestaurantConfig(storeSlug);
      } else {
        const d = await res.json().catch(() => null);
        alert(d?.error?.message || 'Failed');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dm-page">
      <div>
        <h2 className="dm-page-title">{t('admin.deliveryManagementTitle')}</h2>
        <p className="dm-page-sub">{t('admin.deliveryManagementIntro')}</p>
      </div>

      <div className="dm-tabs" role="tablist" aria-label={t('admin.deliveryManagementTitle')}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'fees'}
          className={`dm-tab${tab === 'fees' ? ' is-active' : ''}`}
          onClick={() => setTab('fees')}
        >
          {t('admin.deliveryFeesTab')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'customers'}
          className={`dm-tab${tab === 'customers' ? ' is-active' : ''}`}
          onClick={() => setTab('customers')}
        >
          {t('admin.deliveryCustomersTab')}
        </button>
      </div>

      {tab === 'customers' ? (
        <DeliveryCustomerPanel />
      ) : (
        <>
      <p className="dm-section-sub">{t('admin.deliveryFeeIntro')}</p>
      {loadError ? <div className="dm-error">{loadError}</div> : null}

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 10 }}>
          {t('admin.deliveryFeeColumnsHint')}
        </div>
        {rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-light)', marginBottom: 12 }}>{t('admin.deliveryFeeEmpty')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows.map((r) => (
              <div
                key={r.localId}
                style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto', gap: 10, alignItems: 'end' }}
              >
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>
                    {t('admin.deliveryFeeUptoKm')}
                  </label>
                  <input
                    className="input"
                    type="number"
                    step="0.1"
                    min="0"
                    disabled={r.isUnlimited}
                    value={r.isUnlimited ? '' : r.uptoKm}
                    placeholder={r.isUnlimited ? t('admin.deliveryFeeUnlimitedPh') : ''}
                    onChange={(e) => updateRow(r.localId, { uptoKm: e.target.value })}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>
                    {t('admin.deliveryFeeEuro')}
                  </label>
                  <input
                    className="input"
                    type="number"
                    step="0.01"
                    min="0"
                    value={r.feeEuro}
                    onChange={(e) => updateRow(r.localId, { feeEuro: e.target.value })}
                  />
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, whiteSpace: 'nowrap' }}>
                  <input
                    type="checkbox"
                    checked={r.isUnlimited}
                    onChange={(e) =>
                      updateRow(r.localId, {
                        isUnlimited: e.target.checked,
                        uptoKm: e.target.checked ? '' : r.uptoKm || '5',
                      })
                    }
                  />
                  {t('admin.deliveryFeeRest')}
                </label>
                <button type="button" className="btn btn-outline" onClick={() => removeRow(r.localId)}>
                  {t('common.delete')}
                </button>
              </div>
            ))}
          </div>
        )}
        <p style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 12, marginBottom: 0 }}>
          {t('admin.deliveryFeeLastRowHint')}
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="btn btn-outline" onClick={addRow}>
            {t('admin.deliveryFeeAddTier')}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? t('common.loading') : t('common.save')}
          </button>
          {saved ? <span style={{ fontSize: 13, color: '#2E7D32' }}>{t('admin.savedSuccess')}</span> : null}
        </div>
      </div>
        </>
      )}
    </div>
  );
}
