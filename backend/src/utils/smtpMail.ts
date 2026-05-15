import nodemailer, { type Transporter } from 'nodemailer';

export type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
};

function readSmtpConfigFromEnv(): SmtpConfig {
  const host = (process.env.SMTP_HOST || 'smtp-relay.gmail.com').trim();
  const port = Number(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const from = (process.env.SMTP_FROM || user || '').trim();

  if (!user || !pass) {
    throw new Error('SMTP_USER 与 SMTP_PASS 须在环境变量或 backend/.env 中配置');
  }
  if (!from) {
    throw new Error('SMTP_FROM 或 SMTP_USER 须配置发件人地址');
  }
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('SMTP_PORT 无效');
  }

  return { host, port, user, pass, from };
}

let cachedTransporter: Transporter | null = null;

export function getSmtpTransporter(config?: SmtpConfig): Transporter {
  if (!config && cachedTransporter) {
    return cachedTransporter;
  }
  const c = config ?? readSmtpConfigFromEnv();
  const transporter = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: false,
    requireTLS: true,
    auth: {
      user: c.user,
      pass: c.pass,
    },
  });
  if (!config) {
    cachedTransporter = transporter;
  }
  return transporter;
}

export type SendMailOptions = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  bcc?: string | string[];
  cc?: string | string[];
};

export async function sendMail(opts: SendMailOptions, config?: SmtpConfig): Promise<string> {
  const c = config ?? readSmtpConfigFromEnv();
  const transporter = getSmtpTransporter(config);
  const info = await transporter.sendMail({
    from: c.from,
    to: opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    subject: opts.subject,
    text: opts.text,
    html: opts.html ?? opts.text.replace(/\n/g, '<br>\n'),
  });
  const messageId = typeof info.messageId === 'string' ? info.messageId : '';
  return messageId;
}

export async function verifySmtpConnection(config?: SmtpConfig): Promise<void> {
  const transporter = getSmtpTransporter(config);
  await transporter.verify();
}
