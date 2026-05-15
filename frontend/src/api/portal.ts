type ApiErrorBody = { error?: { message?: string; code?: string } };

async function parsePortalResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = (body as ApiErrorBody)?.error?.message || res.statusText || 'Request failed';
    throw new Error(msg);
  }
  return body as T;
}

export type SlugAvailability = {
  available: boolean;
  slug?: string;
  reason?: 'empty' | 'format' | 'taken';
};

export async function checkPortalSlugAvailable(slug: string): Promise<SlugAvailability> {
  const encoded = encodeURIComponent(slug.trim().toLowerCase());
  const res = await fetch(`/api/public/portal/slug-available/${encoded}`);
  return parsePortalResponse<SlugAvailability>(res);
}

export async function sendPortalRegistrationCode(email: string): Promise<void> {
  const res = await fetch('/api/public/portal/register/send-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  await parsePortalResponse<{ ok: boolean }>(res);
}

export type PortalRegisterResult = {
  slug: string;
  storeId: string;
  loginPath: string;
};

export async function completePortalRegistration(payload: {
  displayName: string;
  slug: string;
  email: string;
  code: string;
  username: string;
  password: string;
}): Promise<PortalRegisterResult> {
  const res = await fetch('/api/public/portal/register/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parsePortalResponse<PortalRegisterResult>(res);
}

export type PortalLoginResolve = {
  slug: string;
  status: string;
  loginPath: string;
};

export async function resolvePortalLogin(slug: string): Promise<PortalLoginResolve> {
  const res = await fetch('/api/public/portal/login/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  return parsePortalResponse<PortalLoginResolve>(res);
}

export async function sendOwnerPasswordResetCode(slug: string, email: string): Promise<void> {
  const res = await fetch('/api/public/portal/password-reset/send-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, email }),
  });
  await parsePortalResponse<{ ok: boolean }>(res);
}

export type OwnerPasswordResetResult = {
  ok: boolean;
  slug: string;
  username: string;
  loginPath: string;
};

export async function completeOwnerPasswordReset(payload: {
  slug: string;
  email: string;
  code: string;
  newPassword: string;
}): Promise<OwnerPasswordResetResult> {
  const res = await fetch('/api/public/portal/password-reset/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parsePortalResponse<OwnerPasswordResetResult>(res);
}
