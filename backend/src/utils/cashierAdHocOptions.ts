export const AD_HOC_OPTION_MAX_PER_LINE = 3;
export const AD_HOC_OPTION_MAX_EXTRA_EURO = 50;
export const AD_HOC_LABEL_MAX_LEN = 80;
export const AD_HOC_DEFAULT_GROUP_ZH = '加料';
export const AD_HOC_DEFAULT_GROUP_EN = 'Extra';

export type AdHocOptionInput = {
  groupName?: string;
  groupNameEn?: string;
  choiceName: string;
  choiceNameEn?: string;
  extraPrice: number;
};

export type AdHocOptionSnapshot = {
  groupName: string;
  groupNameEn: string;
  choiceName: string;
  choiceNameEn: string;
  extraPrice: number;
  source: 'cashier_adhoc';
};

function trimLabel(raw: unknown, maxLen: number): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, maxLen);
}

function parseExtraPrice(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  const rounded = Math.round(n * 100) / 100;
  if (rounded > AD_HOC_OPTION_MAX_EXTRA_EURO) return null;
  return rounded;
}

/** Parse staff ad-hoc options from order item payload. Returns [] if absent. */
export function parseAdHocOptionsFromItemPayload(raw: unknown): AdHocOptionInput[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length > AD_HOC_OPTION_MAX_PER_LINE) return null;

  const out: AdHocOptionInput[] = [];
  for (const el of raw) {
    if (!el || typeof el !== 'object') return null;
    const o = el as Record<string, unknown>;
    const choiceName = trimLabel(o.choiceName, AD_HOC_LABEL_MAX_LEN);
    if (!choiceName) return null;
    const extraPrice = parseExtraPrice(o.extraPrice);
    if (extraPrice === null) return null;
    const groupName = trimLabel(o.groupName, AD_HOC_LABEL_MAX_LEN) || AD_HOC_DEFAULT_GROUP_ZH;
    const groupNameEn = trimLabel(o.groupNameEn, AD_HOC_LABEL_MAX_LEN) || AD_HOC_DEFAULT_GROUP_EN;
    const choiceNameEn = trimLabel(o.choiceNameEn, AD_HOC_LABEL_MAX_LEN) || choiceName;
    out.push({ groupName, groupNameEn, choiceName, choiceNameEn, extraPrice });
  }
  return out;
}

export function adHocOptionsToSnapshots(inputs: AdHocOptionInput[]): AdHocOptionSnapshot[] {
  return inputs.map((o) => ({
    groupName: o.groupName?.trim() || AD_HOC_DEFAULT_GROUP_ZH,
    groupNameEn: o.groupNameEn?.trim() || AD_HOC_DEFAULT_GROUP_EN,
    choiceName: o.choiceName.trim(),
    choiceNameEn: (o.choiceNameEn?.trim() || o.choiceName).trim(),
    extraPrice: o.extraPrice,
    source: 'cashier_adhoc' as const,
  }));
}
