import type { StaffZheApplied } from '../../utils/staffZheDiscount';

type Props = {
  value: string;
  onChange: (next: string) => void;
  applied: StaffZheApplied;
  isEn: boolean;
};

export default function CashierStaffZheDiscountField({ value, onChange, applied, isEn }: Props) {
  return (
    <label className="cashier-zhe">
      <span className="cashier-zhe-label">{isEn ? 'Discount (折)' : '折扣（折）'}</span>
      <div className="cashier-zhe-row">
        <input
          className="input"
          inputMode="decimal"
          placeholder={isEn ? 'e.g. 9 or 85' : '例如 9 或 85'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="cashier-zhe-suffix">折</span>
      </div>
      <div className="cashier-zhe-hint">{isEn ? '9 = 10% off · 85 = 15% off' : '9＝九折 · 85＝八五折'}</div>
      {applied.status === 'invalid' ? (
        <div className="cashier-zhe-err">
          {isEn ? 'Enter 1–10 (e.g. 9) or 11–99 (e.g. 85)' : '请输入 1–10（如 9）或 11–99（如 85）'}
        </div>
      ) : null}
      {applied.status === 'ok' ? (
        <div className="cashier-zhe-ok">
          {applied.labelZh} · {isEn ? 'Save' : '优惠'} −€{applied.discountEuro.toFixed(2)}
        </div>
      ) : null}
    </label>
  );
}
