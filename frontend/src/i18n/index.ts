import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enUS from './locales/en-US.json';
import zhCN from './locales/zh-CN.json';

export const SUPPORTED_LANGS = ['en-US', 'zh-CN'] as const;
export type AppLanguage = (typeof SUPPORTED_LANGS)[number];

const LANGUAGE_KEY = 'language';
/** Set when the user explicitly picks a language in the UI */
const LANGUAGE_PREF_KEY = 'language_pref';

function isAppLanguage(value: string | null | undefined): value is AppLanguage {
  return value === 'en-US' || value === 'zh-CN';
}

/** Prefer zh when browser languages include Chinese; otherwise en-US. */
export function detectBrowserLanguage(): AppLanguage {
  const list: string[] = [];
  if (typeof navigator !== 'undefined') {
    if (Array.isArray(navigator.languages)) list.push(...navigator.languages);
    if (navigator.language) list.push(navigator.language);
  }
  for (const raw of list) {
    const lower = String(raw || '').toLowerCase();
    if (lower.startsWith('zh')) return 'zh-CN';
  }
  return 'en-US';
}

/**
 * Persist an explicit UI language choice (survives reloads; overrides browser default).
 */
export function persistUserLanguage(lng: string): void {
  if (!isAppLanguage(lng)) return;
  localStorage.setItem(LANGUAGE_KEY, lng);
  localStorage.setItem(LANGUAGE_PREF_KEY, '1');
}

function resolveInitialLanguage(): AppLanguage {
  // Drop the old one-time force-to-en-US migration so browser can win for users
  // who never explicitly chose a language.
  if (!localStorage.getItem('language_v3')) {
    localStorage.setItem('language_v3', '1');
    localStorage.removeItem('language_v2');
    if (localStorage.getItem(LANGUAGE_PREF_KEY) !== '1') {
      localStorage.removeItem(LANGUAGE_KEY);
    }
  }

  if (localStorage.getItem(LANGUAGE_PREF_KEY) === '1') {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    if (isAppLanguage(saved)) return saved;
  }

  const detected = detectBrowserLanguage();
  localStorage.setItem(LANGUAGE_KEY, detected);
  return detected;
}

const initialLanguage = resolveInitialLanguage();

i18n.use(initReactI18next).init({
  resources: {
    'en-US': { translation: enUS },
    'zh-CN': { translation: zhCN },
  },
  lng: initialLanguage,
  fallbackLng: 'en-US',
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
