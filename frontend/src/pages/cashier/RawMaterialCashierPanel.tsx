import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';
import { formatPurchaseUnitOption, baseUnitDisplayLabel } from '../../utils/purchaseUnitLabel';

interface PurchaseUnit { code: string; label: string; factorToBase: number; translations?: { locale: string; label: string }[]; }
interface Translation { locale: string; name: string; }

interface SummaryRow {
  rawMaterialId: string;
  translations: Translation[];
  name: string;
  baseUnit: string;
  purchaseUnits: PurchaseUnit[];
  currentQty: number;
  reorderFrequencyDays: number;
  dailyConsumption: number;
  dailyConsumptionBasis: 'history' | 'empty';
  thresholdBase: number;
  color: 'red' | 'orange' | 'green';
}

type ActionKind = 'init' | 'restock' | 'waste';
type RestockSource = '' | 'central_kitchen' | 'third_party' | 'self_purchase';

function pickNames(translations: Translation[] | undefined, lang: string, fallback = ''): { primary: string; secondary: string } {
  const list = translations || [];
  if (list.length === 0) return { primary: fallback, secondary: '' };
  const primaryHit = list.find((tr) => tr.locale === lang)?.name;
  const altLocale = lang === 'zh-CN' ? 'en-US' : 'zh-CN';
  const altHit = list.find((tr) => tr.locale === altLocale)?.name;
  const primary = primaryHit || list[0]?.name || fallback;
  const secondary = altHit && altHit !== primary ? altHit : '';
  return { primary, secondary };
}

function tone(c: 'red' | 'orange' | 'green'): { bg: string; fg: string; bd: string } {
  if (c === 'red') return { bg: '#FFEBEE', fg: '#C62828', bd: '#FFCDD2' };
  if (c === 'orange') return { bg: '#FFF3E0', fg: '#E65100', bd: '#FFE0B2' };
  return { bg: '#F1F8E9', fg: '#2E7D32', bd: '#DCEDC8' };
}

/**
 * 收银侧「原材料」面板：列出当前店内启用中的原材料，给出 restock/waste/init 操作。
 * 与 MenuItem 库存不同，原材料没有「份」概念，UI 直接显示 baseUnit 数量。
 */
