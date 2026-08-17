const STORAGE_KEY = 'lzfood_waiter_mode';

declare global {
  interface Window {
    LZFOODWaiter?: { isWaiter?: boolean };
  }
}

export function isWaiterBridge(): boolean {
  try {
    const w = window.LZFOODWaiter as { isWaiter?: boolean | (() => boolean) } | undefined;
    if (!w) return false;
    if (w.isWaiter === true) return true;
    if (typeof w.isWaiter === 'function') return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function activateWaiterMode(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, '1');
  } catch {
    /* private mode */
  }
}

export function isWaiterMode(): boolean {
  if (typeof window === 'undefined') return false;
  if (isWaiterBridge()) return true;
  try {
    return sessionStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Persist waiter mode from `?waiter=1` or the Android JS bridge. */
export function syncWaiterModeFromSearch(search: string): boolean {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  const q = new URLSearchParams(raw);
  if (q.get('waiter') === '1' || isWaiterBridge()) {
    activateWaiterMode();
    return true;
  }
  return isWaiterMode();
}

export function waiterQuerySuffix(): string {
  return isWaiterMode() ? '?waiter=1' : '';
}
