import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { connectStoreSocket } from '../../api/storeSocket';
import { useAuth } from '../../context/AuthContext';
import ReceiptPrint from '../../components/cashier/ReceiptPrint';
import { apiFetch } from '../../api/client';
import CashierMemberCheckoutBlock, {
  buildMemberFullWalletCheckoutBody,
  canMemberFullWalletPay,
  type CashierMemberPreview,
} from '../../components/cashier/CashierMemberCheckoutBlock';

interface OrderItem {
  _id: string; menuItemId: string; quantity: number; unitPrice: number;
  itemName: string; itemNameEn?: string;
  selectedOptions?: { groupName: string; choiceName: string; extraPrice: number }[];
}

interface PhoneOrder {
  _id: string; type: string; dailyOrderNumber?: number; status: string;
  items: OrderItem[]; createdAt: string;
  customerPhone?: string;
  customerName?: string;
  appliedBundles?: { name: string; nameEn?: string; discount: number }[];
}

export default function PhoneOrderList() {
  const { t } = useTranslation();
  const { token, user, hasFeature } = useAuth();
  const canMemberWallet = hasFeature('cashier.member.wallet');
  const [orders, setOrders] = useState<PhoneOrder[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  // Payment state
  const [showPayment, setShowPayment] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'mixed' | 'member'>('cash');
  const [cashReceived, setCashReceived] = useState('');
  const [mixedCash, setMixedCash] = useState('');
  const [mixedCard, setMixedCard] = useState('');
  const [memberPhone, setMemberPhone] = useState('');
  const [memberPreview, setMemberPreview] = useState<CashierMemberPreview | null>(null);
  const [paying, setPaying] = useState(false);

  // Receipt state
  const [checkoutId, setCheckoutId] = useState<string | null>(null);
  const [checkoutMeta, setCheckoutMeta] = useState<{ total: number; cashReceived: number; change: number } | null>(null);
  const [checkoutBundles, setCheckoutBundles] = useState<{ name: string; nameEn: string; discount: number }[]>([]);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await apiFetch('/api/orders/phone', { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setOrders(await res.json());
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

  useEffect(() => {
    if (!canMemberWallet && paymentMethod === 'member') {
      setPaymentMethod('cash');
      setMemberPreview(null);
    }
  }, [canMemberWallet, paymentMethod]);

  const orderTotal = (o: PhoneOrder) => {
    const itemsSum = o.items.reduce((s, i) => {
      const optExtra = (i.selectedOptions || []).reduce((a, opt) => a + (opt.extraPrice || 0), 0);
      return s + (i.unitPrice + optExtra) * i.quantity;
    }, 0);
    const bundleDisc = (o.appliedBundles || []).reduce((a, b) => a + b.discount, 0);
    return itemsSum - bundleDisc;
  };

  const selectedOrder = orders.find(o => o._id === selected);
  const selectedTotal = selectedOrder ? orderTotal(selectedOrder) : 0;

  const cashReceivedNum = parseFloat(cashReceived) || 0;
  const changeAmount = paymentMethod === 'cash' ? Math.max(0, cashReceivedNum - selectedTotal) : 0;

  const openPayment = (orderId: string) => {
    setSelected(orderId);
    setCashReceived('');
    setPaymentMethod('cash');
    setMemberPhone('');
    setMemberPreview(null);
    setShowPayment(true);
  };

  const handlePay = async () => {
    if (!selected) return;
    setPaying(true);
    try {
      const checkoutBody: Record<string, unknown> =
        paymentMethod === 'member' && memberPreview
          ? buildMemberFullWalletCheckoutBody(selectedTotal, memberPreview.phone)
          : (() => {
              const b: Record<string, unknown> = { paymentMethod };
              if (paymentMethod === 'cash') b.cashAmount = selectedTotal;
              else if (paymentMethod === 'card') b.cardAmount = selectedTotal;
              else {
                b.cashAmount = Number(mixedCash);
                b.cardAmount = Number(mixedCard);
              }
              return b;
            })();

      const res = await apiFetch(`/api/checkout/seat/${selected}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(checkoutBody),
      });
      if (!res.ok) { const d = await res.json().catch(() => null); throw new Error(d?.error?.message || 'Failed'); }
      const data = await res.json();
      setCheckoutId(data._id);
      setCheckoutMeta({ total: selectedTotal, cashReceived: cashReceivedNum, change: changeAmount });
      setCheckoutBundles((selectedOrder?.appliedBundles || []).map(b => ({ name: b.name, nameEn: b.nameEn || '', discount: b.discount })));
      setShowPayment(false);
      fetchOrders();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setPaying(false);
    }
  };

  const handleCancelOrder = async (orderId: string) => {
    if (!confirm('确认取消此电话订单？')) return;
    await apiFetch(`/api/orders/${orderId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    fetchOrders();
  };

  // Receipt screen
  if (checkoutId) {
    return (
      <div style={{ maxWidth: 500, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', padding: 20 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>✅</div>
          <h2 style={{ color: 'var(--green)', marginBottom: 12 }}>{t('cashier.checkoutSuccess')}</h2>
          {checkoutMeta && paymentMethod === 'cash' && checkoutMeta.change > 0 && (
            <div style={{ background: '#FFF3E0', border: '2px solid #FF9800', borderRadius: 12, padding: 16, marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('cashier.total')}: €{checkoutMeta.total.toFixed(2)}</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('cashier.cashReceived')}: €{checkoutMeta.cashReceived.toFixed(2)}</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: '#E65100' }}>{t('cashier.change')}: €{checkoutMeta.change.toFixed(2)}</div>
            </div>
          )}
          <button className="btn btn-primary" onClick={() => { setCheckoutId(null); setCheckoutMeta(null); setSelected(null); }}>继续</button>
          <button className="btn btn-outline" onClick={() => window.print()} style={{ marginLeft: 8 }}>🖨️ 打印小票</button>
        </div>
        <ReceiptPrint checkoutId={checkoutId} cashReceived={checkoutMeta?.cashReceived} changeAmount={checkoutMeta?.change} bundleDiscounts={checkoutBundles} printCopies={1} />
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>📞 电话订单</h2>

      {orders.length === 0 && (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-light)' }}>
          <div style={{ fontSize: 48, opacity: 0.3, marginBottom: 8 }}>📞</div>
          <p>暂无电话订单</p>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {orders.map(o => {
          const total = orderTotal(o);
          const time = new Date(o.createdAt).toLocaleTimeString();
          return (
            <div key={o._id} className="card" style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div>
                  <span style={{ fontWeight: 700, fontSize: 16, color: '#7B1FA2' }}>
                    📞 #{o.dailyOrderNumber} · €{total.toFixed(2)}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--text-light)', marginLeft: 8 }}>{time}</span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-primary" style={{ padding: '6px 14px', fontSize: 12 }}
                    onClick={() => openPayment(o._id)}>
                    💰 结账
                  </button>
                  <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red-primary)' }}
                    onClick={() => handleCancelOrder(o._id)}>
                    取消
                  </button>
                </div>
              </div>
              {(o.customerPhone || o.customerName) && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                  {o.customerName ? <span>{o.customerName}</span> : null}
                  {o.customerName && o.customerPhone ? <span> · </span> : null}
                  {o.customerPhone ? <span>📱 {o.customerPhone}</span> : null}
                </div>
              )}
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {o.items.map((item, i) => (
                  <span key={i}>{i > 0 && ', '}{item.itemName} ×{item.quantity}</span>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Payment Modal */}
      {showPayment && selectedOrder && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 24, width: 380, maxWidth: '90%' }}>
            <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16, textAlign: 'center' }}>📞 电话订单结账</h3>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 20, marginBottom: 16 }}>
              <span>{t('cashier.total')}</span>
              <span style={{ color: 'var(--red-primary)' }}>€{selectedTotal.toFixed(2)}</span>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
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
                payAmount={selectedTotal}
                phone={memberPhone}
                setPhone={setMemberPhone}
                preview={memberPreview}
                setPreview={setMemberPreview}
              />
            ) : null}

            {paymentMethod === 'cash' && (
              <div style={{ padding: 10, background: 'var(--bg)', borderRadius: 8, marginBottom: 12 }}>
                <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>{t('cashier.cashReceived')}</label>
                <input className="input" type="number" step="0.01" value={cashReceived} onChange={e => setCashReceived(e.target.value)}
                  style={{ width: '100%', fontSize: 18, fontWeight: 700, padding: '8px 10px', textAlign: 'right' }} />
                {cashReceivedNum > 0 && (
                  <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', padding: '6px 10px', borderRadius: 6, background: cashReceivedNum >= selectedTotal ? '#E8F5E9' : '#FFEBEE' }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{t('cashier.change')}</span>
                    <span style={{ fontSize: 18, fontWeight: 700, color: cashReceivedNum >= selectedTotal ? 'var(--green)' : 'var(--red-primary)' }}>€{changeAmount.toFixed(2)}</span>
                  </div>
                )}
              </div>
            )}

            {paymentMethod === 'mixed' && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <input className="input" placeholder={t('cashier.cashAmount')} value={mixedCash} onChange={e => setMixedCash(e.target.value)} type="number" />
                <input className="input" placeholder={t('cashier.cardAmount')} value={mixedCard} onChange={e => setMixedCard(e.target.value)} type="number" />
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-outline" style={{ flex: 1 }} onClick={() => setShowPayment(false)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={handlePay}
                disabled={
                  paying ||
                  (paymentMethod === 'cash' && cashReceivedNum < selectedTotal) ||
                  (paymentMethod === 'member' && !canMemberFullWalletPay(memberPreview, selectedTotal))
                }>
                {paying ? t('common.loading') : t('cashier.submitCheckout')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
