import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { getAppleWalletCertStatus } from '../utils/appleWallet/certs';
import { getAppleWalletSettings } from '../utils/appleWallet/config';
import { buildPlatformMemberPkpass } from '../utils/appleWallet/buildPass';
import {
  getAppleWalletStyleUpdatedAt,
  parsePassesUpdatedSince,
  passUpdateTag,
} from '../utils/appleWallet/passUpdate';
import { ensureAppleWalletAuthToken } from '../utils/appleWallet/authToken';
import { parseMemberIdFromSerial } from '../utils/appleWallet/webServiceUrl';

const router = Router();

function models() {
  return getModels() as {
    PlatformMember: mongoose.Model<any>;
    AppleWalletRegistration: mongoose.Model<any>;
  };
}

function expectedPassTypeId(): string {
  return getAppleWalletCertStatus().passTypeId;
}

function applePassAuthToken(req: Request): string {
  const h = req.headers.authorization || '';
  const m = /^ApplePass\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() || '';
}

function paramStr(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return String(v[0] || '');
  return String(v || '');
}

async function loadMemberForSerial(serialNumber: string): Promise<{
  _id: mongoose.Types.ObjectId;
  appleWalletAuthToken?: string;
  appleWalletUpdatedAt?: Date | null;
  memberNo?: number;
  displayName?: string;
  phone?: string;
  creditBalance?: number;
  status?: string;
} | null> {
  const memberId = parseMemberIdFromSerial(serialNumber);
  if (!memberId || !mongoose.isValidObjectId(memberId)) return null;
  const { PlatformMember } = models();
  return (await PlatformMember.findById(memberId).lean()) as any;
}

async function assertPassAuth(
  req: Request,
  serialNumber: string,
  passTypeIdentifier?: string,
): Promise<{
  member: NonNullable<Awaited<ReturnType<typeof loadMemberForSerial>>>;
} | null> {
  const passType = passTypeIdentifier || paramStr(req.params.passTypeIdentifier);
  if (passType !== expectedPassTypeId()) {
    return null;
  }
  const member = await loadMemberForSerial(serialNumber);
  if (!member || member.status !== 'active') return null;
  const token = applePassAuthToken(req);
  const expected = (member.appleWalletAuthToken || '').trim();
  if (!expected || token !== expected) return null;
  return { member };
}

/**
 * POST /v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber
 * Body: { pushToken }
 */
router.post(
  '/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const deviceLibraryIdentifier = paramStr(req.params.deviceLibraryIdentifier);
      const passTypeIdentifier = paramStr(req.params.passTypeIdentifier);
      const serialNumber = paramStr(req.params.serialNumber);
      const auth = await assertPassAuth(req, serialNumber, passTypeIdentifier);
      if (!auth) {
        res.status(401).end();
        return;
      }
      const pushToken =
        typeof (req.body as { pushToken?: unknown })?.pushToken === 'string'
          ? String((req.body as { pushToken: string }).pushToken).trim()
          : '';
      if (!pushToken) {
        res.status(400).end();
        return;
      }

      const { AppleWalletRegistration } = models();
      const filter = {
        deviceLibraryIdentifier,
        passTypeIdentifier,
        serialNumber,
      };
      const existing = await AppleWalletRegistration.findOne(filter).lean();
      await AppleWalletRegistration.findOneAndUpdate(
        filter,
        {
          $set: {
            ...filter,
            pushToken,
            memberId: auth.member._id,
          },
        },
        { upsert: true, new: true },
      );
      res.status(existing ? 200 : 201).end();
    } catch (err) {
      next(err);
    }
  },
);

/**
 * DELETE /v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber
 */
