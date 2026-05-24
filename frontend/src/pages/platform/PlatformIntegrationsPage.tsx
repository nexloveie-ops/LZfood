import { useCallback, useEffect, useState } from 'react';
import { platformApiFetch } from '../../api/client';

type Alert = { level: 'warning' | 'critical'; message: string };

type Overview = {
  fetchedAt: string;
  twilio: {
    configured: boolean;
    fromConfigured: boolean;
    balance: string | null;
    currency: string | null;
    smsOutboundThisMonth: number | null;
    error: string | null;
    consoleBillingUrl: string;
  };
  googleGeo: { configured: boolean; note: string };
  googleTranslate: {
    configured: boolean;
    charactersThisMonth: number;
    requestsThisMonth: number;
    freeTierCharsPerMonth: number;
    estimatedRemainingThisMonth: number;
    monthUtc: string;
    consoleUrl: string;
    note: string;
  };
  gcs: { configured: boolean; bucket: string | null };
  alerts: Alert[];
};

export default function PlatformIntegrationsPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const res = await platformApiFetch('/api/platform/integrations-overview');
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr((j as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`);
        setData(null);
        return;
      }
      setData((await res.json()) as Overview);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Load failed');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#1a237e' }}>API usage & balances</h1>
        <button type="button" className="btn btn-outline" onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {err ? (
        <div className="card" style={{ padding: 16, marginBottom: 16, borderColor: '#c62828', color: '#b71c1c' }}>
          {err}
        </div>
      ) : null}

      {data?.alerts?.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
          {data.alerts.map((a, i) => (
            <div
              key={i}
              style={{
                padding: '12px 14px',
                borderRadius: 10,
                border: `1px solid ${a.level === 'critical' ? '#c62828' : '#f9a825'}`,
                background: a.level === 'critical' ? '#ffebee' : '#fff8e1',
                color: '#333',
                fontSize: 14,
                lineHeight: 1.45,
              }}
            >
              <strong>{a.level === 'critical' ? 'Action needed · ' : 'Reminder · '}</strong>
              {a.message}
            </div>
          ))}
        </div>
      ) : null}

      {loading && !data ? (
        <p style={{ color: '#666' }}>Loading…</p>
      ) : null}

      {data ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card" style={{ padding: 18 }}>
            <h2 style={{ margin: '0 0 12px', fontSize: 16, color: '#283593' }}>Twilio (SMS — member wallet spend)</h2>
            {!data.twilio.configured ? (
              <p style={{ margin: 0, color: '#666' }}>Not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN on the server.</p>
            ) : (
              <>
                {data.twilio.error ? (
                  <p style={{ margin: '0 0 8px', color: '#c62828' }}>Balance API: {data.twilio.error}</p>
                ) : (
                  <p style={{ margin: '0 0 8px', fontSize: 15 }}>
                    <strong>Balance:</strong>{' '}
                    {data.twilio.balance != null && data.twilio.currency ?
                      `${data.twilio.balance} ${data.twilio.currency}`
                    : '—'}
                  </p>
                )}
                <p style={{ margin: '0 0 8px', fontSize: 14, color: '#444' }}>
                  <strong>Outbound SMS (this month, UTC):</strong>{' '}
                  {data.twilio.smsOutboundThisMonth != null ? data.twilio.smsOutboundThisMonth : '—'}
                </p>
                <p style={{ margin: '0 0 8px', fontSize: 14, color: '#444' }}>
                  <strong>Sender configured:</strong> {data.twilio.fromConfigured ? 'Yes' : 'No (set TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID)'}
                </p>
                <a href={data.twilio.consoleBillingUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 14, fontWeight: 600 }}>
                  Open Twilio billing →
                </a>
              </>
            )}
          </div>

          <div className="card" style={{ padding: 18 }}>
            <h2 style={{ margin: '0 0 12px', fontSize: 16, color: '#283593' }}>Google Cloud Translation (GTS)</h2>
            <p style={{ margin: '0 0 8px', fontSize: 14, color: '#444' }}>
              <strong>Server key present (GTS):</strong> {data.googleTranslate.configured ? 'Yes' : 'No'}
            </p>
            {data.googleTranslate.configured ? (
              <>
                <p style={{ margin: '0 0 8px', fontSize: 14, color: '#444' }}>
                  <strong>Characters this month (UTC {data.googleTranslate.monthUtc}):</strong>{' '}
                  {data.googleTranslate.charactersThisMonth.toLocaleString()} /{' '}
                  {data.googleTranslate.freeTierCharsPerMonth.toLocaleString()} free
                </p>
                <p style={{ margin: '0 0 8px', fontSize: 14, color: '#444' }}>
                  <strong>Estimated remaining (free tier):</strong>{' '}
                  {data.googleTranslate.estimatedRemainingThisMonth.toLocaleString()}
                </p>
                <p style={{ margin: '0 0 8px', fontSize: 14, color: '#444' }}>
                  <strong>Translation requests (this app):</strong> {data.googleTranslate.requestsThisMonth.toLocaleString()}
                </p>
                <p style={{ margin: '0 0 8px', fontSize: 13, color: '#666' }}>{data.googleTranslate.note}</p>
                <a
                  href={data.googleTranslate.consoleUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 14, fontWeight: 600, display: 'inline-block', marginTop: 4 }}
                >
                  Google Cloud Translation metrics →
                </a>
              </>
            ) : (
              <p style={{ margin: 0, fontSize: 13, color: '#666' }}>
                Set <code style={{ fontSize: 12 }}>GTS</code> on the server for cashier ad-hoc option translation.
              </p>
            )}
          </div>

          <div className="card" style={{ padding: 18 }}>
            <h2 style={{ margin: '0 0 12px', fontSize: 16, color: '#283593' }}>Google Maps (Geocoding)</h2>
            <p style={{ margin: 0, fontSize: 14, color: '#444' }}>
              <strong>Server key present:</strong> {data.googleGeo.configured ? 'Yes' : 'No'}{' '}
              <span style={{ color: '#666' }}>— {data.googleGeo.note}</span>
            </p>
            <a href="https://console.cloud.google.com/apis/dashboard" target="_blank" rel="noopener noreferrer" style={{ fontSize: 14, fontWeight: 600, display: 'inline-block', marginTop: 8 }}>
              Google Cloud Console →
            </a>
          </div>

          <div className="card" style={{ padding: 18 }}>
            <h2 style={{ margin: '0 0 12px', fontSize: 16, color: '#283593' }}>File storage (GCS)</h2>
            <p style={{ margin: 0, fontSize: 14, color: '#444' }}>
              <strong>Production bucket:</strong>{' '}
              {data.gcs.configured && data.gcs.bucket ? data.gcs.bucket : 'Not set (local uploads / dev)'}
            </p>
            <p style={{ margin: '8px 0 0', fontSize: 13, color: '#666' }}>
              Billing and quota for Cloud Storage are in Google Cloud Console.
            </p>
          </div>

          <p style={{ fontSize: 12, color: '#888', margin: '8px 0 0' }}>
            Last updated: {new Date(data.fetchedAt).toLocaleString()}
          </p>
        </div>
      ) : null}
    </div>
  );
}
