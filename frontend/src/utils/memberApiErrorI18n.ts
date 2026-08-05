import type { TFunction } from 'i18next';

/**
 * Map backend member API Chinese messages (and a few codes) to i18n.
 * Unknown messages are returned as-is.
 */
export function translateMemberApiMessage(message: string | undefined | null, t: TFunction): string {
  if (message == null) return '';
  const m = String(message).trim();
  if (!m) return '';

  const pinLen = /^PIN 长度须在 (\d+)-(\d+) 位$/.exec(m);
  if (pinLen) return t('member.apiErrors.pinLength', { min: pinLen[1], max: pinLen[2] });

  const topUpMin = /^充值金额不得低于 €([\d.]+)$/.exec(m);
  if (topUpMin) return t('member.apiErrors.topUpMin', { min: topUpMin[1] });

  const topUpMax = /^单次充值不得超过 €([\d.]+)$/.exec(m);
  if (topUpMax) return t('member.apiErrors.topUpMax', { max: topUpMax[1] });

  const map: Record<string, string> = {
    '请填写手机号': 'member.apiErrors.phoneRequired',
    'PIN 须为数字': 'member.apiErrors.pinDigits',
    '该手机号已注册': 'member.apiErrors.phoneRegistered',
    '手机号或 PIN 错误': 'member.apiErrors.phoneOrPinWrong',
    '操作过于频繁，请稍后再试': 'member.apiErrors.rateLimit',
    '缺少店铺上下文': 'member.apiErrors.storeRequired',
    '未找到该手机号的会员': 'member.apiErrors.memberNotFound',
    '会员不存在': 'member.apiErrors.memberMissing',
    '记录不存在': 'member.apiErrors.txnNotFound',
    '无效的记录 ID': 'member.apiErrors.invalidTxnId',
    '无可更新字段': 'member.apiErrors.nothingToUpdate',
    '原 PIN 错误': 'member.apiErrors.oldPinWrong',
    '充值金额无效': 'member.apiErrors.invalidTopUpAmount',
    '无效支付': 'member.apiErrors.invalidPayment',
    '支付未完成，请稍后再试或更换支付方式': 'member.apiErrors.paymentIncomplete',
    '币种异常': 'member.apiErrors.currencyMismatch',
    '支付类型不匹配': 'member.apiErrors.paymentTypeMismatch',
    '支付与当前会员不一致': 'member.apiErrors.paymentMemberMismatch',
    '店铺不匹配': 'member.apiErrors.storeMismatch',
    '支付金额不一致': 'member.apiErrors.paymentAmountMismatch',
    '请求失败': 'member.apiErrors.requestFailed',
    '短信服务未完整配置（缺少发信号码或 Messaging Service），无法自助找回 PIN，请联系店员。':
      'member.apiErrors.smsFromMissing',
    '短信服务未完整配置（缺少 Twilio Auth Token 或 Account SID），无法自助找回 PIN；店员请在服务器环境变量中补全后重试。':
      'member.apiErrors.smsNotConfigured',
    '本店未配置短信服务，无法自助找回 PIN，请联系店员。': 'member.apiErrors.smsUnavailable',
    '卡号或 PIN 不正确，或该卡暂不可用': 'member.apiErrors.topUpCardInvalid',
  };

  const key = map[m];
  if (key) return t(key);

  if (m.includes('爱尔兰手机') || m.includes('08 开头')) {
    return t('member.apiErrors.irishMobile');
  }

  if (m.includes('若该手机号已在本店注册') || m.includes('新的 4 位 PIN')) {
    return t('member.forgotPinSuccess');
  }

  if (m.startsWith('短信发送失败')) {
    return t('member.apiErrors.smsSendFailed');
  }

  return m;
}

export function formatMemberApiError(
  status: number,
  body: unknown,
  storeSlug: string,
  statusText: string,
  t: TFunction,
): string {
  const d = body as { error?: { code?: string; message?: string } } | null;
  const code = d?.error?.code;
  const rawMsg = d?.error?.message || statusText || '';

  if (code === 'STORE_NOT_FOUND') {
    return t('member.apiErrors.storeNotFound', { slug: storeSlug || '…' });
  }
  if (code === 'STORE_REQUIRED') {
    return t('member.apiErrors.storeSlugMissing');
  }
  if (status === 404 && !code) {
    if (!storeSlug) return t('member.apiErrors.http404NoSlug');
    return t('member.apiErrors.http404', { slug: storeSlug });
  }

  const translated = translateMemberApiMessage(rawMsg, t);
  return translated || t('member.apiErrors.requestFailed');
}
