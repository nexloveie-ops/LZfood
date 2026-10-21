import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';
import { getJwtSecret, JwtPayload } from '../middleware/auth';

const router = Router();

/**
 * POST /api/auth/login
 * 店内账号：body 需 `username`, `password`, `slug`（店铺 URL 段）。
 * 平台管理员：仅需 `username`, `password`（可选 slug，用于代操作时可仍传目标店）。
 */
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password, slug } = req.body as {
      username?: string;
      password?: string;
      slug?: string;
    };

    if (!username || !password) {
      throw createAppError('VALIDATION_ERROR', 'Username and password are required');
    }

    const { Admin, Store } = getModels();

    let admin = await Admin.findOne({ username, role: 'platform_owner' });

    if (!admin) {
      if (!slug || typeof slug !== 'string') {
        throw createAppError('VALIDATION_ERROR', '店铺 slug 必填（X-Store-Slug 对应值）');
      }
      const store = await Store.findOne({ slug: slug.trim().toLowerCase() });
      if (!store) {
        throw createAppError('UNAUTHORIZED', 'Invalid credentials');
      }
      admin = await Admin.findOne({
        username,
        storeId: store._id,
        role: { $in: ['owner', 'cashier', 'purchasing'] },
      });
    }

    if (!admin) {
      throw createAppError('UNAUTHORIZED', 'Invalid credentials');
    }

    const a = admin as unknown as {
      _id: { toString(): string };
      username: string;
      passwordHash: string;
      role: string;
      storeId?: { toString(): string };
    };

    const isMatch = await bcrypt.compare(password, a.passwordHash);
    if (!isMatch) {
      throw createAppError('UNAUTHORIZED', 'Invalid credentials');
    }

    const payload: JwtPayload = {
      userId: a._id.toString(),
      username: a.username,
      role: a.role as JwtPayload['role'],
    };
    if (a.storeId) {
      payload.storeId = a.storeId.toString();
    }

    const token = jwt.sign(payload, getJwtSecret(), { expiresIn: '8h' });

    res.json({
      token,
      user: {
        id: a._id,
        username: a.username,
        role: a.role,
        storeId: a.storeId ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
