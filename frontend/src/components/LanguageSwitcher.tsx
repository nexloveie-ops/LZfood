import { useTranslation } from 'react-i18next';
import { persistUserLanguage } from '../i18n';

const languages = [
  { code: 'zh-CN', flag: '🇨🇳' },
  { code: 'en-US', flag: '🇬🇧' },
];

export default function LanguageSwitcher() {
  const { i18n } = useTranslation();

  const handleSwitch = (lng: string) => {
    void i18n.changeLanguage(lng);
    persistUserLanguage(lng);
  };

  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {languages.map((lang) => {
        const isActive = i18n.language === lang.code;
        return (
          <button
            key={lang.code}
            onClick={() => handleSwitch(lang.code)}
            aria-label={lang.code}
            style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              border: isActive ? '2px solid var(--red-primary, #C41E24)' : '2px solid transparent',
              background: isActive ? 'var(--red-light, #FFEBEE)' : 'transparent',
              fontSize: 20,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.15s',
              padding: 0,
              opacity: isActive ? 1 : 0.6,
            }}
          >
            {lang.flag}
          </button>
        );
      })}
    </div>
  );
}
