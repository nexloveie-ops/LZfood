import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useCart } from '../../context/CartContext';
import { matchBundles, calcBundleTotal, type OfferData, type MatchedBundle } from '../../utils/bundleMatcher';
import {
  DELIVERY_FEE_RULES_CONFIG_KEY,
  deliveryFeeForDistance,
  parseDeliveryFeeRulesJson,
  type DeliveryFeeTier,
} from '../../utils/deliveryFeeRules';
import { apiFetch } from '../../api/client';
import { useRestaurantConfig } from '../../hooks/useRestaurantConfig';
import { useBusinessStatus } from '../../hooks/useBusinessStatus';
import BannerPlatformCredit from '../../components/customer/BannerPlatformCredit';

/** 自取大致时段（仅展示与排序，不做容量） */
const TAKEOUT_PICKUP_SLOTS = [
  { labelZh: '11:30–12:00', labelEn: '11:30–12:00', h: 11, m: 30 },
  { labelZh: '12:00–12:30', labelEn: '12:00–12:30', h: 12, m: 0 },
  { labelZh: '12:30–13:00', labelEn: '12:30–1:00 PM', h: 12, m: 30 },
  { labelZh: '17:30–18:00', labelEn: '5:30–6:00 PM', h: 17, m: 30 },
  { labelZh: '18:00–18:30', labelEn: '6:00–6:30 PM', h: 18, m: 0 },
  { labelZh: '18:30–19:00', labelEn: '6:30–7:00 PM', h: 18, m: 30 },
] as const;

