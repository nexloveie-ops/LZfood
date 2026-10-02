import crypto from 'crypto';

export type FeieyunPrintResult = {
  ok: boolean;
  ret: number;
  msg: string;
  orderId?: string;
};

function apiBase(): string {
  const raw = (process.env.FEIEYUN_API_BASE || 'https://api.de.feieyun.com/Api/Open').trim();
  return raw.replace(/\/+$/, '');
}

export function isFeieyunConfigured(): boolean {
  return Boolean(process.env.FEIEYUN_USER?.trim() && process.env.FEIEYUN_UKEY?.trim());
}

async function feieCall(path: string, apiname: string, extra: Record<string, string>): Promise<{ ret: number; msg: string; data: unknown }> {
  const user = process.env.FEIEYUN_USER?.trim() || '';
  const ukey = process.env.FEIEYUN_UKEY?.trim() || '';
  if (!user || !ukey) {
    return { ret: -2, msg: 'Feieyun credentials not configured', data: null };
  }
  const stime = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHash('sha1').update(user + ukey + stime).digest('hex');
  const body = new URLSearchParams({ user, stime, sig, apiname, ...extra });
  const res = await fetch(`${apiBase()}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as { ret: number; msg: string; data: unknown };
  } catch {
    return { ret: -1, msg: text.slice(0, 200), data: null };
  }
}

/** 小票机：<BR> 换行；不要 <CUT>（机子任务结束会自动切）。content ≤ 5000 字节。 */
export async function feieyunPrintMsg(sn: string, content: string, times = 1): Promise<FeieyunPrintResult> {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > 5000) {
    return { ok: false, ret: -2, msg: `print content ${bytes} bytes exceeds 5000` };
  }
  const copies = Math.min(5, Math.max(1, Math.floor(times)));
  const r = await feieCall('printMsg', 'Open_printMsg', { sn, content, times: String(copies) });
  return {
    ok: r.ret === 0,
    ret: r.ret,
    msg: r.msg,
    orderId: r.ret === 0 ? String(r.data) : undefined,
  };
}
