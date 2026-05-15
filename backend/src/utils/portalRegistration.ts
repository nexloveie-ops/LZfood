import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { sendMail } from './smtpMail';
import { createAppError } from '../middleware/errorHandler';

export const PORTAL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const OTP_TTL_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

export function generateOtpCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function buildRegistrationOtpEmail(code: string): { subject: string; text: string; html: string } {
  const subject = 'LZFood Registration Code / LZFood 注册验证码';
  const text =
    'Your LZFood verification code / 您的 LZFood 验证码\n\n' +
    `${code}\n\n` +
    'Valid for 15 minutes. If you did not request this, please ignore this email.\n' +
    '验证码 15 分钟内有效。如非本人操作，请忽略此邮件。\n\n' +
    '— L&Z Techserve Ltd / LZFood';
  const html = `
<p><strong>Your LZFood verification code</strong> / <strong>您的 LZFood 验证码</strong></p>
<p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:16px 0;">${code}</p>
<p>Valid for 15 minutes. If you did not request this, please ignore this email.<br>
验证码 15 分钟内有效。如非本人操作，请忽略此邮件。</p>
<p style="color:#64748b;font-size:13px;">— L&amp;Z Techserve Ltd / LZFood</p>
`.trim();
  return { subject, text, html };
}

const DEFAULT_REGISTRATION_NOTIFY_EMAIL = 'info@lztechserve.com';

export type RegistrationSuccessDetails = {
  displayName: string;
  slug: string;
  email: string;
  username: string;
  storeId: string;
  planLabel: string;
};

function portalPublicOrigin(): string {
  const raw =
    process.env.PORTAL_PUBLIC_ORIGIN?.trim() ||
    process.env.QR_BASE_URL?.trim() ||
    'http://localhost:5173';
  return raw.replace(/\/$/, '');
}

function registrationNotifyEmail(): string {
  return (process.env.PORTAL_REGISTRATION_NOTIFY_EMAIL || DEFAULT_REGISTRATION_NOTIFY_EMAIL).trim();
}

export function buildRegistrationSuccessEmail(
  details: RegistrationSuccessDetails,
  publicOrigin: string,
): { subject: string; text: string; html: string } {
  const loginPath = `${publicOrigin}/${details.slug}/login`;
  const subject = 'LZFood Registration Complete / LZFood 注册成功';
  const rows: Array<[string, string]> = [
    ['Store name / 店铺名称', details.displayName],
    ['Store URL (slug) / 店铺网址', details.slug],
    ['Email / 邮箱', details.email],
    ['Admin username / 管理员用户名', details.username],
    ['Plan / 套餐', details.planLabel],
    ['Store ID / 门店 ID', details.storeId],
    ['Sign-in URL / 登录地址', loginPath],
  ];

  const textLines = [
    'Your LZFood store is ready. / 您的 LZFood 门店已开通。',
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    'Password / 密码: set during registration (not shown in email for security).',
    '密码：注册时由您设置（出于安全考虑不在邮件中显示）。',
    '',
    'Sign in with your admin username and password at the URL above.',
    '请使用上述管理员用户名与密码登录。',
    '',
    '— L&Z Techserve Ltd / LZFood',
  ];

  const htmlRows = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;color:#64748b;vertical-align:top;">${label}</td>` +
        `<td style="padding:8px 12px;border:1px solid #e2e8f0;"><strong>${value}</strong></td></tr>`,
    )
    .join('');

  const html = `
<p><strong>Your LZFood store is ready.</strong> / <strong>您的 LZFood 门店已开通。</strong></p>
<table style="border-collapse:collapse;width:100%;max-width:560px;font-size:14px;margin:16px 0;">
  <tbody>${htmlRows}</tbody>
</table>
<p>Password / 密码: set during registration (not shown in email for security).<br>
密码：注册时由您设置（出于安全考虑不在邮件中显示）。</p>
<p>Sign in with your admin username and password.<br>
请使用管理员用户名与密码登录。</p>
<p style="color:#64748b;font-size:13px;">— L&amp;Z Techserve Ltd / LZFood</p>
`.trim();

  return { subject, text: textLines.join('\n'), html };
}

