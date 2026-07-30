import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';
import VoucherCampaignManager from './VoucherCampaignManager';

interface CouponData { _id: string; name: string; nameEn: string; amount: number; active: boolean; }

function CouponListPanel() {
  const { t } = useTranslation();
  const { token } = useAuth();
  const [coupons, setCoupons] = useState<CouponData[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<CouponData | null>(null);
  const [name, setName] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [amount, setAmount] = useState('');
  const [active, setActive] = useState(true);

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const fetchCoupons = useCallback(async () => {
    const res = await apiFetch('/api/coupons/all', { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) setCoupons(await res.json());
  }, [token]);

  useEffect(() => { fetchCoupons(); }, [fetchCoupons]);

  const resetForm = () => { setEditing(null); setName(''); setNameEn(''); setAmount(''); setActive(true); };

  const openCreate = () => { resetForm(); setShowForm(true); };
  const openEdit = (c: CouponData) => {
    setEditing(c); setName(c.name); setNameEn(c.nameEn); setAmount(c.amount.toString()); setActive(c.active);
    setShowForm(true);
  };

  const handleSave = async () => {
    const body = { name, nameEn, amount: parseFloat(amount), active };
    const url = editing ? `/api/coupons/${editing._id}` : '/api/coupons';
    const method = editing ? 'PUT' : 'POST';
    const res = await apiFetch(url, { method, headers, body: JSON.stringify(body) });
    if (res.ok) { setShowForm(false); resetForm(); fetchCoupons(); }
    else { const d = await res.json().catch(() => null); alert(d?.error?.message || 'Failed'); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确认删除？')) return;
    await apiFetch(`/api/coupons/${id}`, { method: 'DELETE', headers });
    fetchCoupons();
  };

  const handleToggle = async (c: CouponData) => {
    await apiFetch(`/api/coupons/${c._id}`, { method: 'PUT', headers, body: JSON.stringify({ active: !c.active }) });
    fetchCoupons();
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>🎟️ Coupon 管理</h2>
        <button className="btn btn-primary" onClick={openCreate}>+ 新建 Coupon</button>
      </div>

      {showForm && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 120px', gap: 10, alignItems: 'end' }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>名称 (中文)</label>
              <input className="input" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>Name (EN)</label>
              <input className="input" value={nameEn} onChange={e => setNameEn(e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>金额 (€)</label>
              <input className="input" type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
              <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} /> 启用
            </label>
            <div style={{ flex: 1 }} />
            <button className="btn btn-primary" onClick={handleSave}>{t('common.save')}</button>
            <button className="btn btn-outline" onClick={() => { setShowForm(false); resetForm(); }}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      {coupons.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-light)' }}>暂无 Coupon</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {coupons.map(c => (
            <div key={c._id} className="card" style={{ padding: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', opacity: c.active ? 1 : 0.5 }}>
              <div>
                <span style={{ fontWeight: 700, fontSize: 15 }}>{c.name}</span>
                {c.nameEn && <span style={{ color: 'var(--text-light)', marginLeft: 8, fontSize: 13 }}>{c.nameEn}</span>}
                {!c.active && <span style={{ marginLeft: 8, fontSize: 10, padding: '2px 6px', borderRadius: 3, background: '#9E9E9E', color: '#fff' }}>停用</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--red-primary)' }}>€{c.amount.toFixed(2)}</span>
                <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => handleToggle(c)}>{c.active ? '停用' : '启用'}</button>
                <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => openEdit(c)}>编辑</button>
                <button className="btn btn-ghost" style={{ fontSize: 12, color: '#F44336' }} onClick={() => handleDelete(c._id)}>删除</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CouponManager() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'coupons' | 'vouchers'>('coupons');
  return (
    <div>
      <div
        style={{
          display: 'inline-flex',
          gap: 4,
          marginBottom: 20,
          padding: 4,
          borderRadius: 10,
          background: 'var(--bg-secondary, #f0f0f0)',
        }}
      >
        <button
          type="button"
          className={tab === 'coupons' ? 'btn btn-primary' : 'btn btn-ghost'}
          style={{ fontSize: 13, borderRadius: 8 }}
          onClick={() => setTab('coupons')}
        >
          Coupon
        </button>
        <button
          type="button"
          className={tab === 'vouchers' ? 'btn btn-primary' : 'btn btn-ghost'}
          style={{ fontSize: 13, borderRadius: 8 }}
          onClick={() => setTab('vouchers')}
        >
          {t('admin.numberedVoucherTab')}
        </button>
      </div>
      {tab === 'coupons' ? <CouponListPanel /> : <VoucherCampaignManager />}
    </div>
  );
}
