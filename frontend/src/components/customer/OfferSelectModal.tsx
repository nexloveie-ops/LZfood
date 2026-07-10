import { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { CartItemOption } from '../../context/CartContext';
import type { OfferData } from '../../utils/bundleMatcher';
import { isCustomerMenuItemSoldOut } from '../../utils/menuItemAvailability';
import { getOptionalMinSelect, getOptionalMaxSelect, optionalMaxReached, optionalSelectionValid } from '../../utils/optionGroupLimits';
import '../../styles/customer-order-saas.css';

interface OptionChoice {
  _id: string;
  extraPrice: number;
  originalPrice?: number;
  translations: { locale: string; name: string }[];
}

interface OptionGroup {
  _id: string;
  required: boolean;
  minSelect?: number;
  maxSelect?: number;
  translations: { locale: string; name: string }[];
  choices: OptionChoice[];
}

interface MenuItem {
  _id: string;
  categoryId: string;
  price: number;
  translations: { locale: string; name: string }[];
  optionGroups?: OptionGroup[];
  isSoldOut?: boolean;
  inventoryTracked?: boolean;
  inventory?: { currentQty?: number; perServing?: number };
}

interface Category {
  _id: string;
  translations: { locale: string; name: string }[];
}

interface SelectedItemWithOptions {
  menuItemId: string;
  names: Record<string, string>;
  price: number;
  options?: CartItemOption[];
}

interface Props {
  offer: OfferData;
  menuItems: MenuItem[];
  categories: Category[];
  lang: string;
  onConfirm: (selectedItems: SelectedItemWithOptions[]) => void;
  onClose: () => void;
}

export default function OfferSelectModal({ offer, menuItems, categories, lang, onConfirm, onClose }: Props) {
  const { t } = useTranslation();

  const getName = (translations: { locale: string; name: string }[]) => {
    const found = translations.find(t2 => t2.locale === lang) || translations[0];
    return found?.name || '';
  };

  const getNameMap = (translations: { locale: string; name: string }[]): Record<string, string> =>
    Object.fromEntries(translations.map(t2 => [t2.locale, t2.name]));

  const excluded = new Set(offer.excludedItemIds || []);

  // selections[slotIndex] = menuItemId
  const [selections, setSelections] = useState<Record<number, string>>(() => {
    const init: Record<number, string> = {};
    offer.slots.forEach((slot, idx) => {
      if (slot.type === 'item' && slot.itemId) {
        init[idx] = slot.itemId;
      }
    });
    return init;
  });

  // optionSelections[slotIndex][groupId] = choiceId (single) or choiceId[] (multi)
  const [singleOpts, setSingleOpts] = useState<Record<string, Record<string, string>>>({});
  const [multiOpts, setMultiOpts] = useState<Record<string, Record<string, string[]>>>({});

  // When item selection changes, reset its options
  const selectItem = (idx: number, itemId: string) => {
    setSelections(prev => {
      const next = { ...prev };
      if (next[idx] === itemId) delete next[idx];
      else next[idx] = itemId;
      return next;
    });
    const key = String(idx);
    setSingleOpts(prev => { const n = { ...prev }; delete n[key]; return n; });
    setMultiOpts(prev => { const n = { ...prev }; delete n[key]; return n; });
  };

  const toggleSingle = (slotKey: string, groupId: string, choiceId: string) => {
    setSingleOpts(prev => {
      const slot = { ...(prev[slotKey] || {}) };
      if (slot[groupId] === choiceId) delete slot[groupId];
      else slot[groupId] = choiceId;
      return { ...prev, [slotKey]: slot };
    });
  };

  const toggleMulti = (slotKey: string, group: OptionGroup, choiceId: string) => {
    setMultiOpts((prev) => {
      const slot = { ...(prev[slotKey] || {}) };
      const current = slot[group._id] || [];
      if (current.includes(choiceId)) {
        slot[group._id] = current.filter((id) => id !== choiceId);
      } else {
        if (optionalMaxReached(group, current.length)) return prev;
        slot[group._id] = [...current, choiceId];
      }
      return { ...prev, [slotKey]: slot };
    });
  };

  // Check if all required options are selected for each slot
  const allOptionsValid = useMemo(() => {
    return offer.slots.every((_, idx) => {
      const itemId = selections[idx];
      if (!itemId) return false;
      const mi = menuItems.find(m => m._id === itemId);
      if (!mi?.optionGroups) return true;
      const key = String(idx);
      return mi.optionGroups.every((g) => {
        if (g.required) return !!(singleOpts[key]?.[g._id]);
        const n = (multiOpts[key]?.[g._id] || []).length;
        return optionalSelectionValid(g, n);
      });
    });
  }, [selections, singleOpts, multiOpts, offer.slots, menuItems]);

  const allSelected = offer.slots.every((_, idx) => selections[idx]);

  // Calculate total option extras for all slots
  const totalOptionExtra = useMemo(() => {
    let sum = 0;
    offer.slots.forEach((_, idx) => {
      const itemId = selections[idx];
      if (!itemId) return;
      const mi = menuItems.find(m => m._id === itemId);
      if (!mi?.optionGroups) return;
      const key = String(idx);
      for (const g of mi.optionGroups) {
        if (g.required) {
          const cId = singleOpts[key]?.[g._id];
          if (cId) { const c = g.choices.find(x => x._id === cId); sum += c?.extraPrice || 0; }
        } else {
          for (const cId of (multiOpts[key]?.[g._id] || [])) {
            const c = g.choices.find(x => x._id === cId); sum += c?.extraPrice || 0;
          }
        }
      }
    });
    return sum;
  }, [selections, singleOpts, multiOpts, offer.slots, menuItems]);

  const handleConfirm = () => {
    const items: SelectedItemWithOptions[] = offer.slots.map((_, idx) => {
      const itemId = selections[idx];
      const mi = menuItems.find(m => m._id === itemId);
      const key = String(idx);
      const options: CartItemOption[] = [];

      if (mi?.optionGroups) {
        for (const g of mi.optionGroups) {
          if (g.required) {
            const cId = singleOpts[key]?.[g._id];
            if (cId) {
              const c = g.choices.find(x => x._id === cId);
              if (c) options.push({
                groupId: g._id, choiceId: c._id,
                groupName: getNameMap(g.translations), choiceName: getNameMap(c.translations),
                extraPrice: c.extraPrice || 0,
              });
            }
          } else {
            for (const cId of (multiOpts[key]?.[g._id] || [])) {
              const c = g.choices.find(x => x._id === cId);
              if (c) options.push({
                groupId: g._id, choiceId: c._id,
                groupName: getNameMap(g.translations), choiceName: getNameMap(c.translations),
                extraPrice: c.extraPrice || 0,
              });
            }
          }
        }
      }

      return {
        menuItemId: itemId,
        names: mi ? getNameMap(mi.translations) : {},
        price: mi?.price || 0,
        options: options.length > 0 ? options : undefined,
      };
    });
    onConfirm(items);
  };

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

  const sheet = (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10050,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        alignItems: 'center',
        pointerEvents: 'auto',
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
        aria-labelledby="offer-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="option-sheet"
        style={{
          position: 'relative',
          zIndex: 1,
          borderRadius: '16px 16px 0 0',
          width: '100%',
          maxWidth: 430,
          maxHeight: 'min(88dvh, 88vh)',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 -8px 32px rgba(0,0,0,0.18)',
        }}
      >
        <div className="option-sheet__header">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div id="offer-modal-title" className="option-sheet__title">
              🎁 {lang === 'zh-CN' ? offer.name : (offer.nameEn || offer.name)}
            </div>
            {(offer.description || offer.descriptionEn) && (
              <div style={{ fontSize: 12, color: 'var(--os-muted, #64748b)', marginTop: 4, lineHeight: 1.35 }}>
                {lang === 'zh-CN' ? offer.description : (offer.descriptionEn || offer.description)}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('customer.closeOptionSheet')}
            className="option-sheet__close"
          >
            ✕
          </button>
        </div>

        <div className="option-sheet__body">
          {offer.slots.map((slot, idx) => {
            const isItem = slot.type === 'item';
            const catName = !isItem && slot.categoryId
              ? getName(categories.find(c => c._id === slot.categoryId)?.translations || [])
              : '';
            const key = String(idx);
            const selectedItemId = selections[idx];
            const selectedMi = selectedItemId ? menuItems.find(m => m._id === selectedItemId) : null;

            return (
              <div key={idx} className="option-group" style={{ marginBottom: 12 }}>
                <div className="option-group__head" style={{ marginBottom: 8 }}>
                  <span className="option-group__title" style={{ fontSize: 13 }}>
                    {idx + 1}. {isItem ? t('common.item', 'Item') : (catName || t('common.category', 'Category'))}
                  </span>
                </div>

                {isItem ? (
                  <div className="offer-slot-fixed">
                    <span style={{ fontWeight: 600, fontSize: 14 }}>
                      ✓ {selectedMi ? getName(selectedMi.translations) : 'Unknown'}
                    </span>
                    <span style={{ fontSize: 13, color: 'var(--os-muted, #64748b)' }}>€{selectedMi?.price || 0}</span>
                  </div>
                ) : (
                  <div className="option-group__choices">
                    {menuItems.filter(m => m.categoryId === slot.categoryId && !excluded.has(m._id) && !isCustomerMenuItemSoldOut(m)).map(mi => {
                      const selected = selections[idx] === mi._id;
                      return (
                        <div
                          key={mi._id}
                          role="button"
                          tabIndex={0}
                          onClick={() => selectItem(idx, mi._id)}
                          className={`option-choice${selected ? ' option-choice--selected' : ''}`}
                        >
                          <span className="option-choice__check" aria-hidden>✓</span>
                          <div className="option-choice__label">
                            {getName(mi.translations)}
                            <span className="option-choice__extra">€{mi.price}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {selectedMi?.optionGroups && selectedMi.optionGroups.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    {selectedMi.optionGroups.map(group => (
                      <div key={group._id} className="option-group" style={{ marginBottom: 10 }}>
                        <div className="option-group__head">
                          <span className="option-group__title">{getName(group.translations)}</span>
                          {group.required ? (
                            <span className="option-group__badge option-group__badge--required">{t('admin.required')}</span>
                          ) : (
                            <span className="option-group__badge option-group__badge--optional">{t('customer.multiSelect', { defaultValue: '多选' })}</span>
                          )}
                        </div>
                        {!group.required && (getOptionalMinSelect(group) > 0 || getOptionalMaxSelect(group) > 0) && (
                          <div className="option-group__hint">
                            {getOptionalMaxSelect(group) === 0
                              ? t('customer.optionalAtLeast', { count: getOptionalMinSelect(group) })
                              : getOptionalMinSelect(group) === 0
                                ? t('customer.optionalAtMost', { count: getOptionalMaxSelect(group) })
                                : t('customer.optionalBetween', { min: getOptionalMinSelect(group), max: getOptionalMaxSelect(group) })}
                          </div>
                        )}
                        <div className="option-group__choices">
                          {group.choices.map(choice => {
                            const selected = group.required
                              ? singleOpts[key]?.[group._id] === choice._id
                              : (multiOpts[key]?.[group._id] || []).includes(choice._id);
                            return (
                              <div
                                key={choice._id}
                                role="button"
                                tabIndex={0}
                                onClick={() => group.required
                                  ? toggleSingle(key, group._id, choice._id)
                                  : toggleMulti(key, group, choice._id)
                                }
                                className={`option-choice${selected ? ' option-choice--selected' : ''}`}
                              >
                                <span className="option-choice__check" aria-hidden>✓</span>
                                <div className="option-choice__label">
                                  {getName(choice.translations)}
                                  {(choice.extraPrice || 0) > 0 && (
                                    <span className="option-choice__extra">{`+€${choice.extraPrice}`}</span>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="option-sheet__footer">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!allSelected || !allOptionsValid}
            className="option-sheet__confirm"
          >
            {t('customer.confirmAdd', 'Add to Cart')}
            <span style={{ fontWeight: 700 }}>€{(offer.bundlePrice + totalOptionExtra).toFixed(2)}</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="option-sheet__cancel"
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(sheet, document.body) : null;
}
