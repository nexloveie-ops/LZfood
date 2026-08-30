import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../api/client';

interface CustomerRow {
  phoneNorm: string;
  customerName: string;
  customerPhone: string;
  email: string;
  deliveryAddress: string;
  postalCode: string;
  orderCount: number;
  totalSpentEuro: number;
  lastOrderAt: string | null;
}

interface OrderRow {
  orderId: string;
  createdAt: string;
  status: string;
  dailyOrderNumber?: number;
  customerName: string;
  deliveryAddress: string;
  postalCode: string;
  totalSpentEuro: number;
  paymentMethod?: string;
  items: {
    itemName: string;
    itemNameEn?: string;
    quantity: number;
    unitPrice: number;
    refunded?: boolean;
    lineKind?: string;
  }[];
}

function fmtEuro(n: number): string {
  return `€${n.toFixed(2)}`;
}

function fmtDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function orderLabel(o: OrderRow): string {
  if (o.dailyOrderNumber) return `#${o.dailyOrderNumber}`;
  return o.orderId.slice(-6).toUpperCase();
}

type SortKey =
  | 'customerName'
  | 'customerPhone'
  | 'email'
  | 'deliveryAddress'
  | 'orderCount'
  | 'totalSpentEuro'
  | 'lastOrderAt';

type SortDir = 'asc' | 'desc';

function sortValue(row: CustomerRow, key: SortKey): string | number {
  switch (key) {
    case 'customerName':
      return (row.customerName || '').toLowerCase();
    case 'customerPhone':
      return row.customerPhone;
    case 'email':
      return (row.email || '').toLowerCase();
    case 'deliveryAddress':
      return `${row.deliveryAddress || ''} ${row.postalCode || ''}`.trim().toLowerCase();
    case 'orderCount':
      return row.orderCount;
    case 'totalSpentEuro':
      return row.totalSpentEuro;
    case 'lastOrderAt':
      return row.lastOrderAt ? new Date(row.lastOrderAt).getTime() : 0;
  }
}

function compareRows(a: CustomerRow, b: CustomerRow, key: SortKey, dir: SortDir): number {
  const av = sortValue(a, key);
  const bv = sortValue(b, key);
  let cmp = 0;
  if (typeof av === 'number' && typeof bv === 'number') {
    cmp = av - bv;
  } else {
    cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
  }
  return dir === 'asc' ? cmp : -cmp;
}

const SORT_COLUMNS: { key: SortKey; labelKey: string }[] = [
  { key: 'customerName', labelKey: 'admin.deliveryCustomersName' },
  { key: 'customerPhone', labelKey: 'admin.deliveryCustomersPhone' },
  { key: 'email', labelKey: 'admin.deliveryCustomersEmail' },
  { key: 'deliveryAddress', labelKey: 'admin.deliveryCustomersAddress' },
  { key: 'orderCount', labelKey: 'admin.deliveryCustomersOrders' },
  { key: 'totalSpentEuro', labelKey: 'admin.deliveryCustomersSpent' },
  { key: 'lastOrderAt', labelKey: 'admin.deliveryCustomersLastOrder' },
];

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

function customerMatchesSearch(row: CustomerRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const qDigits = digitsOnly(q);
  const haystacks = [
    row.customerName,
    row.customerPhone,
    row.email,
    row.deliveryAddress,
    row.postalCode,
    `${row.deliveryAddress} ${row.postalCode}`.trim(),
  ].map((s) => (s || '').toLowerCase());

  if (haystacks.some((h) => h.includes(q))) return true;
  if (qDigits.length >= 3) {
    const phoneDigits = digitsOnly(row.customerPhone);
    if (phoneDigits.includes(qDigits)) return true;
  }
  return false;
}

