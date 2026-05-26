import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch, getConfiguredStoreSlug } from '../../api/client';
import {
  cashierMenuSessionCacheKey,
  patchCashierMenuInventoryQty,
} from '../../utils/cashierMenuSessionCache';

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

interface PurchaseUnitFromItem { code: string; label: string; factorToBase: number; }
interface MenuItemLite {
  _id: string;
  inventoryTracked?: boolean;
  inventory?: { purchaseUnits?: PurchaseUnitFromItem[] };
  translations: { locale: string; name: string }[];
}

type FormKind = 'restock' | 'waste' | 'init';

function statusOrder(c: 'red' | 'orange' | 'green'): number {
  return c === 'red' ? 0 : c === 'orange' ? 1 : 2;
}

/**
 * 按当前 UI 语言优先选名字；缺翻译则回退到 fallback / 任一翻译。
 * 同时返回「另一种语言」作为副标签，保证多语言菜单环境下双语都可见。
 */
function pickNames(
  translations: { locale: string; name: string }[] | undefined,
  lang: string,
  fallback = '',
): { primary: string; secondary: string } {
  const list = translations || [];
  if (list.length === 0) return { primary: fallback, secondary: '' };
  const primaryHit = list.find(tr => tr.locale === lang)?.name;
  const altLocale = lang === 'zh-CN' ? 'en-US' : 'zh-CN';
  const altHit = list.find(tr => tr.locale === altLocale)?.name;
  const primary = primaryHit || list[0]?.name || fallback;
  const secondary = (altHit && altHit !== primary) ? altHit : '';
  return { primary, secondary };
}

