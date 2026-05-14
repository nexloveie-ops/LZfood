import { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { CartItemOption } from '../../context/CartContext';
import type { OfferData } from '../../utils/bundleMatcher';
import { getOptionalMinSelect, getOptionalMaxSelect, optionalMaxReached, optionalSelectionValid } from '../../utils/optionGroupLimits';

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
        style={{
          position: 'relative',
          zIndex: 1,
          background: '#fff',
          borderRadius: '16px 16px 0 0',
          width: '100%',
          maxWidth: 430,
          maxHeight: 'min(88dvh, 88vh)',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 -8px 32px rgba(0,0,0,0.18)',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        <div
          style={{
            flexShrink: 0,
            padding: '12px 16px 10px',
            borderBottom: '1px solid #eee',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 12,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div id="offer-modal-title" style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-dark)' }}>
              🎁 {lang === 'zh-CN' ? offer.name : (offer.nameEn || offer.name)}
            </div>
            {(offer.description || offer.descriptionEn) && (
              <div style={{ fontSize: 12, color: 'var(--text-light)', marginTop: 4, lineHeight: 1.35 }}>
                {lang === 'zh-CN' ? offer.description : (offer.descriptionEn || offer.description)}
              </div>
            )}
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

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            WebkitOverflowScrolling: 'touch',
            overscrollBehavior: 'contain',
            touchAction: 'pan-y',
            padding: '12px 16px',
          }}
        >
          {offer.slots.map((slot, idx) => {
            const isItem = slot.type === 'item';
            const catName = !isItem && slot.categoryId
              ? getName(categories.find(c => c._id === slot.categoryId)?.translations || [])
              : '';
            const key = String(idx);
            const selectedItemId = selections[idx];
            const selectedMi = selectedItemId ? menuItems.find(m => m._id === selectedItemId) : null;

            return (
              <div key={idx} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 6 }}>
                  {idx + 1}. {isItem ? t('common.item', 'Item') : (catName || t('common.category', 'Category'))}
                </div>

                {isItem ? (
                  <div style={{
                    padding: '12px 14px', borderRadius: 10,
                    background: '#E8F5E9', border: '2px solid #4CAF50',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>
                      ✓ {selectedMi ? getName(selectedMi.translations) : 'Unknown'}
                    </span>
                    <span style={{ fontSize: 13, color: 'var(--text-light)' }}>€{selectedMi?.price || 0}</span>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
                    {menuItems.filter(m => m.categoryId === slot.categoryId && !excluded.has(m._id) && !m.isSoldOut).map(mi => {
                      const selected = selections[idx] === mi._id;
                      return (
                        <div key={mi._id} onClick={() => selectItem(idx, mi._id)} style={{
                          padding: '10px 8px', borderRadius: 10, cursor: 'pointer',
                          textAlign: 'center', transition: 'all 0.12s', minWidth: 0,
                          border: selected ? '2px solid var(--red-primary)' : '1px solid #ddd',
                          background: selected ? 'var(--red-light, #FFF5F5)' : '#fafafa',
                        }}>
                          <div style={{ fontSize: 13, fontWeight: selected ? 700 : 500, lineHeight: 1.3, color: selected ? 'var(--red-primary)' : 'var(--text-dark)', wordBreak: 'break-word' }}>
                            {getName(mi.translations)}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 2 }}>€{mi.price}</div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {selectedMi?.optionGroups && selectedMi.optionGroups.length > 0 && (
                  <div style={{ marginTop: 10, paddingLeft: 4 }}>
                    {selectedMi.optionGroups.map(group => (
                      <div key={group._id} style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          {getName(group.translations)}
                          {group.required
                            ? <span style={{ fontSize: 10, color: '#fff', background: 'var(--red-primary)', padding: '1px 5px', borderRadius: 4 }}>{t('admin.required')}</span>
                            : <span style={{ fontSize: 10, color: 'var(--text-light)', padding: '1px 5px', borderRadius: 4, border: '1px solid var(--border)' }}>多选</span>
                          }
                        </div>
                        {!group.required && (getOptionalMinSelect(group) > 0 || getOptionalMaxSelect(group) > 0) && (
                          <div style={{ fontSize: 10, color: 'var(--text-light)', marginBottom: 6 }}>
                            {getOptionalMaxSelect(group) === 0
                              ? t('customer.optionalAtLeast', { count: getOptionalMinSelect(group) })
                              : getOptionalMinSelect(group) === 0
                                ? t('customer.optionalAtMost', { count: getOptionalMaxSelect(group) })
                                : t('customer.optionalBetween', { min: getOptionalMinSelect(group), max: getOptionalMaxSelect(group) })}
                          </div>
                        )}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }}>
                          {group.choices.map(choice => {
                            const selected = group.required
                              ? singleOpts[key]?.[group._id] === choice._id
                              : (multiOpts[key]?.[group._id] || []).includes(choice._id);
                            return (
                              <div key={choice._id}
                                onClick={() => group.required
                                  ? toggleSingle(key, group._id, choice._id)
                                  : toggleMulti(key, group, choice._id)
                                }
                                style={{
                                  padding: '8px 6px', borderRadius: 8, cursor: 'pointer', minWidth: 0,
                                  textAlign: 'center', transition: 'all 0.12s',
                                  border: selected ? '2px solid var(--red-primary)' : '1px solid #ddd',
                                  background: selected ? 'var(--red-light, #FFF5F5)' : '#fafafa',
                                }}>
                                <div
                                  style={{
                                    fontSize: 12,
                                    fontWeight: selected ? 700 : 500,
                                    lineHeight: 1.35,
                                    color: selected ? 'var(--red-primary)' : 'var(--text-dark)',
                                    wordBreak: 'break-word',
                                    textAlign: 'center',
                                  }}
                                >
                                  {getName(choice.translations)}
                                  {(choice.extraPrice || 0) > 0 && (
                                    <span style={{ whiteSpace: 'nowrap', fontWeight: 600, color: 'var(--red-primary)', fontSize: 11 }}>
                                      {` +€${choice.extraPrice}`}
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
                )}
              </div>
            );
          })}
        </div>

        <div
          style={{
            flexShrink: 0,
            padding: '10px 16px 16px',
            borderTop: '1px solid #eee',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!allSelected || !allOptionsValid}
            className="btn btn-primary"
            style={{
              width: '100%',
              padding: '14px 0',
              fontSize: 15,
              letterSpacing: 1,
              opacity: (allSelected && allOptionsValid) ? 1 : 0.5,
              cursor: (allSelected && allOptionsValid) ? 'pointer' : 'not-allowed',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            {t('customer.confirmAdd', 'Add to Cart')}
            <span style={{ fontWeight: 700 }}>€{(offer.bundlePrice + totalOptionExtra).toFixed(2)}</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-outline"
            style={{ width: '100%', padding: '12px 0', fontSize: 14 }}
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(sheet, document.body) : null;
}
