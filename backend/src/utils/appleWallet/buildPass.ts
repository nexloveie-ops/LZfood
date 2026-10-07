import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { PKPass } from 'passkit-generator';
import { loadAppleWalletSignerMaterial } from './certs';
import type { AppleWalletSettings } from './config';
import { resolvePassStoreLocations } from './storeLocations';
import { memberPassSerialNumber, resolveAppleWalletWebServiceUrl } from './webServiceUrl';
import { buildStampStripPngs } from './stampStrip';

export type PlatformMemberPassInput = {
  id: string;
  memberNo?: number | null;
  displayName?: string;
  phone?: string;
  creditBalance?: number;
  stampCount?: number;
  stampRedeemAt?: number;
  /** PassKit authenticationToken；有 webServiceURL 时必填（≥16） */
  authenticationToken?: string;
};

function assetsDir(): string {
  return path.join(__dirname, '../../../assets/apple-wallet');
}

function uploadsRoot(): string {
  return path.join(__dirname, '../../../uploads');
}

function loadDefaultAssetBuffers(): Record<string, Buffer> {
  const dir = assetsDir();
  const names = [
    'icon.png',
    'paula.r@example.org',
    'carol.w@example.org',
    'logo.png',
    'passa.r@example.org',
  ] as const;
  const buffers: Record<string, Buffer> = {};
  for (const name of names) {
    const fp = path.join(dir, name);
    if (fs.existsSync(fp)) buffers[name] = fs.readFileSync(fp);
  }
  if (!buffers['icon.png']) {
    throw new Error('缺少 Apple Wallet 资源 icon.png');
  }
  if (!buffers['paula.r@example.org']) buffers['paula.r@example.org'] = buffers['icon.png'];
  if (!buffers['carol.w@example.org']) buffers['carol.w@example.org'] = buffers['icon.png'];
  if (!buffers['logo.png']) buffers['logo.png'] = buffers['icon.png'];
  if (!buffers['passa.r@example.org']) buffers['passa.r@example.org'] = buffers['logo.png'];
  return buffers;
}

