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
  if (typeof document !== 'undefined') {
    document.documentElement.classList.add('lzfood-waiter');
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

/** Lift bottom sheets above the Android IME when the WebView does not resize. */
export function bindWaiterKeyboardInset(): () => void {
  const root = document.documentElement;
  root.classList.add('lzfood-waiter');
  const sync = () => {
    const vv = window.visualViewport;
    if (!vv) {
      root.style.setProperty('--waiter-keyboard', '0px');
      return;
    }
    const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    root.style.setProperty('--waiter-keyboard', `${inset}px`);
  };
  const onFocus = (e: FocusEvent) => {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    window.setTimeout(() => {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }, 280);
  };
  sync();
  window.visualViewport?.addEventListener('resize', sync);
  window.visualViewport?.addEventListener('scroll', sync);
  window.addEventListener('focusin', onFocus);
  return () => {
    window.visualViewport?.removeEventListener('resize', sync);
    window.visualViewport?.removeEventListener('scroll', sync);
    window.removeEventListener('focusin', onFocus);
    root.style.removeProperty('--waiter-keyboard');
  };
}
