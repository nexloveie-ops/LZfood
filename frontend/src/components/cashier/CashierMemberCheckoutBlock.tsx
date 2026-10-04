import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../../api/client';

export type CashierMemberPreview = {
  displayName: string;
  creditBalance: number;
  memberNo: number;
  phone: string;
  isStaffHere?: boolean;
  staffBalance?: number | null;
  stampCount?: number;
  stampRedeemAt?: number;
};

type Props = {
  payAmount: number;
  phone: string;
  setPhone: (v: string) => void;
  preview: CashierMemberPreview | null;
  setPreview: (p: CashierMemberPreview | null) => void;
  /** 窄布局下用于压缩 padding */
  compact?: boolean;
};

/** 收银弹窗内：手机号载入会员信息，人工核对后可全额储值结账（店员 JWT 免 PIN） */
export default function CashierMemberCheckoutBlock({
  payAmount,
  phone,
  setPhone,
  preview,
  setPreview,
  compact,
}: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);

  const doLookup = async () => {
    setLoading(true);
    setPreview(null);
    try {
      const q = encodeURIComponent(phone.trim());
      const r = await apiFetch(`/api/members/cashier-lookup?phone=${q}`);
      const d = await r.json().catch(() => null);
      if (r.ok && d && typeof d.phone === 'string') {
        setPreview({
          displayName: String(d.displayName || ''),
          creditBalance: Number(d.creditBalance) || 0,
          memberNo: Number(d.memberNo) || 0,
          phone: d.phone,
          isStaffHere: !!d.isStaffHere,
          staffBalance: d.staffBalance == null ? null : Number(d.staffBalance) || 0,
          stampCount: Math.max(0, Math.floor(Number(d.stampCount) || 0)),
          stampRedeemAt: Math.max(1, Math.floor(Number(d.stampRedeemAt) || 9)),
        });
      } else {
        setPreview(null);
      }
    } finally {
      setLoading(false);
    }
  };

  const payableBalance = (() => {
    if (!preview) return 0;
    if (preview.isStaffHere && (preview.staffBalance ?? 0) + 0.001 >= payAmount) {
      return Number(preview.staffBalance) || 0;
    }
    return preview.creditBalance;
  })();
  const shortfall = preview ? Math.max(0, payAmount - payableBalance) : 0;
  const canFullPay = preview != null && shortfall <= 0.001;
  const payWithStaff =
    !!preview?.isStaffHere && (preview.staffBalance ?? 0) + 0.001 >= payAmount;

  return (
    <div
      style={{
        marginBottom: compact ? 10 : 12,
        padding: compact ? 10 : 12,
        background: 'var(--bg)',
        borderRadius: 8,
        border: '1px solid var(--border, #eee)',
      }}
    >
      <div style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 8 }}>{t('cashier.memberCheckoutHint')}</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          className="input"
          placeholder={t('member.phone')}
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
            setPreview(null);
          }}
          style={{ flex: 1 }}
        />
        <button type="button" className="btn btn-outline" disabled={loading || !phone.trim()} onClick={() => void doLookup()}>
          {loading ? t('common.loading') : t('cashier.memberLoadInfo')}
        </button>
      </div>
      {preview ? (
        <div style={{ fontSize: 13, marginBottom: 8, lineHeight: 1.5 }}>
          <div>
            <span style={{ color: 'var(--text-secondary)' }}>{t('member.memberNo')}: </span>
            <strong>#{preview.memberNo}</strong>
          </div>
          <div>
            <span style={{ color: 'var(--text-secondary)' }}>{t('member.editName')}: </span>
            {preview.displayName.trim() || '—'}
          </div>
          <div>
            <span style={{ color: 'var(--text-secondary)' }}>{t('member.balance')}: </span>
            <strong style={{ color: 'var(--red-primary)' }}>€{preview.creditBalance.toFixed(2)}</strong>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <img
              src="/stamps/duck.jpg"
              alt=""
              width={22}
              height={22}
              style={{ width: 22, height: 22, borderRadius: '50%', objectFit: 'cover', background: '#000', flexShrink: 0 }}
            />
            <span>
              <span style={{ color: 'var(--text-secondary)' }}>{t('member.stamps')}: </span>
              <strong>
                {t('member.stampsProgress', '{{count}} / {{goal}}', {
                  count: Math.max(0, Math.floor(Number(preview.stampCount) || 0)),
                  goal: Math.max(1, Math.floor(Number(preview.stampRedeemAt) || 9)),
                })}
              </strong>
            </span>
          </div>
          {preview.isStaffHere ? (
            <div>
              <span style={{ color: 'var(--text-secondary)' }}>{t('cashier.memberStaffBalance')}: </span>
              <strong>€{(Number(preview.staffBalance) || 0).toFixed(2)}</strong>
            </div>
          ) : null}
          {shortfall > 0.001 ? (
            <div style={{ color: 'var(--red-primary)', marginTop: 6 }}>{t('cashier.memberInsufficient', { short: shortfall.toFixed(2) })}</div>
          ) : (
            <div style={{ color: 'var(--green, #2e7d32)', marginTop: 6, fontWeight: 600 }}>
              {payWithStaff ? t('cashier.memberPayingWithStaff') : t('cashier.memberCanPayFull')}
            </div>
          )}
        </div>
      ) : null}
      {canFullPay ? <div style={{ fontSize: 11, color: 'var(--green, #2e7d32)', marginTop: 6 }}>{t('cashier.memberReadyToSubmit')}</div> : null}
    </div>
  );
}

export function buildMemberFullWalletCheckoutBody(payAmount: number, phone: string): Record<string, unknown> {
  return {
    paymentMethod: 'cash',
    cashAmount: payAmount,
    memberPhone: phone.trim(),
  };
}

export function canMemberFullWalletPay(preview: CashierMemberPreview | null, payAmount: number): boolean {
  if (!preview) return false;
  if (preview.isStaffHere && (preview.staffBalance ?? 0) + 1e-9 >= payAmount) return true;
  return preview.creditBalance + 1e-9 >= payAmount;
}
