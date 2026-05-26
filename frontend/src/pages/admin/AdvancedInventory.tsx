import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';

interface SummaryRow {
  menuItemId: string;
  categoryId: string;
  name: string;
  baseUnit: string;
  perServing: number;
  currentQty: number;
  remainingServings: number;
  reorderFrequencyDays: number;
  dailySales: number;
  dailySalesBasis: 'history' | 'estimate' | 'mixed';
  thresholdBase: number;
  color: 'red' | 'orange' | 'green';
}

interface ReportRow {
  menuItemId: string;
  name: string;
  baseUnit: string;
  perServing: number;
  currentQty: number;
  sale: number;
  restock: number;
  waste: number;
  init: number;
  adjust: number;
}

interface TxnRow {
  _id: string;
  type: 'sale' | 'restock' | 'waste' | 'init' | 'adjust';
  qty: number;
  qtyBefore?: number;
  qtyAfter?: number;
  baseUnitSnapshot?: string;
  purchaseUnit?: { code?: string; label?: string; qty?: number };
  note?: string;
  operatorName?: string;
  createdAt: string;
}

function colorTone(c: 'red' | 'orange' | 'green'): { bg: string; fg: string } {
  if (c === 'red') return { bg: '#FFEBEE', fg: '#C62828' };
  if (c === 'orange') return { bg: '#FFF3E0', fg: '#E65100' };
  return { bg: '#E8F5E9', fg: '#2E7D32' };
}

function ymdToday(): string { return new Date().toISOString().slice(0, 10); }
function ymdNDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