function pickupSlotStartIso(h: number, m: number): string {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

export default function CartPage() {
  const { items, increaseQuantity, decreaseQuantity, removeItem, clearCart, totalAmount, totalItems, getItemKey, editOrderId, setEditOrderId } = useCart();
  const navigate = useNavigate();
  const { storeSlug } = useParams<{ storeSlug: string }>();
  const [searchParams] = useSearchParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { config } = useRestaurantConfig();
  const { loading: statusLoading, deliveryEnabled } = useBusinessStatus();
  const canDelivery = deliveryEnabled !== false;
  const storePhone = (config.restaurant_phone || '').trim();
  const getItemName = (names: Record<string, string>) => names[lang] || Object.values(names)[0] || '';
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [offers, setOffers] = useState<OfferData[]>([]);
  const [menuItemCategories, setMenuItemCategories] = useState<Record<string, string>>({});
  const [offersLoaded, setOffersLoaded] = useState(false);
  const [deliveryCustomerName, setDeliveryCustomerName] = useState('');
  const [deliveryCustomerPhone, setDeliveryCustomerPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [deliveryPostalCode, setDeliveryPostalCode] = useState('');
  const [deliveryFeeRules, setDeliveryFeeRules] = useState<DeliveryFeeTier[]>([]);
  const [deliveryGeoLoading, setDeliveryGeoLoading] = useState(false);
  const [deliveryDistanceKm, setDeliveryDistanceKm] = useState<number | null>(null);
  const [deliveryGeoError, setDeliveryGeoError] = useState('');
  const eircodeReqRef = useRef(0);
  const [pickupSlotChoice, setPickupSlotChoice] = useState('');
  const [dineInGuestLabel, setDineInGuestLabel] = useState('');

  const table = searchParams.get('table');
  const seat = searchParams.get('seat');
  const orderType = searchParams.get('type');

  useEffect(() => {
    if (statusLoading) return;
    if (orderType === 'delivery' && !canDelivery) {
      const p = new URLSearchParams(searchParams);
      p.set('type', 'takeout');
      navigate({ pathname: `/${storeSlug ?? ''}/customer/cart`, search: p.toString() }, { replace: true });
    }
  }, [statusLoading, orderType, canDelivery, searchParams, navigate, storeSlug]);

  const menuBasePath = useMemo(() => {
    const p = new URLSearchParams(searchParams);
    p.delete('return');
    const tail = p.toString() ? `?${p.toString()}` : '';
    return searchParams.get('return') === 'store'
      ? `/${storeSlug ?? ''}${tail}`
      : `/${storeSlug ?? ''}/customer/menu${tail}`;
  }, [storeSlug, searchParams]);

  // Fetch offers and menu item category mapping
  useEffect(() => {
    let loaded = 0;
    const check = () => { loaded++; if (loaded >= 2) setOffersLoaded(true); };
    apiFetch('/api/offers').then(r => r.ok ? r.json() : []).then(d => { setOffers(d); check(); }).catch(() => check());
    apiFetch('/api/menu/items?ownOptionGroups=1').then(r => r.ok ? r.json() : []).then((data: { _id: string; categoryId: string }[]) => {
      const map: Record<string, string> = {};
      for (const item of data) map[item._id] = item.categoryId;
      setMenuItemCategories(map);
      check();
    }).catch(() => check());
  }, []);

  useEffect(() => {
    if (orderType !== 'delivery') {
      setDeliveryFeeRules([]);
      return;
    }
    let cancelled = false;
    void apiFetch('/api/admin/config')
      .then(r => (r.ok ? r.json() : {}))
      .then((d: Record<string, string>) => {
        if (cancelled) return;
        const raw = d[DELIVERY_FEE_RULES_CONFIG_KEY];
        setDeliveryFeeRules(typeof raw === 'string' ? parseDeliveryFeeRulesJson(raw) : []);
      })
      .catch(() => {
        if (!cancelled) setDeliveryFeeRules([]);
      });
    return () => { cancelled = true; };
  }, [orderType]);

  const lookupEircode = useCallback(async (raw: string) => {
    const norm = raw.toUpperCase().replace(/[\s-]/g, '');
    if (norm.length !== 7 || !/^[A-Z][0-9][0-9W][0-9A-Z]{4}$/.test(norm)) {
      setDeliveryDistanceKm(null);
      setDeliveryGeoError('');
      setDeliveryGeoLoading(false);
      return;
    }
    const id = ++eircodeReqRef.current;
    setDeliveryGeoLoading(true);
    setDeliveryGeoError('');
    try {
      const codeParam = `${norm.slice(0, 3)} ${norm.slice(3)}`;
      const res = await apiFetch(`/api/geo/customer-eircode?code=${encodeURIComponent(codeParam)}`);
      const data = (await res.json().catch(() => null)) as { formattedAddress?: string; distanceKm?: number; error?: { message?: string } } | null;
      if (id !== eircodeReqRef.current) return;
      if (!res.ok) {
        const msg = data?.error?.message || `HTTP ${res.status}`;
        throw new Error(msg);
      }
      setDeliveryAddress(data?.formattedAddress || '');
      setDeliveryDistanceKm(typeof data?.distanceKm === 'number' ? data.distanceKm : null);
    } catch (e) {
      if (id !== eircodeReqRef.current) return;
      setDeliveryDistanceKm(null);
      setDeliveryGeoError(e instanceof Error ? e.message : '解析失败');
    } finally {
      if (id === eircodeReqRef.current) setDeliveryGeoLoading(false);
    }
  }, []);

  useEffect(() => {
    if (orderType !== 'delivery') {
      setDeliveryDistanceKm(null);
      setDeliveryGeoError('');
      setDeliveryGeoLoading(false);
      return;
    }
    const tmr = window.setTimeout(() => { void lookupEircode(deliveryPostalCode); }, 500);
    return () => window.clearTimeout(tmr);
  }, [deliveryPostalCode, orderType, lookupEircode]);

  // Bundle matching
  const matchedBundles: MatchedBundle[] = useMemo(() => {
    if (offers.length === 0 || items.length === 0) return [];
    const cartEntries = items.map(item => {
      const optExtra = (item.options || []).reduce((s, o) => s + o.extraPrice, 0);
      return {
        key: getItemKey(item),
        menuItemId: item.menuItemId,
        categoryId: menuItemCategories[item.menuItemId] || '',
        basePrice: item.price,
        optionExtra: optExtra,
        quantity: item.quantity,
      };
    });
    return matchBundles(cartEntries, offers);
  }, [items, offers, menuItemCategories, getItemKey]);

  const bundleTotals = useMemo(() => {
    const cartEntries = items.map(item => {
      const optExtra = (item.options || []).reduce((s, o) => s + o.extraPrice, 0);
      return {
        key: getItemKey(item),
        menuItemId: item.menuItemId,
        categoryId: menuItemCategories[item.menuItemId] || '',
        basePrice: item.price,
        optionExtra: optExtra,
        quantity: item.quantity,
      };
    });
    return calcBundleTotal(cartEntries, matchedBundles);
  }, [items, matchedBundles, menuItemCategories, getItemKey]);

  const finalTotal = bundleTotals.finalTotal;

  const deliveryFeeAmount = useMemo(() => {
    if (orderType !== 'delivery' || deliveryDistanceKm == null) return 0;
    return deliveryFeeForDistance(deliveryFeeRules, deliveryDistanceKm);
  }, [orderType, deliveryDistanceKm, deliveryFeeRules]);

  const grandTotal = orderType === 'delivery' ? finalTotal + deliveryFeeAmount : finalTotal;

  const isDineInCart =
    orderType !== 'takeout' &&
    orderType !== 'delivery' &&
    table != null &&
    seat != null &&
    !Number.isNaN(Number(table)) &&
    !Number.isNaN(Number(seat));
  const showDineInGuestLabel =
    isDineInCart && !editOrderId && config.dine_in_workflow_mode === 'pay_after';

  const handleSubmit = async () => {
    if (items.length === 0) return;
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const itemsPayload = items.map(i => {
        const item: Record<string, unknown> = { menuItemId: i.menuItemId, quantity: i.quantity };
        if (i.options && i.options.length > 0) {
          item.selectedOptions = i.options.map(o => ({ groupId: o.groupId, choiceId: o.choiceId }));
        }
        return item;
      });

      let res: Response;
      if (editOrderId) {
        // Update existing order
        res = await apiFetch(`/api/orders/${editOrderId}/items`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: itemsPayload }),
        });
      } else {
        // Create new order
        const body: Record<string, unknown> = { items: itemsPayload };
        if (orderType === 'takeout') {
          body.type = 'takeout';
          if (pickupSlotChoice !== '') {
            const idx = Number.parseInt(pickupSlotChoice, 10);
            const slot = TAKEOUT_PICKUP_SLOTS[idx];
            if (slot) {
              body.pickupSlotLabel = lang.startsWith('zh') ? slot.labelZh : slot.labelEn;
              body.pickupSlotStart = pickupSlotStartIso(slot.h, slot.m);
            }
          }
        } else if (orderType === 'delivery') {
          if (!deliveryCustomerName.trim() || !deliveryCustomerPhone.trim() || !deliveryAddress.trim() || !deliveryPostalCode.trim()) {
            setError('请填写送餐姓名、电话、地址与邮编');
            return;
          }
          if (deliveryFeeRules.length > 0 && deliveryDistanceKm == null) {
            setError(t('cashier.deliveryFeeRulesNeedDistance'));
            return;
          }
          body.type = 'delivery';
          body.deliverySource = 'qr';
          body.customerName = deliveryCustomerName.trim();
          body.customerPhone = deliveryCustomerPhone.trim();
          body.deliveryAddress = deliveryAddress.trim();
          body.postalCode = deliveryPostalCode.trim();
          if (deliveryDistanceKm != null) {
            body.deliveryDistanceKm = deliveryDistanceKm;
          }
        } else {
          body.type = 'dine_in';
          body.tableNumber = Number(table);
          body.seatNumber = Number(seat);
          if (config.dine_in_workflow_mode === 'pay_after') {
            body.dineInGuestLabel = dineInGuestLabel.trim().slice(0, 40);
          }
        }
        // Include bundle discount info
        if (matchedBundles.length > 0) {
          body.appliedBundles = matchedBundles.map(b => ({
            offerId: b.offer._id,
            name: b.offer.name,
            nameEn: b.offer.nameEn,
            discount: b.savings,
          }));
        }
        res = await apiFetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(j?.error?.message || t('customer.updateFailed'));
        return;
      }
      if (editOrderId && config.dine_in_workflow_mode === 'pay_after') {
        const chk = await apiFetch(`/api/orders/${editOrderId}`, { omitStaffToken: true });
        if (chk.ok) {
          const o = (await chk.json()) as { type?: string; status?: string };
          if (o.type === 'dine_in' && (o.status === 'pending' || o.status === 'paid_online')) {
            await apiFetch(`/api/orders/${editOrderId}/dine-in-exposed`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ exposed: true }),
              omitStaffToken: true,
            });
          }
        }
      }
      const order = await res.json();
      const rawId = editOrderId ?? order._id;
      const navId = typeof rawId === 'string' ? rawId : String(rawId);
      clearCart();
      setEditOrderId(null);
      if (!storeSlug) {
        setError(t('customer.updateFailed'));
        return;
      }
      const navParams = new URLSearchParams(searchParams);
      navParams.delete('return');
      const search = navParams.toString() ? `?${navParams.toString()}` : '';
      navigate(`/${storeSlug}/customer/order/${navId}${search}`);
    } catch {
      setError(t('customer.updateFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  if (items.length === 0) {
    return (
      <div style={{ position: 'relative', width: '100%', minHeight: '60vh', paddingTop: 36 }}>
        <BannerPlatformCredit variant="onLight" />
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '50vh', gap: 16 }}>
          <span style={{ fontSize: 48, opacity: 0.3 }}>🛒</span>
          <p style={{ color: 'var(--text-light)' }}>{t('customer.emptyCart')}</p>
          <button className="btn btn-primary" onClick={() => navigate(menuBasePath)}>
            {t('customer.backToMenu')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, paddingBottom: 120, paddingTop: 40, position: 'relative' }}>
      <BannerPlatformCredit variant="onLight" />
      <h2 style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 20, marginBottom: 16, color: 'var(--text-dark)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={() => navigate(menuBasePath)} style={{
          background: 'none', border: 'none', cursor: 'pointer', fontSize: 18,
          color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', padding: 0,
        }}>←</button>
        {t('customer.cart')}
      </h2>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map(item => {
          const key = getItemKey(item);
          const optExtra = (item.options || []).reduce((s, o) => s + o.extraPrice, 0);
          const lockedFloor = typeof item.lockedBaselineQty === 'number' ? item.lockedBaselineQty : null;
          const atLockedFloor = lockedFloor != null && item.quantity <= lockedFloor;
          return (
            <div key={key} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              background: 'var(--bg-white)', borderRadius: 10, padding: '12px 14px',
              border: '1px solid rgba(232,213,184,0.5)',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-dark)' }}>{getItemName(item.names)}</div>
                {item.options && item.options.length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {item.options.map((o, i) => (
                      <div key={`${o.groupId}-${o.choiceId}-${i}`} style={{ lineHeight: 1.35 }}>
                        {o.groupName[lang] || Object.values(o.groupName)[0]}: {o.choiceName[lang] || Object.values(o.choiceName)[0]}
                        {o.extraPrice > 0 && ` +€${o.extraPrice}`}
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ fontSize: 13, color: 'var(--red-primary)', fontWeight: 600, fontFamily: "'Noto Serif SC', serif" }}>
                  €{item.price}{optExtra > 0 && ` +€${optExtra}`}
                </div>
              </div>
              <div style={{
                display: 'flex', alignItems: 'center', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden',
              }}>
                <button
                  type="button"
                  onClick={() => !atLockedFloor && decreaseQuantity(key)}
                  disabled={atLockedFloor}
                  style={{
                    width: 34, height: 34, background: 'var(--bg)', fontSize: 16, fontWeight: 700,
                    color: atLockedFloor ? 'var(--text-light)' : 'var(--red-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: atLockedFloor ? 'not-allowed' : 'pointer',
                  }}>−</button>
                <span style={{ width: 34, textAlign: 'center', fontSize: 14, fontWeight: 700 }}>{item.quantity}</span>
                <button onClick={() => increaseQuantity(key)} style={{
                  width: 34, height: 34, background: 'var(--bg)', fontSize: 16, fontWeight: 700,
                  color: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>+</button>
              </div>
              <div style={{ fontWeight: 700, color: 'var(--red-primary)', minWidth: 50, textAlign: 'right', fontFamily: "'Noto Serif SC', serif" }}>
                €{((item.price + optExtra) * item.quantity).toFixed(2)}
              </div>
              {lockedFloor == null ? (
                <button type="button" onClick={() => removeItem(key)} style={{
                  background: 'none', color: 'var(--text-light)', fontSize: 18, padding: 4,
                }}>✕</button>
              ) : (
                <span style={{ width: 22 }} aria-hidden />
              )}
            </div>
          );
        })}
      </div>

      {error && <div style={{ color: 'var(--red-primary)', marginTop: 12, fontSize: 13 }}>{error}</div>}
      {orderType === 'delivery' && (
        <div style={{
          marginTop: 12,
          padding: '12px 14px',
          borderRadius: 10,
          border: '1px solid #E65100',
          background: '#FFF8E1',
          fontSize: 13,
          lineHeight: 1.55,
          color: '#5D4037',
        }}>
          <div style={{ fontWeight: 700, marginBottom: 8, color: '#E65100' }}>{t('customer.deliveryPolicyTitle')}</div>
          <p style={{ margin: '0 0 8px' }}>{t('customer.deliveryPolicyUnpaidNoKitchen')}</p>
          <p style={{ margin: '0 0 6px' }}>{t('customer.deliveryPolicyCashCallUs')}</p>
          {storePhone ? (
            <a href={`tel:${storePhone.replace(/\s/g, '')}`} style={{ fontWeight: 700, color: '#BF360C', wordBreak: 'break-all' }}>
              {t('customer.deliveryStorePhoneLabel')}：{storePhone}
            </a>
          ) : (
            <span style={{ fontSize: 12, color: '#6D4C41' }}>{t('customer.deliveryNoPhoneConfigured')}</span>
          )}
        </div>
      )}
      {showDineInGuestLabel && (
        <div style={{ marginTop: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 6 }}>
            {t('customer.dineInGuestLabel')}
          </label>
          <input
            className="input"
            value={dineInGuestLabel}
            onChange={(e) => setDineInGuestLabel(e.target.value)}
            placeholder={t('customer.dineInGuestLabelPlaceholder')}
            maxLength={40}
            style={{ width: '100%', fontSize: 14 }}
          />
          <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 6, lineHeight: 1.45 }}>
            {t('customer.dineInGuestLabelHint')}
          </div>
        </div>
      )}
      {orderType === 'takeout' && (
        <div style={{ marginTop: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 6 }}>
            {lang.startsWith('zh') ? '取餐时段（大致）' : 'Pickup time (approx.)'}
          </label>
          <select
            className="input"
            value={pickupSlotChoice}
            onChange={(e) => setPickupSlotChoice(e.target.value)}
            style={{ width: '100%', fontSize: 14 }}
          >
            <option value="">{lang.startsWith('zh') ? '不指定 / 尽快' : 'No preference / ASAP'}</option>
            {TAKEOUT_PICKUP_SLOTS.map((s, i) => (
              <option key={i} value={String(i)}>
                {lang.startsWith('zh') ? s.labelZh : s.labelEn}
              </option>
            ))}
          </select>
        </div>
      )}
      {orderType === 'delivery' && (
        <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
          <input className="input" placeholder={lang === 'zh-CN' ? '收货姓名' : 'Recipient name'} value={deliveryCustomerName} onChange={e => setDeliveryCustomerName(e.target.value)} />
          <input className="input" placeholder={lang === 'zh-CN' ? '联系电话' : 'Phone'} value={deliveryCustomerPhone} onChange={e => setDeliveryCustomerPhone(e.target.value)} />
          <input
            className="input"
            placeholder={t('customer.deliveryEircodePlaceholder')}
            value={deliveryPostalCode}
            onChange={e => setDeliveryPostalCode(e.target.value)}
            autoCapitalize="characters"
          />
          <input
            className="input"
            placeholder={t('customer.deliveryAddressPlaceholder')}
            value={deliveryAddress}
            onChange={e => setDeliveryAddress(e.target.value)}
          />
          {deliveryGeoLoading ? (
            <div style={{ fontSize: 12, color: 'var(--text-light)' }}>{t('customer.deliveryGeocoding')}</div>
          ) : null}
          {deliveryGeoError ? (
            <div style={{ fontSize: 12, color: 'var(--red-primary)' }}>{deliveryGeoError}</div>
          ) : null}
          {deliveryDistanceKm != null && !deliveryGeoLoading ? (
            <div style={{ fontSize: 12, color: '#1565c0' }}>
              {t('customer.deliveryStraightLineKm', { km: deliveryDistanceKm })}
            </div>
          ) : null}
          {deliveryFeeRules.length > 0 && deliveryDistanceKm != null ? (
            <div style={{ fontSize: 12, color: '#1565c0' }}>
              {t('cashier.deliveryFee')}: <strong>€{deliveryFeeAmount.toFixed(2)}</strong>
            </div>
          ) : null}
          {deliveryFeeRules.length > 0 && !deliveryGeoLoading && deliveryPostalCode.trim().length >= 5 && deliveryDistanceKm == null && !deliveryGeoError ? (
            <div style={{ fontSize: 11, color: 'var(--text-light)' }}>{t('cashier.deliveryFeeRulesNeedDistance')}</div>
          ) : null}
        </div>
      )}

      {/* Bundle discount display */}
      {matchedBundles.length > 0 && (
        <div style={{ marginTop: 12, padding: '10px 14px', background: '#E8F5E9', borderRadius: 10, border: '1px solid #C8E6C9' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#2E7D32', marginBottom: 4 }}>🎁 {lang === 'zh-CN' ? '套餐优惠已匹配' : 'Bundle Offer Applied'}</div>
          {matchedBundles.map((b, i) => (
            <div key={i} style={{ fontSize: 12, color: '#388E3C', display: 'flex', justifyContent: 'space-between' }}>
              <span>{b.offer.name}{b.offer.nameEn ? ` ${b.offer.nameEn}` : ''}</span>
              <span style={{ fontWeight: 600 }}>-€{b.savings.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Fixed bottom bar */}
      <div style={{
        position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)',
        maxWidth: 430, width: '100%', padding: '16px 20px',
        background: 'var(--bg-white)', borderTop: '2px solid var(--border-light)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', zIndex: 100,
      }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-light)' }}>{t('customer.totalAmount')} · {totalItems} {t('customer.quantity')}</div>
          {bundleTotals.bundleDiscount > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-light)', textDecoration: 'line-through' }}>€{totalAmount.toFixed(2)}</div>
          )}
          {orderType === 'delivery' && deliveryFeeAmount > 0 ? (
            <div style={{ fontSize: 11, color: 'var(--text-light)' }}>
              {t('cashier.deliveryFee')} +€{deliveryFeeAmount.toFixed(2)}
            </div>
          ) : null}
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--red-primary)', fontFamily: "'Noto Serif SC', serif" }}>€{grandTotal.toFixed(2)}</div>
        </div>
        <button className="btn btn-primary" onClick={handleSubmit} disabled={submitting || !offersLoaded}
          style={{ padding: '12px 28px', fontSize: 15, letterSpacing: 1 }}>
          {!offersLoaded ? '...' : submitting ? t('common.loading') : editOrderId ? t('customer.saveChanges') : t('customer.submitOrder')}
        </button>
      </div>
    </div>
  );
}
