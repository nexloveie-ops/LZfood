import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import ARViewer from './ARViewer';
import OptionSelectModal, { type OptionGroup } from './OptionSelectModal';
import type { CartItemOption } from '../../context/CartContext';
import {
  type BomAvailabilitySnapshot,
  computeCartRawDemand,
  isItemServingBlocked,
} from '../../utils/bomAvailability';

interface MenuItemCardProps {
  id: string;
  name: string;
  names: Record<string, string>;
  description?: string;
  price: number;
  calories?: number;
  avgWaitMinutes?: number;
  photoUrl?: string;
  /** First-screen tiles: browser may fetch sooner; others use lazy + lower contention. */
  photoFetchPriority?: 'high' | 'low' | 'auto';
  arFileUrl?: string;
  isSoldOut?: boolean;
  allergenIcons?: string[];
  optionGroups?: OptionGroup[];
  quantity?: number;
  /** 已点份数均来自不可减的订单行时禁用「−」 */
  decreaseDisabled?: boolean;
  onAdd: (id: string, names: Record<string, string>, price: number, options?: CartItemOption[]) => void;
  onDecrease?: (menuItemId: string) => void;
  bomSnapshot?: BomAvailabilitySnapshot | null;
  /** 购物车/当前单已占用原材料 */
  cartBomLines?: Array<{ menuItemId: string; quantity?: number; options?: { groupId?: string; choiceId?: string }[] }>;
}