router.delete(
  '/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const deviceLibraryIdentifier = paramStr(req.params.deviceLibraryIdentifier);
      const passTypeIdentifier = paramStr(req.params.passTypeIdentifier);
      const serialNumber = paramStr(req.params.serialNumber);
      const auth = await assertPassAuth(req, serialNumber, passTypeIdentifier);
      if (!auth) {
        res.status(401).end();
        return;
      }
      const { AppleWalletRegistration } = models();
      await AppleWalletRegistration.deleteOne({
        deviceLibraryIdentifier,
        passTypeIdentifier,
        serialNumber,
      });
      res.status(200).end();
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier?passesUpdatedSince=
 */
router.get(
  '/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const deviceLibraryIdentifier = paramStr(req.params.deviceLibraryIdentifier);
      const passTypeIdentifier = paramStr(req.params.passTypeIdentifier);
      if (passTypeIdentifier !== expectedPassTypeId()) {
        res.status(404).end();
        return;
      }
      const { AppleWalletRegistration, PlatformMember } = models();
      const regs = (await AppleWalletRegistration.find({
        deviceLibraryIdentifier,
        passTypeIdentifier,
      })
        .select('serialNumber memberId')
        .lean()) as unknown as Array<{ serialNumber: string; memberId: mongoose.Types.ObjectId }>;

      if (regs.length === 0) {
        res.status(204).end();
        return;
      }

      const sinceMs = parsePassesUpdatedSince(req.query.passesUpdatedSince);
      const styleAt = await getAppleWalletStyleUpdatedAt();
      const memberIds = regs.map((r) => r.memberId);
      const members = (await PlatformMember.find({ _id: { $in: memberIds } })
        .select('_id appleWalletUpdatedAt')
        .lean()) as Array<{ _id: mongoose.Types.ObjectId; appleWalletUpdatedAt?: Date | null }>;
      const byId = new Map(members.map((m) => [m._id.toString(), m]));

      const serialNumbers: string[] = [];
      let maxTag = 0;
      for (const reg of regs) {
        const m = byId.get(reg.memberId.toString());
        const tag = passUpdateTag(m?.appleWalletUpdatedAt, styleAt);
        const tagMs = Number(tag) || 0;
        if (tagMs > maxTag) maxTag = tagMs;
        if (!sinceMs || tagMs > sinceMs) {
          serialNumbers.push(reg.serialNumber);
        }
      }

      if (serialNumbers.length === 0) {
        res.status(204).end();
        return;
      }

      res.json({
        lastUpdated: String(maxTag || Date.now()),
        serialNumbers,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /v1/passes/:passTypeIdentifier/:serialNumber
 */
router.get(
  '/v1/passes/:passTypeIdentifier/:serialNumber',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const passTypeIdentifier = paramStr(req.params.passTypeIdentifier);
      const serialNumber = paramStr(req.params.serialNumber);
      const auth = await assertPassAuth(req, serialNumber, passTypeIdentifier);
      if (!auth) {
        res.status(401).end();
        return;
      }
      const settings = await getAppleWalletSettings();
      if (!settings.enabled) {
        res.status(404).end();
        return;
      }

      const styleAt = await getAppleWalletStyleUpdatedAt();
      const lastMod = new Date(
        Number(passUpdateTag(auth.member.appleWalletUpdatedAt, styleAt)) || Date.now(),
      );
      const ims = req.headers['if-modified-since'];
      if (typeof ims === 'string') {
        const since = new Date(ims);
        if (!Number.isNaN(since.getTime()) && lastMod.getTime() <= since.getTime()) {
          res.status(304).end();
          return;
        }
      }

      const token =
        (auth.member.appleWalletAuthToken || '').trim() ||
        (await ensureAppleWalletAuthToken(auth.member._id));
      const buf = await buildPlatformMemberPkpass(
        {
          id: String(auth.member._id),
          memberNo: auth.member.memberNo,
          displayName: auth.member.displayName,
          phone: auth.member.phone,
          creditBalance: auth.member.creditBalance,
          authenticationToken: token,
        },
        settings,
      );
      res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
      res.setHeader('Last-Modified', lastMod.toUTCString());
      res.send(buf);
    } catch (err) {
      next(err);
    }
  },
);

/** POST /v1/log — Apple 调试日志 */
router.post('/v1/log', async (req: Request, res: Response) => {
  try {
    const logs = (req.body as { logs?: unknown })?.logs;
    if (Array.isArray(logs) && logs.length) {
      console.log('[apple-wallet] device log:', logs.slice(0, 20));
    }
  } catch {
    /* ignore */
  }
  res.status(200).end();
});

export default router;