export default function AdvancedInventory() {
  const { t } = useTranslation();
  const { token, hasFeature } = useAuth();
  const enabled = hasFeature('inventory.tracking');
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [report, setReport] = useState<ReportRow[]>([]);
  const [from, setFrom] = useState<string>(ymdNDaysAgo(14));
  const [to, setTo] = useState<string>(ymdToday());
  const [selectedItem, setSelectedItem] = useState<SummaryRow | null>(null);
  const [txns, setTxns] = useState<TxnRow[]>([]);
  const [loading, setLoading] = useState(false);

  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const fetchAll = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const [s, r] = await Promise.all([
        apiFetch('/api/inventory/summary', { headers }),
        apiFetch(`/api/inventory/report?from=${from}T00:00:00.000Z&to=${to}T23:59:59.999Z`, { headers }),
      ]);
      if (s.ok) setSummary(await s.json());
      if (r.ok) setReport(await r.json());
    } finally { setLoading(false); }
  }, [enabled, from, to, headers]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const openTxnDrawer = async (row: SummaryRow) => {
    setSelectedItem(row);
    setTxns([]);
    const res = await apiFetch(`/api/inventory/${row.menuItemId}/txns?limit=100`, { headers });
    if (res.ok) setTxns(await res.json());
  };

  if (!enabled) {
    return <div style={{ padding: 16 }}>{t('admin.invFeatureDisabled')}</div>;
  }

  const lowStockCount = summary.filter(s => s.color !== 'green').length;
  const maxRestock = Math.max(1, ...report.map(r => Math.max(r.restock, Math.abs(r.sale), r.waste)));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>📦 {t('admin.advancedInventory')}</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
          <label>{t('admin.from')}</label>
          <input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} />
          <label>{t('admin.to')}</label>
          <input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} />
          <button className="btn btn-outline" onClick={fetchAll} disabled={loading}>{loading ? '…' : t('admin.refresh')}</button>
        </div>
      </div>

      <div className="card" style={{ padding: 12, marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
          {t('admin.invLowStockCount', { count: lowStockCount })}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
          {summary.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-light)' }}>{t('admin.invNoTrackedItems')}</div>
          ) : summary.map(s => {
            const tone = colorTone(s.color);
            return (
              <div key={s.menuItemId} className="card" style={{
                padding: 12, border: `1px solid ${tone.fg}33`, background: tone.bg, cursor: 'pointer',
              }} onClick={() => openTxnDrawer(s)}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{s.name || s.menuItemId}</div>
                  <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: tone.fg, color: '#fff' }}>
                    {s.color.toUpperCase()}
                  </span>
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6, color: tone.fg }}>
                  {s.currentQty} {s.baseUnit}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 2 }}>
                  ≈ {s.remainingServings} {t('admin.invServings')}　
                  ({t('admin.invThresholdLabel')}: {s.thresholdBase})
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 2 }}>
                  {t('admin.invDailySales')}: {s.dailySales.toFixed(2)} {s.dailySalesBasis === 'estimate' ? `(${t('admin.invEstimate')})` : ''}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card" style={{ padding: 12, marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>{t('admin.invChartTitle')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
          {report.length === 0 ? (
            <div style={{ color: 'var(--text-light)' }}>{t('admin.invNoData')}</div>
          ) : report.map(r => (
            <div key={r.menuItemId} style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 8, alignItems: 'center' }}>
              <div style={{ fontWeight: 600 }}>{r.name || r.menuItemId}</div>
              <div style={{ display: 'flex', gap: 4 }}>
                <div title={`${t('admin.invRestock')} ${r.restock}`} style={{
                  height: 18, background: '#2E7D32', color: '#fff', fontSize: 10, lineHeight: '18px', textAlign: 'center',
                  borderRadius: 3, width: `${(r.restock / maxRestock) * 100}%`, minWidth: r.restock > 0 ? 30 : 0,
                  overflow: 'hidden', whiteSpace: 'nowrap',
                }}>{r.restock > 0 ? `+${r.restock}` : ''}</div>
                <div title={`${t('admin.invSale')} ${Math.abs(r.sale)}`} style={{
                  height: 18, background: '#1565C0', color: '#fff', fontSize: 10, lineHeight: '18px', textAlign: 'center',
                  borderRadius: 3, width: `${(Math.abs(r.sale) / maxRestock) * 100}%`, minWidth: Math.abs(r.sale) > 0 ? 30 : 0,
                  overflow: 'hidden', whiteSpace: 'nowrap',
                }}>{Math.abs(r.sale) > 0 ? `-${Math.abs(r.sale)}` : ''}</div>
                <div title={`${t('admin.invWaste')} ${r.waste}`} style={{
                  height: 18, background: '#C62828', color: '#fff', fontSize: 10, lineHeight: '18px', textAlign: 'center',
                  borderRadius: 3, width: `${(r.waste / maxRestock) * 100}%`, minWidth: r.waste > 0 ? 30 : 0,
                  overflow: 'hidden', whiteSpace: 'nowrap',
                }}>{r.waste > 0 ? `-${r.waste}` : ''}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
              <th style={{ padding: '10px 12px', textAlign: 'left' }}>{t('admin.invItem')}</th>
              <th style={{ padding: '10px 12px', textAlign: 'right' }}>{t('admin.invCurrent')}</th>
              <th style={{ padding: '10px 12px', textAlign: 'right' }}>{t('admin.invRestock')}</th>
              <th style={{ padding: '10px 12px', textAlign: 'right' }}>{t('admin.invSale')}</th>
              <th style={{ padding: '10px 12px', textAlign: 'right' }}>{t('admin.invWaste')}</th>
              <th style={{ padding: '10px 12px', textAlign: 'right' }}>{t('admin.invAdjust')}</th>
            </tr>
          </thead>
          <tbody>
            {report.map(r => (
              <tr key={r.menuItemId} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: '8px 12px' }}>{r.name || r.menuItemId}</td>
                <td style={{ padding: '8px 12px', textAlign: 'right' }}>{r.currentQty} {r.baseUnit}</td>
                <td style={{ padding: '8px 12px', textAlign: 'right', color: '#2E7D32' }}>+{r.restock}</td>
                <td style={{ padding: '8px 12px', textAlign: 'right', color: '#1565C0' }}>{r.sale}</td>
                <td style={{ padding: '8px 12px', textAlign: 'right', color: '#C62828' }}>{r.waste > 0 ? `-${r.waste}` : 0}</td>
                <td style={{ padding: '8px 12px', textAlign: 'right' }}>{r.adjust > 0 ? `+${r.adjust}` : r.adjust}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedItem && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}
          onClick={() => setSelectedItem(null)}>
          <div style={{ background: '#fff', width: 'min(520px, 95vw)', height: '100%', overflow: 'auto', padding: 16 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <h3 style={{ fontSize: 16, fontWeight: 700 }}>{selectedItem.name}</h3>
              <button className="btn btn-ghost" onClick={() => setSelectedItem(null)}>✕</button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 12 }}>
              {t('admin.invCurrent')}: {selectedItem.currentQty} {selectedItem.baseUnit}　
              {t('admin.invThresholdLabel')}: {selectedItem.thresholdBase}　
              {t('admin.invDailySales')}: {selectedItem.dailySales.toFixed(2)}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--bg)' }}>
                  <th style={{ padding: 6, textAlign: 'left' }}>{t('admin.invType')}</th>
                  <th style={{ padding: 6, textAlign: 'right' }}>{t('admin.invQty')}</th>
                  <th style={{ padding: 6, textAlign: 'left' }}>{t('admin.invNote')}</th>
                  <th style={{ padding: 6, textAlign: 'left' }}>{t('admin.invWhen')}</th>
                </tr>
              </thead>
              <tbody>
                {txns.map(tx => (
                  <tr key={tx._id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 6 }}>{tx.type}</td>
                    <td style={{ padding: 6, textAlign: 'right', color: tx.qty < 0 ? '#C62828' : '#2E7D32' }}>{tx.qty}</td>
                    <td style={{ padding: 6, color: 'var(--text-light)' }}>
                      {tx.purchaseUnit?.code ? `[${tx.purchaseUnit.qty} ${tx.purchaseUnit.label}] ` : ''}
                      {tx.note || ''}
                      {tx.operatorName ? ` (${tx.operatorName})` : ''}
                    </td>
                    <td style={{ padding: 6, color: 'var(--text-light)' }}>{new Date(tx.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
