import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';

type NotificationMethod = 'off' | 'sms' | 'whatsapp';

type PolicyRule = {
  channel: 'phone' | 'delivery';
  channelSub: '' | 'qr' | 'phone';
  event: string;
  method: NotificationMethod;
  templateKey: string;
};

type TemplateRow = {
  key: string;
  method: 'sms' | 'whatsapp';
  body: string;
  whatsappTemplateName?: string;
  whatsappTemplateLanguage?: string;
};

type LogRow = {
  _id: string;
  event: string;
  method?: string;
  status: string;
  toE164?: string;
  skipReason?: string;
  error?: string;
  createdAt: string;
};

const EVENT_LABELS: Record<string, string> = {
  order_placed: 'Order placed',
  payment_confirmed: 'Payment confirmed',
  ready_for_pickup: 'Ready / prepared',
  out_for_delivery: 'Out for delivery',
  order_completed: 'Completed',
  order_cancelled: 'Cancelled',
};

const CHANNEL_ROWS: { channel: PolicyRule['channel']; channelSub: PolicyRule['channelSub']; label: string }[] = [
  { channel: 'phone', channelSub: '', label: 'Phone orders' },
  { channel: 'delivery', channelSub: 'qr', label: 'Delivery (QR)' },
  { channel: 'delivery', channelSub: 'phone', label: 'Delivery (phone)' },
];

const EVENTS = Object.keys(EVENT_LABELS);

function ruleKey(r: PolicyRule): string {
  return `${r.channel}:${r.channelSub}:${r.event}`;
}

function templateKeyForRule(
  channel: PolicyRule['channel'],
  channelSub: PolicyRule['channelSub'],
  event: string,
  method: NotificationMethod,
): string {
  const sub = channelSub ? `_${channelSub}` : '';
  const suffix = method === 'off' ? 'sms' : method;
  return `${channel}${sub}_${event}_${suffix}`;
}

