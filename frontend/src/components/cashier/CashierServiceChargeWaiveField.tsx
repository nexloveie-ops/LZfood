type Props = {
  percent: number;
  amount: number;
  waived: boolean;
  isEn: boolean;
};

export default function CashierServiceChargeWaiveField({
  percent,
  amount,
  waived,
  isEn,
}: Props) {
  if (amount <= 0.001) return null;
  const pct = String(percent);
  return (
    <div className="cashier-service-charge">
      <div className="cashier-service-charge-row">
        <span>{isEn ? `Service ${pct}%` : `服务费 ${pct}%`}</span>
        <span className={waived ? 'is-waived' : undefined}>€{amount.toFixed(2)}</span>
      </div>
      {waived ? (
        <div className="cashier-service-waive">
          {isEn ? 'Waived per store settings' : '已按店铺设置减免'}
        </div>
      ) : null}
    </div>
  );
}
