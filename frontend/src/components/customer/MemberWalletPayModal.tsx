import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../../api/client';

interface Props {
  orderId: string;
  orderIds?: string[];
  tableNumber?: number;
  amount: number;
  onSuccess: () => void;
  onClose: () => void;
}

type Verified = { memberNo: number; displayName: string };

export default function MemberWalletPayModal({ orderId, orderIds, tableNumber, amount, onSuccess, onClose }: Props) {
  const { t } = useTranslation();
  const [step, setStep] = useState<'phone' | 'pin'>('phone');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [verified, setVerified] = useState<Verified | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const verifyPhone = async () => {
    setError('');
    setBusy(true);
    setVerified(null);
    try {
      const q = encodeURIComponent(phone.trim());
      const r = await apiFetch(`/api/members/scan-order-lookup?phone=${q}`, { omitStaffToken: true });
      const d = (await r.json().catch(() => null)) as { error?: { message?: string }; memberNo?: number; displayName?: string } | null;
      if (!r.ok) {
        setError(d?.error?.message || t('customer.memberWalletLookupFailed'));
        return;
      }
      if (d && typeof d.memberNo === 'number') {
        setVerified({ memberNo: d.memberNo, displayName: String(d.displayName || '') });
        setStep('pin');
        setPin('');
      } else {
        setError(t('customer.memberWalletLookupFailed'));
      }
    } finally {
      setBusy(false);
    }
  };

  const pay = async () => {
    setError('');
    setBusy(true);
    try {
      const ids = orderIds && orderIds.length > 0 ? orderIds : [orderId];
      const useTable = ids.length > 1 && tableNumber != null && tableNumber > 0;
      const r = await apiFetch(useTable ? `/api/checkout/table/${tableNumber}` : `/api/checkout/seat/${orderId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        omitStaffToken: true,
        body: JSON.stringify({
          memberPhone: phone.trim(),
          memberPin: pin.trim(),
          skipCloudPrint: true,
        }),
      });
      const d = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!r.ok) {
        setError(d?.error?.message || t('customer.memberWalletPayFailed'));
        return;
      }
      onSuccess();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: '16px 16px 0 0',
          width: '100%',
          maxWidth: 430,
          padding: '24px 20px 32px',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>👛 {t('customer.memberWalletTitle')}</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--red-primary)', fontFamily: "'Noto Serif SC', serif", marginTop: 8 }}>
            €{amount.toFixed(2)}
          </div>
        </div>

        {error ? (
          <div style={{ color: '#C62828', fontSize: 13, marginBottom: 12, textAlign: 'center', lineHeight: 1.45 }}>{error}</div>
        ) : null}

        {step === 'phone' ? (
          <>
            <div style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 8 }}>{t('customer.memberWalletPhoneStepHint')}</div>
            <input
              className="input"
              placeholder={t('member.phone')}
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                setError('');
              }}
              autoComplete="tel"
              style={{ width: '100%', marginBottom: 12 }}
            />
            <button
              type="button"
              className="btn btn-primary"
              style={{ width: '100%', padding: '14px 0' }}
              disabled={busy || !phone.trim()}
              onClick={() => void verifyPhone()}
            >
              {busy ? t('common.loading') : t('customer.memberWalletVerifyPhone')}
            </button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.5 }}>
              {t('customer.memberWalletPhoneOk')}
              {verified ? (
                <>
                  <br />
                  <span style={{ color: 'var(--text-dark)' }}>
                    {t('member.memberNo')} #{verified.memberNo}
                    {verified.displayName.trim() ? ` · ${verified.displayName.trim()}` : ''}
                  </span>
                </>
              ) : null}
            </div>
            <input
              className="input"
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder={t('customer.memberWalletPinPlaceholder')}
              value={pin}
              onChange={(e) => {
                setPin(e.target.value);
                setError('');
              }}
              style={{ width: '100%', marginBottom: 12 }}
            />
            <button
              type="button"
              className="btn btn-primary"
              style={{ width: '100%', padding: '14px 0' }}
              disabled={busy || !pin.trim()}
              onClick={() => void pay()}
            >
              {busy ? t('customer.memberWalletPaying') : t('customer.memberWalletConfirm', { amount: amount.toFixed(2) })}
            </button>
            <button
              type="button"
              className="btn btn-outline"
              style={{ width: '100%', marginTop: 10, padding: '12px 0' }}
              disabled={busy}
              onClick={() => {
                setStep('phone');
                setPin('');
                setVerified(null);
                setError('');
              }}
            >
              {t('customer.memberWalletChangePhone')}
            </button>
          </>
        )}

        <div style={{ textAlign: 'center', marginTop: 14 }}>
          <button type="button" onClick={onClose} className="btn btn-outline" style={{ padding: '10px 24px' }}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
