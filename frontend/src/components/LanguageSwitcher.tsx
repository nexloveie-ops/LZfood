import { useTranslation } from 'react-i18next';
import { persistUserLanguage } from '../i18n';

const languages = [
  { code: 'zh-CN', flag: '🇨🇳', short: '中' },
  { code: 'en-US', flag: '🇬🇧', short: 'EN' },
];

export default function LanguageSwitcher({ variant = 'flags' }: { variant?: 'flags' | 'text' }) {
  const { i18n } = useTranslation();

  const handleSwitch = (lng: string) => {
    void i18n.changeLanguage(lng);
    persistUserLanguage(lng);
  };

  return (
    <div style={{ display: 'flex', gap: 4 }} role="group" aria-label="Language">
      {languages.map((lang) => {
        const code = (i18n.language || '').toLowerCase();
        const isActive = code === lang.code.toLowerCase() || code.startsWith(lang.code.slice(0, 2).toLowerCase());
        const textMode = variant === 'text';
        return (
          <button
            type="button"
            key={lang.code}
            onClick={() => handleSwitch(lang.code)}
            aria-label={lang.code}
            aria-pressed={isActive}
            style={{
              width: textMode ? 'auto' : 36,
              minWidth: textMode ? 40 : 36,
              height: 36,
              borderRadius: textMode ? 8 : '50%',
              border: isActive ? '2px solid var(--red-primary, #C41E24)' : '2px solid var(--border, #e2e8f0)',
              background: isActive ? 'var(--red-light, #FFEBEE)' : '#fff',
              fontSize: textMode ? 13 : 20,
              fontWeight: textMode ? 700 : 400,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.15s',
              padding: textMode ? '0 10px' : 0,
              opacity: isActive ? 1 : 0.7,
              color: 'var(--text-primary, #0f172a)',
            }}
          >
            {textMode ? lang.short : lang.flag}
          </button>
        );
      })}
    </div>
  );
}
