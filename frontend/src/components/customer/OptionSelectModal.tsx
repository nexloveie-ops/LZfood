import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { CartItemOption } from '../../context/CartContext';
import { getOptionalMinSelect, getOptionalMaxSelect, optionalMaxReached, optionalSelectionValid } from '../../utils/optionGroupLimits';

interface OptionChoice {
  _id: string;
  extraPrice: number;
  originalPrice?: number;
  translations: { locale: string; name: string }[];
}

export interface OptionGroup {
  _id: string;
  required: boolean;
  /** 仅非必选：最少选几项，默认 0 */
  minSelect?: number;
  /** 仅非必选：最多选几项，0 表示不限制 */
  maxSelect?: number;
  translations: { locale: string; name: string }[];
  choices: OptionChoice[];
}

interface Props {
  itemName: string;
  price: number;
  optionGroups: OptionGroup[];
  onConfirm: (options: CartItemOption[]) => void;
  onClose: () => void;
  /** customer: 底部窄 sheet；cashier: 居中宽面板，选项多列排布 */
  layout?: 'customer' | 'cashier';
}

export default function OptionSelectModal({ itemName, price, optionGroups, onConfirm, onClose, layout = 'customer' }: Props) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;

  const getName = (translations: { locale: string; name: string }[]) => {
    const found = translations.find(t2 => t2.locale === lang) || translations[0];
    return found?.name || '';
  };

  const getNameMap = (translations: { locale: string; name: string }[]): Record<string, string> =>
    Object.fromEntries(translations.map(t2 => [t2.locale, t2.name]));

  // selections: groupId -> choiceId (single) for required, groupId -> choiceId[] (multi) for optional
  const [singleSelections, setSingleSelections] = useState<Record<string, string>>({});
  const [multiSelections, setMultiSelections] = useState<Record<string, string[]>>({});

  const canConfirm = optionGroups.every((g) => {
    if (g.required) return !!singleSelections[g._id];
    const n = (multiSelections[g._id] || []).length;
    return optionalSelectionValid(g, n);
  });

  const toggleSingle = (groupId: string, choiceId: string) => {
    setSingleSelections(prev => {
      const next = { ...prev };
      if (next[groupId] === choiceId) delete next[groupId];
      else next[groupId] = choiceId;
      return next;
    });
  };

  const toggleMulti = (groupId: string, choiceId: string) => {
    const group = optionGroups.find((x) => x._id === groupId);
    if (!group) return;
    setMultiSelections((prev) => {
      const current = prev[groupId] || [];
      if (current.includes(choiceId)) {
        return { ...prev, [groupId]: current.filter((id) => id !== choiceId) };
      }
      if (optionalMaxReached(group, current.length)) return prev;
      return { ...prev, [groupId]: [...current, choiceId] };
    });
  };

  const handleConfirm = () => {
    const options: CartItemOption[] = [];
    for (const group of optionGroups) {
      if (group.required) {
        // Single select
        const choiceId = singleSelections[group._id];
        if (!choiceId) continue;
        const choice = group.choices.find(c => c._id === choiceId);
        if (!choice) continue;
        options.push({
          groupId: group._id, choiceId: choice._id,
          groupName: getNameMap(group.translations), choiceName: getNameMap(choice.translations),
          extraPrice: choice.extraPrice || 0,
        });
      } else {
        // Multi select
        const choiceIds = multiSelections[group._id] || [];
        for (const choiceId of choiceIds) {
          const choice = group.choices.find(c => c._id === choiceId);
          if (!choice) continue;
          options.push({
            groupId: group._id, choiceId: choice._id,
            groupName: getNameMap(group.translations), choiceName: getNameMap(choice.translations),
            extraPrice: choice.extraPrice || 0,
          });
        }
      }
    }
    onConfirm(options);
  };

  const totalExtra = (() => {
    let sum = 0;
    for (const group of optionGroups) {
      if (group.required) {
        const cId = singleSelections[group._id];
        if (cId) { const c = group.choices.find(x => x._id === cId); sum += c?.extraPrice || 0; }
      } else {
        for (const cId of (multiSelections[group._id] || [])) {
          const c = group.choices.find(x => x._id === cId); sum += c?.extraPrice || 0;
        }
      }
    }
    return sum;
  })();

  useEffect(() => {
    const root = document.getElementById('root');
    if (root) root.setAttribute('data-customer-sheet-open', '1');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      if (root) root.removeAttribute('data-customer-sheet-open');
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const isCashier = layout === 'cashier';

  const sheet = (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10050,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: isCashier ? 'center' : 'flex-end',
        alignItems: 'center',
        pointerEvents: 'auto',
        padding: isCashier ? 16 : 0,
      }}
    >
      <div
        role="presentation"
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.5)',
          touchAction: 'none',
        }}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="option-modal-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          zIndex: 1,
          background: 'var(--bg-white, #fff)',
          borderRadius: isCashier ? 16 : '16px 16px 0 0',
          width: '100%',
          maxWidth: isCashier ? 820 : 430,
          maxHeight: isCashier ? 'min(92dvh, 92vh)' : 'min(88dvh, 88vh)',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: isCashier ? '0 12px 40px rgba(0,0,0,0.22)' : '0 -8px 32px rgba(0,0,0,0.18)',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        {/* Header — flexShrink:0 so long option lists never push ✕ off-screen */}
        <div
          style={{
            flexShrink: 0,
            padding: isCashier ? '14px 20px 12px' : '12px 16px 10px',
            borderBottom: '1px solid var(--border, #eee)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 12,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div id="option-modal-title" style={{ fontSize: isCashier ? 18 : 16, fontWeight: 700, color: 'var(--text-dark)', lineHeight: 1.25 }}>
              {itemName}
            </div>
            <div style={{ fontSize: 14, color: 'var(--red-primary)', fontWeight: 600, marginTop: 2 }}>€{price}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('customer.closeOptionSheet')}
            style={{
              flexShrink: 0,
              width: 44,
              height: 44,
              marginTop: -4,
              marginRight: -4,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--bg, #f5f5f5)',
              border: 'none',
              borderRadius: 12,
              fontSize: 20,
              color: 'var(--text-dark)',
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>

        {/* Option groups — minHeight:0 + overscroll-behavior stops scroll chaining to menu */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            WebkitOverflowScrolling: 'touch',
            overscrollBehavior: 'contain',
            touchAction: 'pan-y',
            padding: isCashier ? '14px 20px' : '12px 16px',
          }}
        >
          {optionGroups.map(group => (
            <div key={group._id} style={{ marginBottom: isCashier ? 16 : 20 }}>
              <div style={{ fontSize: isCashier ? 15 : 14, fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {getName(group.translations)}
                {group.required
                  ? <span style={{ fontSize: 11, color: '#fff', background: 'var(--red-primary)', padding: '1px 6px', borderRadius: 4 }}>{t('admin.required')}</span>
                  : <span style={{ fontSize: 11, color: 'var(--text-light)', padding: '1px 6px', borderRadius: 4, border: '1px solid var(--border)' }}>多选</span>
                }
              </div>
              {!group.required && (getOptionalMinSelect(group) > 0 || getOptionalMaxSelect(group) > 0) && (
                <div style={{ fontSize: 11, color: 'var(--text-light)', marginBottom: 8 }}>
                  {getOptionalMaxSelect(group) === 0
                    ? t('customer.optionalAtLeast', { count: getOptionalMinSelect(group) })
                    : getOptionalMinSelect(group) === 0
                      ? t('customer.optionalAtMost', { count: getOptionalMaxSelect(group) })
                      : t('customer.optionalBetween', { min: getOptionalMinSelect(group), max: getOptionalMaxSelect(group) })}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: isCashier ? 'repeat(4, minmax(0, 1fr))' : 'repeat(2, minmax(0, 1fr))', gap: isCashier ? 10 : 8 }}>
                {group.choices.map(choice => {
                  const selected = group.required
                    ? singleSelections[group._id] === choice._id
                    : (multiSelections[group._id] || []).includes(choice._id);
                  return (
                    <div key={choice._id} onClick={() => group.required ? toggleSingle(group._id, choice._id) : toggleMulti(group._id, choice._id)}
                      style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                        padding: '10px 8px', borderRadius: 10, cursor: 'pointer', transition: 'all 0.12s',
                        border: selected ? '2px solid var(--red-primary)' : '1px solid var(--border, #ddd)',
                        background: selected ? 'var(--red-light, #FFF5F5)' : 'var(--bg, #fafafa)',
                        textAlign: 'center', minHeight: 52,
                        minWidth: 0,
                      }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: selected ? 700 : 500,
                          lineHeight: 1.35,
                          color: selected ? 'var(--red-primary)' : 'var(--text-dark)',
                          wordBreak: 'break-word',
                          textAlign: 'center',
                        }}
                      >
                        {getName(choice.translations)}
                        {((choice.extraPrice || 0) > 0
                          || (choice.originalPrice != null && choice.originalPrice > (choice.extraPrice || 0))) && (
                          <span style={{ whiteSpace: 'nowrap', fontWeight: 600, color: 'var(--red-primary)', fontSize: 12 }}>
                            {' '}
                            {choice.originalPrice != null && choice.originalPrice > (choice.extraPrice || 0) && (
                              <span style={{
                                fontSize: 10,
                                color: 'var(--text-light)',
                                textDecoration: 'line-through',
                                fontWeight: 500,
                                marginRight: 4,
                              }}>
                                +€{choice.originalPrice}
                              </span>
                            )}
                            {(choice.extraPrice || 0) > 0 ? `+€${choice.extraPrice}` : ''}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Footer — explicit cancel when ✕ is hard to reach */}
        <div
          style={{
            flexShrink: 0,
            padding: isCashier ? '12px 20px 16px' : '10px 16px 16px',
            borderTop: '1px solid var(--border, #eee)',
            display: 'flex',
            flexDirection: isCashier ? 'row' : 'column',
            gap: 10,
          }}
        >
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="btn btn-primary"
            style={{
              width: isCashier ? 'auto' : '100%',
              flex: isCashier ? 1 : undefined,
              padding: isCashier ? '14px 16px' : '14px 0',
              fontSize: 15,
              letterSpacing: 1,
              opacity: canConfirm ? 1 : 0.5,
              cursor: canConfirm ? 'pointer' : 'not-allowed',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            {t('customer.confirmAdd')}
            <span style={{ fontWeight: 700 }}>€{(price + totalExtra).toFixed(2)}</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-outline"
            style={{ width: isCashier ? 'auto' : '100%', flex: isCashier ? '0 0 120px' : undefined, padding: isCashier ? '14px 16px' : '12px 0', fontSize: 14 }}
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(sheet, document.body) : null;
}