export default function MenuItemCard({
  id, name, names, description, price, calories, avgWaitMinutes,
  photoUrl, photoFetchPriority = 'auto', arFileUrl, isSoldOut, allergenIcons, optionGroups, quantity, decreaseDisabled, onAdd, onDecrease,
  bomSnapshot, cartBomLines = [],
}: MenuItemCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [isClamped, setIsClamped] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [showPhoto, setShowPhoto] = useState(false);
  const [photoLoaded, setPhotoLoaded] = useState(false);
  const descRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = descRef.current;
    if (el) {
      setIsClamped(el.scrollHeight > el.clientHeight + 1);
    }
  }, [description]);

  useEffect(() => {
    setPhotoLoaded(false);
  }, [photoUrl]);

  const hasOptions = optionGroups && optionGroups.length > 0;
  const itemBom = bomSnapshot?.enabled ? bomSnapshot.items[id] : undefined;
  const reservedDemand = bomSnapshot?.enabled
    ? computeCartRawDemand(cartBomLines, bomSnapshot)
    : {};
  const bomItemBlocked = itemBom && bomSnapshot?.enabled
    ? isItemServingBlocked(itemBom, bomSnapshot.materials, reservedDemand)
    : false;
  const unavailable = isSoldOut || bomItemBlocked;

  const handleAddClick = () => {
    if (unavailable) return;
    if (hasOptions) {
      setShowOptions(true);
    } else {
      onAdd(id, names, price);
    }
  };

  const handleOptionConfirm = (options: CartItemOption[]) => {
    onAdd(id, names, price, options);
    setShowOptions(false);
  };

  return (
    <>
      <div className={`menu-item-card${quantity && quantity > 0 ? ' menu-item-card--selected' : ''}`} style={{
        opacity: unavailable ? 0.55 : 1,
        transition: 'transform 0.15s',
      }}>
        {/* Quantity badge */}
        {quantity != null && quantity > 0 && (
          <span style={{
            position: 'absolute', top: 0, left: 0, zIndex: 2,
            background: 'var(--red-primary)', color: '#fff',
            fontSize: 11, fontWeight: 700, padding: '2px 10px',
            borderBottomRightRadius: 10,
          }}>×{quantity}</span>
        )}
        {unavailable && (
          <span style={{
            position: 'absolute', top: 10, right: 10, zIndex: 2,
            background: 'rgba(44,24,16,0.75)', color: '#F0D68A',
            fontSize: 10, padding: '3px 8px', borderRadius: 3,
            letterSpacing: 2, fontWeight: 500,
          }}>{t('customer.soldOut')}</span>
        )}

        {/* Image — <img> + lazy so off-screen rows don’t download full photos; background-image loads everything eagerly */}
        <div
          className="menu-item-card__thumb"
          onClick={photoUrl ? (e) => { e.stopPropagation(); setShowPhoto(true); } : undefined}
          style={{
            cursor: photoUrl ? 'zoom-in' : undefined,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 36,
            filter: unavailable ? 'grayscale(60%)' : 'none',
          }}
        >
          {!photoUrl ? (
            '🍽️'
          ) : (
            <>
              {!photoLoaded ? <span aria-hidden className="menu-item-thumb-shimmer" /> : null}
              <img
                src={photoUrl}
                alt=""
                width={100}
                height={100}
                loading="lazy"
                decoding="async"
                fetchPriority={photoFetchPriority}
                sizes="100px"
                onLoad={() => setPhotoLoaded(true)}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  objectPosition: 'center',
                  opacity: photoLoaded ? 1 : 0,
                  transition: 'opacity 0.2s ease-out',
                }}
              />
            </>
          )}
        </div>

        {/* Body */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div className="menu-item-card__name" style={{
            marginBottom: 2,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
            {arFileUrl && <ARViewer arFileUrl={arFileUrl} itemName={name} />}
          </div>

          {description && (
            <div style={{ marginBottom: 6 }}>
              <div ref={descRef} style={{
                fontSize: 12, color: 'var(--text-light)', lineHeight: 1.5,
                ...(!expanded ? {
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical' as const,
                  overflow: 'hidden',
                } : {}),
              }}>{description}</div>
              {(isClamped || expanded) && (
                <button
                  onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
                  style={{
                    background: 'none', border: 'none', padding: 0, marginTop: 2,
                    fontSize: 11, color: 'var(--red-primary, #C41E24)', cursor: 'pointer',
                    fontWeight: 500, display: 'flex', alignItems: 'center', gap: 2,
                  }}
                >
                  {expanded ? t('customer.collapse') + ' ▲' : t('customer.expand') + ' ▼'}
                </button>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, fontSize: 11, color: 'var(--text-light)', marginBottom: 8 }}>
            {calories != null && <span>🔥 {calories} {t('customer.calories')}</span>}
            {avgWaitMinutes != null && <span>⏱ {avgWaitMinutes} {t('customer.waitTime')}</span>}
          </div>

          {allergenIcons && allergenIcons.length > 0 && (
            <div style={{ display: 'flex', gap: 3, fontSize: 14, marginBottom: 6, opacity: 0.7 }}>
              {allergenIcons.map((icon, i) => <span key={i}>{icon}</span>)}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto' }}>
            <div className="menu-item-card__price">
              <span style={{ fontSize: 13, fontWeight: 500, marginRight: 1 }}>€</span>{price}
            </div>
            <button
              className="menu-item-card__add"
              onClick={handleAddClick}
              disabled={unavailable}
              style={{
                width: 34, height: 34, borderRadius: '50%', border: 'none',
                background: unavailable ? '#ccc' : 'var(--red-primary)',
                color: '#fff', fontSize: 20, cursor: unavailable ? 'not-allowed' : 'pointer',
                boxShadow: unavailable ? 'none' : '0 2px 8px rgba(196,30,36,0.3)',
                display: quantity && quantity > 0 ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'transform 0.15s',
              }}
              aria-label={t('customer.addToCart')}
            >+</button>
            {quantity != null && quantity > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 0, border: '1px solid var(--border, #ddd)', borderRadius: 20, overflow: 'hidden' }}>
                <button
                  type="button"
                  onClick={() => !decreaseDisabled && onDecrease?.(id)}
                  disabled={decreaseDisabled}
                  style={{
                    width: 30, height: 30, border: 'none', background: 'var(--bg, #f5f5f5)',
                    color: decreaseDisabled ? 'var(--text-light, #bbb)' : 'var(--red-primary)', fontSize: 16, fontWeight: 700,
                    cursor: decreaseDisabled ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >−</button>
                <span style={{ width: 28, textAlign: 'center', fontSize: 14, fontWeight: 700 }}>{quantity}</span>
                <button
                  className="menu-item-card__stepper-btn--plus"
                  onClick={handleAddClick}
                  disabled={unavailable}
                  style={{
                    width: 30, height: 30, border: 'none',
                    background: unavailable ? '#ccc' : 'var(--red-primary)',
                    color: '#fff', fontSize: 16, fontWeight: 700,
                    cursor: unavailable ? 'not-allowed' : 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >+</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {showOptions && hasOptions && (
        <OptionSelectModal
          itemName={name}
          price={price}
          optionGroups={optionGroups!}
          menuItemId={id}
          bomSnapshot={bomSnapshot}
          reservedDemand={reservedDemand}
          onConfirm={handleOptionConfirm}
          onClose={() => setShowOptions(false)}
        />
      )}

      {/* Photo lightbox */}
      {showPhoto && photoUrl && (
        <div
          onClick={() => setShowPhoto(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.85)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'zoom-out',
          }}
        >
          <img
            src={photoUrl}
            alt={name}
            loading="eager"
            decoding="async"
            fetchPriority="high"
            style={{
              maxWidth: '90vw', maxHeight: '85vh',
              borderRadius: 12, objectFit: 'contain',
              boxShadow: '0 4px 30px rgba(0,0,0,0.5)',
            }}
          />
          <div style={{
            position: 'absolute', bottom: 40, left: 0, right: 0,
            textAlign: 'center', color: '#fff', fontSize: 16, fontWeight: 600,
            textShadow: '0 1px 4px rgba(0,0,0,0.6)',
          }}>
            {name} · €{price}
          </div>
        </div>
      )}
    </>
  );
}