export default function CustomerNotifications() {
  const { t } = useTranslation();
  const { token } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [rules, setRules] = useState<PolicyRule[]>([]);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [sentThisMonth, setSentThisMonth] = useState(0);
  const [whatsapp, setWhatsapp] = useState({
    enabled: false,
    provider: 'twilio' as 'twilio' | 'meta',
    twilioFrom: '',
    metaPhoneNumberId: '',
    metaAccessToken: '',
  });
  const [testPhone, setTestPhone] = useState('');
  const [testTemplateKey, setTestTemplateKey] = useState('');
  const [testMsg, setTestMsg] = useState('');
  const [editingTpl, setEditingTpl] = useState<TemplateRow | null>(null);

  const ruleMap = useMemo(() => {
    const m = new Map<string, PolicyRule>();
    for (const r of rules) m.set(ruleKey(r), r);
    return m;
  }, [rules]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/admin/customer-notifications', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setEnabled(data.policy?.enabled !== false);
      setRules(data.policy?.rules || data.defaultRules || []);
      setTemplates(data.templates || []);
      setLogs(data.logs || []);
      setSentThisMonth(data.stats?.sentThisMonth ?? 0);
      if (data.whatsapp) {
        setWhatsapp({
          enabled: !!data.whatsapp.enabled,
          provider: data.whatsapp.provider === 'meta' ? 'meta' : 'twilio',
          twilioFrom: data.whatsapp.twilioFrom || '',
          metaPhoneNumberId: data.whatsapp.metaPhoneNumberId || '',
          metaAccessToken: data.whatsapp.metaAccessToken || '',
        });
      }
      const logsRes = await apiFetch('/api/admin/customer-notifications/logs?limit=30', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (logsRes.ok) setLogs(await logsRes.json());
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const setRuleMethod = (channel: PolicyRule['channel'], channelSub: PolicyRule['channelSub'], event: string, method: NotificationMethod) => {
    setRules((prev) => {
      const idx = prev.findIndex((r) => r.channel === channel && r.channelSub === channelSub && r.event === event);
      if (idx < 0) return prev;
      const next = [...prev];
      next[idx] = {
        ...next[idx],
        method,
        templateKey: templateKeyForRule(channel, channelSub, event, method),
      };
      return next;
    });
  };

  const savePolicy = async () => {
    setSaving(true);
    try {
      const res = await apiFetch('/api/admin/customer-notifications/policy', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, rules }),
      });
      if (res.ok) alert(t('admin.customerNotify.saved'));
    } finally {
      setSaving(false);
    }
  };

  const saveWhatsapp = async () => {
    setSaving(true);
    try {
      await apiFetch('/api/admin/customer-notifications/whatsapp', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(whatsapp),
      });
      alert(t('admin.customerNotify.saved'));
      void load();
    } finally {
      setSaving(false);
    }
  };

  const saveTemplate = async (tpl: TemplateRow) => {
    await apiFetch(`/api/admin/customer-notifications/templates/${encodeURIComponent(tpl.key)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(tpl),
    });
    setEditingTpl(null);
    void load();
  };

  const sendTest = async (method: 'sms' | 'whatsapp') => {
    const res = await apiFetch('/api/admin/customer-notifications/test-send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: testPhone,
        method,
        templateKey: testTemplateKey || undefined,
        body: testMsg || undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) alert(t('admin.customerNotify.testOk'));
    else alert(data?.error?.message || data?.message || t('admin.customerNotify.testFail'));
  };

  if (loading) {
    return <div style={{ padding: 24 }}>{t('common.loading')}</div>;
  }

  return (
    <div style={{ maxWidth: 1100 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{t('admin.customerNotify.title')}</h2>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.5 }}>
        {t('admin.customerNotify.intro')}
      </p>

      <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t('admin.customerNotify.masterEnable')}
        </label>
        <span style={{ fontSize: 13, color: 'var(--text-light)' }}>
          {t('admin.customerNotify.sentMonth', { count: sentThisMonth })}
        </span>
      </div>

      <section style={{ marginBottom: 28 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>{t('admin.customerNotify.matrixTitle')}</h3>
        <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <th style={{ textAlign: 'left', padding: 10 }}>{t('admin.customerNotify.channel')}</th>
                {EVENTS.map((ev) => (
                  <th key={ev} style={{ padding: 8, minWidth: 110 }}>{EVENT_LABELS[ev]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CHANNEL_ROWS.map((row) => (
                <tr key={`${row.channel}-${row.channelSub}`} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: 10, fontWeight: 600 }}>{row.label}</td>
                  {EVENTS.map((ev) => {
                    const r = ruleMap.get(`${row.channel}:${row.channelSub}:${ev}`);
                    const method = r?.method ?? 'off';
                    return (
                      <td key={ev} style={{ padding: 6, textAlign: 'center' }}>
                        <select
                          value={method}
                          onChange={(e) => setRuleMethod(row.channel, row.channelSub, ev, e.target.value as NotificationMethod)}
                          style={{ fontSize: 11, padding: '4px 6px', maxWidth: '100%' }}
                        >
                          <option value="off">Off</option>
                          <option value="sms">SMS</option>
                          <option value="whatsapp">WhatsApp</option>
                        </select>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} disabled={saving} onClick={() => void savePolicy()}>
          {saving ? t('common.loading') : t('admin.customerNotify.savePolicy')}
        </button>
      </section>

      <section style={{ marginBottom: 28 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>WhatsApp</h3>
        <div style={{ display: 'grid', gap: 10, maxWidth: 480 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={whatsapp.enabled} onChange={(e) => setWhatsapp((w) => ({ ...w, enabled: e.target.checked }))} />
            Enable WhatsApp for this store
          </label>
          <label>
            Provider
            <select
              value={whatsapp.provider}
              onChange={(e) => setWhatsapp((w) => ({ ...w, provider: e.target.value as 'twilio' | 'meta' }))}
              style={{ display: 'block', width: '100%', marginTop: 4, padding: 8 }}
            >
              <option value="twilio">Twilio</option>
              <option value="meta">Meta Cloud API</option>
            </select>
          </label>
          {whatsapp.provider === 'twilio' ? (
            <label>
              Twilio WhatsApp From
              <input
                className="input"
                placeholder="whatsapp:+353..."
                value={whatsapp.twilioFrom}
                onChange={(e) => setWhatsapp((w) => ({ ...w, twilioFrom: e.target.value }))}
                style={{ width: '100%', marginTop: 4 }}
              />
            </label>
          ) : (
            <>
              <label>
                Meta Phone Number ID
                <input className="input" value={whatsapp.metaPhoneNumberId} onChange={(e) => setWhatsapp((w) => ({ ...w, metaPhoneNumberId: e.target.value }))} style={{ width: '100%', marginTop: 4 }} />
              </label>
              <label>
                Meta Access Token
                <input className="input" type="password" value={whatsapp.metaAccessToken} onChange={(e) => setWhatsapp((w) => ({ ...w, metaAccessToken: e.target.value }))} style={{ width: '100%', marginTop: 4 }} />
              </label>
            </>
          )}
          <button type="button" className="btn btn-outline" disabled={saving} onClick={() => void saveWhatsapp()}>Save WhatsApp</button>
        </div>
      </section>

      <section style={{ marginBottom: 28 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>{t('admin.customerNotify.templatesTitle')}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {templates.map((tpl) => (
            <div key={tpl.key} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                <strong style={{ fontSize: 12 }}>{tpl.key}</strong>
                <span style={{ fontSize: 11, color: 'var(--text-light)' }}>{tpl.method}</span>
              </div>
              <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: 0, color: '#444' }}>{tpl.body}</pre>
              <button type="button" className="btn btn-ghost" style={{ marginTop: 8, fontSize: 11 }} onClick={() => setEditingTpl({ ...tpl })}>
                Edit
              </button>
            </div>
          ))}
        </div>
      </section>

      {editingTpl ? (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 16, width: 480, maxWidth: '94vw' }}>
            <h4 style={{ marginBottom: 8 }}>{editingTpl.key}</h4>
            <textarea
              className="input"
              rows={5}
              value={editingTpl.body}
              onChange={(e) => setEditingTpl({ ...editingTpl, body: e.target.value })}
              style={{ width: '100%', marginBottom: 8 }}
            />
            {editingTpl.method === 'whatsapp' ? (
              <input
                className="input"
                placeholder="WhatsApp template name"
                value={editingTpl.whatsappTemplateName || ''}
                onChange={(e) => setEditingTpl({ ...editingTpl, whatsappTemplateName: e.target.value })}
                style={{ width: '100%', marginBottom: 8 }}
              />
            ) : null}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn btn-outline" onClick={() => setEditingTpl(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={() => void saveTemplate(editingTpl)}>Save</button>
            </div>
          </div>
        </div>
      ) : null}

      <section style={{ marginBottom: 28 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>{t('admin.customerNotify.testTitle')}</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
          <input className="input" placeholder="08xxxxxxxx" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} style={{ width: 160 }} />
          <select className="input" value={testTemplateKey} onChange={(e) => setTestTemplateKey(e.target.value)} style={{ width: 220 }}>
            <option value="">(custom / first template)</option>
            {templates.map((tpl) => (
              <option key={tpl.key} value={tpl.key}>{tpl.key}</option>
            ))}
          </select>
          <input
            className="input"
            placeholder="Custom message (optional)"
            value={testMsg}
            onChange={(e) => setTestMsg(e.target.value)}
            style={{ width: 240 }}
          />
          <button type="button" className="btn btn-outline" onClick={() => void sendTest('sms')}>Test SMS</button>
          <button type="button" className="btn btn-outline" onClick={() => void sendTest('whatsapp')}>Test WhatsApp</button>
        </div>
      </section>

      <section>
        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>{t('admin.customerNotify.logsTitle')}</h3>
        <div style={{ fontSize: 12, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          {logs.length === 0 ? (
            <div style={{ padding: 12, color: 'var(--text-light)' }}>—</div>
          ) : (
            logs.map((log) => (
              <div key={log._id} style={{ padding: '8px 10px', borderTop: '1px solid #eee' }}>
                <strong>{log.event}</strong> · {log.status} · {log.method || '—'} · {log.toE164 || '—'}
                {log.skipReason ? ` · ${log.skipReason}` : ''}
                {log.error ? ` · ${log.error}` : ''}
                <div style={{ color: '#888', fontSize: 11 }}>{new Date(log.createdAt).toLocaleString()}</div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
