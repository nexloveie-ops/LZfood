import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';
import {
  buildPurchaseUnitPayload,
  formatPurchaseUnitOption,
  splitPurchaseUnitLabels,
} from '../../utils/purchaseUnitLabel';

interface PurchaseUnit {
  code: string;
  label: string;
  factorToBase: number;
  translations?: { locale: string; label: string }[];
}

interface Translation {
  locale: string;
  name: string;
}

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

type ActionKind = 'init' | 'restock' | 'waste' | 'adjust';
type RestockSource = '' | 'central_kitchen' | 'third_party' | 'self_purchase';

interface FormPurchaseUnit { code: string; label: string; labelEn: string; factorToBase: number; }

interface FormDraft {
  translations: Translation[];
  baseUnit: string;
  purchaseUnits: FormPurchaseUnit[];
  reorderFrequencyDays: number;
  enabled: boolean;
}

function emptyDraft(): FormDraft {
  return {
    translations: [{ locale: 'zh-CN', name: '' }, { locale: 'en-US', name: '' }],
    baseUnit: 'g',
    purchaseUnits: [],
    reorderFrequencyDays: 3,
    enabled: true,
  };
}

function pickNames(
  translations: Translation[] | undefined,
  lang: string,
  fallback = '',
): { primary: string; secondary: string } {
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

export default function RawMaterials() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'zh-CN';
  const { token } = useAuth();

  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [busy, setBusy] = useState(false);

  const [editing, setEditing] = useState<{ id: string | null; draft: FormDraft } | null>(null);
  const [action, setAction] = useState<{ kind: ActionKind; row: SummaryRow } | null>(null);
  const [actionQty, setActionQty] = useState<number>(1);
  const [actionDelta, setActionDelta] = useState<number>(0);
  const [actionNote, setActionNote] = useState<string>('');
  const [actionUnitCode, setActionUnitCode] = useState<string>('');
  const [actionSource, setActionSource] = useState<RestockSource>('');
  const [actionSupplierNote, setActionSupplierNote] = useState<string>('');
  const [backfillingId, setBackfillingId] = useState<string | null>(null);

  const jsonHeaders = useMemo(
    () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }),
    [token],
  );
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

  const openCreate = () => setEditing({ id: null, draft: emptyDraft() });

  const openEdit = async (rowId: string) => {
    const res = await apiFetch(`/api/raw-materials`, { headers: authHeaders });
    if (!res.ok) return;
    const all = (await res.json()) as Array<{
      _id: string;
      translations: Translation[];
      baseUnit: string;
      purchaseUnits: PurchaseUnit[];
      reorderFrequencyDays: number;
      enabled: boolean;
    }>;
    const found = all.find((r) => r._id === rowId);
    if (!found) return;
    setEditing({
      id: rowId,
      draft: {
        translations: (found.translations || []).map((t) => ({ locale: t.locale, name: t.name })),
        baseUnit: found.baseUnit,
        purchaseUnits: (found.purchaseUnits || []).map((u) => {
          const { labelZh, labelEn } = splitPurchaseUnitLabels(u);
          return { code: u.code, label: labelZh, labelEn, factorToBase: u.factorToBase };
        }),
        reorderFrequencyDays: found.reorderFrequencyDays || 3,
        enabled: found.enabled !== false,
      },
    });
  };

  const closeEdit = () => setEditing(null);

  const saveEdit = async () => {
    if (!editing) return;
    const { id, draft } = editing;
    const translations = draft.translations
      .map((tr) => ({ locale: tr.locale.trim(), name: tr.name.trim() }))
      .filter((tr) => tr.locale && tr.name);
    if (translations.length === 0) { alert(t('admin.rawMaterialNamesTitle')); return; }
    if (!draft.baseUnit.trim()) { alert(t('admin.invBaseUnit')); return; }

    const body = {
      translations,
      baseUnit: draft.baseUnit.trim(),
      purchaseUnits: draft.purchaseUnits
        .filter((u) => u.code.trim() && (u.label.trim() || u.labelEn.trim()) && u.factorToBase >= 1)
        .map((u) => buildPurchaseUnitPayload(u.code, u.label, u.labelEn, u.factorToBase)),
      reorderFrequencyDays: draft.reorderFrequencyDays,
      enabled: draft.enabled,
    };
    const url = id ? `/api/raw-materials/${id}` : '/api/raw-materials';
    const method = id ? 'PUT' : 'POST';
    setBusy(true);
    try {
      const res = await apiFetch(url, { method, headers: jsonHeaders, body: JSON.stringify(body) });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.error?.message || 'save failed');
        return;
      }
      closeEdit();
      await fetchAll();
    } finally { setBusy(false); }
  };

  const deleteRow = async (id: string) => {
    if (!confirm(t('admin.rawMaterialDeleteConfirm'))) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/raw-materials/${id}`, { method: 'DELETE', headers: authHeaders });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.error?.message || 'delete failed');
        return;
      }
      await fetchAll();
    } finally { setBusy(false); }
  };

  const runBackfill = async (row: SummaryRow) => {
    if (!confirm(t('admin.rawMaterialBackfillConfirm'))) return;
    setBackfillingId(row.rawMaterialId);
    setBusy(true);
    try {
      const res = await apiFetch(`/api/raw-materials/${row.rawMaterialId}/backfill`, {
        method: 'POST',
        headers: authHeaders,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.error?.message || t('cashier.invOpFailed'));
        return;
      }
      const data = (await res.json()) as { writtenTxns?: number; scannedOrders?: number };
      alert(t('admin.rawMaterialBackfillDone', {
        n: data.writtenTxns ?? 0,
        m: data.scannedOrders ?? 0,
      }));
      await fetchAll();
    } finally {
      setBackfillingId(null);
      setBusy(false);
    }
  };

  const openAction = (kind: ActionKind, row: SummaryRow) => {
    setAction({ kind, row });
    setActionQty(1);
    setActionDelta(0);
    setActionNote('');
    setActionUnitCode(row.purchaseUnits?.[0]?.code || '');
    setActionSource('');
    setActionSupplierNote('');
  };
  const closeAction = () => setAction(null);

  const submitAction = async () => {
    if (!action) return;
    const { kind, row } = action;
    let url = '';
    let body: Record<string, unknown> = {};
    if (kind === 'init') {
      if (actionQty < 0) { alert(t('cashier.invQtyMustBePositive')); return; }
      url = `/api/raw-materials/${row.rawMaterialId}/init`;
      body = { qty: actionQty, note: actionNote };
    } else if (kind === 'restock') {
      if (actionQty <= 0) { alert(t('cashier.invQtyMustBePositive')); return; }
      if (!actionUnitCode) { alert(t('cashier.invSelectUnit')); return; }
      url = `/api/raw-materials/${row.rawMaterialId}/restock`;
      body = {
        unitCode: actionUnitCode,
        qty: actionQty,
        note: actionNote,
        source: actionSource || undefined,
        supplierNote: actionSupplierNote,
      };
    } else if (kind === 'waste') {
      if (actionQty <= 0) { alert(t('cashier.invQtyMustBePositive')); return; }
      if (!actionNote.trim()) { alert(t('cashier.invWasteRequireNote')); return; }
      url = `/api/raw-materials/${row.rawMaterialId}/waste`;
      body = { qty: actionQty, note: actionNote };
    } else {
      if (!Number.isFinite(actionDelta) || actionDelta === 0) { alert('delta'); return; }
      if (!actionNote.trim()) { alert(t('cashier.invWasteRequireNote')); return; }
      url = `/api/raw-materials/${row.rawMaterialId}/adjust`;
      body = { delta: actionDelta, note: actionNote };
    }
    setBusy(true);
    try {
      const res = await apiFetch(url, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.error?.message || t('cashier.invOpFailed'));
        return;
      }
      closeAction();
      await fetchAll();
    } finally { setBusy(false); }
  };

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>🥩 {t('admin.rawMaterialsTitle')}</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-outline" onClick={fetchAll} disabled={busy}>
            {busy ? '…' : t('cashier.refresh')}
          </button>
          <button className="btn btn-primary" onClick={openCreate} disabled={busy}>
            ➕ {t('admin.rawMaterialNew')}
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-light)' }}>{t('admin.rawMaterialsEmpty')}</div>
      ) : (
        groups.map((group) => {
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
                <span style={{ marginLeft: 'auto', fontSize: 11, color: headColor, fontWeight: 600 }}>
                  {group.rows.length}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
                {group.rows.map((row) => {
                  const tn = tone(row.color);
                  const { primary, secondary } = pickNames(row.translations, lang, row.name);
                  return (
                    <div key={row.rawMaterialId} className="card" style={{ padding: 12, background: tn.bg, border: `1px solid ${tn.bd}` }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontWeight: 700, fontSize: 15 }}>{primary}</div>
                          {secondary && <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 1 }}>{secondary}</div>}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                          <button
                            className="btn btn-ghost"
                            style={{ fontSize: 12, padding: '4px 8px', color: '#C62828' }}
                            onClick={() => deleteRow(row.rawMaterialId)}
                            disabled={busy}
                          >
                            🗑 {t('admin.rawMaterialDelete')}
                          </button>
                          <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: tn.fg, color: '#fff' }}>
                            {row.color.toUpperCase()}
                          </span>
                        </div>
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 700, color: tn.fg, marginTop: 6 }}>
                        {row.currentQty} {row.baseUnit}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 2 }}>
                        {t('cashier.invThresholdLabel')}: {row.thresholdBase} {row.baseUnit}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 2 }}>
                        {t('admin.rawMaterialDailyUsage')}: {row.dailyConsumption.toFixed(2)} {row.baseUnit}/{t('cashier.invDay')}
                        {row.dailyConsumptionBasis === 'empty' && (
                          <span style={{ marginLeft: 6, opacity: 0.75 }}>({t('admin.rawMaterialNoUsageYet')})</span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                        <button className="btn btn-primary" style={{ fontSize: 12, padding: '6px 10px' }}
                          onClick={() => openAction('restock', row)}
                          disabled={(row.purchaseUnits || []).length === 0}>
                          📥 {t('cashier.invRestock')}
                        </button>
                        <button className="btn btn-outline" style={{ fontSize: 12, padding: '6px 10px', color: '#C62828' }}
                          onClick={() => openAction('waste', row)}>
                          🗑 {t('cashier.invWaste')}
                        </button>
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 10px' }}
                          onClick={() => openAction('init', row)}>
                          🧮 {t('cashier.invInit')}
                        </button>
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 10px' }}
                          onClick={() => openAction('adjust', row)}>
                          ⚙️ {t('admin.invAdjust')}
                        </button>
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 10px' }}
                          onClick={() => runBackfill(row)}
                          disabled={busy && backfillingId === row.rawMaterialId}>
                          {backfillingId === row.rawMaterialId
                            ? t('admin.rawMaterialBackfillRunning')
                            : `📊 ${t('admin.rawMaterialBackfill')}`}
                        </button>
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 10px', marginLeft: 'auto' }}
                          onClick={() => openEdit(row.rawMaterialId)}>
                          ✏️ {t('admin.rawMaterialEdit')}
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

      {editing && (
        <EditorModal
          draft={editing.draft}
          isNew={!editing.id}
          onChange={(d) => setEditing({ id: editing.id, draft: d })}
          onClose={closeEdit}
          onSave={saveEdit}
          busy={busy}
          t={t}
        />
      )}

      {action && (
        <ActionModal
          kind={action.kind}
          row={action.row}
          lang={lang}
          actionQty={actionQty} setActionQty={setActionQty}
          actionDelta={actionDelta} setActionDelta={setActionDelta}
          actionNote={actionNote} setActionNote={setActionNote}
          actionUnitCode={actionUnitCode} setActionUnitCode={setActionUnitCode}
          actionSource={actionSource} setActionSource={setActionSource}
          actionSupplierNote={actionSupplierNote} setActionSupplierNote={setActionSupplierNote}
          onClose={closeAction}
          onSubmit={submitAction}
          busy={busy}
          t={t}
        />
      )}
    </div>
  );
}

interface TFunc { (key: string, opts?: Record<string, unknown>): string }

function EditorModal(props: {
  draft: FormDraft;
  isNew: boolean;
  onChange: (d: FormDraft) => void;
  onClose: () => void;
  onSave: () => void;
  busy: boolean;
  t: TFunc;
}) {
  const { draft, isNew, onChange, onClose, onSave, busy, t } = props;
  const addTranslation = () => onChange({ ...draft, translations: [...draft.translations, { locale: '', name: '' }] });
  const setTr = (i: number, k: 'locale' | 'name', v: string) => {
    const copy = draft.translations.slice();
    copy[i] = { ...copy[i], [k]: v };
    onChange({ ...draft, translations: copy });
  };
  const removeTr = (i: number) => {
    const copy = draft.translations.slice();
    copy.splice(i, 1);
    onChange({ ...draft, translations: copy });
  };
  const addPU = () => onChange({ ...draft, purchaseUnits: [...draft.purchaseUnits, { code: '', label: '', labelEn: '', factorToBase: 1 }] });
  const setPU = (i: number, patch: Partial<FormPurchaseUnit>) => {
    const copy = draft.purchaseUnits.slice();
    copy[i] = { ...copy[i], ...patch };
    onChange({ ...draft, purchaseUnits: copy });
  };
  const removePU = (i: number) => {
    const copy = draft.purchaseUnits.slice();
    copy.splice(i, 1);
    onChange({ ...draft, purchaseUnits: copy });
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 20, width: 'min(560px, 95vw)', maxHeight: '90vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>
          {isNew ? `➕ ${t('admin.rawMaterialNew')}` : `✏️ ${t('admin.rawMaterialEdit')}`}
        </h3>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{t('admin.rawMaterialNamesTitle')}</div>
          {draft.translations.map((tr, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
              <input className="input" style={{ width: 90 }} placeholder="zh-CN / en-US"
                value={tr.locale} onChange={(e) => setTr(i, 'locale', e.target.value)} />
              <input className="input" style={{ flex: 1 }} placeholder="name"
                value={tr.name} onChange={(e) => setTr(i, 'name', e.target.value)} />
              <button className="btn btn-ghost" onClick={() => removeTr(i)} style={{ color: '#C62828' }}>✕</button>
            </div>
          ))}
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={addTranslation}>
            ➕ {t('admin.rawMaterialAddTranslation')}
          </button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{t('admin.invBaseUnit')}</label>
          <input className="input" style={{ width: 120 }} value={draft.baseUnit}
            onChange={(e) => onChange({ ...draft, baseUnit: e.target.value })} placeholder={t('admin.invBaseUnitPlaceholder')} />
          <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 4 }}>{t('admin.rawMaterialBaseUnitHint')}</div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{t('admin.invReorderFrequency')}</label>
          <input className="input" type="number" min={1} style={{ width: 120 }}
            value={draft.reorderFrequencyDays}
            onChange={(e) => onChange({ ...draft, reorderFrequencyDays: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{t('admin.invPurchaseUnits')}</div>
          <div style={{ fontSize: 11, color: 'var(--text-light)', marginBottom: 6 }}>{t('admin.invPurchaseUnitHint')}</div>
          {draft.purchaseUnits.map((u, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
              <input className="input" style={{ width: 90 }} placeholder="code"
                value={u.code} onChange={(e) => setPU(i, { code: e.target.value })} />
              <input className="input" style={{ flex: 1 }} placeholder={t('admin.invUnitLabelPlaceholder')}
                value={u.label} onChange={(e) => setPU(i, { label: e.target.value })} />
              <input className="input" style={{ flex: 1 }} placeholder={t('admin.invUnitLabelEnPlaceholder')}
                value={u.labelEn} onChange={(e) => setPU(i, { labelEn: e.target.value })} />
              <input className="input" type="number" min={1} style={{ width: 110 }} placeholder={t('admin.invFactorPlaceholder')}
                value={u.factorToBase}
                onChange={(e) => setPU(i, { factorToBase: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
              <button className="btn btn-ghost" onClick={() => removePU(i)} style={{ color: '#C62828' }}>✕</button>
            </div>
          ))}
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={addPU}>➕ {t('admin.invAddPurchaseUnit')}</button>
        </div>

        {!isNew && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input type="checkbox" checked={draft.enabled}
                onChange={(e) => onChange({ ...draft, enabled: e.target.checked })} />
              {t('admin.rawMaterialEnabledLabel')}
            </label>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onClose}>{t('cashier.refresh') /* placeholder cancel; can be replaced later */}</button>
          <button className="btn btn-primary" onClick={onSave} disabled={busy}>
            {busy ? '…' : t('admin.rawMaterialSave')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ActionModal(props: {
  kind: ActionKind;
  row: SummaryRow;
  lang: string;
  actionQty: number; setActionQty: (n: number) => void;
  actionDelta: number; setActionDelta: (n: number) => void;
  actionNote: string; setActionNote: (s: string) => void;
  actionUnitCode: string; setActionUnitCode: (s: string) => void;
  actionSource: RestockSource; setActionSource: (s: RestockSource) => void;
  actionSupplierNote: string; setActionSupplierNote: (s: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  busy: boolean;
  t: TFunc;
}) {
  const { kind, row, lang, t } = props;
  const { primary } = pickNames(row.translations, lang, row.name);
  const isRestock = kind === 'restock';
  const isAdjust = kind === 'adjust';
  const isWaste = kind === 'waste';
  const isInit = kind === 'init';

  const unit = isRestock
    ? row.purchaseUnits.find((u) => u.code === props.actionUnitCode)
    : undefined;
  const restockBaseDelta = unit ? props.actionQty * unit.factorToBase : 0;

  const title = isRestock ? `📥 ${t('cashier.invRestock')}`
    : isWaste ? `🗑 ${t('cashier.invWaste')}`
    : isInit ? `🧮 ${t('cashier.invInit')}`
    : `⚙️ ${t('admin.invAdjust')}`;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={props.onClose}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 20, width: 'min(480px, 95vw)' }}
        onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>{title} — {primary}</h3>
        <div style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 10 }}>
          {t('cashier.invCurrent')}: {row.currentQty} {row.baseUnit}
        </div>

        {isRestock && (
          <div style={{ marginBottom: 10 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{t('cashier.invSelectUnit')}</label>
            <select className="input" value={props.actionUnitCode}
              onChange={(e) => props.setActionUnitCode(e.target.value)}>
              <option value="">--</option>
              {row.purchaseUnits.map((u) => (
                <option key={u.code} value={u.code}>{formatPurchaseUnitOption(u, lang, row.baseUnit, t)}</option>
              ))}
            </select>
          </div>
        )}

        {!isAdjust && (
          <div style={{ marginBottom: 10 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              {isInit ? t('cashier.invInitQtyLabel') : t('cashier.invQtyLabel')}
            </label>
            <input className="input" type="number" min={isInit ? 0 : 1}
              value={props.actionQty}
              onChange={(e) => props.setActionQty(Math.max(isInit ? 0 : 1, Math.floor(Number(e.target.value) || 0)))} />
            {isRestock && unit && (
              <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 4 }}>
                +{restockBaseDelta} {row.baseUnit}
              </div>
            )}
          </div>
        )}

        {isAdjust && (
          <div style={{ marginBottom: 10 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>delta ({row.baseUnit})</label>
            <input className="input" type="number"
              value={props.actionDelta}
              onChange={(e) => props.setActionDelta(Math.floor(Number(e.target.value) || 0))} />
          </div>
        )}

        {isRestock && (
          <>
            <div style={{ marginBottom: 10 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                {t('admin.rawMaterialSourceLabel')}
              </label>
              <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
                {(['central_kitchen', 'third_party', 'self_purchase'] as const).map((s) => (
                  <label key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <input type="radio" name="rmSource" checked={props.actionSource === s}
                      onChange={() => props.setActionSource(s)} />
                    {s === 'central_kitchen' ? t('admin.rawMaterialSourceCK')
                      : s === 'third_party' ? t('admin.rawMaterialSourceTP')
                      : t('admin.rawMaterialSourceSelf')}
                  </label>
                ))}
              </div>
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                {t('admin.rawMaterialSupplierNote')}
              </label>
              <input className="input" value={props.actionSupplierNote}
                onChange={(e) => props.setActionSupplierNote(e.target.value)} />
            </div>
          </>
        )}

        <div style={{ marginBottom: 10 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            {isWaste || isAdjust ? t('cashier.invNoteRequired') : t('cashier.invNoteOptional')}
          </label>
          <input className="input" value={props.actionNote}
            onChange={(e) => props.setActionNote(e.target.value)} />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={props.onClose}>✕</button>
          <button className="btn btn-primary" onClick={props.onSubmit} disabled={props.busy}>
            {props.busy ? '…' : t('admin.rawMaterialSave')}
          </button>
        </div>
      </div>
    </div>
  );
}
