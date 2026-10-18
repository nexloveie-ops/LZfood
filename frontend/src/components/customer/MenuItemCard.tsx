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
import RecommendedStar from '../RecommendedStar';
import SpiceLevelHint from '../SpiceLevelHint';
import { menuItemHasDiscount, menuItemSellPriceEuro } from '../../utils/menuItemSellPrice';
import MenuPriceLabel from '../MenuPriceLabel';

interface MenuItemCardProps {
  id: string;
  name: string;
  names: Record<string, string>;
  description?: string;
  price: number;
  discountPrice?: number | null;
  categoryDiscountZhe?: unknown;
  calories?: number;
  avgWaitMinutes?: number;
  photoUrl?: string;
  /** First-screen tiles: browser may fetch sooner; others use lazy + lower contention. */
  photoFetchPriority?: 'high' | 'low' | 'auto';
  arFileUrl?: string;
  isSoldOut?: boolean;
  isRecommended?: boolean;
  spiceLevel?: number;
  isMarketPrice?: boolean;
  todayPricePerKg?: number | null;
  allergenIcons?: string[];
  optionGroups?: OptionGroup[];
  quantity?: number;
  /** 已点份数均来自不可减的订单行时禁用「−」 */
  decreaseDisabled?: boolean;
  onAdd: (id: string, names: Record<string, string>, price: number, options?: CartItemOption[], meta?: { isMarketPrice?: boolean; listPrice?: number }) => void;
  onDecrease?: (menuItemId: string) => void;
  bomSnapshot?: BomAvailabilitySnapshot | null;
  /** 购物车/当前单已占用原材料 */
  cartBomLines?: Array<{ menuItemId: string; quantity?: number; options?: { groupId?: string; choiceId?: string }[] }>;
}

export default function MenuItemCard({
  id, name, names, description, price, discountPrice, categoryDiscountZhe, calories, avgWaitMinutes,
  photoUrl, photoFetchPriority = 'auto', arFileUrl, isSoldOut, isRecommended, spiceLevel, isMarketPrice, todayPricePerKg, allergenIcons, optionGroups, quantity, decreaseDisabled, onAdd, onDecrease,
  bomSnapshot, cartBomLines = [],
}: MenuItemCardProps) {
  const { t, i18n } = useTranslation();
  const isEn = (i18n.language || '').toLowerCase().startsWith('en');
  const addMeta = isMarketPrice ? { isMarketPrice: true } : undefined;
  const sellPrice = menuItemSellPriceEuro({ price, discountPrice, isMarketPrice }, categoryDiscountZhe);
  const listPrice = menuItemHasDiscount({ price, discountPrice, isMarketPrice }, categoryDiscountZhe) ? price : undefined;
  const [expanded, setExpanded] = useState(false);
  const [isClamped, setIsClamped] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [showPhoto, setShowPhoto] = useState(false);
  const [photoLoaded, setPhotoLoaded] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  const descRef = useRef<HTMLDivElement>(null);
  const photoSrc = String(photoUrl || '').trim();
  const showThumb = Boolean(photoSrc) && !photoFailed;

  useEffect(() => {
    const el = descRef.current;
    if (el) {
      setIsClamped(el.scrollHeight > el.clientHeight + 1);
    }
  }, [description]);

  useEffect(() => {
    setPhotoLoaded(false);
    setPhotoFailed(false);
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
      onAdd(id, names, sellPrice, undefined, addMeta ? { ...addMeta, listPrice } : { listPrice });
    }
  };

  const handleOptionConfirm = (options: CartItemOption[]) => {
    onAdd(id, names, sellPrice, options, addMeta ? { ...addMeta, listPrice } : { listPrice });
    setShowOptions(false);
  };

  const waitMeta = avgWaitMinutes != null ? (
    <span>⏱ {avgWaitMinutes} {t('customer.waitTime')}</span>
  ) : null;
  const calorieMeta = calories != null ? (
    <span>🔥 {calories} {t('customer.calories')}</span>
  ) : null;
  const allergenMeta = allergenIcons && allergenIcons.length > 0 ? (
    <span className="menu-item-card__allergens">
      {allergenIcons.map((icon, i) => <span key={i}>{icon}</span>)}
    </span>
  ) : null;
  const bodyFacts = showThumb
    ? (calorieMeta || allergenMeta ? <>{calorieMeta}{allergenMeta}</> : null)
    : (waitMeta || calorieMeta || allergenMeta ? <>{waitMeta}{calorieMeta}{allergenMeta}</> : null);

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

        {showThumb ? (
          <div className="menu-item-card__media">
            <div
              className="menu-item-card__thumb"
              onClick={(e) => { e.stopPropagation(); setShowPhoto(true); }}
              style={{
                cursor: 'zoom-in',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                filter: unavailable ? 'grayscale(60%)' : 'none',
              }}
            >
              {!photoLoaded ? <span aria-hidden className="menu-item-thumb-shimmer" /> : null}
              <img
                src={photoSrc}
                alt=""
                width={100}
                height={100}
                loading="lazy"
                decoding="async"
                fetchPriority={photoFetchPriority}
                sizes="100px"
                onLoad={() => setPhotoLoaded(true)}
                onError={() => setPhotoFailed(true)}
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
            </div>
            {waitMeta ? (
              <div className="menu-item-card__media-meta">
                {waitMeta}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Body */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div className="menu-item-card__name" style={{
            marginBottom: 2,
            display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
          }}>
            {isRecommended ? <RecommendedStar size={16} title={t('customer.recommended')} /> : null}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>
              {name}
            </span>
            <SpiceLevelHint level={spiceLevel} />
            {arFileUrl && <ARViewer arFileUrl={arFileUrl} itemName={name} />}
          </div>

          {description && (
            <div style={{ marginBottom: 6 }}>
              <div ref={descRef} className="menu-item-card__desc" style={{
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

          {bodyFacts ? (
            <div className="menu-item-card__facts">
              {bodyFacts}
            </div>
          ) : null}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto' }}>
            <div className="menu-item-card__price">
              <MenuPriceLabel
                price={price}
                discountPrice={discountPrice}
                categoryDiscountZhe={categoryDiscountZhe}
                isMarketPrice={isMarketPrice}
                todayPricePerKg={todayPricePerKg}
                isEn={isEn}
              />
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
          price={sellPrice}
          listPrice={listPrice}
          optionGroups={optionGroups!}
          menuItemId={id}
          bomSnapshot={bomSnapshot}
          reservedDemand={reservedDemand}
          onConfirm={handleOptionConfirm}
          onClose={() => setShowOptions(false)}
        />
      )}

      {/* Photo lightbox */}
      {showPhoto && showThumb && (
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
            src={photoSrc}
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
            {name} · {listPrice != null ? <><s>€{listPrice}</s> €{sellPrice}</> : <>€{sellPrice}</>}
          </div>
        </div>
      )}
    </>
  );
}
