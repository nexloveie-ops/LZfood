export const UNIT_SUGGESTIONS = ['kg', 'g', '个', '瓶', '箱', '袋', '盒', 'L', 'ml'];

export const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export type IsoWeekday = (typeof ISO_WEEKDAYS)[number];

export type PurchaseContact = { name: string; phone: string; email: string };

export type PurchaseCategory = { _id: string; name: string; sortOrder: number; isActive: boolean };
export type PurchaseItem = {
  _id: string;
  categoryId: string;
  name: string;
  description: string;
  unit: string;
  sortOrder: number;
  isActive: boolean;
};
export type PurchaseSupplier = {
  _id: string;
  name: string;
  notes: string;
  contacts: PurchaseContact[];
  deliveryWeekdays: number[];
  isActive: boolean;
};
export type PurchaseQuote = {
  _id: string;
  supplierId: string;
  itemId: string;
  unitPrice: number;
  deliveryWeekdays: number[];
  isActive: boolean;
};

export type WeekQuote = {
  quoteId: string;
  supplierId: string;
  supplierName: string;
  unitPrice: number;
  deliveryWeekdays: number[];
};

export type WeekCell = {
  weekday: IsoWeekday;
  date: string;
  covering: WeekQuote[];
  line: { qty: number; supplierId: string; unitPrice: number; unit: string; supplierName: string } | null;
};

export type WeekItem = {
  _id: string;
  name: string;
  description: string;
  unit: string;
  displayUnitPrice: number | null;
  quotes: WeekQuote[];
  cells: WeekCell[];
};

export type WeekCategory = { _id: string; name: string; items: WeekItem[] };

export type SupplierPo = {
  supplierId: string;
  supplierName: string;
  contacts: PurchaseContact[];
  notes: string;
  total: number;
  lines: Array<{
    date: string;
    weekday: number;
    itemName: string;
    itemDescription: string;
    categoryName: string;
    unit: string;
    qty: number;
    unitPrice: number;
    lineTotal: number;
  }>;
};

export type WeekPayload = {
  weekStart: string;
  dates: string[];
  isPast: boolean;
  isCurrent: boolean;
  updatedByUsername: string;
  updatedAt: string | null;
  categories: WeekCategory[];
  bySupplier: SupplierPo[];
  grandTotal: number;
};

export function euro(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `€${n.toFixed(2)}`;
}

export function cellKey(itemId: string, weekday: number): string {
  return `${itemId}:${weekday}`;
}

export async function readApiError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => null);
  return data?.error?.message || fallback;
}
