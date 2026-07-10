import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams, useNavigate, useParams } from 'react-router-dom';
import { useCart } from '../../context/CartContext';
import MenuItemCard from '../../components/customer/MenuItemCard';
import OfferSelectModal from '../../components/customer/OfferSelectModal';
import type { OfferData } from '../../utils/bundleMatcher';
import { useRestaurantConfig } from '../../hooks/useRestaurantConfig';
import { useBusinessStatus } from '../../hooks/useBusinessStatus';
import { apiFetch } from '../../api/client';
import BannerPlatformCredit from '../../components/customer/BannerPlatformCredit';
import CustomerMenuToolbar from '../../components/customer/CustomerMenuToolbar';
import { useCustomerMenuBootstrap } from '../../context/CustomerMenuBootstrapContext';
import {
  type BomAvailabilitySnapshot,
  emptyBomSnapshot,
} from '../../utils/bomAvailability';
import { isCustomerMenuItemSoldOut } from '../../utils/menuItemAvailability';
import '../../styles/customer-order-saas.css';

interface Category { _id: string; sortOrder: number; translations: { locale: string; name: string }[]; }
interface AllergenData { _id: string; icon: string; }
interface MenuItemData {
  _id: string; categoryId: string; price: number; calories?: number;
  avgWaitMinutes?: number; photoUrl?: string; arFileUrl?: string; isSoldOut?: boolean;
  inventoryTracked?: boolean;
  inventory?: { currentQty?: number; perServing?: number };
  translations: { locale: string; name: string; description?: string }[];
  allergenIds?: string[];
  optionGroups?: {
    _id: string; required: boolean; minSelect?: number; maxSelect?: number;
    translations: { locale: string; name: string }[];
    choices: { _id: string; extraPrice: number; translations: { locale: string; name: string }[] }[];
  }[];
}

