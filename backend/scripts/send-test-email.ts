/**
 * 发送测试邮件（Google Workspace SMTP 中继 + SMTP 身份验证）。
 *
 * 用法：
 *   npm run email:test
 *   npm run email:test -- toys123ie@gmail.com
 *
 * 环境变量（backend/.env）：
 *   SMTP_HOST=smtp-relay.gmail.com
 *   SMTP_PORT=587
 *   SMTP_USER=info@lztechserve.com
 *   SMTP_PASS=应用专用密码（16 位，无空格）
 *   SMTP_FROM=info@lztechserve.com
 */
import path from 'path';
import dotenv from 'dotenv';
import { sendMail, verifySmtpConnection } from '../src/utils/smtpMail';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function main(): Promise<void> {
  const to = (process.argv[2] || 'toys123ie@gmail.com').trim();
  if (!to.includes('@')) {
    console.error('收件人邮箱无效:', to);
    process.exit(1);
  }

  console.log('验证 SMTP 连接…');
  await verifySmtpConnection();
  console.log('SMTP 连接正常');

  const subject = 'LZFood SMTP 测试邮件';
  const text =
    '这是一封来自 LZFood 后端的测试邮件。\n\n' +
    '若您收到此邮件，说明 SMTP 中继（smtp-relay.gmail.com）与发信账号配置正常。\n\n' +
    '— L&Z Techserve';

  console.log(`发送至 ${to} …`);
  const messageId = await sendMail({ to, subject, text });
  console.log('发送成功', messageId ? `(Message-ID: ${messageId})` : '');
}

main().catch((err) => {
  console.error('发送失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
