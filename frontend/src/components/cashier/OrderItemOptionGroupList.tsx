import { useMemo } from 'react';
import {
  groupCashierSelectedOptions,
  type CashierSelectedOptionSnapshot,
} from '../../utils/cashierOrderItemOptions';

type Props = {
  options?: CashierSelectedOptionSnapshot[];
  isEn: boolean;
  /** Tighter typography for dense tables / side panels */
  compact?: boolean;
};

export default function OrderItemOptionGroupList({ options, isEn, compact }: Props) {
  const groups = useMemo(() => groupCashierSelectedOptions(options, isEn), [options, isEn]);
  if (groups.length === 0) return null;

  const fs = compact ? 11 : 12;
  const subFs = compact ? 11 : 12;

  return (
    <div
      style={{
        marginTop: compact ? 2 : 4,
        fontSize: fs,
        color: 'var(--text-light)',
      }}
    >
      {groups.map((g, gi) => (
        <div key={gi} style={{ marginTop: gi > 0 ? (compact ? 4 : 6) : 0 }}>
          <div
            style={{
              fontWeight: 600,
              color: 'var(--text-secondary)',
              fontSize: subFs,
            }}
          >
            {g.groupLabel}
          </div>
          <ul
            style={{
              margin: '2px 0 0 0',
              paddingLeft: 18,
              listStyleType: 'disc',
            }}
          >
            {g.choices.map((c, ci) => (
              <li key={ci} style={{ fontSize: subFs, lineHeight: 1.35 }}>
                {c.label}
                {c.extraEuro > 0 ? `  (+€${c.extraEuro.toFixed(2)})` : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