export async function sendRegistrationSuccessEmail(details: RegistrationSuccessDetails): Promise<void> {
  const mail = buildRegistrationSuccessEmail(details, portalPublicOrigin());
  const notify = registrationNotifyEmail();
  await sendMail({
    to: details.email,
    bcc: notify,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
}

export async function assertEmailAvailableForRegistration(emailRaw: string): Promise<string> {
  const email = normalizeEmail(emailRaw);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw createAppError('VALIDATION_ERROR', '邮箱格式无效');
  }
  const { PortalOwnerEmail } = getModels();
  const taken = await PortalOwnerEmail.findOne({ email }).lean();
  if (taken) {
    throw createAppError(
      'CONFLICT',
      '该邮箱已注册过门店。每个邮箱仅能自助开通一家门店；更多门店请联系我们。',
    );
  }
  return email;
}

export async function assertSlugAvailable(slugRaw: string): Promise<string> {
  const slug = normalizeSlug(slugRaw);
  if (!slug) {
    throw createAppError('VALIDATION_ERROR', '店铺 slug 必填');
  }
  if (!PORTAL_SLUG_RE.test(slug)) {
    throw createAppError('VALIDATION_ERROR', 'slug 仅允许小写字母、数字与连字符');
  }
  const { Store } = getModels();
  const exists = await Store.findOne({ slug }).lean();
  if (exists) {
    throw createAppError('CONFLICT', '该店铺网址已被占用，请换一个 slug');
  }
  return slug;
}

export async function sendRegistrationOtp(emailRaw: string): Promise<void> {
  const email = await assertEmailAvailableForRegistration(emailRaw);
  const { PortalRegistrationOtp } = getModels();

  const existing = (await PortalRegistrationOtp.findOne({ email }).lean()) as {
    lastSentAt?: Date;
  } | null;
  if (existing?.lastSentAt) {
    const elapsed = Date.now() - new Date(existing.lastSentAt).getTime();
    if (elapsed < RESEND_COOLDOWN_MS) {
      throw createAppError('RATE_LIMIT', '请稍后再试（约 60 秒后可重新发送）');
    }
  }

  const code = generateOtpCode();
  const codeHash = await bcrypt.hash(code, 10);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);

  await PortalRegistrationOtp.findOneAndUpdate(
    { email },
    { email, codeHash, expiresAt, lastSentAt: now },
    { upsert: true, new: true },
  );

  const mail = buildRegistrationOtpEmail(code);
  await sendMail({
    to: email,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
}

export async function verifyRegistrationOtp(emailRaw: string, code: string): Promise<string> {
  const email = normalizeEmail(emailRaw);
  if (!email || !code?.trim()) {
    throw createAppError('VALIDATION_ERROR', '邮箱与验证码必填');
  }
  const { PortalRegistrationOtp } = getModels();
  const row = (await PortalRegistrationOtp.findOne({ email }).lean()) as {
    codeHash?: string;
    expiresAt?: Date;
  } | null;
  if (!row?.codeHash || !row.expiresAt) {
    throw createAppError('VALIDATION_ERROR', '请先获取验证码');
  }
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    throw createAppError('VALIDATION_ERROR', '验证码已过期，请重新获取');
  }
  const ok = await bcrypt.compare(code.trim(), row.codeHash);
  if (!ok) {
    throw createAppError('VALIDATION_ERROR', '验证码不正确');
  }
  return email;
}

export async function resolveFreeBasePlanId(): Promise<mongoose.Types.ObjectId | null> {
  const { FeaturePlan } = getModels();
  const plan = (await FeaturePlan.findOne({ code: 'free-base' }).lean()) as {
    _id?: mongoose.Types.ObjectId;
  } | null;
  return plan?._id ?? null;
}

export async function completePortalRegistration(input: {
  displayName: string;
  slug: string;
  email: string;
  code: string;
  username: string;
  password: string;
}): Promise<{ slug: string; storeId: string }> {
  const email = await verifyRegistrationOtp(input.email, input.code);
  const slug = await assertSlugAvailable(input.slug);
  const displayName = input.displayName?.trim();
  const username = input.username?.trim();
  const password = input.password ?? '';

  if (!displayName) {
    throw createAppError('VALIDATION_ERROR', '店铺名称必填');
  }
  if (!username) {
    throw createAppError('VALIDATION_ERROR', '管理员用户名必填');
  }
  if (password.length < 6) {
    throw createAppError('VALIDATION_ERROR', '密码至少 6 位');
  }

  const { Store, Admin, PortalOwnerEmail, PortalRegistrationOtp } = getModels();

  const emailTaken = await PortalOwnerEmail.findOne({ email });
  if (emailTaken) {
    throw createAppError(
      'CONFLICT',
      '该邮箱已注册过门店。每个邮箱仅能自助开通一家门店；更多门店请联系我们。',
    );
  }

  const basePlanId = await resolveFreeBasePlanId();
  const passwordHash = await bcrypt.hash(password, 10);

  let storeDoc: { _id: mongoose.Types.ObjectId } | null = null;
  try {
    storeDoc = (await Store.create({
      slug,
      displayName,
      subscriptionEndsAt: new Date('2099-12-31'),
      status: 'active',
      basePlanId,
      enabledAddOnIds: [],
      featureOverrides: {},
    })) as { _id: mongoose.Types.ObjectId };

    await Admin.create({
      username,
      passwordHash,
      role: 'owner',
      storeId: storeDoc._id,
    });

    await PortalOwnerEmail.create({ email, storeId: storeDoc._id });
    await PortalRegistrationOtp.deleteOne({ email });

    const result = { slug, storeId: storeDoc._id.toString() };
    try {
      await sendRegistrationSuccessEmail({
        displayName,
        slug,
        email,
        username,
        storeId: result.storeId,
        planLabel: 'LZ Free (free-base)',
      });
    } catch (mailErr) {
      console.error('Registration success email failed:', mailErr);
    }

    return result;
  } catch (err) {
    if (storeDoc?._id) {
      await Admin.deleteMany({ storeId: storeDoc._id });
      await Store.findByIdAndDelete(storeDoc._id);
    }
    throw err;
  }
}

export async function resolveStoreLogin(slugRaw: string): Promise<{ slug: string; status: string }> {
  const slug = normalizeSlug(slugRaw);
  if (!slug) {
    throw createAppError('VALIDATION_ERROR', '请输入店铺 slug');
  }
  const { Store } = getModels();
  const store = (await Store.findOne({ slug }).lean()) as {
    slug?: string;
    status?: string;
  } | null;
  if (!store) {
    throw createAppError('NOT_FOUND', '未找到该店铺，请检查 slug 是否正确');
  }
  if (store.status === 'expired' || store.status === 'suspended') {
    throw createAppError('STORE_INACTIVE', '该店铺当前不可用，请联系平台');
  }
  return { slug: store.slug ?? slug, status: store.status ?? 'active' };
}
