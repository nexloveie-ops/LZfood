import { Request, Response, NextFunction } from 'express';

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
  details?: Record<string, unknown>;
}

const STATUS_CODE_MAP: Record<string, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  STORE_REQUIRED: 400,
  STORE_NOT_FOUND: 404,
  STORE_INACTIVE: 403,
  CONFLICT: 409,
  ITEM_SOLD_OUT: 409,
  ORDER_NOT_MODIFIABLE: 409,
  CATEGORY_HAS_ITEMS: 409,
  PAYMENT_AMOUNT_MISMATCH: 400,
  MEMBER_INSUFFICIENT_BALANCE: 400,
  INVALID_FILE_FORMAT: 400,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  RATE_LIMIT: 429,
};

export function createAppError(
  code: string,
  message: string,
  details?: Record<string, unknown>
): AppError {
  const err: AppError = new Error(message);
  err.code = code;
  err.statusCode = STATUS_CODE_MAP[code] || 500;
  err.details = details;
  return err;
}

export function errorHandler(
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message = err.message || 'Internal server error';
  const details = err.details || {};

  if (statusCode === 500) {
    console.error('Internal server error:', err);
  }

  res.status(statusCode).json({
    error: {
      code,
      message,
      details,
    },
  });
}
