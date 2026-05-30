import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type ForwardedRef,
} from 'react';
import { commitConsumptionQtyDraft, isConsumptionQtyDraft } from '../../utils/consumptionQty';

const COMPLETE_QTY = /^\d+(\.\d{1,2})?$/;

export type BomQtyInputHandle = {
  flush: () => number;
};

/** BoM 原材料消耗量：支持 0.5 等小数，保存前可 flush */
const BomQtyInput = forwardRef(function BomQtyInput(
  props: {
    value: number;
    onCommit: (qty: number) => void;
    registerFlush?: (fn: () => number) => () => void;
    style?: CSSProperties;
  },
  ref: ForwardedRef<BomQtyInputHandle>,
) {
  const { value, onCommit, registerFlush, style } = props;
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
    const committed = commitConsumptionQtyDraft(raw);
    const text = String(committed);
    setDraft(text);
    draftRef.current = text;
    onCommit(committed);
    return committed;
  };

  useImperativeHandle(ref, () => ({
    flush: () => commit(draftRef.current),
  }), []);

  useEffect(() => {
    if (!registerFlush) return undefined;
    return registerFlush(() => commit(draftRef.current));
  }, [registerFlush, onCommit]);

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

export default BomQtyInput;
