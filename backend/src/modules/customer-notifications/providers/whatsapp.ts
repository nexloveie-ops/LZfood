import type { WhatsAppConfigDoc } from '../schemas';

type SendWhatsAppParams = {
  toE164: string;
  body: string;
  templateName?: string;
  templateLanguage?: string;
  config: WhatsAppConfigDoc;
};

function twilioCreds(): { sid: string; token: string } | null {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!sid || !token) return null;
  return { sid, token };
}

async function sendTwilioWhatsApp(params: SendWhatsAppParams): Promise<string> {
  const creds = twilioCreds();
  if (!creds) throw new Error('TWILIO_NOT_CONFIGURED');
  const from = params.config.twilioFrom?.trim() || process.env.TWILIO_WHATSAPP_FROM?.trim();
  if (!from) throw new Error('WHATSAPP_FROM_MISSING');

  const to = params.toE164.startsWith('whatsapp:') ? params.toE164 : `whatsapp:${params.toE164}`;
  const fromAddr = from.startsWith('whatsapp:') ? from : `whatsapp:${from}`;

  const urlParams = new URLSearchParams();
  urlParams.set('To', to);
  urlParams.set('From', fromAddr);
  urlParams.set('Body', params.body);

  const auth = Buffer.from(`${creds.sid}:${creds.token}`).toString('base64');
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.sid)}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: urlParams.toString(),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio WhatsApp HTTP ${res.status}: ${text.slice(0, 280)}`);
  }
  const data = (await res.json()) as { sid?: string };
  return data.sid || '';
}

async function sendMetaWhatsApp(params: SendWhatsAppParams): Promise<string> {
  const phoneNumberId = params.config.metaPhoneNumberId?.trim();
  const token = params.config.metaAccessToken?.trim();
  if (!phoneNumberId || !token) throw new Error('META_WHATSAPP_NOT_CONFIGURED');

  const templateName = params.templateName?.trim();
  if (!templateName) {
    throw new Error('META_WHATSAPP_TEMPLATE_REQUIRED');
  }

  const to = params.toE164.replace(/^\+/, '');
  const lang = params.templateLanguage?.trim() || 'en';
  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: lang },
        components: [
          {
            type: 'body',
            parameters: [{ type: 'text', text: params.body.slice(0, 1024) }],
          },
        ],
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Meta WhatsApp HTTP ${res.status}: ${text.slice(0, 280)}`);
  }
  const data = (await res.json()) as { messages?: { id?: string }[] };
  return data.messages?.[0]?.id || '';
}

export async function sendWhatsAppMessage(params: SendWhatsAppParams): Promise<string> {
  if (!params.config.enabled) {
    throw new Error('WHATSAPP_DISABLED');
  }
  if (params.config.provider === 'meta') {
    return sendMetaWhatsApp(params);
  }
  return sendTwilioWhatsApp(params);
}
