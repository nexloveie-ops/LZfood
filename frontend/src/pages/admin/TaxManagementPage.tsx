import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { apiFetch } from '../../api/client';
import { useAuth } from '../../context/AuthContext';

interface Translation {
  locale: string;
  name: string;
}

interface TaxCategory {
  _id: string;
  sortOrder: number;
  rate: number;
  translations: Translation[];
}

interface MenuCategoryAssignment {
  _id: string;
  sortOrder: number;
  nameZh: string;
  nameEn: string;
  taxCategoryId: string | null;
}

interface TaxCategoryOption {
  _id: string;
  sortOrder: number;
  rate: number;
  nameZh: string;
  nameEn: string;
}

interface ExportReadiness {
  ready: boolean;
  taxCategoryCount: number;
  unassignedCategories: { id: string; name: string }[];
}

const RATE_PRESETS = [
  { label: '0%', value: 0 },
  { label: '9%', value: 0.09 },
  { label: '13.5%', value: 0.135 },
  { label: '23%', value: 0.23 },
];

function nameFrom(translations: Translation[], locale: string): string {
  return translations.find((t) => t.locale === locale)?.name?.trim() ?? '';
}

export default function TaxManagementPage() {
  const { t } = useTranslation();
  const { token } = useAuth();
  const { storeSlug } = useParams<{ storeSlug: string }>();
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [tab, setTab] = useState<'categories' | 'assignments'>('categories');
  const [taxCategories, setTaxCategories] = useState<TaxCategory[]>([]);
  const [menuCategories, setMenuCategories] = useState<MenuCategoryAssignment[]>([]);
  const [taxOptions, setTaxOptions] = useState<TaxCategoryOption[]>([]);
  const [readiness, setReadiness] = useState<ExportReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nameZh, setNameZh] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [rate, setRate] = useState(0.09);
  const [sortOrder, setSortOrder] = useState(0);

  const [assignDraft, setAssignDraft] = useState<Record<string, string>>({});

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [taxRes, assignRes, readyRes] = await Promise.all([
        apiFetch('/api/admin/tax-categories', { headers: { Authorization: `Bearer ${token}` } }),
        apiFetch('/api/admin/tax-categories/category-assignments', { headers: { Authorization: `Bearer ${token}` } }),
        apiFetch('/api/admin/tax-categories/export-readiness', { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (taxRes.ok) setTaxCategories(await taxRes.json());
      if (assignRes.ok) {
        const data = await assignRes.json();
        setMenuCategories(data.menuCategories ?? []);
        setTaxOptions(data.taxCategories ?? []);
        const draft: Record<string, string> = {};
        for (const row of data.menuCategories ?? []) {
          draft[row._id] = row.taxCategoryId ?? '';
        }
        setAssignDraft(draft);
      }
      if (readyRes.ok) setReadiness(await readyRes.json());
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const openCreate = () => {
    setEditingId(null);
    setNameZh('');
    setNameEn('');
    setRate(0.09);
    setSortOrder(taxCategories.length);
    setShowForm(true);
  };

  const openEdit = (row: TaxCategory) => {
    setEditingId(row._id);
    setNameZh(nameFrom(row.translations, 'zh-CN'));
    setNameEn(nameFrom(row.translations, 'en-US') || nameFrom(row.translations, 'en'));
    setRate(row.rate);
    setSortOrder(row.sortOrder);
    setShowForm(true);
  };

  const saveTaxCategory = async () => {
    if (!nameEn.trim()) {
      alert(t('admin.taxMgmtEnglishRequired'));
      return;
    }
    const body = {
      sortOrder,
      rate,
      translations: [
        { locale: 'zh-CN', name: nameZh.trim() || nameEn.trim() },
        { locale: 'en-US', name: nameEn.trim() },
      ],
    };
    const res = editingId
      ? await apiFetch(`/api/admin/tax-categories/${editingId}`, { method: 'PUT', headers, body: JSON.stringify(body) })
      : await apiFetch('/api/admin/tax-categories', { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error?.message || '保存失败');
      return;
    }
    setShowForm(false);
    setMsg(t('admin.taxMgmtSaved'));
    await loadAll();
  };

  const deleteTaxCategory = async (id: string) => {
    if (!confirm(t('common.confirm') + '?')) return;
    const res = await apiFetch(`/api/admin/tax-categories/${id}`, { method: 'DELETE', headers });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error?.message || '删除失败');
      return;
    }
    await loadAll();
  };

  const saveAssignments = async () => {
    const assignments = menuCategories.map((c) => ({
      categoryId: c._id,
      taxCategoryId: assignDraft[c._id] || null,
    }));
    const res = await apiFetch('/api/admin/tax-categories/category-assignments', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ assignments }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error?.message || '保存失败');
      return;
    }
    setMsg(t('admin.taxMgmtAssignmentsSaved'));
    await loadAll();
  };

  const rateLabel = (r: number) => `${(r * 100).toFixed(r * 100 % 1 === 0 ? 0 : 1)}%`;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0 }}>{t('admin.taxMgmtTitle')}</h2>
          <p style={{ margin: '8px 0 0', color: 'var(--text-secondary)', fontSize: 14, maxWidth: 720 }}>
            {t('admin.taxMgmtIntro')}
          </p>
        </div>
        <Link className="btn btn-outline" to={`/${storeSlug}/admin/reports`}>
          {t('admin.reports')}
        </Link>
      </div>

      {readiness && !readiness.ready && (
        <div className="card" style={{ padding: 14, marginBottom: 16, borderLeft: '4px solid #ef6c00' }}>
          <strong>{t('admin.taxMgmtNotReady')}</strong>
          {readiness.taxCategoryCount === 0 && (
            <p style={{ margin: '8px 0 0', fontSize: 14 }}>{t('admin.taxMgmtNeedCategories')}</p>
          )}
          {readiness.unassignedCategories.length > 0 && (
            <p style={{ margin: '8px 0 0', fontSize: 14 }}>
              {t('admin.taxMgmtUnassigned')}: {readiness.unassignedCategories.map((c) => c.name).join('、')}
            </p>
          )}
        </div>
      )}

      {msg && (
        <div className="card" style={{ padding: 12, marginBottom: 16, color: 'var(--green, #388E3C)' }}>{msg}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          type="button"
          className={`btn ${tab === 'categories' ? 'btn-primary' : 'btn-outline'}`}
          onClick={() => setTab('categories')}
        >
          {t('admin.taxMgmtTabCategories')}
        </button>
        <button
          type="button"
          className={`btn ${tab === 'assignments' ? 'btn-primary' : 'btn-outline'}`}
          onClick={() => setTab('assignments')}
        >
          {t('admin.taxMgmtTabAssignments')}
        </button>
      </div>

      {loading ? (
        <p>{t('common.loading')}</p>
      ) : tab === 'categories' ? (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>{t('admin.taxMgmtTabCategories')}</h3>
            <button type="button" className="btn btn-primary" onClick={openCreate}>
              + {t('admin.taxMgmtAddCategory')}
            </button>
          </div>

          {showForm && (
            <div style={{ padding: 14, marginBottom: 16, background: 'var(--bg-secondary, #f8f9fa)', borderRadius: 8 }}>
              <div style={{ display: 'grid', gap: 10, maxWidth: 480 }}>
                <label>
                  <span style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{t('admin.taxMgmtNameZh')}</span>
                  <input className="input" value={nameZh} onChange={(e) => setNameZh(e.target.value)} />
                </label>
                <label>
                  <span style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{t('admin.taxMgmtNameEn')} *</span>
                  <input className="input" value={nameEn} onChange={(e) => setNameEn(e.target.value)} required />
                </label>
                <label>
                  <span style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{t('admin.taxMgmtRate')}</span>
                  <select className="input" value={rate} onChange={(e) => setRate(Number(e.target.value))}>
                    {RATE_PRESETS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{t('admin.sortOrder')}</span>
                  <input className="input" type="number" value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value))} />
                </label>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button type="button" className="btn btn-primary" onClick={() => void saveTaxCategory()}>{t('common.save')}</button>
                <button type="button" className="btn btn-outline" onClick={() => setShowForm(false)}>{t('common.cancel')}</button>
              </div>
            </div>
          )}

          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>{t('admin.taxMgmtNameZh')}</th>
                <th>{t('admin.taxMgmtNameEn')}</th>
                <th>{t('admin.taxMgmtRate')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {taxCategories.map((row) => (
                <tr key={row._id}>
                  <td>{nameFrom(row.translations, 'zh-CN')}</td>
                  <td>{nameFrom(row.translations, 'en-US') || nameFrom(row.translations, 'en')}</td>
                  <td>{rateLabel(row.rate)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button type="button" className="btn btn-outline" style={{ marginRight: 8 }} onClick={() => openEdit(row)}>
                      {t('common.edit')}
                    </button>
                    <button type="button" className="btn btn-outline" onClick={() => void deleteTaxCategory(row._id)}>
                      {t('common.delete')}
                    </button>
                  </td>
                </tr>
              ))}
              {taxCategories.length === 0 && (
                <tr><td colSpan={4} style={{ color: 'var(--text-secondary)' }}>{t('admin.taxMgmtEmpty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <h3 style={{ margin: 0 }}>{t('admin.taxMgmtTabAssignments')}</h3>
            <button type="button" className="btn btn-primary" onClick={() => void saveAssignments()}>
              {t('common.save')}
            </button>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0 }}>
            {t('admin.taxMgmtAssignmentsHint')}
          </p>
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>{t('admin.categories')}</th>
                <th>{t('admin.taxMgmtAssignTo')}</th>
              </tr>
            </thead>
            <tbody>
              {menuCategories.map((row) => (
                <tr key={row._id}>
                  <td>
                    {row.nameZh || row.nameEn}
                    {row.nameEn && row.nameZh ? <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}> / {row.nameEn}</span> : null}
                  </td>
                  <td>
                    <select
                      className="input"
                      value={assignDraft[row._id] ?? ''}
                      onChange={(e) => setAssignDraft((prev) => ({ ...prev, [row._id]: e.target.value }))}
                    >
                      <option value="">{t('admin.taxMgmtUnassignedOption')}</option>
                      {taxOptions.map((opt) => (
                        <option key={opt._id} value={opt._id}>
                          {opt.nameEn || opt.nameZh} ({rateLabel(opt.rate)})
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
              {menuCategories.length === 0 && (
                <tr><td colSpan={2} style={{ color: 'var(--text-secondary)' }}>{t('admin.taxMgmtNoMenuCategories')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
