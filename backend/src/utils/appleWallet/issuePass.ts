import mongoose from 'mongoose';
import { ensureAppleWalletAuthToken } from './authToken';
import { buildPlatformMemberPkpass } from './buildPass';
import type { AppleWalletSettings } from './config';
import { resolveAppleWalletWebServiceUrl } from './webServiceUrl';
import { loadStampRules } from '../platformStamps';

type MemberLike = {
  _id: mongoose.Types.ObjectId | string;
  memberNo?: number | null;
  displayName?: string;
  phone?: string;
  creditBalance?: number;
  stampCount?: number;
};

/** 签发/重下 pkpass：有公网 webService 时写入 authenticationToken */
export async function issuePlatformMemberPkpass(
  member: MemberLike,
  settings: AppleWalletSettings,
): Promise<Buffer> {
  const id = String(member._id);
  const webServiceURL = resolveAppleWalletWebServiceUrl();
  const authenticationToken = webServiceURL
    ? await ensureAppleWalletAuthToken(id)
    : undefined;
  const rules = await loadStampRules();
  return buildPlatformMemberPkpass(
    {
      id,
      memberNo: member.memberNo,
      displayName: member.displayName,
      phone: member.phone,
      creditBalance: member.creditBalance,
      stampCount: Math.max(0, Math.floor(Number(member.stampCount) || 0)),
      stampRedeemAt: rules.redeemCount,
      authenticationToken,
    },
    settings,
  );
}
