/** 营业额 / VAT / 品类结构：hide 单与员工钱包单均不计入店铺销售。 */

export function statusContainsHide(status: unknown): boolean {
  return String(status ?? '').toLowerCase().includes('hide');
}

export function isStaffWalletOrder(order: { memberWallet?: unknown } | null | undefined): boolean {
  return order != null && order.memberWallet === 'staff';
}

export function omitOrderFromStoreSales(
  order: { status?: unknown; memberWallet?: unknown } | null | undefined,
): boolean {
  if (!order) return false;
  return statusContainsHide(order.status) || isStaffWalletOrder(order);
}
