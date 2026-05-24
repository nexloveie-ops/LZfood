import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../../api/client';

export type AdHocOptionFormResult = {
  choiceNameZh: string;
  choiceNameEn: string;
  extraPrice: number;
};

type Props = {
  dishName: string;
  existingCount: number;
  maxPerLine: number;
  onConfirm: (result: AdHocOptionFormResult) => void;
  onClose: () => void;
};

type BilingualPair = { source: string; zh: string; en: string };

function detectInputLang(text: string): 'zh' | 'en' {
  if (/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(text)) return 'zh';
  return 'en';
}

async function fetchTranslation(text: string, source: 'zh' | 'en', target: 'zh' | 'en'): Promise<string> {
  const res = await apiFetch('/api/admin/translate-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, source, target }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => null);
    throw new Error((d as { error?: { message?: string } })?.error?.message || 'Translation failed');
  }
  const data = (await res.json()) as { translatedText?: string };
  return (data.translatedText || '').trim();
}

async function toBilingualPair(text: string): Promise<BilingualPair> {
  const lang = detectInputLang(text);
  if (lang === 'zh') {
    try {
      const en = await fetchTranslation(text, 'zh', 'en');
      return { source: text, zh: text, en: en || text };
    } catch {
      return { source: text, zh: text, en: text };
    }
  }
  try {
    const zh = await fetchTranslation(text, 'en', 'zh');
    return { source: text, zh: zh || text, en: text };
  } catch {
    return { source: text, zh: text, en: text };
  }
}

export default function CashierAdHocOptionModal({
  dishName,
  existingCount,
  maxPerLine,
  onConfirm,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [content, setContent] = useState('');
  const [extraPriceInput, setExtraPriceInput] = useState('0.00');
  const [error, setError] = useState('');
  const [translating, setTranslating] = useState(false);
  const [translation, setTranslation] = useState<BilingualPair | null>(null);
  const translateGenRef = useRef(0);

  const runAutoTranslate = useCallback(async (text: string, gen: number) => {
    setTranslating(true);
    try {
      const pair = await toBilingualPair(text);
      if (gen === translateGenRef.current) setTranslation(pair);
    } catch {
      if (gen === translateGenRef.current) {
        setTranslation({ source: text, zh: text, en: text });
      }
    } finally {
      if (gen === translateGenRef.current) setTranslating(false);
    }
  }, []);

  useEffect(() => {
    const text = content.trim();
    if (!text) {
      setTranslation(null);
      setTranslating(false);
      return;
    }
    const gen = ++translateGenRef.current;
    const timer = setTimeout(() => {
      void runAutoTranslate(text, gen);
    }, 600);
    return () => clearTimeout(timer);
  }, [content, runAutoTranslate]);

  const resolveTranslation = async (text: string): Promise<BilingualPair> => {
    if (translation?.source === text) return translation;
    return toBilingualPair(text);
  };

  const handleConfirm = async () => {
    setError('');
    const text = content.trim();
    if (!text) {
      setError(t('cashier.adHocChoiceRequired'));
      return;
    }
    const parsed = parseFloat(String(extraPriceInput).trim().replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed < 0) {
      setError(t('cashier.adHocPriceInvalid'));
      return;
    }
    if (parsed > 50) {
      setError(t('cashier.adHocPriceTooHigh'));
      return;
    }

    setTranslating(true);
    try {
      const pair = await resolveTranslation(text);
      onConfirm({
        choiceNameZh: pair.zh,
        choiceNameEn: pair.en,
        extraPrice: Math.round(parsed * 100) / 100,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setTranslating(false);
    }
  };

  const bumpExtraPrice = () => {
    const current = parseFloat(String(extraPriceInput).trim().replace(',', '.'));
    const base = Number.isFinite(current) && current >= 0 ? current : 0;
    const next = Math.min(50, Math.round((base + 0.5) * 100) / 100);
    setExtraPriceInput(next.toFixed(2));
    setError('');
  };

  const previewText =
    translation && content.trim() === translation.source
      ? detectInputLang(translation.source) === 'zh'
        ? translation.en
        : translation.zh
      : '';

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        zIndex: 1200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        className="card"
        style={{ width: '100%', maxWidth: 400, padding: 16, maxHeight: '90vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700 }}>{t('cashier.adHocTitle')}</h3>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-light)', lineHeight: 1.4 }}>
          {dishName} · {t('cashier.adHocCountHint', { count: existingCount, max: maxPerLine })}
        </p>

        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>{t('cashier.adHocChoiceRequiredLabel')}</label>
        <input
          className="input"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t('cashier.adHocContentPlaceholder')}
          style={{ width: '100%', fontSize: 13, padding: '6px 8px', minHeight: 0, marginBottom: 4 }}
          autoFocus
        />
        {content.trim() ? (
          <div style={{ fontSize: 11, color: 'var(--text-light)', marginBottom: 10, minHeight: 16, lineHeight: 1.4 }}>
            {translating ? t('cashier.adHocTranslating') : previewText || null}
          </div>
        ) : (
          <div style={{ marginBottom: 10 }} />
        )}

        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>{t('cashier.adHocExtraPrice')}</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
          <span style={{ fontWeight: 700 }}>€</span>
          <input className="input cashier-qty-input" type="number" min={0} step="0.01" value={extraPriceInput} onChange={(e) => setExtraPriceInput(e.target.value)} style={{ width: 72, textAlign: 'center' }} />
          <button type="button" className="btn btn-outline" style={{ fontSize: 11, padding: '4px 8px', whiteSpace: 'nowrap' }} onClick={bumpExtraPrice}>
            {t('cashier.adHocExtraPriceQuick')}
          </button>
        </div>

        {error ? <div style={{ fontSize: 12, color: 'var(--red-primary)', marginBottom: 10 }}>{error}</div> : null}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={translating}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" onClick={() => void handleConfirm()} disabled={translating}>
            {translating ? t('cashier.adHocTranslating') : t('cashier.adHocAdd')}
          </button>
        </div>
      </div>
    </div>
  );
}
