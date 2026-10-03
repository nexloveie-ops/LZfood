import mongoose from 'mongoose';
import { ensureAppleWalletAuthToken } from './authToken';
import { buildPlatformMemberPkpass } from './buildPass';
import type { AppleWalletSettings } from './config';
import { resolveAppleWalletWebServiceUrl } from './webServiceUrl';

type MemberLike = {
  _id: mongoose.Types.ObjectId | string;
  memberNo?: number | null;
  displayName?: string;
  phone?: string;
  creditBalance?: number;
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
  return buildPlatformMemberPkpass(
    {
      id,
      memberNo: member.memberNo,
      displayName: member.displayName,
      phone: member.phone,
      creditBalance: member.creditBalance,
      authenticationToken,
    },
    settings,
  );
}
