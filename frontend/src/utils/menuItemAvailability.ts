/** 顾客菜单：手动售罄 + A 模式库存（与收银端 remainingServings 一致） */

export type MenuItemAvailabilityLike = {
  isSoldOut?: boolean;
  inventoryTracked?: boolean;
  inventory?: { currentQty?: number; perServing?: number };
};

/** 可售份数；未启用库存追踪时返回 null */
export function menuItemRemainingServings(item: MenuItemAvailabilityLike): number | null {
  if (!item.inventoryTracked) return null;
  const per = Math.max(1, Math.floor(Number(item.inventory?.perServing) || 1));
  const cur = Math.max(0, Math.floor(Number(item.inventory?.currentQty) || 0));
  return Math.floor(cur / per);
}

/** 顾客端应显示为售罄（不含 BoM 原材料阻断） */
export function isCustomerMenuItemSoldOut(item: MenuItemAvailabilityLike): boolean {
  if (item.isSoldOut) return true;
  const remaining = menuItemRemainingServings(item);
  return remaining !== null && remaining <= 0;
}