export default function MenuView({ storeFrontEmbed = false }: { storeFrontEmbed?: boolean }) {
  const { i18n, t } = useTranslation();
  const { addItem, items: cartItems, decreaseQuantity, getItemKey, editOrderId } = useCart();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { storeSlug } = useParams<{ storeSlug: string }>();
  const { displayName, displayNameOther } = useRestaurantConfig();
  const heroTitle = displayName || storeSlug;
  const heroSub = displayNameOther;
  const { isOpen, reason, loading: statusLoading, deliveryEnabled } = useBusinessStatus();
  const canDelivery = deliveryEnabled !== false;
  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<MenuItemData[]>([]);
  const [bomSnapshot, setBomSnapshot] = useState<BomAvailabilitySnapshot>(emptyBomSnapshot());
  const [allergens, setAllergens] = useState<AllergenData[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>('');
  const lang = i18n.language;

  const table = searchParams.get('table');
  const seat = searchParams.get('seat');
  const qs = searchParams.toString();

  useEffect(() => {
    if (statusLoading) return;
    if (searchParams.get('type') === 'delivery' && !canDelivery) {
      const p = new URLSearchParams(searchParams);
      p.set('type', 'takeout');
      navigate({ search: p.toString() }, { replace: true });
    }
  }, [statusLoading, canDelivery, searchParams, navigate]);

  // On mount: check if there's an active order for this table/seat
  // Skip if we're in edit mode (user came back from modifying an order)
  useEffect(() => {
    if (!table || !seat || editOrderId) return;
    apiFetch(`/api/orders/dine-in/active?table=${table}&seat=${seat}`)
      .then(r => r.ok ? r.json() : [])
      .then((orders: { _id: string }[]) => {
        if (orders.length > 0 && storeSlug) {
          const search = qs ? `?${qs}` : '';
          navigate(`/${storeSlug}/customer/order/${String(orders[0]._id)}${search}`, { replace: true });
        }
      })
      .catch(() => {});
  }, [table, seat, qs, editOrderId, navigate, storeSlug]);

  // Active offers for banner
  const [activeOffers, setActiveOffers] = useState<OfferData[]>([]);
  const [selectedOffer, setSelectedOffer] = useState<OfferData | null>(null);
  const menuBootstrap = useCustomerMenuBootstrap();

  // Banner carousel index
  // Banner carousel index + countdown
  const [bannerIndex, setBannerIndex] = useState(0);
  useEffect(() => {
    if (activeOffers.length <= 1) return;
    const timer = setInterval(() => {
      setBannerIndex(prev => (prev + 1) % activeOffers.length);
    }, 5000);
    return () => clearInterval(timer);
  }, [activeOffers.length]);

  // Refs for scroll-based category tracking
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const tabsRef = useRef<HTMLDivElement>(null);
  const isUserClick = useRef(false);

  useEffect(() => {
    if (!menuBootstrap.ready) return;
    setCategories(menuBootstrap.categories);
    setItems(menuBootstrap.items);
    setBomSnapshot(menuBootstrap.bomSnapshot);
    setAllergens(menuBootstrap.allergens);
    setActiveOffers(menuBootstrap.offers);
    if (menuBootstrap.categories.length > 0) {
      setActiveCategory((prev) => prev || menuBootstrap.categories[0]._id);
    }
  }, [menuBootstrap]);

  useEffect(() => {
    if (storeFrontEmbed && activeOffers.length > 0) setHeroHidden(false);
  }, [storeFrontEmbed, activeOffers.length]);

  const getName = (translations: { locale: string; name: string }[]) => {
    const found = translations.find(t2 => t2.locale === lang) || translations[0];
    return found?.name || '';
  };
  const getDesc = (translations: { locale: string; description?: string }[]) => {
    const found = translations.find(t2 => t2.locale === lang) || translations[0];
    return found?.description || '';
  };

  // IntersectionObserver: track which section is in view
  useEffect(() => {
    if (categories.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (isUserClick.current) return; // skip during programmatic scroll
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const catId = entry.target.getAttribute('data-cat-id');
            if (catId) {
              setActiveCategory(catId);
              // Auto-scroll the tab into view
              const tabEl = document.getElementById(`tab-${catId}`);
              tabEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            }
            break;
          }
        }
      },
      {
        root: scrollContainerRef.current,
        rootMargin: '-20% 0px -60% 0px',
        threshold: 0,
      }
    );

    sectionRefs.current.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [categories, items]);

  // Click tab → scroll to section
  const handleTabClick = useCallback((catId: string) => {
    setActiveCategory(catId);
    const sectionEl = sectionRefs.current.get(catId);
    if (sectionEl && scrollContainerRef.current) {
      isUserClick.current = true;
      sectionEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => { isUserClick.current = false; }, 800);
    }
  }, []);

  const [heroHidden, setHeroHidden] = useState(() => !!storeFrontEmbed);
  const lastScrollY = useRef(0);
  const heroHiddenRef = useRef(false);
  useEffect(() => {
    heroHiddenRef.current = heroHidden;
  }, [heroHidden]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const y = el.scrollTop;
    const prevY = lastScrollY.current;
    const dy = y - prevY;
    const nearBottom = y + el.clientHeight >= el.scrollHeight - 2;

    // At the very bottom, keep hero hidden to avoid bounce jitter toggling.
    if (nearBottom) {
      if (!heroHiddenRef.current) setHeroHidden(true);
      lastScrollY.current = y;
      return;
    }

    // Hysteresis: near top always show; scroll down hides; scroll up shows (slightly looser dy for touch/trackpad).
    if (y <= 12) {
      if (heroHiddenRef.current) setHeroHidden(false);
    } else if (y > 28 && dy > 2) {
      if (!heroHiddenRef.current) setHeroHidden(true);
    } else if (dy < -4) {
      if (heroHiddenRef.current) setHeroHidden(false);
    }

    lastScrollY.current = y;
  }, []);

  const cartBomLines = useMemo(
    () => cartItems.map((i) => ({
      menuItemId: i.menuItemId,
      quantity: i.quantity,
      options: i.options?.map((o) => ({ groupId: o.groupId, choiceId: o.choiceId })),
    })),
    [cartItems],
  );

  // Get cart quantity for a menu item
  const getCartQty = (menuItemId: string) => cartItems.filter(ci => ci.menuItemId === menuItemId).reduce((s, ci) => s + ci.quantity, 0);

  /** 该菜品在购物车中仍可被减掉的份数（已锁定订单行只计超出 lockedBaselineQty 的部分） */
  const reducibleQtyForMenuItem = (menuItemId: string) =>
    cartItems
      .filter(ci => ci.menuItemId === menuItemId)
      .reduce((sum, ci) => {
        const floor = typeof ci.lockedBaselineQty === 'number' ? ci.lockedBaselineQty : 0;
        return sum + Math.max(0, ci.quantity - floor);
      }, 0);

  const handleDecrease = (menuItemId: string) => {
    for (let i = cartItems.length - 1; i >= 0; i--) {
      const ci = cartItems[i];
      if (ci.menuItemId !== menuItemId) continue;
      const floor = typeof ci.lockedBaselineQty === 'number' ? ci.lockedBaselineQty : 0;
      if (ci.quantity > floor) {
        decreaseQuantity(getItemKey(ci));
        return;
      }
    }
  };

  // Group items by category
  const itemsByCategory = new Map<string, MenuItemData[]>();
  for (const item of items) {
    if (!itemsByCategory.has(item.categoryId)) itemsByCategory.set(item.categoryId, []);
    itemsByCategory.get(item.categoryId)!.push(item);
  }

  if (statusLoading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>{t('common.loading')}</div>;
  }

  if (!isOpen) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '70vh', textAlign: 'center', padding: 20 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🕒</div>
        <h2 style={{ marginBottom: 8 }}>{t('customer.storeClosedTitle')}</h2>
        <p style={{ color: 'var(--text-light)', maxWidth: 320 }}>
          {reason === 'closed_date' ? t('customer.storeClosedDate') : t('customer.storeOutsideHours')}
        </p>
      </div>
    );
  }

  const compactHero = storeFrontEmbed && activeOffers.length === 0;
  const heroVariant = storeFrontEmbed ? 'onLight' : 'onLight';

  return (
    <div className="menu-page">
      <div
        className={`menu-hero ${storeFrontEmbed ? 'menu-hero--embed' : 'menu-hero--standalone'}${compactHero ? ' menu-hero--compact' : ''}${heroHidden ? ' menu-hero--hidden' : ''}`}
        aria-hidden={heroHidden}
      >
        <div className="menu-hero__inner">
            <CustomerMenuToolbar />
            <div className="menu-hero-head">
              <div className="menu-store-block">
                <h1 className="menu-store-title">{heroTitle}</h1>
                {heroSub ? <div className="menu-store-subtitle">{heroSub}</div> : null}
              </div>
              <BannerPlatformCredit variant={heroVariant} />
            </div>
            {activeOffers.length > 0 ? (
              <div
                className="menu-offer-wrap"
                onTouchStart={(e) => {
                  const touch = e.touches[0];
                  (e.currentTarget as HTMLDivElement).dataset.touchStartX = String(touch.clientX);
                }}
                onTouchEnd={(e) => {
                  const startX = parseFloat((e.currentTarget as HTMLDivElement).dataset.touchStartX || '0');
                  const endX = e.changedTouches[0].clientX;
                  const diff = startX - endX;
                  if (Math.abs(diff) > 40 && activeOffers.length > 1) {
                    if (diff > 0) {
                      setBannerIndex(prev => (prev + 1) % activeOffers.length);
                    } else {
                      setBannerIndex(prev => (prev - 1 + activeOffers.length) % activeOffers.length);
                    }
                  }
                }}
              >
                {activeOffers.map((offer, idx) => (
                  <div
                    key={offer._id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedOffer(offer)}
                    className="menu-offer-card"
                    style={{
                      opacity: idx === bannerIndex ? 1 : 0,
                      position: idx === 0 ? 'relative' : 'absolute',
                      top: idx === 0 ? undefined : 0,
                      left: idx === 0 ? undefined : 0,
                      right: idx === 0 ? undefined : 0,
                      transition: 'opacity 0.4s ease',
                      pointerEvents: idx === bannerIndex ? 'auto' : 'none',
                    }}
                  >
                    <div className="menu-offer-card__title">
                      🎁 {lang === 'zh-CN' ? offer.name : (offer.nameEn || offer.name)}
                    </div>
                    {(offer.description || offer.descriptionEn) ? (
                      <div className="menu-offer-card__desc">
                        {lang === 'zh-CN' ? offer.description : (offer.descriptionEn || offer.description)}
                      </div>
                    ) : null}
                    <div className="menu-offer-card__price">€{offer.bundlePrice.toFixed(2)}</div>
                  </div>
                ))}
                {activeOffers.length > 1 ? (
                  <div className="menu-offer-dots">
                    {activeOffers.map((_, idx) => (
                      <div
                        key={idx}
                        role="presentation"
                        onClick={(e) => { e.stopPropagation(); setBannerIndex(idx); }}
                        className={`menu-offer-dot${idx === bannerIndex ? ' menu-offer-dot--active' : ''}`}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
        </div>
      </div>

      <div className="menu-tabs-row">
        <div ref={tabsRef} className="menu-tabs">
        {categories.map(cat => (
          <button
            key={cat._id}
            id={`tab-${cat._id}`}
            type="button"
            onClick={() => handleTabClick(cat._id)}
            className={`menu-tab${activeCategory === cat._id ? ' menu-tab--active' : ''}`}
          >
            {getName(cat.translations)}
          </button>
        ))}
        </div>
        {heroHidden ? (
          <div className="menu-tabs__actions">
            <CustomerMenuToolbar variant="actions" />
          </div>
        ) : null}
      </div>

      <div ref={scrollContainerRef} onScroll={handleScroll} className="menu-scroll">
        {categories.map((cat, catIndex) => {
          const catItems = itemsByCategory.get(cat._id) || [];
          return (
            <div
              key={cat._id}
              data-cat-id={cat._id}
              ref={(el) => { if (el) sectionRefs.current.set(cat._id, el); }}
            >
              <h2 className="menu-section-title">{getName(cat.translations)}</h2>
              <div className="menu-items-list">
                {catItems.length > 0 ? catItems.map((item, itemIndex) => (
                  <MenuItemCard
                    key={item._id}
                    id={item._id}
                    name={getName(item.translations)}
                    names={Object.fromEntries(item.translations.map(t2 => [t2.locale, t2.name]))}
                    description={getDesc(item.translations)}
                    price={item.price}
                    calories={item.calories}
                    avgWaitMinutes={item.avgWaitMinutes}
                    photoUrl={item.photoUrl}
                    photoFetchPriority={catIndex === 0 && itemIndex < 8 ? 'high' : 'auto'}
                    arFileUrl={item.arFileUrl}
                    isSoldOut={isCustomerMenuItemSoldOut(item)}
                    allergenIcons={(item.allergenIds || []).map(aid => allergens.find(a => a._id === aid)?.icon).filter((x): x is string => !!x)}
                    optionGroups={item.optionGroups}
                    quantity={getCartQty(item._id)}
                    decreaseDisabled={getCartQty(item._id) > 0 && reducibleQtyForMenuItem(item._id) === 0}
                    onAdd={addItem}
                    onDecrease={handleDecrease}
                    bomSnapshot={bomSnapshot}
                    cartBomLines={cartBomLines}
                  />
                )) : menuBootstrap.ready ? (
                  <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-light, #999)', fontSize: 13 }}>
                    暂无菜品
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}

        <div style={{ height: 20 }} />
      </div>

      {/* Offer Select Modal */}
      {selectedOffer && (
        <OfferSelectModal
          offer={selectedOffer}
          menuItems={items}
          categories={categories}
          lang={lang}
          onConfirm={(selectedItems) => {
            for (const si of selectedItems) {
              addItem(si.menuItemId, si.names, si.price, si.options);
            }
            setSelectedOffer(null);
          }}
          onClose={() => setSelectedOffer(null)}
        />
      )}
    </div>
  );
}