export default function DeliveryCustomerPanel() {
  const { t } = useTranslation();
  const { token, user } = useAuth();
  const canEdit = user?.role === 'owner';
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<CustomerRow | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('totalSpentEuro');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [searchQuery, setSearchQuery] = useState('');
  const [editing, setEditing] = useState<CustomerRow | null>(null);
  const [editForm, setEditForm] = useState({
    customerName: '',
    deliveryAddress: '',
    postalCode: '',
    email: '',
  });
  const [editSaving, setEditSaving] = useState(false);

  const filteredCustomers = useMemo(
    () => customers.filter((c) => customerMatchesSearch(c, searchQuery)),
    [customers, searchQuery],
  );

  const sortedCustomers = useMemo(
    () => [...filteredCustomers].sort((a, b) => compareRows(a, b, sortKey, sortDir)),
    [filteredCustomers, sortKey, sortDir],
  );

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'orderCount' || key === 'totalSpentEuro' || key === 'lastOrderAt' ? 'desc' : 'asc');
    }
  };

  const loadCustomers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/admin/delivery-customers', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error?.message || j.message || '加载失败');
      setCustomers(j.customers || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadCustomers();
  }, [loadCustomers]);

  const openCustomer = async (row: CustomerRow) => {
    setSelected(row);
    setOrders([]);
    setExpandedOrderId(null);
    setOrdersLoading(true);
    try {
      const res = await apiFetch(
        `/api/admin/delivery-customers/orders?phone=${encodeURIComponent(row.phoneNorm)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const j = await res.json();
      if (!res.ok) throw new Error(j.error?.message || j.message || '加载失败');
      setOrders(j.orders || []);
    } catch (e) {
      alert(e instanceof Error ? e.message : '加载失败');
      setSelected(null);
    } finally {
      setOrdersLoading(false);
    }
  };

  const openEdit = (row: CustomerRow, e: MouseEvent) => {
    e.stopPropagation();
    setEditing(row);
    setEditForm({
      customerName: row.customerName || '',
      deliveryAddress: row.deliveryAddress || '',
      postalCode: row.postalCode || '',
      email: row.email || '',
    });
  };

  const saveEdit = async () => {
    if (!editing) return;
    setEditSaving(true);
    try {
      const res = await apiFetch('/api/admin/delivery-customers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          phone: editing.phoneNorm,
          customerName: editForm.customerName.trim(),
          deliveryAddress: editForm.deliveryAddress.trim(),
          postalCode: editForm.postalCode.trim(),
          email: editForm.email.trim(),
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error?.message || j.message || '保存失败');
      setEditing(null);
      await loadCustomers();
    } catch (err) {
      alert(err instanceof Error ? err.message : '保存失败');
    } finally {
      setEditSaving(false);
    }
  };

  return (
    <div>
      <p className="dm-section-sub">{t('admin.deliveryCustomersIntro')}</p>
      {error ? <div className="dm-error">{error}</div> : null}
      {loading ? (
        <div className="dm-muted">{t('common.loading')}</div>
      ) : customers.length === 0 ? (
        <div className="dm-empty card">{t('admin.deliveryCustomersEmpty')}</div>
      ) : (
        <>
        <div className="dm-search-bar card">
          <label className="dm-search-field">
            <span className="dm-search-label">{t('admin.deliveryCustomersSearch')}</span>
            <input
              type="search"
              className="input dm-search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('admin.deliveryCustomersSearchPh')}
            />
          </label>
          {searchQuery.trim() ? (
            <span className="dm-search-count">
              {t('admin.deliveryCustomersSearchCount', {
                count: sortedCustomers.length,
                total: customers.length,
              })}
            </span>
          ) : null}
        </div>
        {sortedCustomers.length === 0 ? (
          <div className="dm-empty card">{t('admin.deliveryCustomersSearchEmpty')}</div>
        ) : (
        <div className="card dm-table-wrap">
          <table className="dm-table">
            <thead>
              <tr>
                {SORT_COLUMNS.map(({ key, labelKey }) => (
                  <th key={key}>
                    <button
                      type="button"
                      className={`dm-th-sort${sortKey === key ? ' is-active' : ''}`}
                      onClick={() => toggleSort(key)}
                    >
                      {t(labelKey)}
                      <span className="dm-th-sort-icon" aria-hidden>
                        {sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ⇅'}
                      </span>
                    </button>
                  </th>
                ))}
                {canEdit ? <th className="dm-th-actions">{t('admin.deliveryCustomersActions')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {sortedCustomers.map((c) => (
                <tr key={c.phoneNorm} className="dm-row-click" onClick={() => void openCustomer(c)}>
                  <td>{c.customerName || '—'}</td>
                  <td>{c.customerPhone}</td>
                  <td>{c.email || '—'}</td>
                  <td>
                    <div>{c.deliveryAddress || '—'}</div>
                    {c.postalCode ? <div className="dm-muted-inline">{c.postalCode}</div> : null}
                  </td>
                  <td>{c.orderCount}</td>
                  <td>{fmtEuro(c.totalSpentEuro)}</td>
                  <td>{fmtDate(c.lastOrderAt || '')}</td>
                  {canEdit ? (
                    <td className="dm-actions-cell">
                      <button
                        type="button"
                        className="btn btn-outline dm-edit-btn"
                        onClick={(e) => openEdit(c, e)}
                      >
                        {t('admin.deliveryCustomersEditBtn')}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
        </>
      )}

      {editing && (
        <div className="dm-modal-backdrop" onClick={() => !editSaving && setEditing(null)} role="presentation">
          <div className="card dm-modal dm-edit-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="dm-modal-head">
              <div>
                <h3 className="dm-modal-title">{t('admin.deliveryCustomersEditTitle')}</h3>
                <p className="dm-modal-sub">{t('admin.deliveryCustomersEditHint')}</p>
              </div>
              <button type="button" className="btn btn-outline" disabled={editSaving} onClick={() => setEditing(null)}>
                {t('common.close', '关闭')}
              </button>
            </div>
            <div className="dm-edit-form">
              <label className="dm-edit-field">
                <span>{t('admin.deliveryCustomersPhone')}</span>
                <input className="input" value={editing.customerPhone} disabled readOnly />
              </label>
              <label className="dm-edit-field">
                <span>{t('admin.deliveryCustomersName')}</span>
                <input
                  className="input"
                  value={editForm.customerName}
                  onChange={(e) => setEditForm((f) => ({ ...f, customerName: e.target.value }))}
                />
              </label>
              <label className="dm-edit-field">
                <span>{t('admin.deliveryCustomersEmail')}</span>
                <input
                  className="input"
                  type="email"
                  value={editForm.email}
                  onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder={t('admin.deliveryCustomersEmailOptional')}
                />
              </label>
              <label className="dm-edit-field">
                <span>{t('admin.deliveryCustomersAddress')}</span>
                <input
                  className="input"
                  value={editForm.deliveryAddress}
                  onChange={(e) => setEditForm((f) => ({ ...f, deliveryAddress: e.target.value }))}
                />
              </label>
              <label className="dm-edit-field">
                <span>Eircode</span>
                <input
                  className="input"
                  value={editForm.postalCode}
                  onChange={(e) => setEditForm((f) => ({ ...f, postalCode: e.target.value }))}
                />
              </label>
            </div>
            <div className="dm-edit-actions">
              <button type="button" className="btn btn-outline" disabled={editSaving} onClick={() => setEditing(null)}>
                {t('common.cancel', '取消')}
              </button>
              <button type="button" className="btn btn-primary" disabled={editSaving} onClick={() => void saveEdit()}>
                {editSaving ? t('common.loading') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {selected && (
        <div className="dm-modal-backdrop" onClick={() => setSelected(null)} role="presentation">
          <div className="card dm-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="dm-modal-head">
              <div>
                <h3 className="dm-modal-title">{selected.customerName || selected.customerPhone}</h3>
                <p className="dm-modal-sub">
                  {selected.customerPhone}
                  {selected.deliveryAddress ? ` · ${selected.deliveryAddress}` : ''}
                  {selected.postalCode ? ` · ${selected.postalCode}` : ''}
                </p>
              </div>
              <button type="button" className="btn btn-outline" onClick={() => setSelected(null)}>
                {t('common.close', '关闭')}
              </button>
            </div>
            <div className="dm-modal-stats">
              <span>{t('admin.deliveryCustomersOrders')}: <strong>{selected.orderCount}</strong></span>
              <span>{t('admin.deliveryCustomersSpent')}: <strong>{fmtEuro(selected.totalSpentEuro)}</strong></span>
            </div>
            {ordersLoading ? (
              <div className="dm-muted">{t('common.loading')}</div>
            ) : orders.length === 0 ? (
              <div className="dm-muted">{t('admin.deliveryCustomersNoOrders')}</div>
            ) : (
              <div className="dm-order-list">
                {orders.map((o) => {
                  const open = expandedOrderId === o.orderId;
                  return (
                    <div key={o.orderId} className="dm-order-card">
                      <button
                        type="button"
                        className="dm-order-head"
                        onClick={() => setExpandedOrderId(open ? null : o.orderId)}
                      >
                        <span>
                          <strong>{orderLabel(o)}</strong>
                          <span className="dm-muted-inline"> · {fmtDate(o.createdAt)}</span>
                        </span>
                        <span>{fmtEuro(o.totalSpentEuro)}{open ? ' ▲' : ' ▼'}</span>
                      </button>
                      {open && (
                        <div className="dm-order-body">
                          <div className="dm-order-meta">
                            <span>{t('admin.deliveryCustomersStatus')}: {o.status}</span>
                            {o.paymentMethod ? (
                              <span>{t('admin.deliveryCustomersPayment')}: {o.paymentMethod}</span>
                            ) : null}
                          </div>
                          <ul className="dm-order-items">
                            {o.items.filter((it) => !it.refunded).map((it, idx) => (
                              <li key={`${o.orderId}-${idx}`}>
                                {it.quantity}× {it.itemName}
                                {it.lineKind === 'delivery_fee' ? ` (${t('cashier.deliveryFee')})` : ''}
                                {' '}
                                <span className="dm-muted-inline">{fmtEuro(it.unitPrice * it.quantity)}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