function fetchUrlBuffer(url: string, timeoutMs = 8000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, (res) => {
      if ((res.statusCode || 0) >= 300 && (res.statusCode || 0) < 400 && res.headers.location) {
        fetchUrlBuffer(res.headers.location, timeoutMs).then(resolve, reject);
        return;
      }
      if ((res.statusCode || 0) >= 400) {
        reject(new Error(`Logo HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Logo download timeout'));
    });
    req.on('error', reject);
  });
}

const logoCache = new Map<string, { buf: Buffer; at: number }>();
const LOGO_TTL_MS = 10 * 60 * 1000;

/** 将设置里的 logoUrl 解析为 PNG buffer（本地 uploads、GCS；避免对本服务自拉 /uploads） */
async function resolveLogoBuffer(logoUrl: string): Promise<Buffer | null> {
  const raw = logoUrl.trim();
  if (!raw) return null;
  const hit = logoCache.get(raw);
  if (hit && Date.now() - hit.at < LOGO_TTL_MS) return hit.buf;
  try {
    let buf: Buffer | null = null;
    if (raw.startsWith('/uploads/')) {
      const rel = raw.replace(/^\/uploads\//, '');
      const fp = path.join(uploadsRoot(), rel);
      if (fs.existsSync(fp)) buf = fs.readFileSync(fp);
      if (!buf) {
        try {
          const { getFileBuffer } = await import('../../storage');
          buf = await getFileBuffer(rel);
        } catch {
          buf = null;
        }
      }
    } else if (raw.startsWith('http://') || raw.startsWith('https://')) {
      buf = await fetchUrlBuffer(raw);
    }
    if (buf && buf.length > 0) {
      logoCache.set(raw, { buf, at: Date.now() });
      return buf;
    }
  } catch {
    return null;
  }
  return null;
}

async function loadAssetBuffers(settings: AppleWalletSettings): Promise<Record<string, Buffer>> {
  const buffers = loadDefaultAssetBuffers();
  const logo = await resolveLogoBuffer(settings.logoUrl || '');
  if (logo && logo.length > 0) {
    // Apple 接受 PNG；上传接口限制为 png。同一图复用到 logo/icon 各倍率。
    buffers['logo.png'] = logo;
    buffers['passa.r@example.org'] = logo;
    buffers['icon.png'] = logo;
    buffers['paula.r@example.org'] = logo;
    buffers['carol.w@example.org'] = logo;
  }
  return buffers;
}

/** QR payload — 收银扫码业务后续再接；格式稳定勿随意改 */
export function memberWalletQrPayload(memberId: string): string {
  return `LZM:${memberId}`;
}

export async function buildPlatformMemberPkpass(
  member: PlatformMemberPassInput,
  settings: AppleWalletSettings,
): Promise<Buffer> {
  const signer = loadAppleWalletSignerMaterial();
  const balance = Number(member.creditBalance) || 0;
  const stamps = Math.max(0, Math.floor(Number(member.stampCount) || 0));
  const stampGoal = Math.max(1, Math.floor(Number(member.stampRedeemAt) || 9));
  const name = (member.displayName || '').trim() || member.phone || 'Member';
  const memberNo = member.memberNo != null ? String(member.memberNo) : member.id.slice(-8);
  const qr = memberWalletQrPayload(member.id);
  const webServiceURL = resolveAppleWalletWebServiceUrl();
  const authToken = (member.authenticationToken || '').trim();
  if (webServiceURL && authToken.length < 16) {
    throw new Error('Apple Wallet authenticationToken 无效（需 ≥16 字符）');
  }

  const [locations, buffers, strips] = await Promise.all([
    resolvePassStoreLocations(settings.storeIds),
    loadAssetBuffers(settings),
    buildStampStripPngs(stamps, stampGoal, settings.foregroundColor).catch((e) => {
      console.error('[apple-wallet] stamp strip:', e instanceof Error ? e.message : e);
      return {} as Record<string, Buffer>;
    }),
  ]);
  Object.assign(buffers, strips);

  const pass = new PKPass(
    buffers,
    {
      wwdr: signer.wwdrPem,
      signerCert: signer.signerCertPem,
      signerKey: signer.signerKeyPem,
    },
    {
      formatVersion: 1,
      passTypeIdentifier: signer.passTypeId,
      teamIdentifier: signer.teamId,
      serialNumber: memberPassSerialNumber(member.id),
      organizationName: settings.organizationName,
      description: settings.description,
      logoText: settings.logoText,
      backgroundColor: settings.backgroundColor,
      foregroundColor: settings.foregroundColor,
      labelColor: settings.labelColor,
      ...(locations.length > 0 && settings.maxDistanceMeters > 0
        ? { maxDistance: settings.maxDistanceMeters }
        : {}),
      ...(webServiceURL && authToken.length >= 16
        ? { webServiceURL, authenticationToken: authToken }
        : {}),
    },
  );

  pass.type = 'storeCard';
  pass.primaryFields.push({
    key: 'balance',
    label: 'BALANCE',
    value: `€${balance.toFixed(2)}`,
    changeMessage: 'Balance: %@',
  });
  pass.auxiliaryFields.push(
    {
      key: 'name',
      label: 'MEMBER',
      value: name,
    },
    {
      key: 'memberNo',
      label: 'NO.',
      value: `#${memberNo}`,
    },
  );
  pass.backFields.push(
    {
      key: 'stampsBack',
      label: 'Stamps',
      value: `${stamps} / ${stampGoal}`,
    },
    {
      key: 'phone',
      label: 'Phone',
      value: member.phone || '—',
    },
    {
      key: 'help',
      label: 'About',
      value:
        'LZFOOD platform membership. Show this QR at participating stores. NFC tap support coming later.',
    },
  );

  pass.setBarcodes({
    message: qr,
    format: 'PKBarcodeFormatQR',
    messageEncoding: 'iso-8859-1',
    altText: qr,
  });

  if (locations.length > 0) {
    pass.setLocations(
      ...locations.map((loc) => ({
        latitude: loc.latitude,
        longitude: loc.longitude,
        relevantText: loc.relevantText,
      })),
    );
  }

  return pass.getAsBuffer();
}