export default function RawMaterialCashierPanel() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'zh-CN';
  const { token } = useAuth();
  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<{ kind: ActionKind; row: SummaryRow } | null>(null);
  const [qty, setQty] = useState<number>(1);
  const [note, setNote] = useState<string>('');
  const [unitCode, setUnitCode] = useState<string>('');
  const [source, setSource] = useState<RestockSource>('');
  const [supplierNote, setSupplierNote] = useState<string>('');

  const jsonHeaders = useMemo(() => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }), [token]);
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const fetchAll = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiFetch('/api/raw-materials/summary', { headers: authHeaders });
      if (res.ok) {
        const data: SummaryRow[] = await res.json();
        data.sort((a, b) => {
          const o = (a.color === 'red' ? 0 : a.color === 'orange' ? 1 : 2)
            - (b.color === 'red' ? 0 : b.color === 'orange' ? 1 : 2);
          if (o !== 0) return o;
          return a.currentQty - b.currentQty;
        });
        setRows(data);
      } else if (res.status === 403) {
        setRows([]); // feature 未开通，静默隐藏
      }
    } finally { setBusy(false); }
  }, [authHeaders]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const groups = useMemo(() => {
    const needs: SummaryRow[] = [];
    const ok: SummaryRow[] = [];
    for (const r of rows) {
      if (r.color === 'green') ok.push(r);
      else needs.push(r);
    }
    const out: Array<{ id: 'needs' | 'ok'; name: string; rows: SummaryRow[]; accent: 'warn' | 'mute' }> = [];
    if (needs.length > 0) out.push({ id: 'needs', name: t('cashier.invGroupNeedsRestock'), rows: needs, accent: 'warn' });
    if (ok.length > 0) out.push({ id: 'ok', name: t('cashier.invGroupSufficient'), rows: ok, accent: 'mute' });
    return out;
  }, [rows, t]);

  const openAction = (kind: ActionKind, row: SummaryRow) => {
    setAction({ kind, row });
    setQty(1);
    setNote('');
    setUnitCode(row.purchaseUnits?.[0]?.code || '');
    setSource('');
    setSupplierNote('');
  };
  const close = () => setAction(null);

  const submit = async () => {
    if (!action) return;
    const { kind, row } = action;
    if (qty <= 0 && kind !== 'init') { alert(t('cashier.invQtyMustBePositive')); return; }
    if (qty < 0 && kind === 'init') { alert(t('cashier.invQtyMustBePositive')); return; }
    let url = '';
    let body: Record<string, unknown> = {};
    if (kind === 'restock') {
      if (!unitCode) { alert(t('cashier.invSelectUnit')); return; }
      url = `/api/raw-materials/${row.rawMaterialId}/restock`;
      body = { unitCode, qty, note, source: source || undefined, supplierNote };
    } else if (kind === 'waste') {
      if (!note.trim()) { alert(t('cashier.invWasteRequireNote')); return; }
      url = `/api/raw-materials/${row.rawMaterialId}/waste`;
      body = { qty, note };
    } else {
      url = `/api/raw-materials/${row.rawMaterialId}/init`;
      body = { qty, note };
    }
    setBusy(true);
    try {
      const res = await apiFetch(url, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.error?.message || t('cashier.invOpFailed'));
        return;
      }
      close();
      await fetchAll();
    } finally { setBusy(false); }
  };

  if (rows.length === 0 && !busy) return null;

  return (
    <section style={{ marginBottom: 28, padding: '12px 14px', background: '#FAFAFA', border: '1px solid var(--border)', borderRadius: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700 }}>🥩 {t('admin.rawMaterialsTitle')}</h3>
      </div>

      {groups.map((group) => {
        const headColor = group.accent === 'warn' ? '#C62828' : 'var(--text-secondary)';
        const headIcon = group.accent === 'warn' ? '⚠️' : '✅';
        return (
          <div key={group.id} style={{ marginBottom: 14 }}>
            <div style={{
              display: 'flex', alignItems: 'baseline', gap: 8,
              padding: '4px 0 6px', marginBottom: 8,
              borderBottom: `1px solid ${group.accent === 'warn' ? '#FFCDD2' : 'var(--border)'}`,
            }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: headColor }}>{headIcon} {group.name}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: headColor, fontWeight: 600 }}>{group.rows.length}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
              {group.rows.map((row) => {
                const tn = tone(row.color);
                const { primary, secondary } = pickNames(row.translations, lang, row.name);
                return (
                  <div key={row.rawMaterialId} className="card" style={{ padding: 10, background: tn.bg, border: `1px solid ${tn.bd}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>{primary}</div>
                        {secondary && <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 1 }}>{secondary}</div>}
                      </div>
                      <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: tn.fg, color: '#fff' }}>
                        {row.color.toUpperCase()}
                      </span>
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: tn.fg, marginTop: 4 }}>
                      {row.currentQty} {row.baseUnit}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 2 }}>
                      {t('cashier.invThresholdLabel')}: {row.thresholdBase} {row.baseUnit}
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                      <button className="btn btn-primary" style={{ fontSize: 12, padding: '5px 8px' }}
                        onClick={() => openAction('restock', row)}
                        disabled={(row.purchaseUnits || []).length === 0}>
                        📥 {t('cashier.invRestock')}
                      </button>
                      <button className="btn btn-outline" style={{ fontSize: 12, padding: '5px 8px', color: '#C62828' }}
                        onClick={() => openAction('waste', row)}>
                        🗑 {t('cashier.invWaste')}
                      </button>
                      <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 8px' }}
                        onClick={() => openAction('init', row)}>
                        🧮 {t('cashier.invInit')}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {action && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={close}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 20, width: 'min(480px, 95vw)' }}
            onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>
              {action.kind === 'restock' ? `📥 ${t('cashier.invRestock')}`
                : action.kind === 'waste' ? `🗑 ${t('cashier.invWaste')}`
                : `🧮 ${t('cashier.invInit')}`} — {pickNames(action.row.translations, lang, action.row.name).primary}
            </h3>
            <div style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 10 }}>
              {t('cashier.invCurrent')}: {action.row.currentQty} {action.row.baseUnit}
            </div>
            {action.kind === 'restock' && (
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>
                  {t('cashier.invSelectUnit')}
                </label>
                <select className="input" value={unitCode} onChange={(e) => setUnitCode(e.target.value)} style={{ width: '100%' }}>
                  {action.row.purchaseUnits.map((u) => (
                    <option key={u.code} value={u.code}>
                      {formatPurchaseUnitOption(u, lang, action.row.baseUnit, t)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>
                {action.kind === 'init' ? t('cashier.invInitQtyLabel') : t('cashier.invQtyLabel')}
              </label>
              <input className="input" type="number" min={action.kind === 'init' ? 0 : 1}
                value={qty}
                onChange={(e) => setQty(Math.max(action.kind === 'init' ? 0 : 1, Math.floor(Number(e.target.value) || 0)))}
                style={{ width: '100%' }} />
              {action.kind === 'restock' && unitCode && (() => {
                const u = action.row.purchaseUnits.find((u2) => u2.code === unitCode);
                if (!u) return null;
                const baseDelta = qty * u.factorToBase;
                return (
                  <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 4 }}>
                    +{baseDelta} {baseUnitDisplayLabel(action.row.baseUnit, t)}
                  </div>
                );
              })()}
            </div>
            {action.kind === 'restock' && (
              <>
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>
                    {t('admin.rawMaterialSourceLabel')}
                  </label>
                  <div style={{ display: 'flex', gap: 12, fontSize: 12, flexWrap: 'wrap' }}>
                    {(['central_kitchen', 'third_party', 'self_purchase'] as const).map((s) => (
                      <label key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <input type="radio" name="rmCashierSource" checked={source === s}
                          onChange={() => setSource(s)} />
                        {s === 'central_kitchen' ? t('admin.rawMaterialSourceCK')
                          : s === 'third_party' ? t('admin.rawMaterialSourceTP')
                          : t('admin.rawMaterialSourceSelf')}
                      </label>
                    ))}
                  </div>
                </div>
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>
                    {t('admin.rawMaterialSupplierNote')}
                  </label>
                  <input className="input" value={supplierNote} onChange={(e) => setSupplierNote(e.target.value)} style={{ width: '100%' }} />
                </div>
              </>
            )}
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>
                {action.kind === 'waste' ? t('cashier.invNoteRequired') : t('cashier.invNoteOptional')}
              </label>
              <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} style={{ width: '100%' }} />
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
    </section>
  );
}
