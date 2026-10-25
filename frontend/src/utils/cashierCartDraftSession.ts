/**
 * 收银台点单草稿：模块内存缓存（SPA 内切换订单中心 ↔ 点单不丢；刷新同会话可选用 sessionStorage）。
 * 结账/下单成功、退出登录后应清空。
 */

export type CashierCartDraftOrderType = 'dine_in' | 'takeout' | 'phone' | 'delivery';

export interface CashierCartDraftLineOption {
  groupId?: string;
  choiceId?: string;
  isAdHoc?: boolean;
  groupName: Record<string, string>;
  choiceName: Record<string, string>;
  extraPrice: number;
}

export interface CashierCartDraftLine {
  id: string;
  menuItemId: string;
  name: string;
  price: number;
  options?: CashierCartDraftLineOption[];
}

export interface CashierCartDraft {
  order: CashierCartDraftLine[];
  orderType: CashierCartDraftOrderType;
  phoneGuestPhone: string;
  phoneGuestName: string;
  phoneCardPaidAtPlacement: boolean;
  deliveryCustomerName: string;
  deliveryCustomerPhone: string;
  deliveryAddress: string;
  deliveryPostalCode: string;
  deliveryFeeInput: string;
  deliveryFeeTouched: boolean;
  deliveryDistanceKm: number | null;
  deliveryCustomerProfileId: string;
  deliveryCustomerCollapsed: boolean;
  counterTableInput: string;
  counterGuestLabel: string;
  editingOrderId: string | null;
  editOrderLabel: string;
  updatedAt: number;
}

const memory = new Map<string, CashierCartDraft>();
const STORAGE_PREFIX = 'lzfood.cashierCartDraft.v1:';

export function cashierCartDraftKey(storeSlug: string, username: string): string {
  return `${storeSlug || '_default'}:${username || 'anon'}`;
}

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`;
}

function readStorage(key: string): CashierCartDraft | undefined {
  try {
    const raw = sessionStorage.getItem(storageKey(key));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as CashierCartDraft;
    if (!parsed || !Array.isArray(parsed.order)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeStorage(key: string, draft: CashierCartDraft): void {
  try {
    sessionStorage.setItem(storageKey(key), JSON.stringify(draft));
  } catch {
    /* quota / private mode — memory still works */
  }
}

function removeStorage(key: string): void {
  try {
    sessionStorage.removeItem(storageKey(key));
  } catch {
    /* ignore */
  }
}

export function getCashierCartDraft(key: string): CashierCartDraft | undefined {
  const mem = memory.get(key);
  if (mem) return mem;
  const fromDisk = readStorage(key);
  if (fromDisk) {
    memory.set(key, fromDisk);
    return fromDisk;
  }
  return undefined;
}

export function setCashierCartDraft(
  key: string,
  draft: Omit<CashierCartDraft, 'updatedAt'>,
): void {
  const next: CashierCartDraft = { ...draft, updatedAt: Date.now() };
  memory.set(key, next);
  writeStorage(key, next);
}

export function clearCashierCartDraft(key: string): void {
  memory.delete(key);
  removeStorage(key);
}

/** 退出登录：清掉该店下所有收银草稿 */
export function clearCashierCartDraftsForStore(storeSlug: string): void {
  const prefix = `${storeSlug || '_default'}:`;
  for (const k of [...memory.keys()]) {
    if (k.startsWith(prefix)) memory.delete(k);
  }
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const sk = sessionStorage.key(i);
      if (sk && sk.startsWith(STORAGE_PREFIX + prefix)) toRemove.push(sk);
    }
    for (const sk of toRemove) sessionStorage.removeItem(sk);
  } catch {
    /* ignore */
  }
}

export function emptyCashierCartDraft(): Omit<CashierCartDraft, 'updatedAt'> {
  return {
    order: [],
    orderType: 'dine_in',
    phoneGuestPhone: '',
    phoneGuestName: '',
    phoneCardPaidAtPlacement: false,
    deliveryCustomerName: '',
    deliveryCustomerPhone: '',
    deliveryAddress: '',
    deliveryPostalCode: '',
    deliveryFeeInput: '0.00',
    deliveryFeeTouched: false,
    deliveryDistanceKm: null,
    deliveryCustomerProfileId: '',
    deliveryCustomerCollapsed: false,
    counterTableInput: '',
    counterGuestLabel: '',
    editingOrderId: null,
    editOrderLabel: '',
  };
}
