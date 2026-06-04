import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { connectStoreSocket } from '../../api/storeSocket';
import { useAuth } from '../../context/AuthContext';
import ReceiptPrint from '../../components/cashier/ReceiptPrint';
import { printBuiltReceipt } from '../../components/cashier/ReceiptPrint';
import { apiFetch } from '../../api/client';
import CashierMemberCheckoutBlock, {
  buildMemberFullWalletCheckoutBody,
  canMemberFullWalletPay,
  type CashierMemberPreview,
} from '../../components/cashier/CashierMemberCheckoutBlock';
import OrderItemOptionGroupList from '../../components/cashier/OrderItemOptionGroupList';

interface OrderItem { _id: string; menuItemId: string; quantity: number; unitPrice: number; itemName: string; selectedOptions?: { groupName: string; groupNameEn?: string; choiceName: string; choiceNameEn?: string; extraPrice: number }[]; }
interface TakeoutOrder {
  _id: string; type: string; dailyOrderNumber?: number; status: string;
  items: OrderItem[]; createdAt: string;
  appliedBundles?: { name: string; nameEn?: string; discount: number }[];
  stripePaymentIntentId?: string;
  memberCreditUsed?: number;
  memberPhoneSnapshot?: string;
}

export default function TakeoutOrderList() {
  const { t, i18n } = useTranslation();
  const isEn = (i18n.language || '').toLowerCase().startsWith('en');
  const { token, user, hasFeature } = useAuth();
  const canMemberWallet = hasFeature('cashier.member.wallet');
  const [orders, setOrders] = useState<TakeoutOrder[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'mixed' | 'member'>('cash');
  const [memberPhone, setMemberPhone] = useState('');
  const [memberPreview, setMemberPreview] = useState<CashierMemberPreview | null>(null);
  const [cashAmount, setCashAmount] = useState('');
  const [cardAmount, setCardAmount] = useState('');
  const [cashReceived, setCashReceived] = useState('');
  const [checkoutId, setCheckoutId] = useState<string | null>(null);
  const [checkoutMeta, setCheckoutMeta] = useState<{ total: number; cashReceived: number; change: number } | null>(null);
  const [checkoutBundles, setCheckoutBundles] = useState<{ name: string; nameEn: string; discount: number }[]>([]);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [finalizing, setFinalizing] = useState(false);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await apiFetch('/api/orders/takeout', { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setOrders(await res.json());
    } catch { /* ignore */ }
  }, [token]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  useEffect(() => {
    apiFetch('/api/admin/config').then(r => r.ok ? r.json() : {}).then(setConfig).catch(() => {});
  }, []);

  useEffect(() => {
    const query = user?.storeId ? { storeId: user.storeId } : {};
    const socket = connectStoreSocket(query);
    socket.on('order:new', fetchOrders);
    socket.on('order:updated', fetchOrders);
    socket.on('order:checked-out', fetchOrders);
    socket.on('order:cancelled', fetchOrders);
    return () => { socket.disconnect(); };
  }, [fetchOrders, user?.storeId]);

  useEffect(() => {
    if (!canMemberWallet && paymentMethod === 'member') {
      setPaymentMethod('cash');
      setMemberPreview(null);
    }
  }, [canMemberWallet, paymentMethod]);

  const selectedOrder = orders.find(o => o._id === selected);
  const orderTotal = (o: TakeoutOrder) => {
    const itemsSum = o.items.reduce((s, i) => {
      const optExtra = (i.selectedOptions || []).reduce((a: number, opt: { extraPrice?: number }) => a + (opt.extraPrice || 0), 0);
      return s + (i.unitPrice + optExtra) * i.quantity;
    }, 0);
    const bundleDisc = (o.appliedBundles || []).reduce((a, b) => a + b.discount, 0);
    return itemsSum - bundleDisc;
  };

  // Reset cashReceived when selecting a new order
  useEffect(() => {
    setCashReceived('');
    setPaymentMethod('cash');
    setMemberPhone('');
    setMemberPreview(null);
  }, [selected]);

  const cashReceivedNum = parseFloat(cashReceived) || 0;
  const currentTotal = selectedOrder ? orderTotal(selectedOrder) : 0;
  const changeAmount = paymentMethod === 'cash' ? Math.max(0, cashReceivedNum - currentTotal) : 0;
  const cashValid = paymentMethod !== 'cash' || cashReceivedNum >= currentTotal;

  const handleFinalizePaid = async (order: TakeoutOrder) => {
    setFinalizing(true);
    try {
      const res = await apiFetch('/api/payments/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orderId: order._id }),
      });
      if (res.ok) {
        const data = await res.json();
        const stripePi = String(order.stripePaymentIntentId || '').trim();
        const memberUsed = Number(order.memberCreditUsed) || 0;
        const memberPrepaid = !stripePi && memberUsed > 0.001;
        const receiptData = {
          checkoutId: data.checkoutId,
          type: 'seat' as const,
          totalAmount: data.totalAmount,
          paymentMethod: memberPrepaid ? ('member' as const) : ('online' as const),
          ...(memberPrepaid
            ? { memberCreditUsed: memberUsed, memberPhoneSnapshot: String(order.memberPhoneSnapshot || '') }
            : {}),
          checkedOutAt: new Date().toISOString(),
          orders: [{
            _id: order._id,
            type: 'takeout' as const,
            dailyOrderNumber: order.dailyOrderNumber,
            status: 'checked_out',
            items: order.items,
          }],
        };
        const bundleDiscounts = (order.appliedBundles || []).map(b => ({ name: b.name, nameEn: b.nameEn || '', discount: b.discount }));
        void printBuiltReceipt(receiptData, config, { bundleDiscounts, copies: 1 });
        setSelected(null);
        fetchOrders();
      }
    } catch { /* ignore */ }
    finally { setFinalizing(false); }
  };

  const handleCheckout = async () => {
    if (!selectedOrder) return;
    if (paymentMethod === 'cash' && cashReceivedNum < currentTotal) return;
    if (paymentMethod === 'member' && !canMemberFullWalletPay(memberPreview, currentTotal)) return;
    setCheckingOut(true);
    try {
      const total = orderTotal(selectedOrder);
      const body: Record<string, unknown> =
        paymentMethod === 'member' && memberPreview
          ? buildMemberFullWalletCheckoutBody(total, memberPreview.phone)
          : (() => {
              const b: Record<string, unknown> = { paymentMethod };
              if (paymentMethod === 'cash') b.cashAmount = total;
              else if (paymentMethod === 'card') b.cardAmount = total;
              else {
                b.cashAmount = Number(cashAmount);
                b.cardAmount = Number(cardAmount);
              }
              return b;
            })();

      const res = await apiFetch(`/api/checkout/seat/${selectedOrder._id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        setCheckoutId(data._id);
        setCheckoutMeta({ total, cashReceived: cashReceivedNum, change: changeAmount });
        setCheckoutBundles((selectedOrder.appliedBundles || []).map(b => ({ name: b.name, nameEn: b.nameEn || '', discount: b.discount })));
      }
    } catch { /* ignore */ }
    finally { setCheckingOut(false); }
  };

  const handleCloseReceipt = () => {
    setCheckoutId(null);
    setCheckoutMeta(null);
    setSelected(null);
    fetchOrders();
  };

  const handleCancelOrder = async (orderId: string) => {
    if (!confirm('确认取消此订单？Cancel this order?')) return;
    try {
      const res = await apiFetch(`/api/orders/${orderId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) { setSelected(null); fetchOrders(); }
    } catch { /* ignore */ }
  };

  // Show receipt after checkout
  if (checkoutId) {
    return (
      <div style={{ maxWidth: 500, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', padding: 20 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>✅</div>
          <h2 style={{ color: 'var(--green)', marginBottom: 12 }}>{t('cashier.checkoutSuccess')}</h2>
          {checkoutMeta && paymentMethod === 'cash' && checkoutMeta.change > 0 && (
            <div style={{
              background: '#FFF3E0', border: '2px solid #FF9800', borderRadius: 12,
              padding: 16, marginBottom: 16, fontSize: 16,
            }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 4 }}>{t('cashier.total')}: €{checkoutMeta.total.toFixed(2)}</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 4 }}>{t('cashier.cashReceived')}: €{checkoutMeta.cashReceived.toFixed(2)}</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: '#E65100' }}>
                {t('cashier.change')}: €{checkoutMeta.change.toFixed(2)}
              </div>
            </div>
          )}
          <button className="btn btn-outline" onClick={handleCloseReceipt} style={{ marginBottom: 20 }}>
            {t('common.back')}
          </button>
          <button className="btn btn-primary" onClick={() => window.print()} style={{ marginBottom: 20, marginLeft: 8 }}>
            🖨️ {t('cashier.printReceipt')}
          </button>
        </div>
        <ReceiptPrint checkoutId={checkoutId} cashReceived={checkoutMeta?.cashReceived} changeAmount={checkoutMeta?.change} bundleDiscounts={checkoutBundles} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%' }}>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>{t('cashier.takeout')}</h2>
        {orders.length === 0 && <div style={{ color: 'var(--text-light)', padding: 40, textAlign: 'center' }}>{t('cashier.noOrders')}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {orders.map(o => {
            const isPaidOnline = o.status === 'paid_online';
            return (
            <div key={o._id} onClick={() => setSelected(o._id)} className="card" style={{
              padding: '14px 16px', cursor: 'pointer',
              border: isPaidOnline ? '3px solid #4CAF50' : selected === o._id ? '2px solid var(--red-primary)' : '1px solid var(--border)',
              background: isPaidOnline ? 'linear-gradient(135deg, #E8F5E9, #C8E6C9)' : undefined,
              boxShadow: isPaidOnline ? '0 0 10px rgba(76,175,80,0.3)' : undefined,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 18, color: isPaidOnline ? '#2E7D32' : 'var(--red-primary)' }}>
                  #{o.dailyOrderNumber}
                  {isPaidOnline && <span style={{ marginLeft: 8, fontSize: 11, padding: '2px 8px', borderRadius: 4, background: '#4CAF50', color: '#fff', fontWeight: 700 }}>💳 ONLINE PAID</span>}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-light)' }}>{o.items.length} items · {new Date(o.createdAt).toLocaleTimeString()}</div>
              </div>
              <div style={{ fontWeight: 700, fontSize: 16, color: isPaidOnline ? '#2E7D32' : 'var(--red-primary)', fontFamily: "'Noto Serif SC', serif" }}>€{orderTotal(o).toFixed(2)}</div>
            </div>
            );
          })}
        </div>
      </div>

      {selectedOrder && (
        <div style={{ width: 360, flexShrink: 0, background: 'var(--bg-white)', borderRadius: 12, border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
            <h3 style={{ fontSize: 16, fontWeight: 700 }}>#{selectedOrder.dailyOrderNumber} {t('cashier.orderDetail')}</h3>
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
            {selectedOrder.items.map(item => (
              <div key={item._id} style={{ padding: '8px 0', borderBottom: '1px solid #f0f0f0', fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>{item.itemName} ×{item.quantity}</span>
                  <span style={{ fontWeight: 600, color: 'var(--red-primary)' }}>€{((item.unitPrice + (item.selectedOptions || []).reduce((a: number, o: { extraPrice?: number }) => a + (o.extraPrice || 0), 0)) * item.quantity).toFixed(2)}</span>
                </div>
                <OrderItemOptionGroupList options={item.selectedOptions} isEn={isEn} compact />
              </div>
            ))}
          </div>
          <div style={{ padding: 16, borderTop: '2px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {selectedOrder.appliedBundles && selectedOrder.appliedBundles.length > 0 && (
              <div style={{ padding: '8px 10px', background: '#FFF3E0', borderRadius: 8, fontSize: 13 }}>
                {selectedOrder.appliedBundles.map((b, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', color: '#E65100' }}>
                    <span>🎁 {b.name}</span>
                    <span style={{ fontWeight: 600 }}>-€{b.discount.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 18 }}>
              <span>{t('cashier.total')}</span>
              <span style={{ color: selectedOrder.status === 'paid_online' ? '#2E7D32' : 'var(--red-primary)' }}>€{currentTotal.toFixed(2)}</span>
            </div>

            {selectedOrder.status === 'paid_online' ? (
              <>
                <div style={{ padding: 10, background: '#E8F5E9', borderRadius: 8, textAlign: 'center', fontWeight: 700, color: '#2E7D32' }}>
                  💳 Online Payment Received
                </div>
                <button className="btn" style={{ width: '100%', background: '#4CAF50', color: '#fff', border: 'none', padding: '12px 0', fontSize: 15 }}
                  disabled={finalizing}
                  onClick={() => handleFinalizePaid(selectedOrder)}>
                  {finalizing ? '...' : '🖨️ Print & Complete'}
                </button>
              </>
            ) : (
            <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {(canMemberWallet ? (['cash', 'card', 'mixed', 'member'] as const) : (['cash', 'card', 'mixed'] as const)).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setPaymentMethod(m);
                    setCashReceived('');
                    if (m !== 'member') {
                      setMemberPreview(null);
                    }
                  }}
                  className="btn"
                  style={{
                    flex: '1 1 40%',
                    minWidth: 72,
                    fontSize: 12,
                    padding: '8px 0',
                    background: paymentMethod === m ? 'var(--red-primary)' : 'var(--bg)',
                    color: paymentMethod === m ? '#fff' : 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {t(`cashier.${m}`)}
                </button>
              ))}
            </div>

            {paymentMethod === 'member' ? (
              <CashierMemberCheckoutBlock
                payAmount={currentTotal}
                phone={memberPhone}
                setPhone={setMemberPhone}
                preview={memberPreview}
                setPreview={setMemberPreview}
                compact
              />
            ) : null}

            {/* Cash: input received amount + change */}
            {paymentMethod === 'cash' && (
              <div style={{ padding: 10, background: 'var(--bg)', borderRadius: 8 }}>
                <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>
                  {t('cashier.cashReceived')}
                </label>
                <input className="input" type="number" step="0.01" min="0" value={cashReceived}
                  onChange={e => setCashReceived(e.target.value)}
                  style={{ width: '100%', fontSize: 16, fontWeight: 700, padding: '8px 10px', textAlign: 'right' }} />
                {cashReceivedNum > 0 && (
                  <div style={{
                    marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '6px 10px', borderRadius: 6,
                    background: cashReceivedNum >= currentTotal ? '#E8F5E9' : '#FFEBEE',
                  }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{t('cashier.change')}</span>
                    <span style={{
                      fontSize: 18, fontWeight: 700,
                      color: cashReceivedNum >= currentTotal ? 'var(--green)' : 'var(--red-primary)',
                    }}>€{changeAmount.toFixed(2)}</span>
                  </div>
                )}
              </div>
            )}

            {paymentMethod === 'mixed' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input" placeholder={t('cashier.cashAmount')} value={cashAmount} onChange={e => setCashAmount(e.target.value)} type="number" />
                <input className="input" placeholder={t('cashier.cardAmount')} value={cardAmount} onChange={e => setCardAmount(e.target.value)} type="number" />
              </div>
            )}

            <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleCheckout}
              disabled={
                checkingOut ||
                (paymentMethod === 'cash' && !cashValid) ||
                (paymentMethod === 'member' && !canMemberFullWalletPay(memberPreview, currentTotal))
              }>
              {checkingOut ? t('common.loading') : t('cashier.submitCheckout')}
            </button>
            <button className="btn btn-ghost" style={{ width: '100%', marginTop: 8, color: 'var(--red-primary)', border: '1px dashed var(--red-primary)', fontSize: 13 }}
              onClick={() => handleCancelOrder(selectedOrder._id)}>
              ✕ 取消订单
            </button>
            </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
