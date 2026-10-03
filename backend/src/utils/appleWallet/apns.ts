import http2 from 'http2';
import { loadAppleWalletSignerMaterial } from './certs';

export type ApnsPushResult = {
  pushToken: string;
  status: number;
  reason?: string;
};

/**
 * 用 Pass Type ID 证书向生产 APNs 发送空推送（Wallet 卡更新）。
 * Wallet 更新推送仅走 production，不用 sandbox。
 */
export async function sendWalletPassUpdatePush(pushToken: string): Promise<ApnsPushResult> {
  const token = pushToken.trim();
  if (!token) return { pushToken: '', status: 0, reason: 'empty token' };

  const signer = loadAppleWalletSignerMaterial();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ApnsPushResult) => {
      if (settled) return;
      settled = true;
      try {
        client.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const client = http2.connect('https://api.push.apple.com', {
      key: signer.signerKeyPem,
      cert: signer.signerCertPem,
    });

    client.on('error', (err) => {
      finish({ pushToken: token, status: 0, reason: err.message });
    });

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      'apns-topic': signer.passTypeId,
      'apns-push-type': 'background',
      'apns-priority': '5',
      'content-type': 'application/json',
      'content-length': 2,
    });

    let status = 0;
    let body = '';
    req.on('response', (headers) => {
      status = Number(headers[':status'] || 0);
    });
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      let reason: string | undefined;
      try {
        if (body) reason = (JSON.parse(body) as { reason?: string }).reason;
      } catch {
        reason = body || undefined;
      }
      finish({ pushToken: token, status, reason });
    });
    req.on('error', (err) => {
      finish({ pushToken: token, status: 0, reason: err.message });
    });

    req.end('{}');

    setTimeout(() => {
      finish({ pushToken: token, status: 0, reason: 'timeout' });
    }, 12000);
  });
}

export async function sendWalletPassUpdatePushes(
  pushTokens: string[],
  opts?: { concurrency?: number },
): Promise<ApnsPushResult[]> {
  const unique = [...new Set(pushTokens.map((t) => t.trim()).filter(Boolean))];
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 8, 20));
  const out: ApnsPushResult[] = [];
  let i = 0;
  async function worker() {
    while (i < unique.length) {
      const idx = i++;
      out[idx] = await sendWalletPassUpdatePush(unique[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()));
  return out;
}