export default function RestockPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'zh-CN';
  const { token } = useAuth();
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [items, setItems] = useState<MenuItemLite[]>([]);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<{ kind: FormKind; row: SummaryRow } | null>(null);
  const [unitCode, setUnitCode] = useState<string>('');
  const [qty, setQty] = useState<number>(1);
  const [note, setNote] = useState<string>('');

  const headers = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }), [token]);
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const fetchAll = useCallback(async () => {
    setBusy(true);
    try {
      const [s, m] = await Promise.all([
        apiFetch('/api/inventory/summary', { headers: authHeaders }),
        apiFetch('/api/menu/items?ownOptionGroups=1', { headers: authHeaders }),
      ]);
      if (s.ok) {
        const rows: SummaryRow[] = await s.json();
        rows.sort((a, b) => {
          const o = statusOrder(a.color) - statusOrder(b.color);
          if (o !== 0) return o;
          return a.currentQty - b.currentQty;
        });
        setSummary(rows);
      }
      if (m.ok) {
        const all = (await m.json()) as MenuItemLite[];
        setItems(all.filter((it) => it.inventoryTracked));
      }
    } finally { setBusy(false); }
  }, [authHeaders]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const itemById = useMemo(() => {
    const map = new Map<string, MenuItemLite>();
    for (const it of items) map.set(it._id, it);
    return map;
  }, [items]);

  /** 按「需要补货 (red+orange) / 库存充足 (green)」分组。
   *  组内沿用 fetchAll 已经做好的 red→orange→green、currentQty 升序，无需再排。 */
  const groups = useMemo(() => {
    const needs: SummaryRow[] = [];
    const ok: SummaryRow[] = [];
    for (const r of summary) {
      if (r.color === 'green') ok.push(r);
      else needs.push(r);
    }
    const out: Array<{ id: 'needs' | 'ok'; name: string; rows: SummaryRow[]; accent: 'warn' | 'mute' }> = [];
    if (needs.length > 0) {
      out.push({ id: 'needs', name: t('cashier.invGroupNeedsRestock'), rows: needs, accent: 'warn' });
    }
    if (ok.length > 0) {
      out.push({ id: 'ok', name: t('cashier.invGroupSufficient'), rows: ok, accent: 'mute' });
    }
    return out;
  }, [summary, t]);

  const openForm = (kind: FormKind, row: SummaryRow) => {
    setActive({ kind, row });
    setQty(1);
    setNote('');
    if (kind === 'restock') {
      const it = itemById.get(row.menuItemId);
      const first = it?.inventory?.purchaseUnits?.[0]?.code || '';
      setUnitCode(first);
    } else {
      setUnitCode('');
    }
  };

  const close = () => { setActive(null); };

  const submit = async () => {
    if (!active) return;
    const { kind, row } = active;
    if (qty <= 0) { alert(t('cashier.invQtyMustBePositive')); return; }
    let url = '';
    let body: Record<string, unknown> = {};
    if (kind === 'restock') {
      if (!unitCode) { alert(t('cashier.invSelectUnit')); return; }
      url = `/api/inventory/${row.menuItemId}/restock`;
      body = { unitCode, qty, note };
    } else if (kind === 'waste') {
      if (!note.trim()) { alert(t('cashier.invWasteRequireNote')); return; }
      url = `/api/inventory/${row.menuItemId}/waste`;
      body = { qty, note };
    } else {
      url = `/api/inventory/${row.menuItemId}/init`;
      body = { qty, note };
    }
    setBusy(true);
    try {
      const res = await apiFetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.error?.message || t('cashier.invOpFailed'));
        return;
      }
      /** 后端 init/restock/waste/adjust 均返回 currentQty —— 顺手把点单 tab 的会话缓存 patch 掉，
       *  避免下次切回「点单」用过期 qty 渲染。 */
      const data = await res.json().catch(() => null) as { currentQty?: number } | null;
      if (data && typeof data.currentQty === 'number') {
        patchCashierMenuInventoryQty(
          cashierMenuSessionCacheKey(getConfiguredStoreSlug(), 'zh-CN'),
          row.menuItemId,
          data.currentQty,
        );
        patchCashierMenuInventoryQty(
          cashierMenuSessionCacheKey(getConfiguredStoreSlug(), 'en-US'),
          row.menuItemId,
          data.currentQty,
        );
      }
      close();
      await fetchAll();
    } finally { setBusy(false); }
  };

  const tone = (c: 'red' | 'orange' | 'green'): { bg: string; fg: string; bd: string } => {
    if (c === 'red') return { bg: '#FFEBEE', fg: '#C62828', bd: '#FFCDD2' };
    if (c === 'orange') return { bg: '#FFF3E0', fg: '#E65100', bd: '#FFE0B2' };
    return { bg: '#F1F8E9', fg: '#2E7D32', bd: '#DCEDC8' };
  };

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>📦 {t('cashier.restockTitle')}</h2>
        <button className="btn btn-outline" onClick={fetchAll} disabled={busy}>
          {busy ? '…' : t('cashier.refresh')}
        </button>
      </div>
      {summary.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-light)' }}>{t('cashier.invNoTrackedItems')}</div>
      ) : (
        groups.map(group => {
          const headColor = group.accent === 'warn' ? '#C62828' : 'var(--text-secondary)';
          const headIcon = group.accent === 'warn' ? '⚠️' : '✅';
          return (
          <section key={group.id} style={{ marginBottom: 22 }}>
            <div style={{
              display: 'flex', alignItems: 'baseline', gap: 8,
              padding: '6px 0 8px', marginBottom: 10,
              borderBottom: `1px solid ${group.accent === 'warn' ? '#FFCDD2' : 'var(--border)'}`,
            }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: headColor }}>
                {headIcon} {group.name}
              </h3>
              <span style={{
                marginLeft: 'auto', fontSize: 11,
                color: headColor, fontWeight: 600,
              }}>
                {group.rows.length}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
              {group.rows.map((row) => {
                const tn = tone(row.color);
                const it = itemById.get(row.menuItemId);
                const units = it?.inventory?.purchaseUnits || [];
                const { primary: itemName, secondary: itemNameAlt } = pickNames(it?.translations, lang, row.name);
                /** 阈值换算到「份」：thresholdBase / perServing，向上取整保证保守预警 */
                const perServing = Math.max(1, row.perServing || 1);
                const thresholdServings = Math.ceil(row.thresholdBase / perServing);
                return (
                  <div key={row.menuItemId} className="card" style={{ padding: 12, background: tn.bg, border: `1px solid ${tn.bd}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 15 }}>{itemName}</div>
                        {itemNameAlt && (
                          <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 1 }}>{itemNameAlt}</div>
                        )}
                      </div>
                      <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: tn.fg, color: '#fff' }}>
                        {row.color.toUpperCase()}
                      </span>
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: tn.fg, marginTop: 6 }}>
                      {row.remainingServings} {t('cashier.invServings')}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 2 }}>
                      {t('cashier.invThresholdLabel')}: {thresholdServings} {t('cashier.invServings')}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 2 }}>
                      {t('cashier.invDailySales')}: {row.dailySales.toFixed(2)} {t('cashier.invServings')}/{t('cashier.invDay', { defaultValue: lang.startsWith('zh') ? '天' : 'day' })}
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                      <button className="btn btn-primary" style={{ fontSize: 12, padding: '6px 10px' }}
                        onClick={() => openForm('restock', row)} disabled={units.length === 0}>
                        📥 {t('cashier.invRestock')}
                      </button>
                      <button className="btn btn-outline" style={{ fontSize: 12, padding: '6px 10px', color: '#C62828' }}
                        onClick={() => openForm('waste', row)}>
                        🗑 {t('cashier.invWaste')}
                      </button>
                      <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 10px' }}
                        onClick={() => openForm('init', row)}>
                        🧮 {t('cashier.invInit')}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
          );
        })
      )}

      {active && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={close}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 20, width: 'min(480px, 95vw)' }}
            onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>
              {active.kind === 'restock' ? `📥 ${t('cashier.invRestock')}`
                : active.kind === 'waste' ? `🗑 ${t('cashier.invWaste')}`
                : `🧮 ${t('cashier.invInit')}`} — {pickNames(itemById.get(active.row.menuItemId)?.translations, lang, active.row.name).primary}
            </h3>
            <div style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 10 }}>
              {t('cashier.invCurrent')}: {active.row.remainingServings} {t('cashier.invServings')}
              <span style={{ marginLeft: 6, opacity: 0.7 }}>
                ({active.row.currentQty} {active.row.baseUnit})
              </span>
            </div>
            {active.kind === 'restock' && (
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>
                  {t('cashier.invSelectUnit')}
                </label>
                <select className="input" value={unitCode} onChange={e => setUnitCode(e.target.value)} style={{ width: '100%' }}>
                  {(itemById.get(active.row.menuItemId)?.inventory?.purchaseUnits || []).map((u) => (
                    <option key={u.code} value={u.code}>
                      {u.label} (= {u.factorToBase} {active.row.baseUnit})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>
                {active.kind === 'init' ? t('cashier.invInitQtyLabel') : t('cashier.invQtyLabel')}
              </label>
              <input className="input" type="number" min={active.kind === 'init' ? 0 : 1}
                value={qty}
                onChange={e => setQty(Math.max(active.kind === 'init' ? 0 : 1, Math.floor(Number(e.target.value) || 0)))}
                style={{ width: '100%' }} />
              {active.kind === 'restock' && unitCode && (
                <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 4 }}>
                  {(() => {
                    const u = (itemById.get(active.row.menuItemId)?.inventory?.purchaseUnits || []).find(u2 => u2.code === unitCode);
                    if (!u) return '';
                    const addBase = qty * u.factorToBase;
                    const ps = Math.max(1, active.row.perServing || 1);
                    const addServings = Math.floor(addBase / ps);
                    return `≈ +${addServings} ${t('cashier.invServings')} (+${addBase} ${active.row.baseUnit})`;
                  })()}
                </div>
              )}
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>
                {active.kind === 'waste' ? t('cashier.invNoteRequired') : t('cashier.invNoteOptional')}
              </label>
              <textarea className="input" rows={2} value={note} onChange={e => setNote(e.target.value)} style={{ width: '100%' }} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" onClick={submit} disabled={busy} style={{ flex: 1 }}>
                {busy ? '…' : t('common.confirm')}
              </button>
              <button className="btn btn-outline" onClick={close} style={{ flex: 1 }}>{t('common.cancel')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
