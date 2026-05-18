import { Router, type Request, type Response, type NextFunction } from 'express';
import { createAppError } from '../middleware/errorHandler';
import {
  completeOwnerPasswordReset,
  sendOwnerPasswordResetCode,
} from '../utils/portalPasswordReset';
import { portalOriginInputFromRequest } from '../utils/portalPublicOrigin';
import {
  assertSlugAvailable,
  completePortalRegistration,
  normalizeSlug,
  PORTAL_SLUG_RE,
  resolveStoreLogin,
  sendRegistrationOtp,
} from '../utils/portalRegistration';

const router = Router();

/** GET /api/public/portal/slug-available/:slug */
router.get('/slug-available/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw = typeof req.params.slug === 'string' ? req.params.slug : '';
    const slug = normalizeSlug(raw);
    if (!slug) {
      res.json({ available: false, reason: 'empty' });
      return;
    }
    if (!PORTAL_SLUG_RE.test(slug)) {
      res.json({ available: false, reason: 'format' });
      return;
    }
    try {
      await assertSlugAvailable(slug);
      res.json({ available: true, slug });
    } catch (err: unknown) {
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code) : '';
      if (code === 'CONFLICT') {
        res.json({ available: false, reason: 'taken', slug });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

/** POST /api/public/portal/register/send-code  { email } */
router.post('/register/send-code', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body as { email?: string };
    if (!email || typeof email !== 'string') {
      throw createAppError('VALIDATION_ERROR', '邮箱必填');
    }
    await sendRegistrationOtp(email);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** POST /api/public/portal/register/complete */
router.post('/register/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { displayName, slug, email, code, username, password, publicOrigin } = req.body as {
      displayName?: string;
      slug?: string;
      email?: string;
      code?: string;
      username?: string;
      password?: string;
      publicOrigin?: string;
    };
    if (!displayName || !slug || !email || !code || !username || !password) {
      throw createAppError('VALIDATION_ERROR', '请填写完整注册信息');
    }
    const result = await completePortalRegistration({
      displayName,
      slug,
      email,
      code,
      username,
      password,
      portalOrigin: portalOriginInputFromRequest(req, { publicOrigin }),
    });
    res.status(201).json({
      ...result,
      loginPath: `/${result.slug}/login`,
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/public/portal/password-reset/send-code  { slug, email } */
router.post('/password-reset/send-code', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { slug, email, publicOrigin } = req.body as {
      slug?: string;
      email?: string;
      publicOrigin?: string;
    };
    if (!slug || typeof slug !== 'string' || !email || typeof email !== 'string') {
      throw createAppError('VALIDATION_ERROR', '店铺 slug 与邮箱必填');
    }
    await sendOwnerPasswordResetCode(
      slug,
      email,
      portalOriginInputFromRequest(req, { publicOrigin }),
    );
    res.json({
      ok: true,
      message:
        '若该邮箱为本店注册邮箱，您将收到验证码。/ If this email is registered for this store, you will receive a code.',
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/public/portal/password-reset/complete */
router.post('/password-reset/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { slug, email, code, newPassword, publicOrigin } = req.body as {
      slug?: string;
      email?: string;
      code?: string;
      newPassword?: string;
      publicOrigin?: string;
    };
    if (!slug || !email || !code || !newPassword) {
      throw createAppError('VALIDATION_ERROR', '请填写完整信息');
    }
    const result = await completeOwnerPasswordReset({
      slug,
      email,
      code,
      newPassword,
      portalOrigin: portalOriginInputFromRequest(req, { publicOrigin }),
    });
    res.json({
      ok: true,
      ...result,
      loginPath: `/${result.slug}/login`,
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/public/portal/login/resolve  { slug } */
router.post('/login/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { slug } = req.body as { slug?: string };
    if (!slug || typeof slug !== 'string') {
      throw createAppError('VALIDATION_ERROR', '请输入店铺 slug');
    }
    const store = await resolveStoreLogin(slug);
    res.json({
      ...store,
      loginPath: `/${store.slug}/login`,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
