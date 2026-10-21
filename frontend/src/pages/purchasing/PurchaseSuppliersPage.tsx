import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import {
  ISO_WEEKDAYS,
  readApiError,
  type PurchaseCategory,
  type PurchaseContact,
  type PurchaseItem,
  type PurchaseQuote,
  type PurchaseSupplier,
} from './types';
import './purchasing.css';

const emptyContact = (): PurchaseContact => ({ name: '', phone: '', email: '' });

type AssignRow = { on: boolean; price: string; quoteId?: string };

function quotesToAssign(
  quotes: PurchaseQuote[],
  supplierId: string,
  items: PurchaseItem[],
): Record<string, AssignRow> {
  const mine = quotes.filter((q) => q.supplierId === supplierId && q.isActive !== false);
  const byItem = new Map(mine.map((q) => [q.itemId, q]));
  const out: Record<string, AssignRow> = {};
  for (const it of items) {
    const q = byItem.get(it._id);
    out[it._id] = q
      ? { on: true, price: String(q.unitPrice), quoteId: q._id }
      : { on: false, price: '' };
  }
  return out;
}

export default function PurchaseSuppliersPage() {
  const { t } = useTranslation();
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }),
    [token],
  );
  const [suppliers, setSuppliers] = useState<PurchaseSupplier[]>([]);
  const [categories, setCategories] = useState<PurchaseCategory[]>([]);
  const [items, setItems] = useState<PurchaseItem[]>([]);
  const [quotes, setQuotes] = useState<PurchaseQuote[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', notes: '', contacts: [emptyContact()], deliveryWeekdays: [] as number[] });
  const [assign, setAssign] = useState<Record<string, AssignRow>>({});
  const [catalogId, setCatalogId] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [savingQuotes, setSavingQuotes] = useState(false);
  const catalogAllRef = useRef<HTMLInputElement>(null);

  const activeItems = useMemo(
    () => items.filter((it) => it.isActive !== false),
    [items],
  );
  const activeCats = useMemo(() => {
    const withItems = new Set(activeItems.map((it) => it.categoryId));
    return categories.filter((c) => c.isActive !== false && withItems.has(c._id));
  }, [categories, activeItems]);
  const catalogItems = useMemo(
    () => activeItems.filter((it) => it.categoryId === catalogId),
    [activeItems, catalogId],
  );

  const load = useCallback(async () => {
    const res = await apiFetch('/api/purchasing/bootstrap', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      setErr(await readApiError(res, t('purchasing.loadFail')));
      return;
    }
    const data = await res.json();
    setSuppliers(data.suppliers || []);
    setCategories(data.categories || []);
    setItems(data.items || []);
    setQuotes(data.quotes || []);
  }, [token, t]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setAssign({});
      return;
    }
    setAssign(quotesToAssign(quotes, selectedId, items));
  }, [selectedId, quotes, items]);

  useEffect(() => {
    if (!catalogId && activeCats.length) setCatalogId(activeCats[0]._id);
    if (catalogId && activeCats.length && !activeCats.some((c) => c._id === catalogId)) {
      setCatalogId(activeCats[0]._id);
    }
  }, [activeCats, catalogId]);

  const checkedInCatalog = catalogItems.filter((it) => assign[it._id]?.on).length;
  const allInCatalogOn = catalogItems.length > 0 && checkedInCatalog === catalogItems.length;
  const someInCatalogOn = checkedInCatalog > 0 && !allInCatalogOn;

  useEffect(() => {
    if (catalogAllRef.current) catalogAllRef.current.indeterminate = someInCatalogOn;
  }, [someInCatalogOn]);

  const assignedCount = activeItems.filter((it) => assign[it._id]?.on).length;

  const startNew = () => {
    setSelectedId(null);
    setForm({ name: '', notes: '', contacts: [emptyContact()], deliveryWeekdays: [] });
    setMsg('');
    setErr('');
  };

  const openSupplier = (s: PurchaseSupplier) => {
    setSelectedId(s._id);
    setForm({
      name: s.name,
      notes: s.notes || '',
      contacts: s.contacts?.length ? s.contacts.map((c) => ({ ...emptyContact(), ...c })) : [emptyContact()],
      deliveryWeekdays: [...(s.deliveryWeekdays || [])],
    });
    setMsg('');
    setErr('');
  };

  const saveSupplier = async () => {
    setErr('');
    setMsg('');
    const body = { name: form.name, notes: form.notes, contacts: form.contacts, deliveryWeekdays: form.deliveryWeekdays };
    const res = selectedId
      ? await apiFetch(`/api/purchasing/suppliers/${selectedId}`, { method: 'PUT', headers, body: JSON.stringify(body) })
      : await apiFetch('/api/purchasing/suppliers', { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      setErr(await readApiError(res, t('purchasing.saveFail')));
      return;
    }
    const saved = await res.json();
    await load();
    setSelectedId(saved._id);
  };

  const delSupplier = async (id: string) => {
    if (!confirm(t('common.confirm') + '?')) return;
    const res = await apiFetch(`/api/purchasing/suppliers/${id}`, { method: 'DELETE', headers });
    if (!res.ok) {
      setErr(await readApiError(res, t('purchasing.saveFail')));
      return;
    }
    if (selectedId === id) startNew();
    await load();
  };

  const patchItem = (itemId: string, part: Partial<AssignRow>) => {
    setAssign((prev) => {
      const cur = prev[itemId] || { on: false, price: '' };
      return { ...prev, [itemId]: { ...cur, ...part } };
    });
  };

  const toggleItem = (item: PurchaseItem, on: boolean) => {
    setAssign((prev) => {
      const cur = prev[item._id] || { on: false, price: '' };
      return { ...prev, [item._id]: { ...cur, on } };
    });
  };

  const toggleCatalog = (on: boolean) => {
    setAssign((prev) => {
      const next = { ...prev };
      for (const it of catalogItems) {
        const cur = next[it._id] || { on: false, price: '' };
        next[it._id] = { ...cur, on };
      }
      return next;
    });
  };

  const toggleSupplierDay = (wd: number) => {
    setForm((prev) => ({
      ...prev,
      deliveryWeekdays: prev.deliveryWeekdays.includes(wd)
        ? prev.deliveryWeekdays.filter((x) => x !== wd)
        : [...prev.deliveryWeekdays, wd].sort((a, b) => a - b),
    }));
  };

  const saveQuotes = async () => {
    if (!selectedId) return;
    setErr('');
    setMsg('');
    const checked = activeItems.filter((it) => assign[it._id]?.on);
    if (!form.deliveryWeekdays.length) {
      setErr(t('purchasing.needSupplierDays'));
      return;
    }
    setSavingQuotes(true);
    try {
      const mine = quotes.filter((q) => q.supplierId === selectedId);
      const checkedIds = new Set(checked.map((it) => it._id));
      for (const q of mine) {
        if (!checkedIds.has(q.itemId)) {
          const res = await apiFetch(`/api/purchasing/quotes/${q._id}`, { method: 'DELETE', headers });
          if (!res.ok) {
            setErr(await readApiError(res, t('purchasing.saveFail')));
            return;
          }
        }
      }
      for (const it of checked) {
        const row = assign[it._id];
        const res = await apiFetch('/api/purchasing/quotes', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            supplierId: selectedId,
            itemId: it._id,
            unitPrice: Number(row.price) > 0 ? Number(row.price) : 0,
          }),
        });
        if (!res.ok) {
          setErr(await readApiError(res, t('purchasing.saveFail')));
          return;
        }
      }
      setMsg(t('purchasing.quotesSaved'));
      await load();
    } finally {
      setSavingQuotes(false);
    }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16 }}>
      <div className="card" style={{ padding: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <strong>{t('purchasing.navSuppliers')}</strong>
          <button type="button" className="btn btn-ghost" onClick={startNew}>{t('common.add')}</button>
        </div>
        {suppliers.map((s) => (
          <button
            key={s._id}
            type="button"
            onClick={() => openSupplier(s)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '8px 10px',
              border: 'none',
              borderRadius: 8,
              background: selectedId === s._id ? 'var(--red-light)' : 'transparent',
              cursor: 'pointer',
            }}
          >
            {s.name}
          </button>
        ))}
      </div>
      <div>
        {err ? <div className="purch-banner">{err}</div> : null}
        {msg ? <div className="purch-banner" style={{ background: '#ecfdf5', color: '#065f46' }}>{msg}</div> : null}
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ fontWeight: 650, marginBottom: 10 }}>{selectedId ? t('common.edit') : t('common.add')}</div>
          <div style={{ display: 'grid', gap: 8 }}>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('purchasing.supplierName')} />
            <div className="purch-assign-defaults">
              <span>{t('purchasing.deliveryDays')}</span>
              {ISO_WEEKDAYS.map((wd) => (
                <label key={wd}>
                  <input type="checkbox" checked={form.deliveryWeekdays.includes(wd)} onChange={() => toggleSupplierDay(wd)} /> {t(`purchasing.dow${wd}`)}
                </label>
              ))}
            </div>
            <textarea className="input" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder={t('purchasing.supplierNotes')} />
            {form.contacts.map((c, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                <input className="input" value={c.name} placeholder={t('purchasing.contactName')} onChange={(e) => {
                  const contacts = [...form.contacts];
                  contacts[i] = { ...c, name: e.target.value };
                  setForm({ ...form, contacts });
                }} />
                <input className="input" value={c.phone} placeholder={t('purchasing.contactPhone')} onChange={(e) => {
                  const contacts = [...form.contacts];
                  contacts[i] = { ...c, phone: e.target.value };
                  setForm({ ...form, contacts });
                }} />
                <input className="input" value={c.email} placeholder={t('purchasing.contactEmail')} onChange={(e) => {
                  const contacts = [...form.contacts];
                  contacts[i] = { ...c, email: e.target.value };
                  setForm({ ...form, contacts });
                }} />
              </div>
            ))}
            <button type="button" className="btn btn-outline" onClick={() => setForm({ ...form, contacts: [...form.contacts, emptyContact()] })}>
              {t('purchasing.addContact')}
            </button>
            <div>
              <button type="button" className="btn btn-primary" onClick={() => void saveSupplier()}>{t('common.save')}</button>
              {selectedId ? (
                <button type="button" className="btn btn-ghost" style={{ color: 'var(--red-primary)', marginLeft: 8 }} onClick={() => void delSupplier(selectedId)}>
                  {t('common.delete')}
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {selectedId ? (
          <div className="card" style={{ padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 650 }}>{t('purchasing.assignGoods')}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                  {t('purchasing.assignHint')} · {t('purchasing.assignedCount', { count: assignedCount })}
                </div>
              </div>
              <button type="button" className="btn btn-primary" disabled={savingQuotes} onClick={() => void saveQuotes()}>
                {savingQuotes ? t('common.loading') : t('purchasing.saveQuotes')}
              </button>
            </div>

            {form.deliveryWeekdays.length ? (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
                {t('purchasing.deliveryDays')}: {form.deliveryWeekdays.map((wd) => t(`purchasing.dow${wd}`)).join(' ')}
              </div>
            ) : (
              <div className="purch-banner">{t('purchasing.needSupplierDays')}</div>
            )}

            {activeCats.length === 0 ? (
              <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{t('purchasing.emptyCatalog')}</div>
            ) : (
              <div className="purch-assign">
                <div className="purch-assign-cats" role="tablist" aria-label={t('purchasing.categories')}>
                  {activeCats.map((c) => {
                    const n = activeItems.filter((it) => it.categoryId === c._id && assign[it._id]?.on).length;
                    const total = activeItems.filter((it) => it.categoryId === c._id).length;
                    return (
                      <button
                        key={c._id}
                        type="button"
                        role="tab"
                        aria-selected={catalogId === c._id}
                        className={`purch-assign-cat${catalogId === c._id ? ' is-active' : ''}`}
                        onClick={() => setCatalogId(c._id)}
                      >
                        <span>{c.name}</span>
                        <span className="purch-assign-cat-count">{n}/{total}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="purch-assign-items">
                  <label className="purch-assign-all">
                    <input
                      ref={catalogAllRef}
                      type="checkbox"
                      checked={allInCatalogOn}
                      onChange={(e) => toggleCatalog(e.target.checked)}
                    />
                    {t('purchasing.selectAllInCatalog')}
                  </label>
                  {catalogItems.map((it) => {
                    const row = assign[it._id] || { on: false, price: '' };
                    return (
                      <div key={it._id} className={`purch-assign-row${row.on ? ' is-on' : ''}`}>
                        <label className="purch-assign-name">
                          <input type="checkbox" checked={row.on} onChange={(e) => toggleItem(it, e.target.checked)} />
                          <span>
                            <strong>{it.name}</strong>
                            <span className="purch-assign-unit">{it.unit}</span>
                            {it.description ? <div className="purch-item-desc">{it.description}</div> : null}
                          </span>
                        </label>
                        {row.on ? (
                          <div className="purch-assign-meta">
                            <input
                              className="input purch-qty"
                              inputMode="decimal"
                              value={row.price}
                              placeholder={t('purchasing.colPrice')}
                              onChange={(e) => patchItem(it._id, { price: e.target.value })}
                            />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="card" style={{ padding: 16, color: 'var(--text-secondary)', fontSize: 13 }}>
            {t('purchasing.assignNeedSupplier')}
          </div>
        )}
      </div>
    </div>
  );
}
