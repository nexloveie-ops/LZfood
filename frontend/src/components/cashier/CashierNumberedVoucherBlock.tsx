import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../../api/client';

export type NumberedVoucherPreview = {
  code: string;
  campaignName: string;
  voucherDiscountEuro: number;
  payableEuro: number;
  discountType: string;
};

type Props = {
  token: string;
  orderId: string | null;
  code: string;
  onCodeChange: (code: string) => void;
  disabled?: boolean;
  disabledReason?: string;
  couponActive?: boolean;
  onClearCoupon?: () => void;
  preview: NumberedVoucherPreview | null;
  onPreviewChange: (p: NumberedVoucherPreview | null) => void;
};

export default function CashierNumberedVoucherBlock({
  token,
  orderId,
  code,
  onCodeChange,
  disabled,
  disabledReason,
  couponActive,
  onClearCoupon,
  preview,
  onPreviewChange,
}: Props) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const apply = async () => {
    setErr('');
    if (couponActive) {
      setErr(t('cashier.numberedVoucher.conflictCoupon'));
      return;
    }
    const trimmed = code.trim();
    if (!trimmed) {
      onPreviewChange(null);
      return;
    }
    if (!orderId) {
      setErr(t('cashier.numberedVoucher.needOrder'));
      onPreviewChange(null);
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch('/api/voucher-campaigns/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code: trimmed, orderId }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(d?.error?.message || t('cashier.numberedVoucher.validateFailed'));
      }
      onClearCoupon?.();
      onPreviewChange({
        code: String(d.code),
        campaignName: String(d.campaignName || ''),
        voucherDiscountEuro: Number(d.voucherDiscountEuro) || 0,
        payableEuro: Number(d.payableEuro) || 0,
        discountType: String(d.discountType || ''),
      });
    } catch (e) {
      onPreviewChange(null);
      setErr(e instanceof Error ? e.message : t('cashier.numberedVoucher.validateFailed'));
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    onCodeChange('');
    setErr('');
    onPreviewChange(null);
  };

  return (
    <div style={{ marginBottom: 12, padding: 10, background: 'var(--bg)', borderRadius: 8, opacity: disabled ? 0.55 : 1 }}>
      <div style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 6 }}>🎫 {t('cashier.numberedVoucher.title')}</div>
      {disabled && disabledReason ? (
        <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>{disabledReason}</div>
      ) : null}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          className="input"
          style={{ flex: 1, fontSize: 13 }}
          placeholder={t('cashier.numberedVoucher.placeholder')}
          value={code}
          disabled={disabled || busy}
          onChange={(e) => {
            onCodeChange(e.target.value);
            if (preview) onPreviewChange(null);
            setErr('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void apply();
          }}
        />
        <button type="button" className="btn btn-primary" style={{ fontSize: 12 }} disabled={disabled || busy} onClick={() => void apply()}>
          {t('cashier.numberedVoucher.apply')}
        </button>
        {(preview || code) && (
          <button type="button" className="btn btn-outline" style={{ fontSize: 12 }} disabled={busy} onClick={clear}>
            {t('cashier.numberedVoucher.clear')}
          </button>
        )}
      </div>
      {err ? <div style={{ fontSize: 11, color: '#c62828', marginTop: 6 }}>{err}</div> : null}
      {preview ? (
        <div style={{ marginTop: 8, fontSize: 12 }}>
          <div style={{ color: '#555' }}>
            {preview.campaignName} · {preview.code}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontWeight: 700 }}>
            <span style={{ color: '#2E7D32' }}>
              {t('cashier.numberedVoucher.discount')} -€{preview.voucherDiscountEuro.toFixed(2)}
            </span>
            <span style={{ color: '#2E7D32' }}>
              {t('cashier.numberedVoucher.payable')} €{preview.payableEuro.toFixed(2)}
            </span>
          </div>
        </div>
      ) : code.trim() && !orderId ? (
        <div style={{ fontSize: 11, color: '#888', marginTop: 6 }}>{t('cashier.numberedVoucher.needOrder')}</div>
      ) : null}
    </div>
  );
}
