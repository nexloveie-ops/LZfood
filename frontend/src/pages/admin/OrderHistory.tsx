import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../../api/client';

interface OrderItem { _id: string; quantity: number; unitPrice: number; itemName: string; }
interface HistoryOrder {
  _id: string; type: string; tableNumber?: number; seatNumber?: number;
  dailyOrderNumber?: number; dineInOrderNumber?: string; status: string;
  items: OrderItem[]; createdAt: string;
  checkout?: { totalAmount: number; paymentMethod: string } | null;
}
export default function OrderHistory() {
  const { t } = useTranslation();
  const [orders, setOrders] = useState<HistoryOrder[]>([]);
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [typeFilter, setTypeFilter] = useState('');
  const [loading, setLoading] = useState(false);

  // Password protection
  const [unlocked, setUnlocked] = useState(false);
  const [pwdInput, setPwdInput] = useState('');
  const [pwdError, setPwdError] = useState(false);

  const checkPassword = () => {
    const now = new Date();
    const expected = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
    if (pwdInput === expected) {
      setUnlocked(true);
      setPwdError(false);
    } else {
      setPwdError(true);
    }
  };

  const fetchOrders = useCallback(async () => {
    if (!startDate || !endDate) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('startDate', startDate);
      params.set('endDate', endDate);
      params.set('includeHiddenOrders', '1');
      if (typeFilter) params.set('paymentMethod', typeFilter);
      const res = await apiFetch(`/api/reports/orders?${params}`);
      if (res.ok) {
        const data: HistoryOrder[] = await res.json();
        // includeHiddenOrders=1：订单历史含 hide；营业报表钻取默认不含 hide。
        setOrders(data);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [startDate, endDate, typeFilter]);

  const toggleHide = useCallback(async (orderId: string) => {
    try {
      const res = await apiFetch(`/api/orders/${orderId}/toggle-hide`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) {
        const updated: HistoryOrder = await res.json();
        setOrders(prev => prev.map(o => o._id === orderId ? { ...o, status: updated.status } : o));
      }
    } catch { /* ignore */ }
  }, []);

  const orderTotal = (o: HistoryOrder) => o.checkout?.totalAmount ?? o.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);

  // Password gate
  if (!unlocked) {
    return (
      <div>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>{t('admin.orderHistory')}</h2>
        <div className="card" style={{ padding: 40, maxWidth: 360, margin: '40px auto', textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🔒</div>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 16 }}>请输入访问密码</p>
          <input
            className="input"
            type="password"
            maxLength={4}
            value={pwdInput}
            onChange={e => { setPwdInput(e.target.value.replace(/\D/g, '').slice(0, 4)); setPwdError(false); }}
            onKeyDown={e => e.key === 'Enter' && checkPassword()}
            placeholder=""
            style={{ width: 120, fontSize: 24, textAlign: 'center', letterSpacing: 8, fontFamily: 'monospace' }}
          />
          {pwdError && <div style={{ color: 'var(--red-primary)', fontSize: 13, marginTop: 8 }}>密码错误</div>}
          <div style={{ marginTop: 16 }}>
            <button className="btn btn-primary" onClick={checkPassword} style={{ padding: '8px 24px' }}>
              {t('common.confirm')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>{t('admin.orderHistory')}</h2>

      {/* Filters */}
      <div className="card" style={{ padding: 16, marginBottom: 16, display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>开始日期 *</label>
          <input className="input" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>结束日期 *</label>
          <input className="input" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>支付方式</label>
          <select className="input" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">全部</option>
            <option value="card">刷卡</option>
            <option value="cash">现金</option>
            <option value="member">会员</option>
          </select>
        </div>
        <button className="btn btn-primary" onClick={fetchOrders} disabled={loading || !startDate || !endDate}>
          {loading ? t('common.loading') : t('common.search')}
        </button>
        {(!startDate || !endDate) && (
          <span style={{ fontSize: 12, color: 'var(--text-light)' }}>请选择日期范围</span>
        )}
      </div>

      {/* Results */}
      {orders.length > 0 && (
        <div className="card" style={{ overflow: 'auto' }}>
          <div style={{ padding: '10px 12px', fontSize: 13, color: 'var(--text-secondary)' }}>
            共 {orders.length} 条记录
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 600 }}>
            <thead>
              <tr style={{ background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
                <th style={{ padding: '10px 12px', textAlign: 'left' }}>订单号</th>
                <th style={{ padding: '10px 12px', textAlign: 'left' }}>类型</th>
                <th style={{ padding: '10px 12px', textAlign: 'left' }}>菜品</th>
                <th style={{ padding: '10px 12px', textAlign: 'right' }}>金额</th>
                <th style={{ padding: '10px 12px', textAlign: 'left' }}>支付</th>
                <th style={{ padding: '10px 12px', textAlign: 'left' }}>时间</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(o => {
                const orderNum = o.dineInOrderNumber
                  || (o.dailyOrderNumber ? `#${o.dailyOrderNumber}` : o._id.slice(-6).toUpperCase());
                const isHidden = o.status === 'completed-hide' || o.status === 'checked_out-hide';
                const canToggleHide =
                  o.checkout?.paymentMethod === 'cash' || o.checkout?.paymentMethod === 'member';
                return (
                  <tr
                    key={o._id}
                    style={{
                      borderBottom: '1px solid #f0f0f0',
                      background: isHidden ? '#FFFDE7' : undefined,
                      cursor: canToggleHide ? 'pointer' : undefined,
                    }}
                    onClick={canToggleHide ? () => toggleHide(o._id) : undefined}
                    title={canToggleHide ? (isHidden ? '点击恢复显示' : '点击隐藏') : undefined}
                  >
                    <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontWeight: 600 }}>{orderNum}</td>
                    <td style={{ padding: '8px 12px' }}>
                      <span className="badge" style={{
                        background: o.type === 'dine_in' ? 'var(--red-light)' : '#E3F2FD',
                        color: o.type === 'dine_in' ? 'var(--red-primary)' : 'var(--blue)',
                      }}>{o.type === 'dine_in' ? '堂食' : o.type === 'phone' ? '电话' : '外卖'}</span>
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-secondary)', maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {o.items.map(i => `${i.itemName}×${i.quantity}`).join(', ')}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, color: 'var(--red-primary)' }}>€{orderTotal(o).toFixed(2)}</td>
                    <td style={{ padding: '8px 12px', fontSize: 12 }}>{o.checkout?.paymentMethod || '-'}</td>
                    <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-light)' }}>{new Date(o.createdAt).toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
