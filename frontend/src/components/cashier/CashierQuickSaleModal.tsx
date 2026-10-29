import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../../api/client';

export type QuickSaleFormResult = {
  nameZh: string;
  nameEn: string;
  categoryId: string;
  unitPrice: number;
};

type CategoryOpt = { _id: string; translations: { locale: string; name: string }[] };

type Props = {
  categories: CategoryOpt[];
  getCategoryName: (translations: { locale: string; name: string }[]) => string;
  onConfirm: (result: QuickSaleFormResult) => void;
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

export default function CashierQuickSaleModal({
  categories,
  getCategoryName,
  onConfirm,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState(categories[0]?._id || '');
  const [priceInput, setPriceInput] = useState('');
  const [error, setError] = useState('');
  const [translating, setTranslating] = useState(false);
  const [translation, setTranslation] = useState<BilingualPair | null>(null);
  const translateGenRef = useRef(0);
  const nameRef = useRef<HTMLInputElement>(null);

  const catOptions = useMemo(() => categories, [categories]);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

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
    const text = name.trim();
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
  }, [name, runAutoTranslate]);

  const handleConfirm = async () => {
    setError('');
    const text = name.trim();
    if (!text) {
      setError(t('cashier.quickSaleNameRequired'));
      return;
    }
    if (!categoryId) {
      setError(t('cashier.quickSaleCategoryRequired'));
      return;
    }
    const parsed = parseFloat(String(priceInput).trim().replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 999.99) {
      setError(t('cashier.quickSalePriceInvalid'));
      return;
    }
    setTranslating(true);
    try {
      const pair = translation?.source === text ? translation : await toBilingualPair(text);
      onConfirm({
        nameZh: pair.zh,
        nameEn: pair.en,
        categoryId,
        unitPrice: Math.round(parsed * 100) / 100,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setTranslating(false);
    }
  };

  const previewText =
    translation && name.trim() === translation.source
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
        <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700 }}>{t('cashier.quickSaleTitle')}</h3>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-light)', lineHeight: 1.4 }}>
          {t('cashier.quickSaleHint')}
        </p>

        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>{t('cashier.quickSaleNameLabel')}</label>
        <input
          ref={nameRef}
          className="input"
          value={name}
          onChange={(e) => { setName(e.target.value); setError(''); }}
          placeholder={t('cashier.quickSaleNamePlaceholder')}
          maxLength={80}
          style={{ width: '100%', marginBottom: 10 }}
        />
        {translating ? (
          <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: -6, marginBottom: 8 }}>{t('cashier.adHocTranslating')}</div>
        ) : previewText ? (
          <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: -6, marginBottom: 8 }}>{previewText}</div>
        ) : null}

        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>{t('cashier.quickSaleCategoryLabel')}</label>
        <select
          className="input"
          value={categoryId}
          onChange={(e) => { setCategoryId(e.target.value); setError(''); }}
          style={{ width: '100%', marginBottom: 10 }}
        >
          {catOptions.map((c) => (
            <option key={c._id} value={c._id}>{getCategoryName(c.translations)}</option>
          ))}
        </select>

        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>{t('cashier.quickSalePriceLabel')}</label>
        <input
          className="input"
          inputMode="decimal"
          value={priceInput}
          onChange={(e) => { setPriceInput(e.target.value); setError(''); }}
          placeholder="0.00"
          style={{ width: '100%', marginBottom: 12 }}
        />

        {error ? <div style={{ color: 'var(--red-primary)', fontSize: 12, marginBottom: 10 }}>{error}</div> : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" onClick={() => void handleConfirm()} disabled={translating}>
            {t('cashier.quickSaleAdd')}
          </button>
        </div>
      </div>
    </div>
  );
}
