import { useCallback, useEffect, useState } from 'react';
import { platformApiFetch } from '../../api/client';

type GeoProvider = 'google' | 'session';
type SessionRow = {
  id: string;
  label: string;
  cookieSuffix: string;
  enabled: boolean;
  status: 'active' | 'expired' | 'disabled';
  lastOkAt: string | null;
  lastFailAt: string | null;
  lastFailReason: string;
  sortOrder: number;
};

type GeoLookupState = {
  provider: GeoProvider;
  degradedAt: string | null;
  activeSessionCount: number;
  sessions: SessionRow[];
};

function statusLabel(s: SessionRow): string {
  if (!s.enabled) return '已停用';
  if (s.status === 'expired') return '已失效';
  return '可用';
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IE', { timeZone: 'Europe/Dublin' });
}

export default function PlatformGeoLookupPage() {
  const [state, setState] = useState<GeoLookupState | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [providerSaving, setProviderSaving] = useState(false);
  const [label, setLabel] = useState('');
  const [cookie, setCookie] = useState('');
  const [adding, setAdding] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const res = await platformApiFetch('/api/platform/geo-lookup');
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr((j as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`);
        return;
      }
      setState(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setProvider = async (provider: GeoProvider) => {
    setProviderSaving(true);
    setErr('');
    setMsg('');
    try {
      const res = await platformApiFetch('/api/platform/geo-lookup', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr((j as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`);
        return;
      }
      await load();
      setMsg(provider === 'session' ? '已切换为 Session 池（收银与顾客点餐共用）' : '已切换为 Google');
    } finally {
      setProviderSaving(false);
    }
  };

  const addSession = async () => {
    setAdding(true);
    setErr('');
    setMsg('');
    try {
      const res = await platformApiFetch('/api/platform/geo-lookup/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, cookie }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr((j as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`);
        return;
      }
      setLabel('');
      setCookie('');
      await load();
      setMsg('已保存（Cookie 不会再显示全文）');
    } finally {
      setAdding(false);
    }
  };

  const toggleEnabled = async (row: SessionRow) => {
    const res = await platformApiFetch(`/api/platform/geo-lookup/sessions/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !row.enabled }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr((j as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`);
      return;
    }
    await load();
  };

  const replaceCookie = async (row: SessionRow) => {
    const next = window.prompt(`更新「${row.label}」的 Cookie（粘贴 SESSION=…，保存后不会回显）`);
    if (next == null || !next.trim()) return;
    const res = await platformApiFetch(`/api/platform/geo-lookup/sessions/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: next }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr((j as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`);
      return;
    }
    await load();
    setMsg('Cookie 已更新');
  };

  const remove = async (row: SessionRow) => {
    if (!window.confirm(`删除 session「${row.label}」？`)) return;
    const res = await platformApiFetch(`/api/platform/geo-lookup/sessions/${row.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr((j as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`);
      return;
    }
    await load();
  };

  const testOne = async (row: SessionRow) => {
    setTestingId(row.id);
    setErr('');
    setMsg('');
    try {
      const res = await platformApiFetch(`/api/platform/geo-lookup/sessions/${row.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eircode: 'D01 T2X2' }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr((j as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`);
        return;
      }
      const body = j as { ok?: boolean; formattedAddress?: string; reason?: string; eircode?: string };
      if (body.ok) {
        setMsg(
          body.formattedAddress
            ? `探测成功（${body.eircode}）：${body.formattedAddress}`
            : `探测成功（${body.eircode}），该邮编无门牌结果`,
        );
      } else {
        setErr(`探测失败：${body.reason || 'unknown'}`);
      }
      await load();
    } finally {
      setTestingId(null);
    }
  };

  const provider = state?.provider || 'google';

  return (
    <div style={{ width: '100%' }}>
      <h1 style={{ margin: '0 0 8px', fontSize: 22, fontWeight: 700, color: '#1a237e' }}>邮编查询</h1>
      <p style={{ margin: '0 0 20px', fontSize: 13, color: '#546e7a', lineHeight: 1.5 }}>
        收银和外送点餐共用这一套开关。Session 池按顺序试用；某个 Cookie 返回未登录则跳过下一个；全部失效后自动回退 Google（街区级）。Cookie 加密存 MongoDB，页面只显示末 4 位。这是过渡方案，长期仍建议正式门牌库。
      </p>

      {err ? (
        <div className="card" style={{ padding: 16, marginBottom: 16, borderColor: '#c62828', color: '#b71c1c' }}>{err}</div>
      ) : null}
      {msg ? (
        <div className="card" style={{ padding: 16, marginBottom: 16, borderColor: '#2e7d32', color: '#1b5e20' }}>{msg}</div>
      ) : null}
      {state?.degradedAt && provider === 'session' ? (
        <div className="card" style={{ padding: 16, marginBottom: 16, borderColor: '#ef6c00', color: '#e65100' }}>
          Session 池当前不可用（{fmtTime(state.degradedAt)} 起已回退 Google）。请更新 Cookie 后再探测。
        </div>
      ) : null}

      <div className="card" style={{ padding: 20, marginBottom: 20 }}>
        <div style={{ fontWeight: 700, marginBottom: 12 }}>查询方案</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
          <label style={{ fontSize: 14, display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="radio"
              name="geo-provider"
              checked={provider === 'google'}
              disabled={providerSaving || loading}
              onChange={() => void setProvider('google')}
            />
            Google（街区级）
          </label>
          <label style={{ fontSize: 14, display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="radio"
              name="geo-provider"
              checked={provider === 'session'}
              disabled={providerSaving || loading}
              onChange={() => void setProvider('session')}
            />
            Session 池（门牌级，失效回退 Google）
          </label>
          <span style={{ fontSize: 12, color: '#546e7a' }}>
            可用 session：{state?.activeSessionCount ?? 0}
          </span>
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 20 }}>
        <div style={{ fontWeight: 700, marginBottom: 12 }}>添加 Session</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 640 }}>
          <label style={{ fontSize: 13 }}>
            备注名
            <input
              className="input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="例如 账号 A"
              style={{ display: 'block', marginTop: 4, width: '100%' }}
            />
          </label>
          <label style={{ fontSize: 13 }}>
            Cookie（只在保存时提交一次）
            <textarea
              className="input"
              value={cookie}
              onChange={(e) => setCookie(e.target.value)}
              placeholder="SESSION=… 或完整 Cookie 头。保存后不会再显示全文。"
              rows={3}
              autoComplete="off"
              spellCheck={false}
              style={{ display: 'block', marginTop: 4, width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
            />
          </label>
          <div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={adding || !label.trim() || !cookie.trim()}
              onClick={() => void addSession()}
            >
              {adding ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ background: '#f5f5f5', textAlign: 'left' }}>
              <th style={{ padding: '12px 16px' }}>备注</th>
              <th style={{ padding: '12px 16px' }}>Cookie</th>
              <th style={{ padding: '12px 16px' }}>状态</th>
              <th style={{ padding: '12px 16px' }}>上次成功</th>
              <th style={{ padding: '12px 16px' }} />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} style={{ padding: 20, color: '#888' }}>加载中…</td></tr>
            ) : !state?.sessions.length ? (
              <tr><td colSpan={5} style={{ padding: 20, color: '#888' }}>尚未添加 session</td></tr>
            ) : state.sessions.map((s) => (
              <tr key={s.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: '12px 16px', fontWeight: 600 }}>{s.label}</td>
                <td style={{ padding: '12px 16px', fontFamily: 'ui-monospace, monospace' }}>{s.cookieSuffix}</td>
                <td style={{ padding: '12px 16px' }}>
                  <div>{statusLabel(s)}</div>
                  {s.lastFailReason ? (
                    <div style={{ fontSize: 12, color: '#c62828' }}>{s.lastFailReason}</div>
                  ) : null}
                </td>
                <td style={{ padding: '12px 16px', fontSize: 12, color: '#546e7a' }}>{fmtTime(s.lastOkAt)}</td>
                <td style={{ padding: '12px 16px', whiteSpace: 'nowrap' }}>
                  <button type="button" className="btn btn-outline" style={{ fontSize: 12, marginRight: 6 }} disabled={testingId === s.id} onClick={() => void testOne(s)}>
                    {testingId === s.id ? '探测中…' : '探测'}
                  </button>
                  <button type="button" className="btn btn-outline" style={{ fontSize: 12, marginRight: 6 }} onClick={() => void replaceCookie(s)}>
                    更新 Cookie
                  </button>
                  <button type="button" className="btn btn-outline" style={{ fontSize: 12, marginRight: 6 }} onClick={() => void toggleEnabled(s)}>
                    {s.enabled ? '停用' : '启用'}
                  </button>
                  <button type="button" className="btn btn-outline" style={{ fontSize: 12, color: '#b71c1c', borderColor: '#ffcdd2' }} onClick={() => void remove(s)}>
                    删除
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
