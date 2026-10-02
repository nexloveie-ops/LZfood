import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';

type Printer = { sn: string; label: string };

export default function CloudPrintSettings({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  const { token } = useAuth();
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [copies, setCopies] = useState(1);
  const [autoCheckout, setAutoCheckout] = useState(true);
  const [printers, setPrinters] = useState<Printer[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const res = await apiFetch('/api/admin/cloud-print', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr((j as { error?: { message?: string } })?.error?.message || t('common.error'));
        return;
      }
      const data = await res.json() as {
        enabled: boolean;
        copies: number;
        autoCheckout: boolean;
        printers: Printer[];
      };
      setEnabled(!!data.enabled);
      setCopies(data.copies || 1);
      setAutoCheckout(data.autoCheckout !== false);
      setPrinters(Array.isArray(data.printers) ? data.printers : []);
    } catch {
      setErr(t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaving(true);
    setErr('');
    try {
      const res = await apiFetch('/api/admin/cloud-print', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ enabled, copies, autoCheckout }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr((j as { error?: { message?: string } })?.error?.message || t('common.error'));
        return;
      }
      alert(t('admin.savedSuccess'));
    } catch {
      setErr(t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {embedded ? null : (
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{t('admin.cloudPrint')}</h2>
      )}
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.5 }}>
        {t('admin.cloudPrintHelp')}
      </p>

      {err ? <div style={{ color: 'var(--red-primary)', marginBottom: 12 }}>{err}</div> : null}
      {loading ? <div>{t('common.loading')}</div> : (
        <>
          <div className="card" style={{ padding: 20, marginBottom: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 10 }}>{t('admin.cloudPrintBound')}</div>
            {printers.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-light)' }}>{t('admin.cloudPrintNoPrinter')}</div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.8 }}>
                {printers.map((p) => (
                  <li key={p.sn}>
                    <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 600 }}>{p.sn}</span>
                    {p.label ? <span style={{ color: 'var(--text-secondary)' }}> · {p.label}</span> : null}
                    <span style={{ marginLeft: 8, fontSize: 12, color: '#2e7d32' }}>{t('admin.cloudPrintBoundTag')}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card" style={{ padding: 20 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              {t('admin.cloudPrintEnabled')}
            </label>

            <label style={{ display: 'block', marginBottom: 16, fontSize: 14 }}>
              {t('admin.cloudPrintCopies')}
              <input
                className="input"
                type="number"
                min={1}
                max={5}
                value={copies}
                onChange={(e) => setCopies(Math.min(5, Math.max(1, Number(e.target.value) || 1)))}
                style={{ display: 'block', marginTop: 6, maxWidth: 120 }}
              />
              <span style={{ fontSize: 12, color: 'var(--text-light)' }}>{t('admin.cloudPrintCopiesHint')}</span>
            </label>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, marginBottom: 8 }}>{t('admin.cloudPrintWhen')}</div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 14 }}>
                <input type="radio" name="cloudPrintWhen" checked={autoCheckout} onChange={() => setAutoCheckout(true)} style={{ marginRight: 6 }} />
                {t('admin.cloudPrintAuto')}
              </label>
              <label style={{ display: 'block', fontSize: 14 }}>
                <input type="radio" name="cloudPrintWhen" checked={!autoCheckout} onChange={() => setAutoCheckout(false)} style={{ marginRight: 6 }} />
                {t('admin.cloudPrintReprintOnly')}
              </label>
            </div>

            <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
              {saving ? t('common.loading') : t('common.save')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
