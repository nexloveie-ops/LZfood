import { useCallback, useEffect, useState } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { useStoreSlug } from '../../context/StoreContext';
import { refreshRestaurantConfig } from '../../hooks/useRestaurantConfig';
import { apiFetch } from '../../api/client';
import CloudPrintSettings from './CloudPrintSettings';

type CatalogPrintMode = 'off' | 'headers' | 'split';
type PrintTab = 'local' | 'cloud';

function parseCatalogPrintMode(raw: string | undefined): CatalogPrintMode {
  const v = String(raw ?? 'split').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return 'off';
  if (v === 'headers' || v === 'same' || v === '2' || v === 'grouped') return 'headers';
  return 'split';
}

export function CloudPrintPathRedirect() {
  const { storeSlug = '' } = useParams<{ storeSlug: string }>();
  const { hasFeature } = useAuth();
  const to = hasFeature('print.cloud')
    ? `/${storeSlug}/admin/print-settings?tab=cloud`
    : `/${storeSlug}/admin/print-settings`;
  return <Navigate to={to} replace />;
}

export default function PrintSettings() {
  const { t } = useTranslation();
  const { token, hasFeature } = useAuth();
  const storeSlug = useStoreSlug();
  const [searchParams, setSearchParams] = useSearchParams();
  const hasCloudPrint = hasFeature('print.cloud');
  const tab: PrintTab = hasCloudPrint && searchParams.get('tab') === 'cloud' ? 'cloud' : 'local';

  const [catalogMode, setCatalogMode] = useState<CatalogPrintMode>('split');
  const [copies, setCopies] = useState(2);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const loadLocal = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/admin/config', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const data = await res.json() as Record<string, string>;
      setCatalogMode(parseCatalogPrintMode(data.receipt_print_by_catalog));
      const n = parseInt(String(data.receipt_print_copies || '2'), 10);
      setCopies(Number.isFinite(n) && n >= 0 ? Math.min(10, n) : 2);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void loadLocal(); }, [loadLocal]);

  const setTab = (next: PrintTab) => {
    if (next === 'cloud' && hasCloudPrint) setSearchParams({ tab: 'cloud' });
    else setSearchParams({});
  };

  const saveLocal = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await apiFetch('/api/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          receipt_print_copies: String(Math.min(10, Math.max(0, Math.floor(copies)))),
          receipt_print_by_catalog:
            catalogMode === 'off' ? '0' : catalogMode === 'headers' ? 'headers' : 'split',
        }),
      });
      if (res.ok) {
        setSaved(true);
        await refreshRestaurantConfig(storeSlug);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>{t('admin.printSettings')}</h2>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button
          type="button"
          className={`btn ${tab === 'local' ? 'btn-primary' : 'btn-outline'}`}
          onClick={() => setTab('local')}
        >
          {t('admin.printSettingsLocalTab')}
        </button>
        {hasCloudPrint ? (
          <button
            type="button"
            className={`btn ${tab === 'cloud' ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setTab('cloud')}
          >
            {t('admin.printSettingsCloudTab')}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-outline"
            disabled
            title={t('admin.printSettingsCloudBlocked')}
            style={{ opacity: 0.55, cursor: 'not-allowed' }}
          >
            {t('admin.printSettingsCloudTab')}
          </button>
        )}
      </div>

      {tab === 'cloud' && hasCloudPrint ? (
        <CloudPrintSettings embedded />
      ) : loading ? (
        <div>{t('common.loading')}</div>
      ) : (
        <div className="card" style={{ padding: 20 }}>
          <label style={{ display: 'block', marginBottom: 20, fontSize: 14 }}>
            {t('admin.receiptPrintCopies')}
            <input
              className="input"
              type="number"
              min={0}
              max={10}
              value={copies}
              onChange={(e) => {
                const n = Number(e.target.value);
                setCopies(Math.min(10, Math.max(0, Number.isFinite(n) ? Math.floor(n) : 0)));
                setSaved(false);
              }}
              style={{ display: 'block', marginTop: 6, maxWidth: 120 }}
            />
            <span style={{ fontSize: 12, color: 'var(--text-light)' }}>{t('admin.receiptPrintCopiesHint')}</span>
          </label>

          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>{t('admin.receiptPrintByCatalogTitle')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
              <input
                type="radio"
                name="receiptPrintByCatalog"
                checked={catalogMode === 'split'}
                onChange={() => { setCatalogMode('split'); setSaved(false); }}
              />
              <span>{t('admin.receiptPrintByCatalogSplit')}</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
              <input
                type="radio"
                name="receiptPrintByCatalog"
                checked={catalogMode === 'headers'}
                onChange={() => { setCatalogMode('headers'); setSaved(false); }}
              />
              <span>{t('admin.receiptPrintByCatalogHeaders')}</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
              <input
                type="radio"
                name="receiptPrintByCatalog"
                checked={catalogMode === 'off'}
                onChange={() => { setCatalogMode('off'); setSaved(false); }}
              />
              <span>{t('admin.receiptPrintByCatalogOff')}</span>
            </label>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-light)', marginTop: 10, lineHeight: 1.5, marginBottom: 20 }}>
            {t('admin.receiptPrintByCatalogHint')}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="button" className="btn btn-primary" onClick={() => void saveLocal()} disabled={saving}>
              {saving ? t('common.loading') : t('common.save')}
            </button>
            {saved ? <span style={{ color: 'green', fontSize: 13 }}>✓ {t('admin.savedSuccess')}</span> : null}
          </div>
        </div>
      )}
    </div>
  );
}
