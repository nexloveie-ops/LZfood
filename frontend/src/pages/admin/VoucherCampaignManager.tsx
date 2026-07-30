import { useState, useEffect, useCallback, useMemo, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';

type CampaignRow = {
  _id: string;
  campaignCode: string;
  name: string;
  nameEn?: string;
  discountType: string;
  discountValue: number;
  serialFrom: number;
  serialTo: number;
  startsAt: string;
  endsAt: string;
  active: boolean;
  totalVouchers: number;
  usedCount: number;
  unusedCount: number;
  expiredCount: number;
  voidCount: number;
};

type VoucherLinkedOrder = {
  _id: string;
  type?: string;
  dailyOrderNumber?: number;
  dineInOrderNumber?: string;
  tableNumber?: number;
  seatNumber?: number;
  status?: string;
  createdAt?: string;
  customerName?: string;
};

type VoucherLinkedCheckout = {
  totalAmount?: number;
  paymentMethod?: string;
  voucherDiscountEuro?: number;
  checkedOutAt?: string;
};

type VoucherRow = {
  _id: string;
  code: string;
  serialNumber: number;
  status: string;
  redeemedAt?: string;
  orderId?: string;
  order?: VoucherLinkedOrder | null;
  checkout?: VoucherLinkedCheckout | null;
};

type OrderDetailItem = {
  _id?: string;
  itemName: string;
  itemNameEn?: string;
  quantity: number;
  unitPrice: number;
  lineKind?: string;
};

type OrderDetailDoc = VoucherLinkedOrder & {
  items?: OrderDetailItem[];
  customerPhone?: string;
  deliveryAddress?: string;
};

const thStyle: CSSProperties = {
  padding: '10px 12px',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--text-secondary)',
  whiteSpace: 'nowrap',
  verticalAlign: 'middle',
};

const tdStyle: CSSProperties = {
  padding: '10px 12px',
  verticalAlign: 'middle',
  fontSize: 13,
  lineHeight: '20px',
  color: 'var(--text-primary, #222)',
};

const monoCellStyle: CSSProperties = {
  ...tdStyle,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
};

const mutedDashStyle: CSSProperties = {
  color: 'var(--text-light)',
  fontWeight: 400,
  fontFamily: 'inherit',
};

function formatOrderNumber(o: VoucherLinkedOrder): string {
  if (o.dineInOrderNumber?.trim()) return o.dineInOrderNumber.trim();
  if (o.dailyOrderNumber != null && Number.isFinite(o.dailyOrderNumber)) return `#${o.dailyOrderNumber}`;
  return o._id.slice(-6).toUpperCase();
}

const labelStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--text-light)',
  display: 'block',
  marginBottom: 4,
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: 'var(--text-light)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  marginBottom: 10,
  marginTop: 4,
};

const formGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
  gap: 12,
};

