import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { apiFetch } from '../api/client';
import { useStoreSlug } from '../context/StoreContext';

export interface RestaurantConfig {
  /** 堂食流程：pay_first（默认）| pay_after（后结，能力迭代中） */
  dine_in_workflow_mode?: 'pay_first' | 'pay_after';
  restaurant_name_zh?: string;
  restaurant_name_en?: string;
  restaurant_address?: string;
  restaurant_phone?: string;
  restaurant_logo?: string;
  restaurant_website?: string;
  restaurant_email?: string;
  receipt_terms?: string;
  receipt_print_copies?: string;
  /** JSON array of { start, end } time strings — same as admin Business Hours */
  business_hours_slots?: string;
}

const configBySlug = new Map<string, RestaurantConfig>();
const promiseBySlug = new Map<string, Promise<RestaurantConfig>>();

function pickDocumentTitleName(cfg: RestaurantConfig): string {
  const zh = cfg.restaurant_name_zh?.trim();
  const en = cfg.restaurant_name_en?.trim();
  const wantsZh = (i18n.language || 'en-US').startsWith('zh');
  if (wantsZh) return zh || en || '';
  return en || zh || '';
}

export function applyDocumentTitle(cfg: RestaurantConfig, slug: string) {
  const name = pickDocumentTitleName(cfg).trim();
  document.title = name || slug || 'Restaurant';
}

function fetchConfigForSlug(slug: string): Promise<RestaurantConfig> {
  const hit = configBySlug.get(slug);
  if (hit) return Promise.resolve(hit);
  let p = promiseBySlug.get(slug);
  if (!p) {
    p = apiFetch('/api/admin/config')
      .then((r) => (r.ok ? r.json() : {}))
      .then((data) => {
        const cfg = (data || {}) as RestaurantConfig;
        configBySlug.set(slug, cfg);
        applyDocumentTitle(cfg, slug);
        return cfg;
      })
      .catch(() => {
        const cfg = {} as RestaurantConfig;
        configBySlug.set(slug, cfg);
        applyDocumentTitle(cfg, slug);
        return cfg;
      })
      .finally(() => {
        promiseBySlug.delete(slug);
      });
    promiseBySlug.set(slug, p);
  }
  return p;
}

export async function refreshRestaurantConfig(slug: string): Promise<RestaurantConfig> {
  configBySlug.delete(slug);
  promiseBySlug.delete(slug);
  const cfg = await fetchConfigForSlug(slug);
  return cfg;
}

export function useRestaurantConfig() {
  const { i18n } = useTranslation();
  const slug = useStoreSlug();
  const [config, setConfig] = useState<RestaurantConfig>(() => configBySlug.get(slug) || {});

  useEffect(() => {
    fetchConfigForSlug(slug).then(setConfig);
  }, [slug]);

  useEffect(() => {
    const syncTitle = () => applyDocumentTitle(config, slug);
    syncTitle();
    i18n.on('languageChanged', syncTitle);
    return () => {
      i18n.off('languageChanged', syncTitle);
    };
  }, [config, slug]);

  const nameZh = (config.restaurant_name_zh || '').trim();
  const nameEn = (config.restaurant_name_en || '').trim();
  const wantsZh = (i18n.language || 'en-US').startsWith('zh');
  const displayName = (wantsZh ? (nameZh || nameEn) : (nameEn || nameZh)) || '';
  /** 另一语言店名（仅当中英文都有且不同时展示，避免重复） */
  const displayNameOther =
    nameZh && nameEn && nameZh !== nameEn ? (wantsZh ? nameEn : nameZh) : '';

  return { config, displayName, displayNameOther, nameZh, nameEn };
}
