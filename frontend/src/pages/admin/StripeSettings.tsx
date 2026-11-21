import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';

type StripeHealthBody = {
  ok: boolean;
  checks: {
    publishableKeyFormatOk: boolean;
    secretKeyFormatOk: boolean;
    modeMatch: boolean;
    publishableMode: string;
    secretMode: string;
  };
  stripeApi: { ok: true } | { ok: false; code: string; message: string };
};

export default function StripeSettings() {
  const { t } = useTranslation();
  const { token } = useAuth();
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const [publishableKey, setPublishableKey] = useState('');
  const [secretKeyDraft, setSecretKeyDraft] = useState('');
  const [hasSecret, setHasSecret] = useState(false);
  const [hasWebhookSecret, setHasWebhookSecret] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecretDraft, setWebhookSecretDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [copied, setCopied] = useState(false);
  const [health, setHealth] = useState<StripeHealthBody | null>(null);
  const [checkRunning, setCheckRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/admin/stripe-config', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const data = await res.json();
      setPublishableKey(typeof data.publishableKey === 'string' ? data.publishableKey : '');
      setHasSecret(!!data.hasSecret);
      setHasWebhookSecret(!!data.hasWebhookSecret);
      setWebhookUrl(typeof data.webhookUrl === 'string' ? data.webhookUrl : '');
      setSecretKeyDraft('');
      setWebhookSecretDraft('');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (clearSecret: boolean) => {
    setSaving(true);
    try {
      const body: {
        publishableKey: string;
        secretKey?: string;
        clearSecret?: boolean;
        webhookSecret?: string;
      } = {
        publishableKey,
      };
      if (clearSecret) {
        body.clearSecret = true;
      } else if (secretKeyDraft.trim().length > 0) {
        body.secretKey = secretKeyDraft.trim();
      }
      if (webhookSecretDraft.trim().length > 0) {
        body.webhookSecret = webhookSecretDraft.trim();
      }
      const res = await apiFetch('/api/admin/stripe-config', { method: 'PUT', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        alert(j?.error?.message || t('common.error'));
        return;
      }
      setSecretKeyDraft('');
      await load();
      alert(t('admin.savedSuccess'));
    } catch {
      alert(t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  const runHealthCheck = async () => {
    setCheckRunning(true);
    setHealth(null);
    try {
      const res = await apiFetch('/api/admin/stripe-health', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        alert(j?.error?.message || t('common.error'));
        return;
      }
      setHealth((await res.json()) as StripeHealthBody);
    } catch {
      alert(t('common.error'));
    } finally {
      setCheckRunning(false);
    }
  };

  if (loading) {
    return <div style={{ color: 'var(--text-light)' }}>{t('common.loading')}</div>;
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{t('admin.stripeSettings')}</h2>
      <p style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 16, maxWidth: 640, lineHeight: 1.5 }}>
        {t('admin.stripeSettingsHelp')}
      </p>

      <div className="card" style={{ padding: 20, maxWidth: 640 }}>
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-light)', marginBottom: 6 }}>
            {t('admin.stripePublishableKey')}
          </label>
          <input
            className="input"
            value={publishableKey}
            onChange={(e) => setPublishableKey(e.target.value)}
            placeholder="pk_live_... / pk_test_..."
            autoComplete="off"
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-light)', marginBottom: 6 }}>
            {t('admin.stripeSecretKey')}
            {hasSecret && (
              <span style={{ marginLeft: 8, color: 'var(--text-secondary)', fontWeight: 400 }}>({t('admin.stripeSecretSaved')})</span>
            )}
          </label>
          <input
            className="input"
            type="password"
            value={secretKeyDraft}
            onChange={(e) => setSecretKeyDraft(e.target.value)}
            placeholder={hasSecret ? t('admin.stripeSecretPlaceholder') : 'sk_live_... / sk_test_...'}
            autoComplete="new-password"
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 6 }}>{t('admin.stripeSecretHint')}</div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary" onClick={() => save(false)} disabled={saving}>
            {saving ? t('common.loading') : t('common.save')}
          </button>
          {hasSecret && (
            <button
              className="btn btn-outline"
              type="button"
              style={{ color: 'var(--red-primary)' }}
              onClick={() => {
                if (confirm(t('admin.stripeClearSecretConfirm'))) save(true);
              }}
              disabled={saving}
            >
              {t('admin.stripeClearSecret')}
            </button>
          )}
        </div>
      </div>

      <div className="card" style={{ padding: 20, maxWidth: 640, marginTop: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t('admin.stripeWebhookTitle')}</div>
        <p style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 12, lineHeight: 1.5 }}>
          {t('admin.stripeWebhookHelp')}
        </p>
        {webhookUrl ? (
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-light)', marginBottom: 6 }}>
              {t('admin.stripeWebhookUrl')}
              {hasWebhookSecret && (
                <span style={{ marginLeft: 8, color: 'var(--text-secondary)', fontWeight: 400 }}>
                  ({t('admin.stripeWebhookSecretSaved')})
                </span>
              )}
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input className="input" readOnly value={webhookUrl} style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} />
              <button
                type="button"
                className="btn btn-outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(webhookUrl);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  } catch {
                    /* ignore */
                  }
                }}
              >
                {copied ? t('admin.stripeWebhookCopied') : t('admin.stripeWebhookCopy')}
              </button>
            </div>
          </div>
        ) : null}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-light)', marginBottom: 6 }}>
            {t('admin.stripeWebhookSecret')}
          </label>
          <input
            className="input"
            type="password"
            value={webhookSecretDraft}
            onChange={(e) => setWebhookSecretDraft(e.target.value)}
            placeholder={t('admin.stripeWebhookSecretPlaceholder')}
            autoComplete="new-password"
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button className="btn btn-primary" type="button" onClick={() => save(false)} disabled={saving}>
            {saving ? t('common.loading') : t('common.save')}
          </button>
          <button
            className="btn btn-outline"
            type="button"
            disabled={registering || !hasSecret}
            onClick={async () => {
              setRegistering(true);
              try {
                const res = await apiFetch('/api/admin/stripe-webhook/register', { method: 'POST', headers });
                const j = await res.json().catch(() => null);
                if (!res.ok) {
                  alert(j?.error?.message || t('common.error'));
                  return;
                }
                await load();
                if (j?.needsPasteSecret) alert(t('admin.stripeWebhookNeedSecret'));
                else alert(j?.message || t('admin.stripeWebhookRegisterOk'));
              } catch {
                alert(t('common.error'));
              } finally {
                setRegistering(false);
              }
            }}
          >
            {registering ? t('common.loading') : t('admin.stripeWebhookRegister')}
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 20, maxWidth: 640, marginTop: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t('admin.stripeCheckConnection')}</div>
        <p style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 12, lineHeight: 1.5 }}>
          {t('admin.stripeHealthIntro')}
        </p>
        <button type="button" className="btn btn-outline" onClick={runHealthCheck} disabled={checkRunning || !token}>
          {checkRunning ? t('admin.stripeCheckRunning') : t('admin.stripeCheckConnection')}
        </button>

        {health && (
          <div
            style={{
              marginTop: 16,
              padding: 12,
              borderRadius: 8,
              background: health.ok ? 'rgba(46, 125, 50, 0.08)' : 'rgba(198, 40, 40, 0.06)',
              border: `1px solid ${health.ok ? 'rgba(46, 125, 50, 0.35)' : 'rgba(198, 40, 40, 0.25)'}`,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: health.ok ? '#2e7d32' : '#c62828' }}>
              {health.ok ? t('admin.stripeHealthOk') : t('admin.stripeHealthFail')}
            </div>
            <HealthRow label={t('admin.stripeHealthCheckPublishable')} pass={health.checks.publishableKeyFormatOk} t={t} />
            <HealthRow label={t('admin.stripeHealthCheckSecret')} pass={health.checks.secretKeyFormatOk} t={t} />
            <HealthRow label={t('admin.stripeHealthCheckMode')} pass={health.checks.modeMatch} t={t} />
            <HealthRow label={t('admin.stripeHealthCheckApi')} pass={health.stripeApi.ok} t={t} />
            <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 10, fontFamily: 'monospace' }}>
              pk:{health.checks.publishableMode} · sk:{health.checks.secretMode}
            </div>
            {!health.stripeApi.ok && (
              <div style={{ fontSize: 12, color: '#c62828', marginTop: 10 }}>
                <strong>{t('admin.stripeHealthError')}</strong>
                {' '}
                [{health.stripeApi.code}] {health.stripeApi.message}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function HealthRow({
  label,
  pass,
  t,
}: {
  label: string;
  pass: boolean;
  t: (k: string) => string;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, marginTop: 6 }}>
      <span>{label}</span>
      <span style={{ color: pass ? '#2e7d32' : '#c62828', whiteSpace: 'nowrap' }}>
        {pass ? t('admin.stripeHealthYes') : t('admin.stripeHealthNo')}
      </span>
    </div>
  );
}
