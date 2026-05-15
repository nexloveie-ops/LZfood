import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { sendMail } from './smtpMail';
import { createAppError } from '../middleware/errorHandler';
import { generateOtpCode, normalizeEmail, normalizeSlug } from './portalRegistration';

const OTP_TTL_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const DEFAULT_NOTIFY_EMAIL = 'info@lztechserve.com';

function registrationNotifyEmail(): string {
  return (process.env.PORTAL_REGISTRATION_NOTIFY_EMAIL || DEFAULT_NOTIFY_EMAIL).trim();
}

function portalPublicOrigin(): string {
  const raw =
    process.env.PORTAL_PUBLIC_ORIGIN?.trim() ||
    process.env.QR_BASE_URL?.trim() ||
    'http://localhost:5173';
  return raw.replace(/\/$/, '');
}

export function buildPasswordResetOtpEmail(input: {
  code: string;
  slug: string;
  displayName: string;
  email: string;
  username: string;
}): { subject: string; text: string; html: string } {
  const loginPath = `${portalPublicOrigin()}/${input.slug}/login`;
  const subject = 'LZFood Password Reset Code / LZFood 重置密码验证码';
  const accountBlock =
    `Store name / 店铺名称: ${input.displayName}\n` +
    `Store URL (slug) / 店铺网址: /${input.slug}\n` +
    `Email / 邮箱: ${input.email}\n` +
    `Admin username / 管理员用户名: ${input.username}\n` +
    `Sign-in URL / 登录地址: ${loginPath}\n`;
  const text =
    'Your password reset request / 您的重置密码请求\n\n' +
    '— Account / 账号信息 —\n' +
    `${accountBlock}\n` +
    '— Verification code / 验证码（15 分钟内有效）—\n' +
    `${input.code}\n\n` +
    'Enter this code on the forgot-password page to set a new password.\n' +
    '请在忘记密码页面输入此验证码并设置新密码。\n\n' +
    'If you did not request this, please ignore this email.\n' +
    '如非本人操作，请忽略此邮件。\n\n' +
    '— L&Z Techserve Ltd / LZFood';
  const html = `
<p><strong>Your password reset request</strong> / <strong>您的重置密码请求</strong></p>
<table style="border-collapse:collapse;width:100%;max-width:560px;font-size:14px;margin:16px 0;">
  <tbody>
    <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;color:#64748b;">Store name / 店铺名称</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;"><strong>${input.displayName}</strong></td></tr>
    <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;color:#64748b;">Store URL / 店铺网址</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;"><strong>/${input.slug}</strong></td></tr>
    <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;color:#64748b;">Email / 邮箱</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;"><strong>${input.email}</strong></td></tr>
    <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;color:#64748b;">Admin username / 管理员用户名</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;"><strong>${input.username}</strong></td></tr>
    <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;color:#64748b;">Sign-in URL / 登录地址</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;"><a href="${loginPath}">${loginPath}</a></td></tr>
  </tbody>
</table>
<p><strong>Verification code / 验证码</strong>（15 minutes / 15 分钟内有效）</p>
<p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:16px 0;">${input.code}</p>
<p>Enter this code on the forgot-password page to set a new password.<br>
请在忘记密码页面输入此验证码并设置新密码。</p>
<p>If you did not request this, please ignore this email.<br>
如非本人操作，请忽略此邮件。</p>
<p style="color:#64748b;font-size:13px;">— L&amp;Z Techserve Ltd / LZFood</p>
`.trim();
  return { subject, text, html };
}

export function buildPasswordResetSuccessEmail(input: {
  slug: string;
  email: string;
  username: string;
}): { subject: string; text: string; html: string } {
  const loginPath = `${portalPublicOrigin()}/${input.slug}/login`;
  const subject = 'LZFood Password Updated / LZFood 密码已重置';
  const text =
    'Your store owner password has been updated. / 您的店铺管理员密码已重置。\n\n' +
    `Store / 店铺: /${input.slug}\n` +
    `Email / 邮箱: ${input.email}\n` +
    `Admin username / 管理员用户名: ${input.username}\n` +
    `Sign-in URL / 登录地址: ${loginPath}\n\n` +
    'If you did not make this change, contact us immediately.\n' +
    '如非本人操作，请立即联系我们。\n\n' +
    '— L&Z Techserve Ltd / LZFood';
  const html = `
<p><strong>Your store owner password has been updated.</strong><br>
<strong>您的店铺管理员密码已重置。</strong></p>
<ul style="line-height:1.7;">
  <li>Store / 店铺: <strong>/${input.slug}</strong></li>
  <li>Email / 邮箱: <strong>${input.email}</strong></li>
  <li>Admin username / 管理员用户名: <strong>${input.username}</strong></li>
  <li>Sign-in URL / 登录地址: <a href="${loginPath}">${loginPath}</a></li>
</ul>
<p>If you did not make this change, contact us immediately.<br>
如非本人操作，请立即联系我们。</p>
<p style="color:#64748b;font-size:13px;">— L&amp;Z Techserve Ltd / LZFood</p>
`.trim();
  return { subject, text, html };
}

