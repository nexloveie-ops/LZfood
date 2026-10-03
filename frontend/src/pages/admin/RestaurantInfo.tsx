import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { useStoreSlug } from '../../context/StoreContext';
import { refreshRestaurantConfig } from '../../hooks/useRestaurantConfig';
import { apiFetch } from '../../api/client';

const CONFIG_KEYS = [
  'account_number',
  'restaurant_name_zh',
  'restaurant_name_en',
  'restaurant_address',
  'restaurant_address_en',
  'restaurant_phone',
  'restaurant_website',
  'restaurant_email',
  'receipt_terms',
] as const;

type ConfigKey = (typeof CONFIG_KEYS)[number];

const FIELD_I18N: Record<ConfigKey, string> = {
  account_number: 'admin.accountNumber',
  restaurant_name_zh: 'admin.restaurantNameZh',
  restaurant_name_en: 'admin.restaurantNameEn',
  restaurant_address: 'admin.restaurantAddress',
  restaurant_address_en: 'admin.restaurantAddressEn',
  restaurant_phone: 'admin.restaurantPhone',
  restaurant_website: 'admin.restaurantWebsite',
  restaurant_email: 'admin.restaurantEmail',
  receipt_terms: 'admin.receiptTerms',
};

export default function RestaurantInfo() {
  const { t } = useTranslation();
  const { token, user, hasFeature } = useAuth();
  const storeSlug = useStoreSlug();
  const showWidgetApi = user?.role === 'owner' && hasFeature('admin.widget.api');
  const [values, setValues] = useState<Record<ConfigKey, string>>(() => {
    const init: Record<string, string> = {};
    CONFIG_KEYS.forEach(k => { init[k] = ''; });
    return init as Record<ConfigKey, string>;
  });
  const [logoUrl, setLogoUrl] = useState('');
  const [restaurantLat, setRestaurantLat] = useState('');
  const [restaurantLng, setRestaurantLng] = useState('');
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeMsg, setGeocodeMsg] = useState<string | null>(null);
  const [dineInWorkflowMode, setDineInWorkflowMode] = useState<'pay_first' | 'pay_after'>('pay_first');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);

  type WidgetKeyStatus =
    | { configured: false }
    | { configured: true; keyPrefix: string; createdAt: string | null; lastUsedAt: string | null };
  const [widgetKeyStatus, setWidgetKeyStatus] = useState<WidgetKeyStatus | null>(null);
  const [widgetKeyLoading, setWidgetKeyLoading] = useState(false);
  const [widgetNewKey, setWidgetNewKey] = useState<string | null>(null);
  const [widgetKeyCopied, setWidgetKeyCopied] = useState(false);

  const fetchWidgetKeyStatus = useCallback(async () => {
    if (!showWidgetApi || !token) return;
    setWidgetKeyLoading(true);
    try {
      const res = await apiFetch('/api/admin/widget-api-key', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setWidgetKeyStatus(await res.json());
      }
    } catch { /* ignore */ }
    finally { setWidgetKeyLoading(false); }
  }, [showWidgetApi, token]);

  useEffect(() => { void fetchWidgetKeyStatus(); }, [fetchWidgetKeyStatus]);

  const handleGenerateWidgetKey = async () => {
    if (!token) return;
    const confirmMsg = widgetKeyStatus?.configured
      ? t('admin.widgetApiRegenerate')
      : t('admin.widgetApiGenerate');
    if (!window.confirm(`${confirmMsg}?`)) return;
    setWidgetKeyLoading(true);
    try {
      const res = await apiFetch('/api/admin/widget-api-key', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setWidgetNewKey(data.apiKey ?? null);
        setWidgetKeyCopied(false);
        await fetchWidgetKeyStatus();
      }
    } catch { /* ignore */ }
    finally { setWidgetKeyLoading(false); }
  };

  const handleRevokeWidgetKey = async () => {
    if (!token || !window.confirm(`${t('admin.widgetApiRevoke')}?`)) return;
    setWidgetKeyLoading(true);
    try {
      const res = await apiFetch('/api/admin/widget-api-key', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setWidgetNewKey(null);
        await fetchWidgetKeyStatus();
      }
    } catch { /* ignore */ }
    finally { setWidgetKeyLoading(false); }
  };

  const handleCopyWidgetKey = async () => {
    if (!widgetNewKey) return;
    try {
      await navigator.clipboard.writeText(widgetNewKey);
      setWidgetKeyCopied(true);
    } catch { /* ignore */ }
  };

  const widgetEndpoint = `${window.location.origin}/api/public/widget-snapshot`;

  const fetchConfig = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/config', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data: Record<string, string> = await res.json();
        setValues(prev => {
          const next = { ...prev };
          CONFIG_KEYS.forEach(k => {
            if (data[k] !== undefined) next[k] = data[k];
          });
          return next;
        });
        if (data.restaurant_logo) setLogoUrl(data.restaurant_logo);
        if (data.restaurant_lat !== undefined) setRestaurantLat(data.restaurant_lat);
        if (data.restaurant_lng !== undefined) setRestaurantLng(data.restaurant_lng);
        if (data.dine_in_workflow_mode === 'pay_after' || data.dine_in_workflow_mode === 'pay_first') {
          setDineInWorkflowMode(data.dine_in_workflow_mode);
        }
      }
    } catch { /* ignore */ }
  }, [token]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const handleChange = (key: ConfigKey, value: string) => {
    setValues(prev => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const handleGeocodeFromAddress = async () => {
    if (!token) return;
    setGeocoding(true);
    setGeocodeMsg(null);
    setSaved(false);
    try {
      const name = (values.restaurant_name_en || values.restaurant_name_zh || '').trim();
      const addr = (values.restaurant_address_en || values.restaurant_address || '').trim();
      const address = [name, addr].filter(Boolean).join(', ');
      const res = await apiFetch('/api/admin/geocode-from-address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(address ? { address } : {}),
      });
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok) {
        const errMsg = (data as { error?: { message?: string } })?.error?.message;
        setGeocodeMsg(typeof errMsg === 'string' ? errMsg : t('admin.restaurantGeocodeFail'));
        return;
      }
      if (typeof data.lat === 'number' && typeof data.lng === 'number') {
        setRestaurantLat(String(data.lat));
        setRestaurantLng(String(data.lng));
        setGeocodeMsg(t('admin.restaurantGeocodeOk'));
      } else {
        setGeocodeMsg(t('admin.restaurantGeocodeFail'));
      }
    } catch {
      setGeocodeMsg(t('admin.restaurantGeocodeFail'));
    } finally {
      setGeocoding(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const body: Record<string, string> = {};
      CONFIG_KEYS.forEach(k => { body[k] = values[k]; });
      body.dine_in_workflow_mode = dineInWorkflowMode;
      body.restaurant_lat = restaurantLat.trim();
      body.restaurant_lng = restaurantLng.trim();
      const res = await apiFetch('/api/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setSaved(true);
        setGeocodeMsg(null);
        await refreshRestaurantConfig(storeSlug);
      }
    } catch { /* ignore */ }
    finally { setSaving(false); }
  };

  const handleLogoUpload = async (file: File) => {
    setUploadingLogo(true);
    try {
      const fd = new FormData();
      fd.append('logo', file);
      const res = await apiFetch('/api/admin/logo', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (res.ok) {
        const data = await res.json();
        setLogoUrl(data.logoUrl);
        await refreshRestaurantConfig(storeSlug);
      }
    } catch { /* ignore */ }
    finally { setUploadingLogo(false); }
  };

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>{t('admin.restaurantInfo')}</h2>

      {/* Logo Upload */}
      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <label style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 10 }}>
          Logo
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{
            width: 80, height: 80, borderRadius: '50%', overflow: 'hidden',
            background: logoUrl ? `url(${logoUrl}) center/cover` : 'var(--bg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '2px solid var(--border)', fontSize: 32, flexShrink: 0,
          }}>
            {!logoUrl && '🏪'}
          </div>
          <div>
            <label style={{ cursor: 'pointer' }}>
              <span className="btn btn-outline" style={{ fontSize: 13, display: 'inline-block' }}>
                {uploadingLogo ? '上传中...' : logoUrl ? '更换 Logo' : '上传 Logo'}
              </span>
              <input type="file" accept="image/*" hidden disabled={uploadingLogo}
                onChange={e => { if (e.target.files?.[0]) { handleLogoUpload(e.target.files[0]); e.target.value = ''; } }} />
            </label>
            <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 4 }}>
              支持 JPG, PNG, SVG, 最大 5MB
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>{t('admin.dineInWorkflowTitle')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
            <input
              type="radio"
              name="dineInWorkflow"
              checked={dineInWorkflowMode === 'pay_first'}
              onChange={() => { setDineInWorkflowMode('pay_first'); setSaved(false); }}
            />
            <span>{t('admin.dineInWorkflowPayFirst')}</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
            <input
              type="radio"
              name="dineInWorkflow"
              checked={dineInWorkflowMode === 'pay_after'}
              onChange={() => { setDineInWorkflowMode('pay_after'); setSaved(false); }}
            />
            <span>{t('admin.dineInWorkflowPayAfter')}</span>
          </label>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-light)', marginTop: 10, lineHeight: 1.5 }}>
          {t('admin.dineInWorkflowHint')}
        </div>
      </div>

      {showWidgetApi && (
        <div className="card" style={{ padding: 20, marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>{t('admin.widgetApiTitle')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 14, lineHeight: 1.5 }}>
            {t('admin.widgetApiHint')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
            <span style={{ fontWeight: 500 }}>{t('admin.widgetApiEndpoint')}:</span>{' '}
            <code style={{ fontSize: 11 }}>{widgetEndpoint}</code>
          </div>

          {widgetKeyLoading && widgetKeyStatus === null ? (
            <div style={{ fontSize: 13, color: 'var(--text-light)' }}>{t('common.loading')}</div>
          ) : widgetKeyStatus?.configured ? (
            <div style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
              <div><span style={{ color: 'var(--text-secondary)' }}>{t('admin.widgetApiPrefix')}:</span> <code>{widgetKeyStatus.keyPrefix}…</code></div>
              <div><span style={{ color: 'var(--text-secondary)' }}>{t('admin.widgetApiCreatedAt')}:</span> {widgetKeyStatus.createdAt ? new Date(widgetKeyStatus.createdAt).toLocaleString() : '—'}</div>
              <div><span style={{ color: 'var(--text-secondary)' }}>{t('admin.widgetApiLastUsedAt')}:</span> {widgetKeyStatus.lastUsedAt ? new Date(widgetKeyStatus.lastUsedAt).toLocaleString() : t('admin.widgetApiNeverUsed')}</div>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--text-light)', marginBottom: 14 }}>{t('admin.widgetApiNotConfigured')}</div>
          )}

          {widgetNewKey && (
            <div style={{ padding: 12, background: 'var(--bg)', borderRadius: 8, marginBottom: 14, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t('admin.widgetApiNewKeyTitle')}</div>
              <code style={{ display: 'block', wordBreak: 'break-all', fontSize: 12, marginBottom: 10 }}>{widgetNewKey}</code>
              <button type="button" className="btn btn-outline" style={{ fontSize: 12 }} onClick={() => void handleCopyWidgetKey()}>
                {widgetKeyCopied ? t('admin.widgetApiCopied') : t('admin.widgetApiCopy')}
              </button>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" style={{ fontSize: 13 }} disabled={widgetKeyLoading} onClick={() => void handleGenerateWidgetKey()}>
              {widgetKeyStatus?.configured ? t('admin.widgetApiRegenerate') : t('admin.widgetApiGenerate')}
            </button>
            {widgetKeyStatus?.configured && (
              <button type="button" className="btn btn-outline" style={{ fontSize: 13 }} disabled={widgetKeyLoading} onClick={() => void handleRevokeWidgetKey()}>
                {t('admin.widgetApiRevoke')}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {CONFIG_KEYS.map(key => (
            <div key={key}>
              <div style={{ display: 'flex', alignItems: key === 'receipt_terms' ? 'flex-start' : 'center', gap: 16 }}>
                <label style={{ width: 180, fontSize: 14, fontWeight: 500, color: 'var(--text-secondary)', flexShrink: 0, paddingTop: key === 'receipt_terms' ? 8 : 0 }}>
                  {t(FIELD_I18N[key])}
                </label>
                {key === 'receipt_terms' ? (
                  <div style={{ flex: 1, maxWidth: 400 }}>
                    <textarea
                      className="input"
                      value={values[key]}
                      onChange={e => handleChange(key, e.target.value)}
                      rows={5}
                      style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
                    />
                    <div style={{ fontSize: 12, color: 'var(--text-light)', marginTop: 4 }}>
                      {t('admin.receiptTermsHelp')}
                    </div>
                  </div>
                ) : (
                  <input
                    className="input"
                    value={values[key]}
                    onChange={e => handleChange(key, e.target.value)}
                    style={{ maxWidth: 400, flex: 1 }}
                  />
                )}
              </div>
              {key === 'restaurant_address_en' && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                    <label style={{ width: 180, fontSize: 14, fontWeight: 500, color: 'var(--text-secondary)', flexShrink: 0 }}>
                      {t('admin.restaurantLatLng')}
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, flexWrap: 'wrap', maxWidth: 520 }}>
                      <input
                        className="input"
                        inputMode="decimal"
                        placeholder={t('admin.restaurantLat')}
                        value={restaurantLat}
                        onChange={e => { setRestaurantLat(e.target.value); setSaved(false); setGeocodeMsg(null); }}
                        style={{ width: 140 }}
                      />
                      <input
                        className="input"
                        inputMode="decimal"
                        placeholder={t('admin.restaurantLng')}
                        value={restaurantLng}
                        onChange={e => { setRestaurantLng(e.target.value); setSaved(false); setGeocodeMsg(null); }}
                        style={{ width: 140 }}
                      />
                      <button
                        type="button"
                        className="btn btn-outline"
                        style={{ fontSize: 13 }}
                        disabled={geocoding}
                        onClick={() => void handleGeocodeFromAddress()}
                      >
                        {geocoding ? t('common.loading') : t('admin.restaurantGeocodeBtn')}
                      </button>
                    </div>
                  </div>
                  <div style={{ marginLeft: 196, marginTop: 6, fontSize: 12, color: 'var(--text-light)', lineHeight: 1.5, maxWidth: 520 }}>
                    {t('admin.restaurantLatLngHint')}
                  </div>
                  {geocodeMsg && (
                    <div style={{ marginLeft: 196, marginTop: 4, fontSize: 12, color: geocodeMsg === t('admin.restaurantGeocodeOk') ? 'green' : 'var(--danger, #c0392b)' }}>
                      {geocodeMsg}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? t('common.loading') : t('common.save')}
          </button>
          {saved && (
            <span style={{ color: 'green', fontSize: 13 }}>✓ {t('admin.savedSuccess')}</span>
          )}
        </div>
      </div>
    </div>
  );
}
