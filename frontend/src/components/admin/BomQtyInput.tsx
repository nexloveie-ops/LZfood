import { useEffect, useState, type CSSProperties } from 'react';
import { commitConsumptionQtyDraft, isConsumptionQtyDraft } from '../../utils/consumptionQty';

/** BoM 消耗量：允许输入过程中保留「0.」「0.5」等中间态，失焦时再规范化 */
export default function BomQtyInput(props: {
  value: number;
  onCommit: (qty: number) => void;
  style?: CSSProperties;
}) {
  const { value, onCommit, style } = props;
  const [draft, setDraft] = useState(() => String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <input
      className="input"
      type="text"
      inputMode="decimal"
      autoComplete="off"
      style={style}
      value={draft}
      onChange={(e) => {
        const next = e.target.value;
        if (isConsumptionQtyDraft(next)) setDraft(next);
      }}
      onBlur={() => {
        const committed = commitConsumptionQtyDraft(draft);
        setDraft(String(committed));
        if (committed !== value) onCommit(committed);
      }}
    />
  );
}
