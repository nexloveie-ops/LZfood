import fs from 'fs';
import path from 'path';
import { PKPass } from 'passkit-generator';
import { loadAppleWalletSignerMaterial } from './certs';
import type { AppleWalletSettings } from './config';
import { resolvePassStoreLocations } from './storeLocations';

export type PlatformMemberPassInput = {
  id: string;
  memberNo?: number | null;
  displayName?: string;
  phone?: string;
  creditBalance?: number;
};

function assetsDir(): string {
  return path.join(__dirname, '../../../assets/apple-wallet');
}

function loadAssetBuffers(): Record<string, Buffer> {
  const dir = assetsDir();
  const names = ['icon.png', 'paula.r@example.org', 'carol.w@example.org', 'logo.png', 'passa.r@example.org'] as const;
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

/** QR payload — 收银扫码业务后续再接；格式稳定勿随意改 */
export function memberWalletQrPayload(memberId: string): string {
  return `LZM:${memberId}`;
}

export async function buildPlatformMemberPkpass(
  member: PlatformMemberPassInput,
  settings: AppleWalletSettings,
): Promise<Buffer> {
  const signer = loadAppleWalletSignerMaterial();
  const locations = await resolvePassStoreLocations(settings.storeIds);
  const balance = Number(member.creditBalance) || 0;
  const name = (member.displayName || '').trim() || member.phone || 'Member';
  const memberNo = member.memberNo != null ? String(member.memberNo) : member.id.slice(-8);
  const qr = memberWalletQrPayload(member.id);

  const pass = new PKPass(
    loadAssetBuffers(),
    {
      wwdr: signer.wwdrPem,
      signerCert: signer.signerCertPem,
      signerKey: signer.signerKeyPem,
    },
    {
      formatVersion: 1,
      passTypeIdentifier: signer.passTypeId,
      teamIdentifier: signer.teamId,
      serialNumber: `lzfood-member-${member.id}`,
      organizationName: settings.organizationName,
      description: settings.description,
      logoText: settings.logoText,
      backgroundColor: settings.backgroundColor,
      foregroundColor: settings.foregroundColor,
      labelColor: settings.labelColor,
      ...(locations.length > 0 && settings.maxDistanceMeters > 0
        ? { maxDistance: settings.maxDistanceMeters }
        : {}),
    },
  );

  pass.type = 'storeCard';
  pass.primaryFields.push({
    key: 'balance',
    label: 'BALANCE',
    value: `€${balance.toFixed(2)}`,
  });
  pass.secondaryFields.push(
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
