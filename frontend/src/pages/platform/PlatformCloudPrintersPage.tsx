import { useCallback, useEffect, useState } from 'react';
import { platformApiFetch } from '../../api/client';

type StoreOpt = { _id: string; slug: string; displayName: string; hasCloudPrint: boolean };
type PrinterRow = {
  _id: string;
  storeId: string;
  storeSlug: string;
  storeName: string;
  sn: string;
  label: string;
};

export default function PlatformCloudPrintersPage() {
  const [feieyunConfigured, setFeieyunConfigured] = useState(true);
  const [stores, setStores] = useState<StoreOpt[]>([]);
  const [printers, setPrinters] = useState<PrinterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [storeId, setStoreId] = useState('');
  const [sn, setSn] = useState('');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const res = await platformApiFetch('/api/platform/cloud-printers');
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr((j as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`);
        return;
      }
      const data = await res.json() as {
        feieyunConfigured?: boolean;
        stores?: StoreOpt[];
        printers?: PrinterRow[];
      };
      setFeieyunConfigured(data.feieyunConfigured !== false);
      const list = data.stores || [];
      setStores(list);
      setPrinters(data.printers || []);
      setStoreId((prev) => prev || list.find((s) => s.hasCloudPrint)?._id || '');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    if (!storeId || !sn.trim()) return;
    setSaving(true);
    setErr('');
    try {
      const res = await platformApiFetch('/api/platform/cloud-printers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId, sn: sn.trim(), label: label.trim() }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr((j as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`);
        return;
      }
      setSn('');
      setLabel('');
      await load();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string, printerSn: string) => {
    if (!confirm(`解除绑定打印机 ${printerSn}？`)) return;
    const res = await platformApiFetch(`/api/platform/cloud-printers/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr((j as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`);
      return;
    }
    await load();
  };

  const eligible = stores.filter((s) => s.hasCloudPrint);

  return (
    <div style={{ width: '100%' }}>
      <h1 style={{ margin: '0 0 8px', fontSize: 22, fontWeight: 700, color: '#1a237e' }}>云打印 · 分配打印机</h1>
      <p style={{ margin: '0 0 20px', fontSize: 13, color: '#546e7a', lineHeight: 1.5 }}>
        把飞鹅云打印机编号（SN）分配给已开通 Plan 功能 <code>print.cloud</code> 的店铺。账号 UKEY 只在服务器环境变量，不会下发到店铺。一店可绑多台，同一 SN 不能分给两家店。
      </p>

      {!feieyunConfigured ? (
        <div className="card" style={{ padding: 16, marginBottom: 16, borderColor: '#ef6c00', color: '#e65100' }}>
          平台尚未配置飞鹅云账号（FEIEYUN_USER / FEIEYUN_UKEY）。分配后也无法出纸，请先在服务器环境变量中填写。
        </div>
      ) : null}

      {err ? (
        <div className="card" style={{ padding: 16, marginBottom: 16, borderColor: '#c62828', color: '#b71c1c' }}>{err}</div>
      ) : null}

      <div className="card" style={{ padding: 20, marginBottom: 20 }}>
        <div style={{ fontWeight: 700, marginBottom: 12 }}>绑定新机</div>
        {eligible.length === 0 && !loading ? (
          <div style={{ fontSize: 13, color: '#546e7a' }}>还没有店铺开通云打印。请先到「店铺管理 → 配置功能包」在 Plan 中勾选云打印。</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
            <label style={{ fontSize: 13 }}>
              店铺
              <select className="input" value={storeId} onChange={(e) => setStoreId(e.target.value)} style={{ display: 'block', marginTop: 4, minWidth: 220 }}>
                <option value="">选择店铺</option>
                {eligible.map((s) => (
                  <option key={s._id} value={s._id}>{s.displayName} / {s.slug}</option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: 13 }}>
              打印机编号 SN
              <input className="input" value={sn} onChange={(e) => setSn(e.target.value)} placeholder="例如 960809872" style={{ display: 'block', marginTop: 4, width: 180 }} />
            </label>
            <label style={{ fontSize: 13 }}>
              备注（可选）
              <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="前台 / 厨房" style={{ display: 'block', marginTop: 4, width: 140 }} />
            </label>
            <button type="button" className="btn btn-primary" disabled={saving || !storeId || !sn.trim()} onClick={() => void add()}>
              {saving ? '保存中…' : '分配'}
            </button>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ background: '#f5f5f5', textAlign: 'left' }}>
              <th style={{ padding: '12px 16px' }}>店铺</th>
              <th style={{ padding: '12px 16px' }}>SN</th>
              <th style={{ padding: '12px 16px' }}>备注</th>
              <th style={{ padding: '12px 16px' }} />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} style={{ padding: 20, color: '#888' }}>加载中…</td></tr>
            ) : printers.length === 0 ? (
              <tr><td colSpan={4} style={{ padding: 20, color: '#888' }}>尚未分配打印机</td></tr>
            ) : printers.map((p) => (
              <tr key={p._id} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: '12px 16px' }}>
                  <div style={{ fontWeight: 600 }}>{p.storeName || p.storeSlug}</div>
                  <div style={{ fontSize: 12, color: '#666' }}>/{p.storeSlug}</div>
                </td>
                <td style={{ padding: '12px 16px', fontFamily: 'ui-monospace, monospace' }}>{p.sn}</td>
                <td style={{ padding: '12px 16px' }}>{p.label || '—'}</td>
                <td style={{ padding: '12px 16px' }}>
                  <button type="button" className="btn btn-outline" style={{ fontSize: 12, color: '#b71c1c', borderColor: '#ffcdd2' }} onClick={() => void remove(p._id, p.sn)}>
                    解除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