/** 校验 slug+邮箱是否对应自助注册店主；不匹配时返回 null（不暴露原因） */
async function resolveOwnerResetContext(
  slugRaw: string,
  emailRaw: string,
): Promise<{
  email: string;
  slug: string;
  displayName: string;
  storeId: mongoose.Types.ObjectId;
  ownerId: mongoose.Types.ObjectId;
  ownerUsername: string;
} | null> {
  const slug = normalizeSlug(slugRaw);
  const email = normalizeEmail(emailRaw);
  if (!slug || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }

  const { Store, PortalOwnerEmail, Admin } = getModels();
  const store = (await Store.findOne({ slug }).lean()) as {
    _id?: mongoose.Types.ObjectId;
    status?: string;
    displayName?: string;
  } | null;
  if (!store?._id || store.status === 'expired' || store.status === 'suspended') {
    return null;
  }

  const ownerEmail = (await PortalOwnerEmail.findOne({ email }).lean()) as {
    storeId?: mongoose.Types.ObjectId;
  } | null;
  if (!ownerEmail?.storeId || String(ownerEmail.storeId) !== String(store._id)) {
    return null;
  }

  const owner = (await Admin.findOne({ storeId: store._id, role: 'owner' }).lean()) as {
    _id?: mongoose.Types.ObjectId;
    username?: string;
  } | null;
  if (!owner?._id || !owner.username) {
    return null;
  }

  return {
    email,
    slug,
    displayName: store.displayName?.trim() || slug,
    storeId: store._id,
    ownerId: owner._id,
    ownerUsername: owner.username,
  };
}

/** 发送重置验证码；无匹配店主时静默成功（防枚举） */
export async function sendOwnerPasswordResetCode(slugRaw: string, emailRaw: string): Promise<void> {
  const ctx = await resolveOwnerResetContext(slugRaw, emailRaw);
  if (!ctx) {
    return;
  }

  const { PortalPasswordResetOtp } = getModels();
  const existing = (await PortalPasswordResetOtp.findOne({ email: ctx.email }).lean()) as {
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

  await PortalPasswordResetOtp.findOneAndUpdate(
    { email: ctx.email },
    {
      email: ctx.email,
      storeId: ctx.storeId,
      codeHash,
      expiresAt,
      lastSentAt: now,
    },
    { upsert: true, new: true },
  );

  const mail = buildPasswordResetOtpEmail({
    code,
    slug: ctx.slug,
    displayName: ctx.displayName,
    email: ctx.email,
    username: ctx.ownerUsername,
  });
  await sendMail({
    to: ctx.email,
    bcc: registrationNotifyEmail(),
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
}

async function verifyPasswordResetOtp(email: string, code: string): Promise<void> {
  const { PortalPasswordResetOtp } = getModels();
  const row = (await PortalPasswordResetOtp.findOne({ email }).lean()) as {
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
}

export async function completeOwnerPasswordReset(input: {
  slug: string;
  email: string;
  code: string;
  newPassword: string;
}): Promise<{ slug: string; username: string }> {
  const ctx = await resolveOwnerResetContext(input.slug, input.email);
  if (!ctx) {
    throw createAppError(
      'VALIDATION_ERROR',
      '无法重置：请确认店铺网址与注册邮箱是否正确。若门店为平台代开，请联系 info@lztechserve.com。',
    );
  }

  await verifyPasswordResetOtp(ctx.email, input.code);

  const password = input.newPassword ?? '';
  if (password.length < 6) {
    throw createAppError('VALIDATION_ERROR', '新密码至少 6 位');
  }

  const { Admin, PortalPasswordResetOtp } = getModels();
  const passwordHash = await bcrypt.hash(password, 10);

  const updated = await Admin.findOneAndUpdate(
    { _id: ctx.ownerId, role: 'owner', storeId: ctx.storeId },
    { $set: { passwordHash } },
    { new: true },
  ).lean();

  if (!updated) {
    throw createAppError('NOT_FOUND', '未找到店铺管理员账号');
  }

  await PortalPasswordResetOtp.deleteOne({ email: ctx.email });

  try {
    const mail = buildPasswordResetSuccessEmail({
      slug: ctx.slug,
      email: ctx.email,
      username: ctx.ownerUsername,
    });
    await sendMail({
      to: ctx.email,
      bcc: registrationNotifyEmail(),
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  } catch (mailErr) {
    console.error('Password reset success email failed:', mailErr);
  }

  return { slug: ctx.slug, username: ctx.ownerUsername };
}
