import { io, type Socket } from 'socket.io-client';

/**
 * 与 `api/client` 中 `VITE_API_ORIGIN` 规则一致：
 * - 未配置：Socket 走当前页 origin（开发时依赖 Vite 对 `/socket.io` 的代理）
 * - 已配置且与当前页 **不同 host**：与 REST 一样直连后端（避免 API 走 8080、Socket 仍连 5173 导致失败）
 */
export function getSocketIoServerUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const raw = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.trim().replace(/\/$/, '') ?? '';
  if (!raw) return undefined;
  try {
    const api = new URL(raw.endsWith('/') ? raw.slice(0, -1) : raw);
    const page = new URL(window.location.href);
    if (api.host !== page.host) return api.origin;
  } catch {
    /* ignore */
  }
  return undefined;
}

/** 收银端店铺房间：与现有各页 `io({ query: { storeId } })` 行为一致，仅统一 URL 与传输策略 */
export function connectStoreSocket(query: Record<string, string | undefined>): Socket {
  const url = getSocketIoServerUrl();
  const q = Object.fromEntries(
    Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== ''),
  );
  const transports: string[] = ['polling', 'websocket'];
  const opts = {
    transports,
    query: q,
    path: '/socket.io',
  };
  return url ? io(url, opts) : io(opts);
}
