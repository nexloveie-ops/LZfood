/** Snapshot lines persisted on orders (see backend `snapshotSelectedOptionsFromMenuItem`). */
export type CashierSelectedOptionSnapshot = {
  groupName?: string;
  groupNameEn?: string;
  choiceName?: string;
  choiceNameEn?: string;
  extraPrice?: number;
};

export type CashierGroupedOptionRow = {
  groupLabel: string;
  choices: { label: string; extraEuro: number }[];
};

/**
 * Groups flat `selectedOptions` by option group so multi-select groups show as one block
 * with multiple choices (instead of repeating the group name on one line).
 */
export function groupCashierSelectedOptions(
  opts: CashierSelectedOptionSnapshot[] | undefined,
  isEn: boolean,
): CashierGroupedOptionRow[] {
  const list = opts?.filter(Boolean) ?? [];
  if (list.length === 0) return [];

  const orderKeys: string[] = [];
  const byKey = new Map<string, CashierGroupedOptionRow>();

  for (const o of list) {
    const gZh = (o.groupName || '').trim();
    const gEn = (o.groupNameEn || '').trim();
    const key = `${gZh}\0${gEn}`;
    const groupLabel = isEn ? gEn || gZh || '—' : gZh || gEn || '—';
    const cZh = (o.choiceName || '').trim();
    const cEn = (o.choiceNameEn || '').trim();
    const label = isEn ? cEn || cZh || '—' : cZh || cEn || '—';
    const extra = typeof o.extraPrice === 'number' && Number.isFinite(o.extraPrice) ? o.extraPrice : 0;

    let row = byKey.get(key);
    if (!row) {
      row = { groupLabel, choices: [] };
      byKey.set(key, row);
      orderKeys.push(key);
    }
    row.choices.push({ label, extraEuro: extra });
  }

  return orderKeys.map((k) => byKey.get(k)!);
}
