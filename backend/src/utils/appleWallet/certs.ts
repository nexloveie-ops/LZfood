import fs from 'fs';
import path from 'path';
import forge from 'node-forge';

export type AppleWalletSignerMaterial = {
  wwdrPem: string;
  signerCertPem: string;
  signerKeyPem: string;
  signerKeyPassphrase?: string;
  passTypeId: string;
  teamId: string;
};

function readEnvFileOrBase64(pathKey: string, b64Key: string): Buffer | null {
  const filePath = process.env[pathKey]?.trim();
  if (filePath) {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    if (fs.existsSync(resolved)) return fs.readFileSync(resolved);
  }
  // Secret Manager 可能带换行/空白；去掉空白后再解码
  const b64 = process.env[b64Key]?.replace(/\s+/g, '');
  if (b64) return Buffer.from(b64, 'base64');
  return null;
}

function derOrPemToPem(buf: Buffer, type: 'CERTIFICATE' | 'PRIVATE KEY'): string {
  const text = buf.toString('utf8');
  if (text.includes('-----BEGIN')) return text;
  const b64 = buf.toString('base64');
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${type}-----\n${lines.join('\n')}\n-----END ${type}-----\n`;
}

function extractFromP12(p12Buf: Buffer, password: string): { certPem: string; keyPem: string } {
  const asn1 = forge.asn1.fromDer(p12Buf.toString('binary'));
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password || '');
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  const keyBags =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ||
    p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ||
    [];
  const cert = certBags[0]?.cert;
  const key = keyBags[0]?.key;
  if (!cert || !key) {
    throw new Error('Apple Wallet .p12 中未找到证书或私钥');
  }
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(key),
  };
}

/** 仅报告是否已配置，不返回任何密钥内容 */
export function getAppleWalletCertStatus(): {
  passTypeId: string;
  teamId: string;
  hasP12: boolean;
  hasWwdr: boolean;
  hasPassword: boolean;
  ready: boolean;
} {
  const passTypeId = process.env.APPLE_PASS_TYPE_ID?.trim() || 'pass.com.lztechserve.lzfood.membership';
  const teamId = process.env.APPLE_TEAM_ID?.trim() || '';
  const hasP12 = !!readEnvFileOrBase64('APPLE_PASS_P12_PATH', 'APPLE_PASS_P12_BASE64');
  const hasWwdr = !!readEnvFileOrBase64('APPLE_WWDR_CER_PATH', 'APPLE_WWDR_CER_BASE64');
  const hasPassword = !!process.env.APPLE_PASS_P12_PASSWORD?.trim();
  return {
    passTypeId,
    teamId,
    hasP12,
    hasWwdr,
    hasPassword,
    ready: !!(passTypeId && teamId && hasP12 && hasWwdr && hasPassword),
  };
}

export function loadAppleWalletSignerMaterial(): AppleWalletSignerMaterial {
  const status = getAppleWalletCertStatus();
  if (!status.teamId) {
    throw new Error('未配置 APPLE_TEAM_ID');
  }
  const p12 = readEnvFileOrBase64('APPLE_PASS_P12_PATH', 'APPLE_PASS_P12_BASE64');
  if (!p12) {
    throw new Error('未配置 APPLE_PASS_P12_PATH 或 APPLE_PASS_P12_BASE64');
  }
  const wwdrRaw = readEnvFileOrBase64('APPLE_WWDR_CER_PATH', 'APPLE_WWDR_CER_BASE64');
  if (!wwdrRaw) {
    throw new Error('未配置 APPLE_WWDR_CER_PATH 或 APPLE_WWDR_CER_BASE64');
  }
  // Secret 挂载时密码末尾常带 \n，不 trim 会导致 PKCS#12 MAC 校验失败
  const password = (process.env.APPLE_PASS_P12_PASSWORD ?? '').trim();
  const { certPem, keyPem } = extractFromP12(p12, password);
  return {
    wwdrPem: derOrPemToPem(wwdrRaw, 'CERTIFICATE'),
    signerCertPem: certPem,
    signerKeyPem: keyPem,
    passTypeId: status.passTypeId,
    teamId: status.teamId,
  };
}
