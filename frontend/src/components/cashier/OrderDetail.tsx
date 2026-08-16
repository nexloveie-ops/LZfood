import { useTranslation } from 'react-i18next';
import OrderItemOptionGroupList from './OrderItemOptionGroupList';
import { cashierBundleDisplayName, cashierOrderItemDisplayName } from '../../utils/cashierOrderItemOptions';

export interface OrderItem {
  _id: string;
  menuItemId: string;
  quantity: number;
  unitPrice: number;
  itemName: string;
  itemNameEn?: string;
  lineKind?: string;
  refunded?: boolean;
  settledQty?: number;
  selectedOptions?: {
    groupName: string;
    groupNameEn?: string;
    choiceName: string;
    choiceNameEn?: string;
    extraPrice: number;
  }[];
}

export interface Order {
  _id: string;
  type: string;
  tableNumber?: number;
  seatNumber?: number;
  status: string;
  items: OrderItem[];
  appliedBundles?: { offerId?: string; name: string; nameEn?: string; discount: number }[];
  createdAt: string;
}

interface OrderDetailProps {
  orders: Order[];
}

export default function OrderDetail({ orders }: OrderDetailProps) {
  const { t, i18n } = useTranslation();
  const isEn = (i18n.language || '').toLowerCase().startsWith('en');

  if (orders.length === 0) return null;

  const bySeat = new Map<number, Order[]>();
  for (const order of orders) {
    const seat = order.seatNumber ?? 0;
    if (!bySeat.has(seat)) bySeat.set(seat, []);
    bySeat.get(seat)!.push(order);
  }

  const sortedSeats = [...bySeat.keys()].sort((a, b) => a - b);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {sortedSeats.map((seat) => {
        const seatOrders = bySeat.get(seat)!;
        return (
          <div key={seat} style={{ background: 'var(--bg)', borderRadius: 8, padding: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
              {t('cashier.seat')} {seat}
            </div>
            {seatOrders.map((order) => (
              <div key={order._id}>
                {order.items.map((item) => (
                  <div key={item._id} style={{ padding: '6px 0', borderBottom: '1px solid #eee' }}>
                    <div style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13,
                    }}>
                      <span style={{ fontWeight: 500 }}>{cashierOrderItemDisplayName(item, isEn)}</span>
                      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                        <span style={{ color: 'var(--text-light)' }}>×{item.quantity}</span>
                        <span style={{ fontWeight: 600, color: 'var(--red-primary)', minWidth: 50, textAlign: 'right' }}>
                          €{((item.unitPrice + (item.selectedOptions || []).reduce((s, o) => s + (o.extraPrice || 0), 0)) * item.quantity).toFixed(2)}
                        </span>
                      </div>
                    </div>
                    {item.selectedOptions && item.selectedOptions.length > 0 ? (
                      <div style={{ paddingLeft: 8 }}>
                        <OrderItemOptionGroupList options={item.selectedOptions} isEn={isEn} compact />
                      </div>
                    ) : null}
                  </div>
                ))}
                {order.appliedBundles && order.appliedBundles.length > 0 && (
                  <div style={{ padding: '6px 0' }}>
                    {order.appliedBundles.map((b, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, color: '#E65100' }}>
                        <span>🎁 {cashierBundleDisplayName(b, isEn)}</span>
                        <span style={{ fontWeight: 600, minWidth: 50, textAlign: 'right' }}>-€{b.discount.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
