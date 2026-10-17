import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../../api/client';

export default function WeighMarketDialog({
  open,
  title,
  menuItemId,
  initialKg,
  initialPricePerKg,
  busy,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  menuItemId?: string;
  initialKg?: number;
  initialPricePerKg?: number | null;
  busy?: boolean;
  onClose: () => void;
  onSave: (weightKg: number, pricePerKg: number) => void | Promise<void>;
}) {
  const { i18n } = useTranslation();
  const isEn = (i18n.language || '').toLowerCase().startsWith('en');
  const [kg, setKg] = useState('');
  const [rate, setRate] = useState('');
  const [rateLocked, setRateLocked] = useState(false);
  const [rateLoading, setRateLoading] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) return;
    setKg(initialKg && initialKg > 0 ? String(initialKg) : '');
    setErr('');
    const fromLine = Number(initialPricePerKg) > 0 ? Number(initialPricePerKg) : 0;
    if (fromLine > 0) {
      setRate(String(fromLine));
      setRateLocked(true);
      setRateLoading(false);
      return;
    }
    setRate('');
    setRateLocked(false);
    if (!menuItemId) {
      setRateLoading(false);
      return;
    }
    let cancelled = false;
    setRateLoading(true);
    void (async () => {
      try {
        const res = await apiFetch('/api/menu/market-prices');
        if (!res.ok) return;
        const d = (await res.json()) as { items?: Array<{ menuItemId?: string; pricePerKg?: number | null }> };
        const hit = (d.items || []).find((x) => String(x.menuItemId) === String(menuItemId));
        const p = Number(hit?.pricePerKg) || 0;
        if (cancelled || !(p > 0)) return;
        setRate(String(p));
        setRateLocked(true);
      } catch {
        /* keep €/kg input */
      } finally {
        if (!cancelled) setRateLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, initialKg, initialPricePerKg, menuItemId]);

  if (!open) return null;

  const weightNum = Number(kg);
  const rateNum = Number(rate);
  const previewEuro =
    Number.isFinite(weightNum) && weightNum > 0 && Number.isFinite(rateNum) && rateNum > 0
      ? Math.round(weightNum * rateNum * 100) / 100
      : null;

  const submit = async () => {
    const w = Number(kg);
    const r = Number(rate);
    if (!Number.isFinite(w) || w <= 0 || w > 50) {
      setErr(isEn ? 'Enter weight in kg (0.01–50)' : '请填写重量 kg（0.01–50）');
      return;
    }
    if (!Number.isFinite(r) || r <= 0) {
      setErr(isEn ? 'Enter today’s €/kg first (今日时价)' : '尚未录入当天时价，请填写 €/kg');
      return;
    }
    setErr('');
    await onSave(Math.round(w * 100) / 100, Math.round(r * 100) / 100);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1800, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ width: 360, maxWidth: '94vw', background: '#fff', borderRadius: 14, padding: 18 }}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 12 }}>{title}</div>
        <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>{isEn ? 'Weight (kg)' : '重量 (kg)'}</label>
        <input className="input" type="number" step="0.01" min="0.01" value={kg} onChange={(e) => setKg(e.target.value)} autoFocus style={{ width: '100%', marginBottom: 10 }} />
        {rateLocked ? (
          <div style={{ fontSize: 13, marginBottom: 10, padding: '8px 10px', background: '#F5F5F5', borderRadius: 8, color: '#333' }}>
            {isEn
              ? `Today’s rate €${rateNum.toFixed(2)}/kg (already set)`
              : `当天时价 €${rateNum.toFixed(2)}/kg（已录入）`}
          </div>
        ) : (
          <>
            <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>{isEn ? '€ / kg' : '当天 €/kg'}</label>
            <input
              className="input"
              type="number"
              step="0.01"
              min="0.01"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              disabled={rateLoading}
              style={{ width: '100%', marginBottom: 10 }}
            />
          </>
        )}
        {previewEuro != null ? (
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--red-primary)', marginBottom: 10 }}>
            €{previewEuro.toFixed(2)}
          </div>
        ) : null}
        {err ? <div style={{ color: 'var(--red-primary)', fontSize: 12, marginBottom: 8 }}>{err}</div> : null}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>{isEn ? 'Cancel' : '取消'}</button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy || rateLoading}>{isEn ? 'Save' : '保存'}</button>
        </div>
      </div>
    </div>
  );
}
