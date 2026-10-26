import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api/client';
import { useAuth } from '../context/AuthContext';

const STORAGE_KEY = 'lzfood.adminMenuId';

export type AdminMenu = {
  _id: string;
  isDefault?: boolean;
  sortOrder?: number;
  channels?: string[];
  schedule?: { days?: number[]; start?: string; end?: string }[];
  translations?: { locale: string; name: string }[];
};

export function adminMenuName(menu: AdminMenu, lang: string): string {
  const hit = menu.translations?.find((t) => t.locale === lang) || menu.translations?.[0];
  return hit?.name || menu._id;
}

export function useAdminMenus() {
  const { token } = useAuth();
  const [menus, setMenus] = useState<AdminMenu[]>([]);
  const [menuId, setMenuIdState] = useState(() => {
    try {
      return sessionStorage.getItem(STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });

  const reload = useCallback(async () => {
    const res = await apiFetch('/api/menus', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const data = (await res.json()) as AdminMenu[];
    const list = Array.isArray(data) ? data : [];
    setMenus(list);
    setMenuIdState((prev) => {
      if (prev && list.some((m) => m._id === prev)) return prev;
      const def = list.find((m) => m.isDefault) || list[0];
      const next = def?._id || '';
      try {
        if (next) sessionStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, [token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setMenuId = useCallback((id: string) => {
    setMenuIdState(id);
    try {
      sessionStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
  }, []);

  return { menus, menuId, setMenuId, reload };
}
