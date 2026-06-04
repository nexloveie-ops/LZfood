import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { connectStoreSocket } from '../../api/storeSocket';
import { useAuth } from '../../context/AuthContext';
import OrderDetail, { type Order } from '../../components/cashier/OrderDetail';
import { printBuiltReceipt } from '../../components/cashier/ReceiptPrint';
import { apiFetch } from '../../api/client';
import { computeCustomerFacingPayableEuro } from '../../utils/orderPayableEuro';

interface TableGroup {
  tableNumber: number;
  orders: Order[];
  total: number;
  hasPaidOnline: boolean;
  allPaidOnline: boolean;
}

export default function DineInOrderBoard() {
  const { t } = useTranslation();
  const { token, user } = useAuth();
  const navigate = useNavigate();
  const [rawOrders, setRawOrders] = useState<Order[]>([]);
  const [selectedTable, setSelectedTable] = useState<number | null>(null);
  const [printing, setPrinting] = useState(false);
  const [config, setConfig] = useState<Record<string, string>>({});

  useEffect(() => {
    apiFetch('/api/admin/config').then(r => r.ok ? r.json() : {}).then(setConfig).catch(() => {});
  }, []);

  const dineInPayAfter = config.dine_in_workflow_mode === 'pay_after';

  const tables = useMemo((): TableGroup[] => {
    const grouped = new Map<number, Order[]>();
    for (const order of rawOrders) {
      const tbl = order.tableNumber ?? 0;
      if (!grouped.has(tbl)) grouped.set(tbl, []);
      grouped.get(tbl)!.push(order);
    }
    const orderPayable = (o: Order) =>
      computeCustomerFacingPayableEuro(
        {
          type: o.type,
          status: o.status,
          items: o.items,
          appliedBundles: o.appliedBundles,
        },
        dineInPayAfter,
      );
    return [...grouped.entries()]
      .map(([tableNumber, orders]) => ({
        tableNumber,
        orders,
        total: orders.reduce((s, o) => s + orderPayable(o), 0),
        hasPaidOnline: orders.some(o => o.status === 'paid_online'),
        allPaidOnline: orders.length > 0 && orders.every(o => o.status === 'paid_online'),
      }))
      .sort((a, b) => a.tableNumber - b.tableNumber);
  }, [rawOrders, dineInPayAfter]);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await apiFetch('/api/orders/dine-in', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const data: Order[] = await res.json();
      setRawOrders(data);
    } catch { /* ignore */ }
  }, [token]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  useEffect(() => {
    const query = user?.storeId ? { storeId: user.storeId } : {};
    const socket = connectStoreSocket(query);
    socket.on('order:new', fetchOrders);
    socket.on('order:updated', fetchOrders);
    socket.on('order:checked-out', fetchOrders);
    socket.on('order:cancelled', fetchOrders);
    return () => { socket.disconnect(); };
  }, [fetchOrders, user?.storeId]);

  const handleCancelOrder = async (orderId: string) => {
    if (!confirm('确认取消此订单？Cancel this order?')) return;
    try {
      const res = await apiFetch(`/api/orders/${orderId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) fetchOrders();
    } catch { /* ignore */ }
  };

  // Finalize paid_online orders: create checkout + print receipt
  const handleFinalizePaid = async (tbl: TableGroup) => {
    setPrinting(true);
    try {
      const paidOrders = tbl.orders.filter(o => o.status === 'paid_online');
      for (const order of paidOrders) {
        const res = await apiFetch('/api/payments/finalize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ orderId: order._id }),
        });
        if (res.ok) {
          const data = await res.json();
          const stripePi = String((order as { stripePaymentIntentId?: string }).stripePaymentIntentId || '').trim();
          const memberUsed = Number((order as { memberCreditUsed?: number }).memberCreditUsed) || 0;
          const memberPrepaid = !stripePi && memberUsed > 0.001;
          // Build and print receipt（Stripe → online；顾客会员预付 → member，与报表/退款分类一致）
          const receiptData = {
            checkoutId: data.checkoutId,
            type: 'seat' as const,
            tableNumber: order.tableNumber,
            totalAmount: data.totalAmount,
            paymentMethod: memberPrepaid ? ('member' as const) : ('online' as const),
            ...(memberPrepaid
              ? {
                  memberCreditUsed: memberUsed,
                  memberPhoneSnapshot: String((order as { memberPhoneSnapshot?: string }).memberPhoneSnapshot || ''),
                }
              : { cardAmount: data.totalAmount }),
            checkedOutAt: new Date().toISOString(),
            orders: [{
              _id: order._id,
              type: order.type as 'dine_in',
              tableNumber: order.tableNumber,
              seatNumber: order.seatNumber,
              dineInOrderNumber: (order as unknown as { dineInOrderNumber?: string }).dineInOrderNumber,
              status: 'checked_out',
              items: order.items.map(i => ({
                ...i,
                menuItemId: i.menuItemId,
              })),
            }],
          };
          const bundleDiscounts = (order.appliedBundles || []).map(b => ({ name: b.name, nameEn: b.nameEn || '', discount: b.discount }));
          void printBuiltReceipt(receiptData, config, { bundleDiscounts, copies: 1 });
        }
      }
      fetchOrders();
    } catch { /* ignore */ }
    finally { setPrinting(false); }
  };

  const selected = tables.find(t2 => t2.tableNumber === selectedTable);

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%' }}>
      {/* Table grid */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>{t('cashier.dineIn')}</h2>
        {tables.length === 0 && <div style={{ color: 'var(--text-light)', padding: 40, textAlign: 'center' }}>{t('cashier.noOrders')}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 }}>
          {tables.map(tbl => (
            <div key={tbl.tableNumber} onClick={() => setSelectedTable(tbl.tableNumber)}
              className="card" style={{
                padding: 16, cursor: 'pointer', textAlign: 'center', position: 'relative', overflow: 'hidden',
                border: tbl.hasPaidOnline ? '3px solid #4CAF50' : selectedTable === tbl.tableNumber ? '2px solid var(--red-primary)' : '1px solid var(--border)',
                background: tbl.allPaidOnline ? 'linear-gradient(135deg, #E8F5E9, #C8E6C9)' : selectedTable === tbl.tableNumber ? 'var(--red-light)' : 'var(--bg-white)',
                boxShadow: tbl.hasPaidOnline ? '0 0 12px rgba(76,175,80,0.4)' : undefined,
                animation: tbl.hasPaidOnline ? 'pulse-green 2s infinite' : undefined,
              }}>
              {tbl.hasPaidOnline && (
                <div style={{
                  position: 'absolute', top: 0, left: 0, right: 0,
                  background: '#4CAF50', color: '#fff', fontSize: 11, fontWeight: 700,
                  padding: '3px 0', letterSpacing: 1, textAlign: 'center',
                }}>
                  💳 ONLINE PAID
                </div>
              )}
              <div style={{ fontSize: 13, color: 'var(--text-light)', marginBottom: 4, marginTop: tbl.hasPaidOnline ? 16 : 0 }}>{t('cashier.table')}</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: tbl.allPaidOnline ? '#2E7D32' : 'var(--red-primary)', fontFamily: "'Noto Serif SC', serif" }}>{tbl.tableNumber}</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
                {tbl.orders.length} {t('cashier.orderDetail')}
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: tbl.allPaidOnline ? '#2E7D32' : 'var(--red-primary)', marginTop: 4 }}>€{tbl.total.toFixed(2)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Detail panel */}
      {selected && (
        <div style={{ width: 340, flexShrink: 0, background: 'var(--bg-white)', borderRadius: 12, border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <h3 style={{ fontSize: 16, fontWeight: 700 }}>{t('cashier.table')} {selected.tableNumber}</h3>
            <div style={{ display: 'flex', gap: 6 }}>
              {selected.hasPaidOnline && (
                <button className="btn" style={{ padding: '8px 12px', fontSize: 12, background: '#4CAF50', color: '#fff', border: 'none' }}
                  disabled={printing}
                  onClick={() => handleFinalizePaid(selected)}>
                  {printing ? '...' : '🖨️ Print & Complete'}
                </button>
              )}
              {selected.orders.some(o => o.status === 'pending') && (
                <button className="btn btn-primary" style={{ padding: '8px 12px', fontSize: 12 }}
                  onClick={() => navigate(`checkout/${selected.tableNumber}`)}>
                  {t('cashier.checkout')}
                </button>
              )}
            </div>
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
            {/* Status labels */}
            {selected.orders.map(o => (
              o.status === 'paid_online' ? (
                <div key={o._id + '-badge'} style={{ fontSize: 11, color: '#2E7D32', fontWeight: 600, padding: '3px 8px', background: '#E8F5E9', borderRadius: 4, display: 'inline-block', marginBottom: 6, marginRight: 4 }}>
                  💳 {o.seatNumber && o.seatNumber > 0 ? `Seat ${o.seatNumber}` : ''} Paid Online
                </div>
              ) : null
            ))}
            <OrderDetail orders={selected.orders} />
            {/* Cancel buttons only for pending orders */}
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {selected.orders.filter(o => o.status === 'pending').map(o => (
                <button key={o._id} className="btn btn-ghost"
                  onClick={() => handleCancelOrder(o._id)}
                  style={{ fontSize: 12, color: 'var(--red-primary)', textAlign: 'left', padding: '6px 8px', border: '1px dashed var(--red-primary)', borderRadius: 6 }}>
                  ✕ 取消 {o.seatNumber && o.seatNumber > 0 ? `座位${o.seatNumber}的订单` : `订单 ${o._id.slice(-6)}`}
                </button>
              ))}
            </div>
          </div>
          <div style={{ padding: '12px 16px', borderTop: '2px solid var(--border)', display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 16 }}>
            <span>{t('cashier.total')}</span>
            <span style={{ color: 'var(--red-primary)' }}>€{selected.total.toFixed(2)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
