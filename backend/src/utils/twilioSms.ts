import mongoose from 'mongoose';
import { getModels } from '../getModels';

/** Normalize Irish member mobiles (e.g. 08xxxxxxxx) to E.164 for Twilio. Returns null if unsupported. */
export function memberPhoneToSmsE164(raw: string): string | null {
  const t = String(raw || '').trim();
  let d = t.replace(/\D/g, '');
  if (!d) return null;

  if (d.startsWith('353')) {
    d = d.slice(3);
    if (d.length === 9 && /^8\d{8}$/.test(d)) return `+353${d}`;
    if (d.length === 10 && d.startsWith('0')) return `+353${d.slice(1)}`;
  }
  if (d.length === 10 && d.startsWith('08') && /^08\d{8}$/.test(d)) {
    return `+353${d.slice(1)}`;
  }
  if (d.length === 9 && /^8\d{8}$/.test(d)) {
    return `+353${d}`;
  }
  if (t.startsWith('+')) {
    const rest = t.replace(/\D/g, '');
    if (rest.length >= 10) return `+${rest}`;
  }
  return null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function twilioSendSms(to: string, body: string): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from = process.env.TWILIO_FROM?.trim();
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  if (!sid || !token) return;
  if (!from && !messagingServiceSid) {
    console.warn('[twilio] skip SMS: set TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID');
    return;
  }

  const params = new URLSearchParams();
  params.set('To', to);
  params.set('Body', body);
  if (messagingServiceSid) params.set('MessagingServiceSid', messagingServiceSid);
  else params.set('From', from!);

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio HTTP ${res.status}: ${text.slice(0, 280)}`);
  }
}

/** After a member wallet spend succeeds; failures are logged only. */
export async function sendMemberWalletSpendSms(params: {
  storeId: mongoose.Types.ObjectId;
  memberPhoneLocal: string;
  spentEuro: number;
  balanceEuro: number;
}): Promise<void> {
  const to = memberPhoneToSmsE164(params.memberPhoneLocal);
  if (!to) {
    console.warn('[twilio] skip spend SMS: unsupported phone format', params.memberPhoneLocal);
    return;
  }

  let head = '';
  try {
    const { Store } = getModels();
    const store = (await Store.findById(params.storeId).select('displayName').lean()) as {
      displayName?: string;
    } | null;
    const dn = store?.displayName?.trim();
    if (dn) head = `${dn}: `;
  } catch {
    /* ignore store name */
  }

  const spent = round2(params.spentEuro);
  const bal = round2(params.balanceEuro);
  const body = `${head}€${spent.toFixed(2)} was charged from your wallet. Current balance: €${bal.toFixed(2)}.`;

  await twilioSendSms(to, body);
}

/** 会员自助短信（找回 PIN 等）前调用；未配置则勿改库 */
export function assertTwilioSmsReadyForOutbound(): void {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from = process.env.TWILIO_FROM?.trim();
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  if (!sid || !token) {
    throw new Error('TWILIO_NOT_CONFIGURED');
  }
  if (!from && !messagingServiceSid) {
    throw new Error('TWILIO_FROM_MISSING');
  }
}

/** 会员 PIN 重置短信（中英双语一行） */
export async function sendMemberPinResetSms(params: {
  storeId: mongoose.Types.ObjectId;
  memberPhoneLocal: string;
  newPin: string;
}): Promise<void> {
  const to = memberPhoneToSmsE164(params.memberPhoneLocal);
  if (!to) {
    throw new Error('PHONE_SMS_UNSUPPORTED');
  }
  let head = '';
  try {
    const { Store } = getModels();
    const store = (await Store.findById(params.storeId).select('displayName').lean()) as {
      displayName?: string;
    } | null;
    const dn = store?.displayName?.trim();
    if (dn) head = `${dn}: `;
  } catch {
    /* ignore store name */
  }
  const body = `${head}您的新会员 PIN 为 ${params.newPin}，请在会员页登录。如非本人操作请致电门店。 Your new wallet PIN is ${params.newPin}. Sign in on the member page.`;
  await twilioSendSms(to, body);
}
