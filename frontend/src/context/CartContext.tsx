import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';

export interface CartItemOption {
  groupId: string;
  choiceId: string;
  groupName: Record<string, string>;
  choiceName: Record<string, string>;
  extraPrice: number;
}

export interface CartItem {
  menuItemId: string;
  names: Record<string, string>;
  price: number;
  quantity: number;
  options?: CartItemOption[];
  /** 来自已锁定/仅可加菜的堂食改单：数量不可减至此值以下，且不可整行删除 */
  lockedBaselineQty?: number;
  isMarketPrice?: boolean;
  lineId?: string;
  /** 有折扣时的目录原价，仅展示划线 */
  listPrice?: number;
}

export type CartAddMeta = { isMarketPrice?: boolean; listPrice?: number };

/** 已下单锁定量之外、购物车里还能加减的份数 */
export function cartItemOpenQty(item: CartItem): number {
  const floor = typeof item.lockedBaselineQty === 'number' ? Math.max(0, item.lockedBaselineQty) : 0;
  return Math.max(0, item.quantity - floor);
}

export function isLockedCartBaseline(item: CartItem): boolean {
  return typeof item.lockedBaselineQty === 'number';
}

/** Bump when option group id strategy changes so stale groupId/choiceId are not reused */
const STORAGE_KEY = 'cart_items_v2';

function cartItemKey(menuItemId: string, options?: CartItemOption[], lineId?: string): string {
  if (lineId) return lineId;
  if (!options || options.length === 0) return menuItemId;
  return menuItemId + '|' + JSON.stringify(options.map(o => ({ g: o.groupId, c: o.choiceId })));
}

function dishOptionKey(menuItemId: string, options?: CartItemOption[]): string {
  if (!options || options.length === 0) return menuItemId;
  return menuItemId + '|' + JSON.stringify(options.map(o => ({ g: o.groupId, c: o.choiceId })));
}

function newAddLineId(): string {
  return `add-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadCart(): CartItem[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return parsed.map((item: CartItem & { name?: string }) => {
      if (!item.names && item.name) {
        return { ...item, names: { 'zh-CN': item.name, 'en-US': item.name } };
      }
      return item;
    });
  } catch { return []; }
}

function saveCart(items: CartItem[]) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

interface CartContextValue {
  items: CartItem[];
  addItem: (menuItemId: string, names: Record<string, string>, price: number, options?: CartItemOption[], meta?: CartAddMeta) => void;
  removeItem: (key: string) => void;
  increaseQuantity: (key: string) => void;
  decreaseQuantity: (key: string) => void;
  clearCart: () => void;
  setItems: (items: CartItem[]) => void;
  editOrderId: string | null;
  setEditOrderId: (id: string | null) => void;
  totalAmount: number;
  totalItems: number;
  openCartTotalItems: number;
  openCartTotalAmount: number;
  getItemKey: (item: CartItem) => string;
}

const CartContext = createContext<CartContextValue | null>(null);

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within CartProvider');
  return ctx;
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItemsState] = useState<CartItem[]>(loadCart);
  const [editOrderId, setEditOrderId] = useState<string | null>(null);

  useEffect(() => { saveCart(items); }, [items]);

  const setItems = useCallback((newItems: CartItem[]) => { setItemsState(newItems); }, []);

  const getItemKey = useCallback((item: CartItem) => cartItemKey(item.menuItemId, item.options, item.lineId), []);

  const addItem = useCallback((menuItemId: string, names: Record<string, string>, price: number, options?: CartItemOption[], meta?: CartAddMeta) => {
    if (meta?.isMarketPrice) {
      const lineId = `mkt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setItemsState((prev) => [...prev, { menuItemId, names, price: 0, quantity: 1, options, isMarketPrice: true, lineId }]);
      return;
    }
    const dishKey = dishOptionKey(menuItemId, options);
    setItemsState((prev) => {
      const existingOpen = prev.find((i) =>
        !i.isMarketPrice && !isLockedCartBaseline(i) && dishOptionKey(i.menuItemId, i.options) === dishKey,
      );
      if (existingOpen) {
        return prev.map((i) =>
          !i.isMarketPrice && !isLockedCartBaseline(i) && dishOptionKey(i.menuItemId, i.options) === dishKey
            ? { ...i, quantity: i.quantity + 1 }
            : i,
        );
      }
      const hasLockedSame = prev.some((i) => isLockedCartBaseline(i) && dishOptionKey(i.menuItemId, i.options) === dishKey);
      if (hasLockedSame) {
        return [...prev, { menuItemId, names, price, quantity: 1, options, lineId: newAddLineId(), listPrice: meta?.listPrice }];
      }
      return [...prev, { menuItemId, names, price, quantity: 1, options, listPrice: meta?.listPrice }];
    });
  }, []);

  const itemKey = (i: CartItem) => cartItemKey(i.menuItemId, i.options, i.lineId);

  const removeItem = useCallback((key: string) => {
    setItemsState((prev) => {
      const item = prev.find((i) => itemKey(i) === key);
      if (item && typeof item.lockedBaselineQty === 'number') return prev;
      return prev.filter((i) => itemKey(i) !== key);
    });
  }, []);

  const increaseQuantity = useCallback((key: string) => {
    setItemsState((prev) => {
      const item = prev.find((i) => itemKey(i) === key);
      if (!item) return prev;
      if (item.isMarketPrice) {
        const lineId = `mkt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return [...prev, { ...item, lineId, quantity: 1, lockedBaselineQty: undefined }];
      }
      return prev.map((i) => (itemKey(i) === key ? { ...i, quantity: i.quantity + 1 } : i));
    });
  }, []);

  const decreaseQuantity = useCallback((key: string) => {
    setItemsState((prev) => {
      const item = prev.find((i) => itemKey(i) === key);
      if (!item) return prev;
      const floor = typeof item.lockedBaselineQty === 'number' ? Math.max(0, item.lockedBaselineQty) : 0;
      if (item.quantity <= floor) return prev;
      const nextQty = item.quantity - 1;
      if (nextQty <= 0) {
        if (floor > 0) return prev;
        return prev.filter((i) => itemKey(i) !== key);
      }
      return prev.map((i) =>
        itemKey(i) === key ? { ...i, quantity: Math.max(floor, nextQty) } : i,
      );
    });
  }, []);

  const clearCart = useCallback(() => { setItemsState([]); setEditOrderId(null); sessionStorage.removeItem(STORAGE_KEY); }, []);

  const totalAmount = items.reduce((sum, i) => {
    const optExtra = (i.options || []).reduce((s, o) => s + o.extraPrice, 0);
    return sum + (i.price + optExtra) * i.quantity;
  }, 0);
  const totalItems = items.reduce((sum, i) => sum + i.quantity, 0);
  const openCartTotalItems = items.reduce((sum, i) => sum + cartItemOpenQty(i), 0);
  const openCartTotalAmount = items.reduce((sum, i) => {
    const optExtra = (i.options || []).reduce((s, o) => s + o.extraPrice, 0);
    return sum + (i.price + optExtra) * cartItemOpenQty(i);
  }, 0);

  return (
    <CartContext.Provider
      value={{ items, addItem, removeItem, increaseQuantity, decreaseQuantity, clearCart, setItems, editOrderId, setEditOrderId, totalAmount, totalItems, openCartTotalItems, openCartTotalAmount, getItemKey }}
    >
      {children}
    </CartContext.Provider>
  );
}
