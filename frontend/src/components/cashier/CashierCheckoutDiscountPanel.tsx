import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../../api/client';
import type { NumberedVoucherPreview } from './CashierNumberedVoucherBlock';

type CouponOption = { _id: string; name: string; nameEn: string; amount: number };

type Props = {
  token: string;
  orderId: string | null;
  subtotalEuro: number;
  payableEuro: number;
  disabled?: boolean;
  disabledReason?: string;
  availableCoupons: CouponOption[];
  selectedCoupon: CouponOption | null;
  onSelectCoupon: (c: CouponOption | null) => void;
  voucherCode: string;
  onVoucherCodeChange: (code: string) => void;
  voucherPreview: NumberedVoucherPreview | null;
  onVoucherPreviewChange: (p: NumberedVoucherPreview | null) => void;
  onDiscountInteraction?: () => void;
};

type DiscountMode = 'coupon' | 'voucher';

export default function CashierCheckoutDiscountPanel({
  token,
  orderId,
  subtotalEuro,
  payableEuro,
  disabled,
  disabledReason,
  availableCoupons,
  selectedCoupon,
  onSelectCoupon,
  voucherCode,
  onVoucherCodeChange,
  voucherPreview,
  onVoucherPreviewChange,
  onDiscountInteraction,
}: Props) {
  const { t } = useTranslation();
  const hasCoupons = availableCoupons.length > 0;
  const showVoucher = Boolean(orderId);
  const showPanel = !disabled && (hasCoupons || showVoucher);

  const [mode, setMode] = useState<DiscountMode>(() => {
    if (voucherPreview || voucherCode.trim()) return 'voucher';
    if (selectedCoupon) return 'coupon';
    return hasCoupons ? 'coupon' : 'voucher';
  });
  const [voucherBusy, setVoucherBusy] = useState(false);
  const [voucherErr, setVoucherErr] = useState('');

  useEffect(() => {
    if (voucherPreview || voucherCode.trim()) setMode('voucher');
    else if (selectedCoupon) setMode('coupon');
  }, [selectedCoupon, voucherCode, voucherPreview]);

  if (!showPanel) {
    if (disabled && disabledReason) {
      return (
        <div style={{ fontSize: 11, color: '#888', marginBottom: 10, padding: '6px 8px', background: 'var(--bg)', borderRadius: 8 }}>
          {disabledReason}
        </div>
      );
    }
    return null;
  }

  const switchMode = (next: DiscountMode) => {
    setMode(next);
    setVoucherErr('');
    onDiscountInteraction?.();
    if (next === 'coupon') {
      onVoucherCodeChange('');
      onVoucherPreviewChange(null);
    } else {
      onSelectCoupon(null);
    }
  };

  const validateVoucher = async () => {
    setVoucherErr('');
    if (selectedCoupon) {
      setVoucherErr(t('cashier.numberedVoucher.conflictCoupon'));
      return;
    }
    const trimmed = voucherCode.trim();
    if (!trimmed) {
      onVoucherPreviewChange(null);
      return;
    }
    if (!orderId) {
      setVoucherErr(t('cashier.numberedVoucher.needOrder'));
      onVoucherPreviewChange(null);
      return;
    }
    setVoucherBusy(true);
    try {
      const res = await apiFetch('/api/voucher-campaigns/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code: trimmed, orderId }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error?.message || t('cashier.numberedVoucher.validateFailed'));
      onSelectCoupon(null);
      onVoucherPreviewChange({
        code: String(d.code),
        campaignName: String(d.campaignName || ''),
        voucherDiscountEuro: Number(d.voucherDiscountEuro) || 0,
        payableEuro: Number(d.payableEuro) || 0,
        discountType: String(d.discountType || ''),
      });
      onDiscountInteraction?.();
    } catch (e) {
      onVoucherPreviewChange(null);
      setVoucherErr(e instanceof Error ? e.message : t('cashier.numberedVoucher.validateFailed'));
    } finally {
      setVoucherBusy(false);
    }
  };

  const showBeforeAfter = payableEuro + 0.001 < subtotalEuro;
  const sliderLeft = mode === 'coupon' ? '2px' : 'calc(50% + 1px)';

  return (
    <div style={{ marginBottom: 10, padding: '8px 10px', background: 'var(--bg)', borderRadius: 10 }}>
      {showBeforeAfter ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            marginBottom: 8,
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          <span style={{ color: '#888', textDecoration: 'line-through' }}>€{subtotalEuro.toFixed(2)}</span>
          <span style={{ color: '#bbb', fontSize: 12 }}>→</span>
          <span style={{ color: 'var(--red-primary)', fontSize: 16 }}>€{payableEuro.toFixed(2)}</span>
        </div>
      ) : null}

      {hasCoupons && showVoucher ? (
        <div
          style={{
            position: 'relative',
            display: 'flex',
            marginBottom: 8,
            padding: 2,
            borderRadius: 8,
            background: 'rgba(0,0,0,0.06)',
          }}
          role="tablist"
        >
          <div
            aria-hidden
            style={{
              position: 'absolute',
              top: 2,
              bottom: 2,
              left: sliderLeft,
              width: 'calc(50% - 3px)',
              borderRadius: 6,
              background: '#fff',
              boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
              transition: 'left 0.2s ease',
            }}
          />
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'coupon'}
            onClick={() => switchMode('coupon')}
            style={{
              flex: 1,
              zIndex: 1,
              border: 'none',
              background: 'transparent',
              padding: '6px 4px',
              fontSize: 12,
              fontWeight: mode === 'coupon' ? 700 : 500,
              color: mode === 'coupon' ? 'var(--text-primary)' : 'var(--text-light)',
              cursor: 'pointer',
            }}
          >
            {t('cashier.discountTabCoupon')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'voucher'}
            onClick={() => switchMode('voucher')}
            style={{
              flex: 1,
              zIndex: 1,
              border: 'none',
              background: 'transparent',
              padding: '6px 4px',
              fontSize: 12,
              fontWeight: mode === 'voucher' ? 700 : 500,
              color: mode === 'voucher' ? 'var(--text-primary)' : 'var(--text-light)',
              cursor: 'pointer',
            }}
          >
            {t('cashier.discountTabVoucher')}
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 11, color: 'var(--text-light)', marginBottom: 6 }}>
          {hasCoupons ? t('cashier.discountTabCoupon') : t('cashier.numberedVoucher.title')}
        </div>
      )}

      {mode === 'coupon' && hasCoupons ? (
        <div style={{ display: 'flex', flexWrap: 'nowrap', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
          {availableCoupons.map((c) => {
            const isSelected = selectedCoupon?.name === c.name && selectedCoupon?.amount === c.amount;
            return (
              <button
                key={c._id}
                type="button"
                onClick={() => {
                  onDiscountInteraction?.();
                  if (isSelected) onSelectCoupon(null);
                  else {
                    onSelectCoupon(c);
                    onVoucherCodeChange('');
                    onVoucherPreviewChange(null);
                  }
                }}
                className="btn"
                style={{
                  flexShrink: 0,
                  padding: '5px 10px',
                  fontSize: 11,
                  borderRadius: 16,
                  background: isSelected ? '#4CAF50' : 'var(--bg-white)',
                  color: isSelected ? '#fff' : 'var(--text-secondary)',
                  border: isSelected ? '2px solid #388E3C' : '1px solid var(--border)',
                }}
              >
                {c.name} -€{c.amount.toFixed(2)}
              </button>
            );
          })}
        </div>
      ) : null}

      {(mode === 'voucher' || (!hasCoupons && showVoucher)) ? (
        <div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              className="input"
              style={{ flex: 1, fontSize: 13, minWidth: 0 }}
              placeholder={t('cashier.numberedVoucher.placeholder')}
              value={voucherCode}
              disabled={voucherBusy}
              onChange={(e) => {
                onVoucherCodeChange(e.target.value);
                if (voucherPreview) onVoucherPreviewChange(null);
                setVoucherErr('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void validateVoucher();
              }}
            />
            <button type="button" className="btn btn-primary" style={{ fontSize: 11, padding: '6px 10px', flexShrink: 0 }} disabled={voucherBusy} onClick={() => void validateVoucher()}>
              {t('cashier.numberedVoucher.apply')}
            </button>
            {(voucherPreview || voucherCode) ? (
              <button
                type="button"
                className="btn btn-outline"
                style={{ fontSize: 11, padding: '6px 8px', flexShrink: 0 }}
                disabled={voucherBusy}
                onClick={() => {
                  onVoucherCodeChange('');
                  onVoucherPreviewChange(null);
                  setVoucherErr('');
                }}
              >
                {t('cashier.numberedVoucher.clear')}
              </button>
            ) : null}
          </div>
          {voucherErr ? <div style={{ fontSize: 11, color: '#c62828', marginTop: 4 }}>{voucherErr}</div> : null}
          {voucherPreview ? (
            <div style={{ fontSize: 11, color: '#2E7D32', marginTop: 4, fontWeight: 600 }}>
              {voucherPreview.campaignName} · {voucherPreview.code} (−€{voucherPreview.voucherDiscountEuro.toFixed(2)})
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
