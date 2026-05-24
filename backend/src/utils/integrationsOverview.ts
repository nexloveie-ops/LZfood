import { GTS_FREE_TIER_CHARS_PER_MONTH, getGtsUsageForMonth } from './translationUsage';

function twilioBasicAuthHeader(): string | null {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!sid || !token) return null;
  return `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
}

async function fetchTwilioJson(pathSuffix: string): Promise<unknown> {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const auth = twilioBasicAuthHeader();
  if (!sid || !auth) throw new Error('Twilio not configured');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}${pathSuffix}`;
  const res = await fetch(url, { headers: { Authorization: auth } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { message?: string })?.message || JSON.stringify(data).slice(0, 200);
    throw new Error(`${res.status}: ${msg}`);
  }
  return data;
}

/** First day of month through today (UTC), for “month to date” usage. */
function monthToDateRangeUtc(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(now) };
}

async function twilioSmsOutboundCountThisMonth(): Promise<number | null> {
  try {
    const { start, end } = monthToDateRangeUtc();
    let total = 0;
    let pages = 0;
    const sid = process.env.TWILIO_ACCOUNT_SID!.trim();
    const auth = twilioBasicAuthHeader()!;
    const root = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}`;
    let nextUrl: string | null =
      `${root}/Usage/Records.json?Category=sms-outbound&StartDate=${start}&EndDate=${end}&PageSize=100`;

    while (nextUrl && pages < 20) {
      pages += 1;
      const res = await fetch(nextUrl, { headers: { Authorization: auth } });
      const data = (await res.json().catch(() => ({}))) as {
        usage_records?: { category?: string; count?: string }[];
        next_page_uri?: string | null;
      };
      if (!res.ok) return null;
      for (const r of data.usage_records || []) {
        if (r.count != null) total += Number(r.count) || 0;
      }
      const rel = data.next_page_uri;
      nextUrl =
        rel ?
          rel.startsWith('http') ? rel : `https://api.twilio.com${rel}`
        : null;
    }
    return total;
  } catch {
    return null;
  }
}

export type IntegrationsOverview = {
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
  googleGeo: {
    configured: boolean;
    note: string;
  };
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
  gcs: {
    configured: boolean;
    bucket: string | null;
  };
  alerts: Array<{ level: 'warning' | 'critical'; message: string }>;
};

export async function buildIntegrationsOverview(): Promise<IntegrationsOverview> {
  const fetchedAt = new Date().toISOString();
  const alerts: IntegrationsOverview['alerts'] = [];

  const lowUsd = Number(process.env.TWILIO_LOW_BALANCE_USD || '5') || 5;

  const twilio: IntegrationsOverview['twilio'] = {
    configured: false,
    fromConfigured: !!(process.env.TWILIO_FROM?.trim() || process.env.TWILIO_MESSAGING_SERVICE_SID?.trim()),
    balance: null,
    currency: null,
    smsOutboundThisMonth: null,
    error: null,
    consoleBillingUrl: 'https://www.twilio.com/console/billing',
  };

  if (process.env.TWILIO_ACCOUNT_SID?.trim() && process.env.TWILIO_AUTH_TOKEN?.trim()) {
    twilio.configured = true;
    try {
      const bal = (await fetchTwilioJson('/Balance.json')) as {
        balance?: string;
        currency?: string;
      };
      twilio.balance = bal.balance ?? null;
      twilio.currency = bal.currency ?? null;
      if (twilio.balance != null && twilio.currency) {
        const n = parseFloat(twilio.balance);
        const threshold = twilio.currency === 'USD' ? lowUsd : 5;
        if (!Number.isNaN(n) && n < threshold) {
          alerts.push({
            level: n < 1 ? 'critical' : 'warning',
            message: `Twilio balance is low (${twilio.balance} ${twilio.currency}). Top up soon to avoid SMS failures.`,
          });
        }
      }
    } catch (e) {
      twilio.error = e instanceof Error ? e.message : 'Twilio balance fetch failed';
      alerts.push({
        level: 'warning',
        message: `Could not read Twilio balance: ${twilio.error}`,
      });
    }
    twilio.smsOutboundThisMonth = await twilioSmsOutboundCountThisMonth();
  }

  if (twilio.configured && !twilio.fromConfigured) {
    alerts.push({
      level: 'warning',
      message: 'Twilio credentials are set but TWILIO_FROM (or TWILIO_MESSAGING_SERVICE_SID) is missing — SMS will not send.',
    });
  }

  const googleGeo = {
    configured: !!process.env.GoogleGeo?.trim(),
    note: 'Usage and quotas are managed in Google Cloud Console → APIs & Services.',
  };

  const gtsUsage = await getGtsUsageForMonth();
  const gtsConfigured = !!process.env.GTS?.trim();
  const gtsChars = gtsUsage.characters;
  const googleTranslate = {
    configured: gtsConfigured,
    charactersThisMonth: gtsChars,
    requestsThisMonth: gtsUsage.requests,
    freeTierCharsPerMonth: GTS_FREE_TIER_CHARS_PER_MONTH,
    estimatedRemainingThisMonth: Math.max(0, GTS_FREE_TIER_CHARS_PER_MONTH - gtsChars),
    monthUtc: gtsUsage.month,
    consoleUrl: 'https://console.cloud.google.com/apis/api/translate.googleapis.com/metrics',
    note: 'Free tier: 500,000 source characters/month (NMT). Usage below is counted by this app when staff use「译成英文」.',
  };

  if (gtsConfigured && gtsChars >= GTS_FREE_TIER_CHARS_PER_MONTH * 0.9) {
    alerts.push({
      level: gtsChars >= GTS_FREE_TIER_CHARS_PER_MONTH ? 'critical' : 'warning',
      message: `Google Translation (GTS) usage this month: ${gtsChars.toLocaleString()} / ${GTS_FREE_TIER_CHARS_PER_MONTH.toLocaleString()} free characters.`,
    });
  }

  const gcsBucket = process.env.GCS_BUCKET?.trim() || null;
  const gcs = {
    configured: !!gcsBucket && !/^1|true|yes$/i.test(String(process.env.USE_LOCAL_UPLOADS || '').trim()),
    bucket: gcsBucket,
  };

  if (!twilio.configured) {
    alerts.push({
      level: 'warning',
      message: 'Twilio is not configured — member spend SMS notifications are disabled.',
    });
  }

  return {
    fetchedAt,
    twilio,
    googleGeo,
    googleTranslate,
    gcs,
    alerts,
  };
}
