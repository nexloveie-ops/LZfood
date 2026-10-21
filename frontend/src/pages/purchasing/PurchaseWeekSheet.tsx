import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { cellKey, euro, ISO_WEEKDAYS, readApiError, type WeekPayload } from './types';
import './purchasing.css';

type Draft = { qty: string; supplierId: string };

function shiftMonday(weekStart: string, weeks: number): string {
  const [y, m, d] = weekStart.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + weeks * 7));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export default function PurchaseWeekSheet() {
  const { t } = useTranslation();
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }),
    [token],
  );
  const [weekStart, setWeekStart] = useState('');
  const [data, setData] = useState<WeekPayload | null>(null);
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async (ws?: string) => {
    setLoading(true);
    setErr('');
    const q = ws ? `?weekStart=${encodeURIComponent(ws)}` : '';
    const res = await apiFetch(`/api/purchasing/week${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      setErr(await readApiError(res, t('purchasing.loadFail')));
      setLoading(false);
      return;
    }
    const payload = (await res.json()) as WeekPayload;
    setData(payload);
    setWeekStart(payload.weekStart);
    const next: Record<string, Draft> = {};
    for (const cat of payload.categories) {
      for (const item of cat.items) {
        for (const cell of item.cells) {
          const covering = cell.covering;
          const saved = cell.line;
          const defaultSup = covering.length === 1 ? covering[0].supplierId : '';
          next[cellKey(item._id, cell.weekday)] = {
            qty: saved ? String(saved.qty) : '',
            supplierId: saved?.supplierId || defaultSup,
          };
        }
      }
    }
    setDraft(next);
    setLoading(false);
  }, [token, t]);

  useEffect(() => { void load(); }, [load]);

  const patch = (itemId: string, weekday: number, part: Partial<Draft>) => {
    const k = cellKey(itemId, weekday);
    setDraft((prev) => ({
      ...prev,
      [k]: { qty: prev[k]?.qty || '', supplierId: prev[k]?.supplierId || '', ...part },
    }));
  };

  const save = async () => {
    if (!data || data.isPast) return;
    setSaving(true);
    setMsg('');
    setErr('');
    const lines: Array<{ itemId: string; weekday: number; qty: number; supplierId?: string }> = [];
    for (const cat of data.categories) {
      for (const item of cat.items) {
        for (const cell of item.cells) {
          const d = draft[cellKey(item._id, cell.weekday)];
          const qty = Number(d?.qty);
          if (!d || !Number.isFinite(qty) || qty <= 0) continue;
          const line: { itemId: string; weekday: number; qty: number; supplierId?: string } = {
            itemId: item._id,
            weekday: cell.weekday,
            qty,
          };
          if (cell.covering.length > 1) line.supplierId = d.supplierId;
          else if (cell.covering.length === 1) line.supplierId = cell.covering[0].supplierId;
          lines.push(line);
        }
      }
    }
    const res = await apiFetch('/api/purchasing/week', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ weekStart: data.weekStart, lines }),
    });
    setSaving(false);
    if (!res.ok) {
      setErr(await readApiError(res, t('purchasing.saveFail')));
      return;
    }
    setMsg(t('purchasing.saved'));
    await load(data.weekStart);
  };

  if (loading && !data) return <div>{t('common.loading')}</div>;
  if (err && !data) return <div className="purch-banner">{err}</div>;
  if (!data) return null;

  const emptyCatalog = data.categories.length === 0;

  return (
    <div>
      <div className="purch-toolbar purch-no-print">
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{t('purchasing.sheetTitle')}</h2>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
            {data.dates[0]} → {data.dates[6]}
            {data.isCurrent ? ` · ${t('purchasing.thisWeek')}` : ''}
            {data.isPast ? ` · ${t('purchasing.pastWeek')}` : ''}
          </div>
        </div>
        <div className="purch-week-nav">
          <button type="button" className="btn btn-outline" onClick={() => void load(shiftMonday(weekStart, -1))}>
            {t('purchasing.prevWeek')}
          </button>
          <button type="button" className="btn btn-outline" onClick={() => void load()}>
            {t('purchasing.thisWeek')}
          </button>
          <button type="button" className="btn btn-outline" onClick={() => void load(shiftMonday(weekStart, 1))}>
            {t('purchasing.nextWeek')}
          </button>
          <button type="button" className="btn btn-primary" disabled={saving || data.isPast} onClick={() => void save()}>
            {saving ? t('common.loading') : t('common.save')}
          </button>
        </div>
      </div>
      {err ? <div className="purch-banner">{err}</div> : null}
      {msg ? <div className="purch-banner" style={{ background: '#ecfdf5', color: '#065f46' }}>{msg}</div> : null}
      {data.isPast ? <div className="purch-banner">{t('purchasing.pastLocked')}</div> : null}
      {emptyCatalog ? (
        <div className="card" style={{ padding: 16 }}>
          {t('purchasing.emptyCatalog')}{' '}
          <Link to="catalog">{t('purchasing.navCatalog')}</Link>
          {' · '}
          <Link to="suppliers">{t('purchasing.navSuppliers')}</Link>
        </div>
      ) : (
        <div className="purch-sheet-wrap">
          <table className="purch-sheet">
            <thead>
              <tr>
                <th className="col-cat">{t('purchasing.colCategory')}</th>
                <th className="col-info">{t('purchasing.colInfo')}</th>
                <th className="col-unit">{t('purchasing.colUnit')}</th>
                <th className="col-price">{t('purchasing.colPrice')}</th>
                {ISO_WEEKDAYS.map((wd, i) => (
                  <th key={wd} className="col-day">
                    {t(`purchasing.dow${wd}`)}
                    <div style={{ fontWeight: 500, color: 'var(--text-secondary)', fontSize: 11 }}>{data.dates[i].slice(5)}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.categories.map((cat) =>
                cat.items.map((item, idx) => (
                  <tr key={item._id}>
                    <td className="col-cat">{idx === 0 ? cat.name : ''}</td>
                    <td className="col-info">
                      <div className="purch-item-name">{item.name}</div>
                      {item.description ? <div className="purch-item-desc">{item.description}</div> : null}
                    </td>
                    <td className="col-unit">{item.unit}</td>
                    <td className="col-price">{euro(item.displayUnitPrice)}</td>
                    {item.cells.map((cell) => {
                      const d = draft[cellKey(item._id, cell.weekday)] || { qty: '', supplierId: '' };
                      const locked = cell.covering.length === 0;
                      const conflict = cell.covering.length > 1;
                      const chosen = cell.covering.find((q) => q.supplierId === d.supplierId) || (cell.covering.length === 1 ? cell.covering[0] : null);
                      const cls = `col-day${locked ? ' is-locked' : conflict ? ' is-conflict' : ' is-open'}`;
                      return (
                        <td key={cell.weekday} className={cls}>
                          {locked ? (
                            '—'
                          ) : (
                            <>
                              {conflict ? (
                                <select
                                  className="input purch-sup-select"
                                  disabled={data.isPast}
                                  value={d.supplierId}
                                  onChange={(e) => patch(item._id, cell.weekday, { supplierId: e.target.value })}
                                >
                                  <option value="">{t('purchasing.pickSupplier')}</option>
                                  {cell.covering.map((q) => (
                                    <option key={q.supplierId} value={q.supplierId}>
                                      {q.unitPrice > 0 ? `${q.supplierName} ${euro(q.unitPrice)}` : q.supplierName}
                                    </option>
                                  ))}
                                </select>
                              ) : null}
                              <input
                                className="input purch-qty"
                                inputMode="decimal"
                                disabled={data.isPast || (conflict && !d.supplierId)}
                                value={d.qty}
                                placeholder="0"
                                onChange={(e) => patch(item._id, cell.weekday, { qty: e.target.value })}
                              />
                              {chosen && chosen.unitPrice > 0 ? <div className="purch-cell-price">{euro(chosen.unitPrice)}</div> : null}
                            </>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="purch-no-print" style={{ marginTop: 12, fontSize: 13, color: 'var(--text-secondary)' }}>
        {t('purchasing.sheetHint')} · {t('purchasing.grandTotal')}: {euro(data.grandTotal)}
        {' · '}
        <Link to={`orders?weekStart=${data.weekStart}`}>{t('purchasing.navOrders')}</Link>
      </div>
    </div>
  );
}
