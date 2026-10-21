import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useRestaurantConfig } from '../../hooks/useRestaurantConfig';
import { euro, readApiError, type WeekPayload } from './types';
import { printPurchaseOrders } from './printPurchaseOrders';
import './purchasing.css';

function shiftMonday(weekStart: string, weeks: number): string {
  const [y, m, d] = weekStart.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + weeks * 7));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function csvEscape(v: string | number): string {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export default function PurchaseOrdersPage() {
  const { t } = useTranslation();
  const { token } = useAuth();
  const { displayName } = useRestaurantConfig();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<WeekPayload | null>(null);
  const [err, setErr] = useState('');
  const [printing, setPrinting] = useState(false);

  const load = useCallback(async (ws?: string) => {
    const q = ws ? `?weekStart=${encodeURIComponent(ws)}` : '';
    setErr('');
    const res = await apiFetch(`/api/purchasing/week${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      setErr(await readApiError(res, t('purchasing.loadFail')));
      return;
    }
    const payload = (await res.json()) as WeekPayload;
    setData(payload);
    setParams({ weekStart: payload.weekStart }, { replace: true });
  }, [token, t, setParams]);

  useEffect(() => {
    void load(params.get('weekStart') || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const exportCsv = () => {
    if (!data) return;
    const rows = [
      ['Supplier', 'Contact', 'Date', 'Category', 'Item', 'Unit', 'Qty', 'Unit price', 'Line total'],
    ];
    for (const po of data.bySupplier) {
      const contact = (po.contacts || []).map((c) => [c.name, c.phone, c.email].filter(Boolean).join(' ')).join(' | ');
      for (const line of po.lines) {
        rows.push([
          po.supplierName,
          contact,
          line.date,
          line.categoryName,
          line.itemName,
          line.unit,
          String(line.qty),
          String(line.unitPrice),
          String(line.lineTotal),
        ]);
      }
    }
    const body = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + body], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `purchase-${data.weekStart}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (!data) return err ? <div className="purch-banner">{err}</div> : <div>{t('common.loading')}</div>;

  return (
    <div>
      {err ? <div className="purch-banner">{err}</div> : null}
      <div className="purch-toolbar purch-no-print">
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{t('purchasing.navOrders')}</h2>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
            {data.weekStart} · {t('purchasing.grandTotal')}: {euro(data.grandTotal)}
          </div>
        </div>
        <div className="purch-week-nav">
          <button type="button" className="btn btn-outline" onClick={() => void load(shiftMonday(data.weekStart, -1))}>{t('purchasing.prevWeek')}</button>
          <button type="button" className="btn btn-outline" onClick={() => void load()}>{t('purchasing.thisWeek')}</button>
          <button type="button" className="btn btn-outline" onClick={() => void load(shiftMonday(data.weekStart, 1))}>{t('purchasing.nextWeek')}</button>
          <button type="button" className="btn btn-outline" onClick={exportCsv}>{t('purchasing.exportCsv')}</button>
          <button type="button" className="btn btn-primary" disabled={printing || data.bySupplier.length === 0} onClick={() => {
            setPrinting(true);
            setErr('');
            void printPurchaseOrders(data, displayName, {
              title: t('purchasing.navOrders'),
              week: t('purchasing.thisWeek'),
              date: t('purchasing.colDate'),
              category: t('purchasing.colCategory'),
              item: t('purchasing.colInfo'),
              unit: t('purchasing.colUnit'),
              qty: t('purchasing.colQty'),
              price: t('purchasing.colPrice'),
              lineTotal: t('purchasing.colLineTotal'),
              total: t('purchasing.grandTotal'),
              weekday: (wd) => t(`purchasing.dow${wd}`),
            }).catch(() => setErr(t('purchasing.printFail'))).finally(() => setPrinting(false));
          }}>{printing ? t('purchasing.printBusy') : t('purchasing.print')}</button>
        </div>
      </div>
      {data.bySupplier.length === 0 ? (
        <div className="card" style={{ padding: 16 }}>{t('purchasing.noOrders')}</div>
      ) : (
        data.bySupplier.map((po) => (
          <div key={po.supplierId} className="card purch-po" style={{ padding: 16 }}>
            <h3>{po.supplierName}</h3>
            <div className="meta">
              {(po.contacts || []).map((c, i) => (
                <div key={i}>{[c.name, c.phone, c.email].filter(Boolean).join(' · ')}</div>
              ))}
              {po.notes ? <div>{po.notes}</div> : null}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', background: 'var(--bg)' }}>
                  <th style={{ padding: 6 }}>{t('purchasing.colDate')}</th>
                  <th style={{ padding: 6 }}>{t('purchasing.colCategory')}</th>
                  <th style={{ padding: 6 }}>{t('purchasing.colInfo')}</th>
                  <th style={{ padding: 6 }}>{t('purchasing.colUnit')}</th>
                  <th style={{ padding: 6 }}>{t('purchasing.colQty')}</th>
                  <th style={{ padding: 6 }}>{t('purchasing.colPrice')}</th>
                  <th style={{ padding: 6 }}>{t('purchasing.colLineTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {po.lines.map((line, i) => (
                  <tr key={`${line.itemName}-${line.weekday}-${i}`} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: 6 }}>{line.date} {t(`purchasing.dow${line.weekday}`)}</td>
                    <td style={{ padding: 6 }}>{line.categoryName}</td>
                    <td style={{ padding: 6 }}>
                      {line.itemName}
                      {line.itemDescription ? <div style={{ color: 'var(--text-secondary)' }}>{line.itemDescription}</div> : null}
                    </td>
                    <td style={{ padding: 6 }}>{line.unit}</td>
                    <td style={{ padding: 6 }}>{line.qty}</td>
                    <td style={{ padding: 6 }}>{euro(line.unitPrice)}</td>
                    <td style={{ padding: 6 }}>{euro(line.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ textAlign: 'right', marginTop: 8, fontWeight: 700 }}>{t('purchasing.grandTotal')}: {euro(po.total)}</div>
          </div>
        ))
      )}
    </div>
  );
}
