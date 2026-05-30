import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type ForwardedRef,
} from 'react';
import { commitNonNegativeQtyDraft, isConsumptionQtyDraft } from '../../utils/consumptionQty';

/** 已输入完成的数量（不含末尾单独的「.」） */
const COMPLETE_QTY = /^\d+(\.\d{1,2})?$/;

export type InventoryQtyInputHandle = {
  /** 将当前输入规范化并返回（保存前调用） */
  flush: () => number;
};

/** 库存基础单位数量：允许输入 6.6 等小数 */
const InventoryQtyInput = forwardRef(function InventoryQtyInput(
  props: {
    value: number;
    onCommit: (qty: number) => void;
    style?: CSSProperties;
  },
  ref: ForwardedRef<InventoryQtyInputHandle>,
) {
  const { value, onCommit, style } = props;
  const [draft, setDraft] = useState(() => String(value));
  const draftRef = useRef(draft);
  const focusedRef = useRef(false);

  draftRef.current = draft;

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(String(value));
      draftRef.current = String(value);
    }
  }, [value]);

  const commit = (raw: string): number => {
    const committed = commitNonNegativeQtyDraft(raw);
    const text = String(committed);
    setDraft(text);
    draftRef.current = text;
    onCommit(committed);
    return committed;
  };

  useImperativeHandle(ref, () => ({
    flush: () => commit(draftRef.current),
  }), []);

  return (
    <input
      className="input"
      type="text"
      inputMode="decimal"
      autoComplete="off"
      style={style}
      value={draft}
      onFocus={() => { focusedRef.current = true; }}
      onChange={(e) => {
        const next = e.target.value;
        if (!isConsumptionQtyDraft(next)) return;
        setDraft(next);
        draftRef.current = next;
        if (COMPLETE_QTY.test(next)) commit(next);
      }}
      onBlur={() => {
        focusedRef.current = false;
        commit(draftRef.current);
      }}
    />
  );
});

export default InventoryQtyInput;

export function parseInventoryQtyDraft(raw: string): number {
  return commitNonNegativeQtyDraft(raw);
}

export { COMPLETE_QTY, isConsumptionQtyDraft };
