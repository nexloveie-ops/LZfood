import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { CartItemOption } from '../../context/CartContext';
import { getOptionalMinSelect, getOptionalMaxSelect, optionalMaxReached, optionalSelectionValid } from '../../utils/optionGroupLimits';
import {
  type BomAvailabilitySnapshot,
  isModalChoiceSelectable,
} from '../../utils/bomAvailability';
import '../../styles/customer-order-saas.css';

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
  /** BoM 库存：选选项时禁用缺料 choice */
  menuItemId?: string;
  bomSnapshot?: BomAvailabilitySnapshot | null;
  /** 购物车/当前单已占用原材料（不含本 modal） */
  reservedDemand?: Record<string, number>;
}

export default function OptionSelectModal({
  itemName, price, optionGroups, onConfirm, onClose, layout = 'customer',
  menuItemId, bomSnapshot, reservedDemand = {},
}: Props) {
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

  const itemBom = menuItemId && bomSnapshot?.enabled ? bomSnapshot.items[menuItemId] : undefined;
  const materials = bomSnapshot?.enabled ? bomSnapshot.materials : {};

  const isChoiceDisabled = (groupId: string, choiceId: string, alreadySelected: boolean): boolean => {
    if (alreadySelected) return false;
    if (!itemBom || !bomSnapshot?.enabled) return false;
    return !isModalChoiceSelectable(
      optionGroups,
      singleSelections,
      multiSelections,
      groupId,
      choiceId,
      itemBom,
      materials,
      reservedDemand,
    );
  };

  const toggleSingle = (groupId: string, choiceId: string) => {
    const selected = singleSelections[groupId] === choiceId;
    if (!selected && isChoiceDisabled(groupId, choiceId, false)) return;
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
      if (isChoiceDisabled(groupId, choiceId, false)) return prev;
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
        className={`option-sheet${isCashier ? ' option-sheet--cashier' : ''}`}
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
        }}
      >
        <div className="option-sheet__header">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div id="option-modal-title" className="option-sheet__title">{itemName}</div>
            <div className="option-sheet__price">€{price}</div>
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
          {optionGroups.map(group => (
            <div key={group._id} className="option-group">
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
                    ? singleSelections[group._id] === choice._id
                    : (multiSelections[group._id] || []).includes(choice._id);
                  const disabled = isChoiceDisabled(group._id, choice._id, selected);
                  return (
                    <div
                      key={choice._id}
                      role="button"
                      tabIndex={disabled ? -1 : 0}
                      onClick={() => {
                        if (disabled) return;
                        group.required ? toggleSingle(group._id, choice._id) : toggleMulti(group._id, choice._id);
                      }}
                      className={`option-choice${selected ? ' option-choice--selected' : ''}${disabled ? ' option-choice--disabled' : ''}`}
                    >
                      <span className="option-choice__check" aria-hidden>✓</span>
                      <div className="option-choice__label">
                        {getName(choice.translations)}
                        {disabled && (
                          <div className="option-choice__unavailable">
                            {t('customer.bomChoiceUnavailable', { defaultValue: '缺货' })}
                          </div>
                        )}
                        {((choice.extraPrice || 0) > 0
                          || (choice.originalPrice != null && choice.originalPrice > (choice.extraPrice || 0))) && (
                          <span className="option-choice__extra">
                            {choice.originalPrice != null && choice.originalPrice > (choice.extraPrice || 0) && (
                              <span className="option-choice__extra-strike">+€{choice.originalPrice}</span>
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

        <div className="option-sheet__footer">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="option-sheet__confirm"
          >
            {t('customer.confirmAdd')}
            <span style={{ fontWeight: 700 }}>€{(price + totalExtra).toFixed(2)}</span>
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