function VoucherStatusPill({ status, label }: { status: string; label: string }) {
  const tone =
    status === 'unused'
      ? { bg: 'rgba(33, 150, 243, 0.12)', color: '#1565C0' }
      : status === 'used'
        ? { bg: 'rgba(76, 175, 80, 0.15)', color: '#2E7D32' }
        : status === 'void'
          ? { bg: 'rgba(244, 67, 54, 0.12)', color: '#C62828' }
          : { bg: 'rgba(158, 158, 158, 0.2)', color: '#616161' };
  return (
    <span
      style={{
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 999,
        fontWeight: 600,
        background: tone.bg,
        color: tone.color,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

function StatusPill({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        padding: '2px 8px',
        borderRadius: 999,
        fontWeight: 600,
        background: active ? 'rgba(76, 175, 80, 0.15)' : 'rgba(158, 158, 158, 0.2)',
        color: active ? '#2E7D32' : '#757575',
      }}
    >
      {label}
    </span>
  );
}

export default function VoucherCampaignManager() {
  const { t } = useTranslation();
  const { token } = useAuth();
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const nv = (key: string) => t(`admin.numberedVoucher.${key}`);

  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailCampaign, setDetailCampaign] = useState<CampaignRow | null>(null);
  const [detailVouchers, setDetailVouchers] = useState<VoucherRow[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [voucherStatusFilter, setVoucherStatusFilter] = useState('');

  const [orderModalVoucher, setOrderModalVoucher] = useState<VoucherRow | null>(null);
  const [orderModalDetail, setOrderModalDetail] = useState<OrderDetailDoc | null>(null);
  const [orderModalLoading, setOrderModalLoading] = useState(false);
  const [orderModalError, setOrderModalError] = useState('');

  const [campaignCode, setCampaignCode] = useState('');
  const [name, setName] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [discountType, setDiscountType] = useState<'fixed' | 'percent' | 'free_order'>('fixed');
  const [discountValue, setDiscountValue] = useState('');
  const [serialFrom, setSerialFrom] = useState('1');
  const [serialTo, setSerialTo] = useState('100');
  const [endsAt, setEndsAt] = useState('');

  const serialPreview = useMemo(() => {
    const from = parseInt(serialFrom, 10);
    const to = parseInt(serialTo, 10);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
    return { from, to, count: to - from + 1 };
  }, [serialFrom, serialTo]);

  const formatDiscountShort = (c: { discountType: string; discountValue: number }) => {
    if (c.discountType === 'free_order') return nv('discountFreeShort');
    if (c.discountType === 'percent') return t('admin.numberedVoucher.discountPercentShort', { value: c.discountValue });
    return t('admin.numberedVoucher.discountFixedShort', { value: c.discountValue });
  };

  const formatDiscountDetail = (c: { discountType: string; discountValue: number }) => {
    if (c.discountType === 'free_order') return nv('discountFreeDetail');
    if (c.discountType === 'percent') return t('admin.numberedVoucher.discountPercentShort', { value: c.discountValue });
    return t('admin.numberedVoucher.discountFixedShort', { value: c.discountValue });
  };

  const statusLabel = (status: string) =>
    t(`admin.numberedVoucher.status.${status}`, { defaultValue: status });

  const fetchCampaigns = useCallback(async () => {
    const res = await apiFetch('/api/voucher-campaigns', { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) setCampaigns(await res.json());
  }, [token]);

  useEffect(() => {
    void fetchCampaigns();
  }, [fetchCampaigns]);

  const orderTypeLabel = (type?: string) => {
    switch (type) {
      case 'dine_in':
        return t('cashier.orderTypeDineIn');
      case 'takeout':
        return t('cashier.orderTypeTakeout');
      case 'phone':
        return t('cashier.orderTypePhone');
      case 'delivery':
        return t('cashier.orderTypeDelivery');
      default:
        return type || '—';
    }
  };

  const orderStatusLabel = (status?: string) => {
    if (!status) return '—';
    return t(`admin.numberedVoucher.orderStatus.${status}`, { defaultValue: status });
  };

  const loadDetailVouchers = useCallback(
    async (id: string, statusFilter: string) => {
      setDetailLoading(true);
      try {
        const q = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
        const res = await apiFetch(`/api/voucher-campaigns/${id}/vouchers${q}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const d = await res.json();
          setDetailCampaign(d.campaign);
          setDetailVouchers(d.vouchers || []);
        }
      } finally {
        setDetailLoading(false);
      }
    },
    [token],
  );

  const openDetail = async (id: string) => {
    setDetailId(id);
    setVoucherStatusFilter('');
    setDetailCampaign(null);
    setDetailVouchers([]);
    await loadDetailVouchers(id, '');
  };

  const closeOrderModal = () => {
    setOrderModalVoucher(null);
    setOrderModalDetail(null);
    setOrderModalError('');
    setOrderModalLoading(false);
  };

  const openOrderModal = async (v: VoucherRow) => {
    if (!v.order && !v.orderId) return;
    setOrderModalVoucher(v);
    setOrderModalDetail(v.order ? { ...v.order } : null);
    setOrderModalError('');
    setOrderModalLoading(true);
    try {
      const oid = v.order?._id || v.orderId;
      if (!oid) {
        setOrderModalError(nv('orderLoadFailed'));
        return;
      }
      const res = await apiFetch(`/api/orders/${oid}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setOrderModalError(d?.error?.message || nv('orderLoadFailed'));
        return;
      }
      setOrderModalDetail(await res.json());
    } catch {
      setOrderModalError(nv('orderLoadFailed'));
    } finally {
      setOrderModalLoading(false);
    }
  };

  const resetForm = () => {
    setCampaignCode('');
    setName('');
    setNameEn('');
    setDiscountType('fixed');
    setDiscountValue('');
    setSerialFrom('1');
    setSerialTo('100');
    setEndsAt('');
  };

  const handleCreate = async () => {
    const body = {
      campaignCode: campaignCode.trim(),
      name: name.trim(),
      nameEn: nameEn.trim(),
      discountType,
      discountValue: discountType === 'free_order' ? 0 : parseFloat(discountValue),
      serialFrom: parseInt(serialFrom, 10),
      serialTo: parseInt(serialTo, 10),
      endsAt: endsAt ? new Date(endsAt).toISOString() : undefined,
    };
    const res = await apiFetch('/api/voucher-campaigns', { method: 'POST', headers, body: JSON.stringify(body) });
    if (res.ok) {
      setShowForm(false);
      resetForm();
      void fetchCampaigns();
    } else {
      const d = await res.json().catch(() => null);
      alert(d?.error?.message || nv('createFailed'));
    }
  };

  const toggleActive = async (c: CampaignRow) => {
    await apiFetch(`/api/voucher-campaigns/${c._id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ active: !c.active }),
    });
    void fetchCampaigns();
  };

  const voidVoucher = async (voucherId: string) => {
    if (!detailId || !confirm(nv('voidConfirm'))) return;
    const res = await apiFetch(`/api/voucher-campaigns/${detailId}/vouchers/${voucherId}/void`, { method: 'PATCH', headers });
    if (res.ok) void loadDetailVouchers(detailId, voucherStatusFilter);
    else {
      const d = await res.json().catch(() => null);
      alert(d?.error?.message || nv('actionFailed'));
    }
  };

  const exportCsv = async (id: string, code: string) => {
    const res = await apiFetch(`/api/voucher-campaigns/${id}/export.csv`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      alert(nv('exportFailed'));
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${code}-vouchers.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (detailId) {
    return (
      <div>
        <button
          type="button"
          className="btn btn-outline"
          style={{ marginBottom: 16 }}
          onClick={() => {
            setDetailId(null);
            setDetailCampaign(null);
            setDetailVouchers([]);
          }}
        >
          ← {nv('backToList')}
        </button>

        {detailLoading && !detailCampaign ? (
          <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-light)' }}>
            {nv('loading')}
          </div>
        ) : detailCampaign ? (
          <>
            <div className="card" style={{ padding: 16, marginBottom: 16 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0, flex: '1 1 240px' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span
                      style={{
                        fontFamily: 'ui-monospace, monospace',
                        fontSize: 13,
                        fontWeight: 700,
                        padding: '4px 10px',
                        borderRadius: 6,
                        background: 'var(--bg-secondary, #f5f5f5)',
                      }}
                    >
                      {detailCampaign.campaignCode}
                    </span>
                    <StatusPill active={detailCampaign.active} label={detailCampaign.active ? nv('active') : nv('inactive')} />
                  </div>
                  <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
                    {detailCampaign.name}
                    {detailCampaign.nameEn ? (
                      <span style={{ fontWeight: 500, color: 'var(--text-light)', marginLeft: 8, fontSize: 15 }}>
                        {detailCampaign.nameEn}
                      </span>
                    ) : null}
                  </h3>
                  <p style={{ fontSize: 13, color: 'var(--text-light)', margin: '8px 0 0' }}>
                    {formatDiscountDetail(detailCampaign)}
                  </p>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 13, color: 'var(--text-light)' }}>
                    {t('admin.numberedVoucher.usageStats', {
                      unused: detailCampaign.unusedCount,
                      used: detailCampaign.usedCount,
                    })}
                  </span>
                  <button
                    type="button"
                    className="btn btn-outline"
                    style={{ fontSize: 13 }}
                    onClick={() => void exportCsv(detailId, detailCampaign.campaignCode)}
                  >
                    {nv('exportCsv')}
                  </button>
                </div>
              </div>
            </div>

            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div
                style={{
                  padding: '12px 16px',
                  borderBottom: '1px solid var(--border-light, #eee)',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 12,
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 14 }}>
                  {nv('voucherListTitle')}
                  <span style={{ fontWeight: 500, color: 'var(--text-light)', marginLeft: 8 }}>
                    ({detailVouchers.length})
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {(['', 'unused', 'used', 'expired', 'void'] as const).map((s) => (
                    <button
                      key={s || 'all'}
                      type="button"
                      className={voucherStatusFilter === s ? 'btn btn-primary' : 'btn btn-outline'}
                      style={{ fontSize: 12, padding: '4px 10px' }}
                      onClick={() => {
                        setVoucherStatusFilter(s);
                        void loadDetailVouchers(detailId, s);
                      }}
                    >
                      {s ? statusLabel(s) : nv('filterAll')}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ overflowX: 'auto', opacity: detailLoading ? 0.55 : 1, pointerEvents: detailLoading ? 'none' : undefined }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg, #fafafa)', borderBottom: '2px solid var(--border-light, #e8e8e8)' }}>
                      <th style={thStyle}>{nv('colSerial')}</th>
                      <th style={thStyle}>{nv('colCode')}</th>
                      <th style={thStyle}>{nv('colStatus')}</th>
                      <th style={thStyle}>{nv('colRedeemedAt')}</th>
                      <th style={{ ...thStyle, minWidth: 200 }}>{nv('linkedOrder')}</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>{nv('paymentAndPaid')}</th>
                      <th style={{ ...thStyle, width: 96 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {detailVouchers.map((v) => {
                      const order = v.order;
                      const checkout = v.checkout;
                      return (
                        <tr key={v._id} style={{ borderBottom: '1px solid var(--border-light, #f0f0f0)', height: 48 }}>
                          <td style={{ ...tdStyle, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                            {v.serialNumber}
                          </td>
                          <td style={monoCellStyle}>{v.code}</td>
                          <td style={tdStyle}>
                            <VoucherStatusPill status={v.status} label={statusLabel(v.status)} />
                          </td>
                          <td style={{ ...tdStyle, whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                            {v.redeemedAt ? new Date(v.redeemedAt).toLocaleString() : <span style={mutedDashStyle}>—</span>}
                          </td>
                          <td style={tdStyle}>
                            {order ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 20 }}>
                                <button
                                  type="button"
                                  onClick={() => void openOrderModal(v)}
                                  title={nv('viewOrder')}
                                  style={{
                                    ...monoCellStyle,
                                    padding: 0,
                                    margin: 0,
                                    border: 'none',
                                    background: 'none',
                                    cursor: 'pointer',
                                    color: 'var(--red-primary)',
                                    textDecoration: 'underline',
                                    textUnderlineOffset: 2,
                                    lineHeight: '20px',
                                  }}
                                >
                                  {formatOrderNumber(order)}
                                </button>
                                <span
                                  style={{
                                    fontSize: 11,
                                    lineHeight: '16px',
                                    fontWeight: 600,
                                    padding: '2px 6px',
                                    borderRadius: 4,
                                    whiteSpace: 'nowrap',
                                    background: order.type === 'dine_in' ? 'var(--red-light, #ffebee)' : '#E3F2FD',
                                    color: order.type === 'dine_in' ? 'var(--red-primary)' : 'var(--blue, #1976D2)',
                                  }}
                                >
                                  {orderTypeLabel(order.type)}
                                </span>
                              </div>
                            ) : v.orderId ? (
                              <button
                                type="button"
                                onClick={() => void openOrderModal(v)}
                                style={{
                                  ...monoCellStyle,
                                  padding: 0,
                                  margin: 0,
                                  border: 'none',
                                  background: 'none',
                                  cursor: 'pointer',
                                  color: 'var(--red-primary)',
                                  textDecoration: 'underline',
                                  textUnderlineOffset: 2,
                                  lineHeight: '20px',
                                }}
                              >
                                …{String(v.orderId).slice(-8)}
                              </button>
                            ) : (
                              <span style={mutedDashStyle}>—</span>
                            )}
                          </td>
                          <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {checkout?.paymentMethod || checkout?.totalAmount != null ? (
                              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, lineHeight: '18px' }}>
                                <span style={{ fontSize: 13, lineHeight: '18px', fontWeight: 500 }}>
                                  {checkout.paymentMethod || '—'}
                                </span>
                                <span style={{ fontSize: 13, lineHeight: '18px', fontWeight: 700, color: 'var(--red-primary)', fontVariantNumeric: 'tabular-nums' }}>
                                  {checkout.totalAmount != null ? `€${Number(checkout.totalAmount).toFixed(2)}` : '—'}
                                </span>
                              </div>
                            ) : (
                              <span style={mutedDashStyle}>—</span>
                            )}
                          </td>
                          <td style={{ ...tdStyle, textAlign: 'right', width: 88 }}>
                            {v.status === 'unused' ? (
                              <button
                                type="button"
                                className="btn btn-outline"
                                style={{ fontSize: 12, lineHeight: '18px', padding: '4px 10px', color: '#F44336', borderColor: '#F44336' }}
                                onClick={() => void voidVoucher(v._id)}
                              >
                                {nv('voidBtn')}
                              </button>
                            ) : (
                              <span style={mutedDashStyle}>—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {detailVouchers.length === 0 && !detailLoading ? (
                  <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-light)', fontSize: 13 }}>
                    {nv('filterEmpty')}
                  </div>
                ) : null}
              </div>
            </div>
          </>
        ) : null}

        {orderModalVoucher ? (
          <div
            role="dialog"
            aria-modal="true"
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.45)',
              zIndex: 2000,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 16,
            }}
            onClick={closeOrderModal}
          >
            <div
              className="card"
              style={{
                width: 560,
                maxWidth: '100%',
                maxHeight: '85vh',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                padding: 0,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                style={{
                  padding: '14px 16px',
                  borderBottom: '1px solid var(--border-light, #eee)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 12,
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{nv('orderModalTitle')}</div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
                    {nv('colCode')}:{' '}
                    <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 600 }}>{orderModalVoucher.code}</span>
                    {orderModalVoucher.redeemedAt
                      ? ` · ${nv('colRedeemedAt')}: ${new Date(orderModalVoucher.redeemedAt).toLocaleString()}`
                      : ''}
                  </div>
                </div>
                <button type="button" className="btn btn-outline" style={{ fontSize: 12 }} onClick={closeOrderModal}>
                  {nv('closeModal')}
                </button>
              </div>

              <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
                {orderModalLoading && !orderModalDetail ? (
                  <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-light)' }}>{nv('loading')}</div>
                ) : orderModalError && !orderModalDetail ? (
                  <div style={{ textAlign: 'center', padding: 24, color: '#C62828' }}>{orderModalError}</div>
                ) : orderModalDetail ? (
                  <>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
                        gap: 12,
                        marginBottom: 16,
                        fontSize: 13,
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text-light)', marginBottom: 2 }}>{nv('colOrder')}</div>
                        <div style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 700 }}>
                          {formatOrderNumber(orderModalDetail)}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text-light)', marginBottom: 2 }}>{nv('orderTypeLabel')}</div>
                        <div>{orderTypeLabel(orderModalDetail.type)}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text-light)', marginBottom: 2 }}>{nv('orderStatusLabel')}</div>
                        <div>{orderStatusLabel(orderModalDetail.status)}</div>
                      </div>
                      {orderModalDetail.type === 'dine_in' && orderModalDetail.tableNumber != null ? (
                        <div>
                          <div style={{ fontSize: 11, color: 'var(--text-light)', marginBottom: 2 }}>{t('cashier.table')}</div>
                          <div>
                            {orderModalDetail.tableNumber}
                            {orderModalDetail.seatNumber != null ? ` / ${t('cashier.seat')} ${orderModalDetail.seatNumber}` : ''}
                          </div>
                        </div>
                      ) : null}
                      {orderModalDetail.customerName?.trim() ? (
                        <div>
                          <div style={{ fontSize: 11, color: 'var(--text-light)', marginBottom: 2 }}>{nv('customerName')}</div>
                          <div>{orderModalDetail.customerName.trim()}</div>
                        </div>
                      ) : null}
                      {orderModalDetail.createdAt ? (
                        <div>
                          <div style={{ fontSize: 11, color: 'var(--text-light)', marginBottom: 2 }}>{nv('orderCreatedAt')}</div>
                          <div>{new Date(orderModalDetail.createdAt).toLocaleString()}</div>
                        </div>
                      ) : null}
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text-light)', marginBottom: 2 }}>{nv('orderTotalBeforeDiscount')}</div>
                        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--red-primary)' }}>
                          €{(() => {
                            const itemsSum = Array.isArray(orderModalDetail.items)
                              ? orderModalDetail.items.reduce((s, i) => s + Number(i.unitPrice) * Number(i.quantity), 0)
                              : 0;
                            if (itemsSum > 0) return itemsSum.toFixed(2);
                            const paid = Number(orderModalVoucher.checkout?.totalAmount) || 0;
                            const disc = Number(orderModalVoucher.checkout?.voucherDiscountEuro) || 0;
                            return (paid + disc).toFixed(2);
                          })()}
                        </div>
                      </div>
                    </div>

                    {orderModalVoucher.checkout ? (
                      <div
                        style={{
                          padding: 12,
                          borderRadius: 8,
                          background: 'var(--bg-secondary, #f7f7f7)',
                          marginBottom: 16,
                          fontSize: 13,
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '8px 16px',
                        }}
                      >
                        {orderModalVoucher.checkout.paymentMethod ? (
                          <span>
                            {nv('paymentMethod')}: {orderModalVoucher.checkout.paymentMethod}
                          </span>
                        ) : null}
                        {orderModalVoucher.checkout.voucherDiscountEuro != null
                        && orderModalVoucher.checkout.voucherDiscountEuro > 0 ? (
                          <span>
                            {nv('voucherDiscount')}: −€{Number(orderModalVoucher.checkout.voucherDiscountEuro).toFixed(2)}
                          </span>
                        ) : null}
                      </div>
                    ) : null}

                    {orderModalError ? (
                      <div style={{ fontSize: 12, color: '#C62828', marginBottom: 8 }}>{orderModalError}</div>
                    ) : null}

                    <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>{nv('orderItems')}</div>
                    {orderModalLoading ? (
                      <div style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 8 }}>{nv('loading')}</div>
                    ) : null}
                    {Array.isArray(orderModalDetail.items) && orderModalDetail.items.length > 0 ? (
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border-light, #eee)' }}>
                            <th style={{ ...thStyle, padding: '8px 0' }}>{nv('itemName')}</th>
                            <th style={{ ...thStyle, padding: '8px 8px', textAlign: 'right' }}>{nv('itemQty')}</th>
                            <th style={{ ...thStyle, padding: '8px 0', textAlign: 'right' }}>{nv('itemAmount')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {orderModalDetail.items.map((item, idx) => (
                            <tr key={item._id || idx} style={{ borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>
                              <td style={{ padding: '8px 0' }}>
                                {item.itemName}
                                {item.lineKind === 'delivery_fee' ? (
                                  <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-light)' }}>
                                    ({nv('deliveryFee')})
                                  </span>
                                ) : null}
                              </td>
                              <td style={{ padding: '8px 8px', textAlign: 'right', color: 'var(--text-secondary)' }}>
                                ×{item.quantity}
                              </td>
                              <td style={{ padding: '8px 0', textAlign: 'right', fontWeight: 600 }}>
                                €{(item.unitPrice * item.quantity).toFixed(2)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div style={{ fontSize: 13, color: 'var(--text-light)' }}>{nv('noOrderItems')}</div>
                    )}
                  </>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>🎫 {nv('title')}</h2>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            resetForm();
            setShowForm(true);
          }}
        >
          + {nv('newCampaign')}
        </button>
      </div>

      {showForm && (
        <div className="card" style={{ padding: 20, marginBottom: 20 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 16px' }}>{nv('formTitle')}</h3>

          <p style={sectionTitleStyle}>{nv('sectionBasic')}</p>
          <div style={{ ...formGridStyle, marginBottom: 16 }}>
            <div>
              <label style={labelStyle}>{nv('campaignCodeLabel')}</label>
              <input
                className="input"
                value={campaignCode}
                onChange={(e) => setCampaignCode(e.target.value.toUpperCase())}
                placeholder="OPENING"
              />
            </div>
            <div>
              <label style={labelStyle}>{nv('nameLabel')}</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>{nv('nameEnLabel')}</label>
              <input className="input" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
            </div>
          </div>

          <p style={sectionTitleStyle}>{nv('sectionDiscount')}</p>
          <div style={{ ...formGridStyle, marginBottom: 16 }}>
            <div>
              <label style={labelStyle}>{nv('discountTypeLabel')}</label>
              <select
                className="input"
                value={discountType}
                onChange={(e) => setDiscountType(e.target.value as typeof discountType)}
              >
                <option value="fixed">{nv('discountFixed')}</option>
                <option value="percent">{nv('discountPercent')}</option>
                <option value="free_order">{nv('discountFreeOrder')}</option>
              </select>
            </div>
            {discountType !== 'free_order' && (
              <div>
                <label style={labelStyle}>
                  {discountType === 'percent' ? nv('discountPercentValue') : nv('discountAmountValue')}
                </label>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  value={discountValue}
                  onChange={(e) => setDiscountValue(e.target.value)}
                />
              </div>
            )}
          </div>

          <p style={sectionTitleStyle}>{nv('sectionSerial')}</p>
          <div style={formGridStyle}>
            <div>
              <label style={labelStyle}>{nv('serialFrom')}</label>
              <input className="input" type="number" min={1} value={serialFrom} onChange={(e) => setSerialFrom(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>{nv('serialTo')}</label>
              <input className="input" type="number" min={1} value={serialTo} onChange={(e) => setSerialTo(e.target.value)} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>{nv('endsAt')}</label>
              <input className="input" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </div>
          </div>
          {serialPreview ? (
            <p style={{ fontSize: 12, color: 'var(--text-light)', marginTop: 10, marginBottom: 0 }}>
              {t('admin.numberedVoucher.serialRangeHint', {
                count: serialPreview.count,
                from: serialPreview.from,
                to: serialPreview.to,
              })}
            </p>
          ) : null}

          <div style={{ display: 'flex', gap: 8, marginTop: 20, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: 1 }} />
            <button type="button" className="btn btn-outline" onClick={() => { setShowForm(false); resetForm(); }}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void handleCreate()}>
              {nv('generate')}
            </button>
          </div>
        </div>
      )}

      {campaigns.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-light)' }} className="card">
          {nv('emptyCampaigns')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {campaigns.map((c) => (
            <div
              key={c._id}
              className="card"
              style={{
                padding: 16,
                display: 'flex',
                flexWrap: 'wrap',
                gap: 12,
                justifyContent: 'space-between',
                alignItems: 'center',
                opacity: c.active ? 1 : 0.55,
              }}
            >
              <div style={{ minWidth: 0, flex: '1 1 280px' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span
                    style={{
                      fontFamily: 'ui-monospace, monospace',
                      fontSize: 12,
                      fontWeight: 700,
                      padding: '3px 8px',
                      borderRadius: 4,
                      background: 'var(--bg-secondary, #f5f5f5)',
                    }}
                  >
                    {c.campaignCode}
                  </span>
                  <StatusPill active={c.active} label={c.active ? nv('active') : nv('inactive')} />
                </div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>
                  {c.name}
                  {c.nameEn ? (
                    <span style={{ color: 'var(--text-light)', fontWeight: 500, marginLeft: 8, fontSize: 13 }}>{c.nameEn}</span>
                  ) : null}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--text-light)',
                    marginTop: 6,
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '4px 12px',
                  }}
                >
                  <span>
                    {nv('colQty')}: {c.totalVouchers}
                  </span>
                  <span>
                    {nv('colUsage')}: {c.unusedCount}/{c.usedCount}
                  </span>
                  <span>
                    {nv('colValidUntil')}: {c.endsAt ? new Date(c.endsAt).toLocaleDateString() : '—'}
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--red-primary)', whiteSpace: 'nowrap' }}>
                  {formatDiscountShort(c)}
                </span>
                <button type="button" className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => void openDetail(c._id)}>
                  {nv('detailBtn')}
                </button>
                <button type="button" className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => void toggleActive(c)}>
                  {c.active ? nv('disable') : nv('enable')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
