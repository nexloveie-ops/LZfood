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
  const { token } = useAuth();
  const storeSlug = useStoreSlug();
  const [values, setValues] = useState<Record<ConfigKey, string>>(() => {
    const init: Record<string, string> = {};
    CONFIG_KEYS.forEach(k => { init[k] = ''; });
    return init as Record<ConfigKey, string>;
  });
  const [logoUrl, setLogoUrl] = useState('');
  const [dineInWorkflowMode, setDineInWorkflowMode] = useState<'pay_first' | 'pay_after'>('pay_first');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);

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

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const body: Record<string, string> = {};
      CONFIG_KEYS.forEach(k => { body[k] = values[k]; });
      body.dine_in_workflow_mode = dineInWorkflowMode;
      const res = await apiFetch('/api/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setSaved(true);
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
