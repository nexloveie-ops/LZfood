import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useCart } from '../../context/CartContext';
import type { CartItem } from '../../context/CartContext';
import PaymentModal from '../../components/customer/PaymentModal';
import MemberWalletPayModal from '../../components/customer/MemberWalletPayModal';
import { apiFetch } from '../../api/client';
import { resolveBackendAssetUrl } from '../../utils/backendPublicUrl';
import { useRestaurantConfig } from '../../hooks/useRestaurantConfig';
import { computeCustomerFacingPayableEuro } from '../../utils/orderPayableEuro';

interface OrderItem {
  _id: string;
  menuItemId?: string;
  lineKind?: string;
  quantity: number;
  unitPrice: number;
  itemName: string;
  itemNameEn?: string;
  settledQty?: number;
  refunded?: boolean;
  /** 与后端 DELETE 堂食取消规则、收银 dineInAllowCancelPending 一致 */
  kitchenPrintedQty?: number;
  selectedOptions?: { groupName: string; groupNameEn?: string; choiceName: string; choiceNameEn?: string; extraPrice: number }[];
}
interface AppliedBundle { offerId?: string; name: string; nameEn?: string; discount: number; }
interface Order {
  _id: string; type: string; tableNumber?: number; seatNumber?: number;
  dailyOrderNumber?: number; status: string; items: OrderItem[];
  appliedBundles?: AppliedBundle[];
  deliveryFeeEuro?: number;
  pickupSlotLabel?: string;
  dineInExposedToStaff?: boolean;
  dineInStaffLockedAt?: string;
  dineInGuestLabel?: string;
}

interface PostOrderSlide {
  imageUrl: string;
  captionZh?: string;
  captionEn?: string;
}

interface PostOrderAdBanner {
  _id: string;
  titleZh: string;
  titleEn?: string;
  linkUrl: string;
  slides: PostOrderSlide[];
}

/** 下单后在本页即可展示广告（含待支付） */
const POST_ORDER_AD_STATUSES = new Set(['pending', 'paid_online', 'checked_out', 'completed']);

/** 堂食 pending：已出厨房或已有部分结账（加菜/锁行基准，与取消无关） */
function dineInKitchenOrSettlementStarted(o: Order): boolean {
  if (o.type !== 'dine_in' || o.status !== 'pending') return false;
  for (const it of o.items || []) {
    if (it.lineKind === 'delivery_fee' || it.refunded) continue;
    if ((Number(it.kitchenPrintedQty) || 0) > 0) return true;
    if ((Number(it.settledQty) || 0) > 0) return true;
  }
  return false;
}

/** pending 且未付：顾客可自助取消（与 DELETE /api/orders/:id 一致） */
function customerMaySelfCancelOrder(o: Order): boolean {
  if (o.status !== 'pending') return false;
  if (o.stripePaymentIntentId) return false;
  if (o.phoneCardPaidAtPlacement) return false;
  if (o.placementPrepaidMethod) return false;
  if ((Number(o.memberCreditUsed) || 0) > 0.001) return false;
  const ps = String(o.paymentStatus || 'unpaid');
  if (ps === 'paid' || ps === 'partial') return false;
  return true;
}

function PostOrderAdCarousel({ slides, lang }: { slides: PostOrderSlide[]; lang: string }) {
  const [idx, setIdx] = useState(0);
  const scRef = useRef<HTMLDivElement>(null);

  const onScroll = useCallback(() => {
    const el = scRef.current;
    if (!el) return;
    const w = el.clientWidth || 1;
    setIdx(Math.min(slides.length - 1, Math.max(0, Math.round(el.scrollLeft / w))));
  }, [slides.length]);

  useEffect(() => {
    setIdx(0);
    const el = scRef.current;
    if (el && slides.length > 0) el.scrollTo({ left: 0, behavior: 'auto' });
  }, [slides.length]);

  useEffect(() => {
    if (slides.length <= 1) return;
    const tick = () => {
      const el = scRef.current;
      if (!el) return;
      const w = el.clientWidth;
      if (!w) return;
      const n = slides.length;
      const cur = Math.min(n - 1, Math.max(0, Math.round(el.scrollLeft / w)));
      const next = (cur + 1) % n;
      // `auto` snaps reliably; `smooth` often misses final scrollLeft / snap on some browsers
      el.scrollTo({ left: next * w, behavior: 'auto' });
      setIdx(next);
    };
    const id = window.setInterval(tick, 5000);
    return () => window.clearInterval(id);
  }, [slides.length]);

  return (
    <>
      <div
        ref={scRef}
        onScroll={onScroll}
        style={{
          overflowX: 'auto',
          display: 'flex',
          scrollSnapType: 'x mandatory',
          WebkitOverflowScrolling: 'touch',
          maxHeight: 220,
        }}
      >
        {slides.map((s, i) => (
          <div
            key={i}
            style={{
              flex: '0 0 100%',
              scrollSnapAlign: 'start',
              minWidth: 0,
            }}
          >
            <img
              src={resolveBackendAssetUrl(s.imageUrl)}
              alt=""
              style={{ width: '100%', height: 'auto', display: 'block', maxHeight: 180, objectFit: 'cover' }}
            />
            {(lang === 'en-US' ? s.captionEn : s.captionZh)?.trim() ? (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '6px 10px 4px', lineHeight: 1.35 }}>
                {lang === 'en-US' ? s.captionEn?.trim() : s.captionZh?.trim()}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {slides.length > 1 ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: 6,
            padding: '6px 0 2px',
            pointerEvents: 'none',
          }}
        >
          {slides.map((_, i) => (
            <span
              key={i}
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: i === idx ? 'var(--red-primary, #C41E24)' : 'rgba(0,0,0,0.15)',
              }}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

export default function OrderStatusPage() {
  const { orderId, storeSlug } = useParams<{ orderId: string; storeSlug: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { config } = useRestaurantConfig();
  const storePhone = (config.restaurant_phone || '').trim();
  const { clearCart, setItems, setEditOrderId } = useCart();
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPayment, setShowPayment] = useState(false);
  const [showMemberWallet, setShowMemberWallet] = useState(false);
  const [postOrderAds, setPostOrderAds] = useState<PostOrderAdBanner[]>([]);
  const qs = searchParams.toString();
  const menuHref = storeSlug ? `/${storeSlug}/customer/menu${qs ? `?${qs}` : ''}` : '/';

  const fetchOrder = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/orders/${orderId}`);
      if (!res.ok) throw new Error();
      setOrder(await res.json());
    } catch { setOrder(null); }
    finally { setLoading(false); }
  }, [orderId]);

  useEffect(() => { fetchOrder(); }, [fetchOrder]);

  useEffect(() => {
    if (!order || !POST_ORDER_AD_STATUSES.has(order.status)) {
      setPostOrderAds([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/public/post-order-ads');
        if (!res.ok) return;
        const data = (await res.json()) as unknown;
        if (!cancelled && Array.isArray(data)) {
          setPostOrderAds(data as PostOrderAdBanner[]);
        }
      } catch {
        if (!cancelled) setPostOrderAds([]);
      }
    })();
    return () => { cancelled = true; };
  }, [order?.status, orderId]);

  const impressionLoggedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!order || !POST_ORDER_AD_STATUSES.has(order.status)) return;
    if (postOrderAds.length === 0) return;
    const key = `${orderId}:${postOrderAds.map(a => a._id).sort().join(',')}`;
    if (impressionLoggedKey.current === key) return;
    impressionLoggedKey.current = key;
    void apiFetch('/api/public/post-order-ads/impressions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adIds: postOrderAds.map(a => a._id) }),
    });
  }, [order?.status, orderId, postOrderAds]);

  const handleModifyOrder = async () => {
    if (!order) return;
    try {
      if (
        order.type === 'dine_in' &&
        config.dine_in_workflow_mode === 'pay_after' &&
        order.status === 'pending' &&
        !order.dineInStaffLockedAt
      ) {
        const w = await apiFetch(`/api/orders/${order._id}/dine-in-exposed`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ exposed: false }),
          omitStaffToken: true,
        });
        if (!w.ok) {
          const j = (await w.json().catch(() => null)) as { error?: { message?: string } } | null;
          alert(j?.error?.message || (lang.startsWith('zh') ? '暂时无法进入改单，请稍后再试' : 'Could not start edit'));
          return;
        }
      }
      // Fetch menu items to resolve groupId/choiceId from stored groupName/choiceName
      const menuRes = await apiFetch('/api/menu/items');
      const menuItems: {
        _id: string;
        optionGroups?: {
          _id: string;
          translations: { locale: string; name: string }[];
          choices: { _id: string; extraPrice: number; translations: { locale: string; name: string }[] }[];
        }[];
      }[] = menuRes.ok ? await menuRes.json() : [];
      const menuMap = new Map(menuItems.map(m => [m._id, m]));

      const useLockedLineBaselines =
        order.type === 'dine_in' &&
        order.status === 'pending' &&
        (dineInKitchenOrSettlementStarted(order) ||
          (config.dine_in_workflow_mode === 'pay_after' && !!order.dineInStaffLockedAt));

      const cartItems: CartItem[] = order.items
        .filter(
          (item): item is OrderItem & { menuItemId: string } =>
            Boolean(item.menuItemId) && item.lineKind !== 'delivery_fee',
        )
        .map(item => {
        const menuItem = menuMap.get(item.menuItemId);
        const options: CartItem['options'] = [];

        if (item.selectedOptions && item.selectedOptions.length > 0 && menuItem?.optionGroups) {
          for (const sel of item.selectedOptions) {
            // Find matching group by name
            const group = menuItem.optionGroups.find(g =>
              g.translations.some(t2 => t2.name === sel.groupName)
            );
            if (group) {
              // Find matching choice by name
              const choice = group.choices.find(c =>
                c.translations.some(t2 => t2.name === sel.choiceName)
              );
              if (choice) {
                const groupNames: Record<string, string> = {};
                for (const t2 of group.translations) groupNames[t2.locale] = t2.name;
                const choiceNames: Record<string, string> = {};
                for (const t2 of choice.translations) choiceNames[t2.locale] = t2.name;
                options.push({
                  groupId: group._id,
                  choiceId: choice._id,
                  groupName: groupNames,
                  choiceName: choiceNames,
                  extraPrice: choice.extraPrice || 0,
                });
              }
            }
          }
        }

        const row: CartItem = {
          menuItemId: item.menuItemId,
          names: { 'zh-CN': item.itemName, 'en-US': item.itemNameEn || item.itemName },
          price: item.unitPrice,
          quantity: item.quantity,
          options: options.length > 0 ? options : undefined,
        };
        return useLockedLineBaselines ? { ...row, lockedBaselineQty: item.quantity } : row;
      });

      clearCart();
      setItems(cartItems);
      setEditOrderId(order._id);
      navigate(menuHref);
    } catch {
      navigate(menuHref);
    }
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-light)' }}>{t('customer.loadingOrder')}</div>;
  if (!order) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-light)' }}>{t('customer.orderNotFound')}</div>;

  const isPending = order.status === 'pending';
  const maySelfCancel = customerMaySelfCancelOrder(order);
  const showDineInPrimaryAsAddDishes =
    order.type === 'dine_in' &&
    isPending &&
    (dineInKitchenOrSettlementStarted(order) ||
      (config.dine_in_workflow_mode === 'pay_after' && !!order.dineInStaffLockedAt));
  const isPaidOnline = order.status === 'paid_online';
  /** 扫码送餐：Stripe 成功后订单为 checked_out 且已写 Checkout，顾客仍显示「已支付」 */
  const isDeliveryPaidCheckout = order.type === 'delivery' && order.status === 'checked_out';
  const statusLabel = order.status === 'pending'
    ? t('customer.statusPending')
    : isPaidOnline || isDeliveryPaidCheckout
      ? t('customer.statusPaidOnline')
      : order.status === 'checked_out'
        ? t('customer.statusCheckedOut')
        : t('customer.statusCompleted');
  const statusColor = order.status === 'pending'
    ? 'var(--gold-primary)'
    : isPaidOnline || isDeliveryPaidCheckout
      ? '#2E7D32'
      : order.status === 'checked_out'
        ? 'var(--blue)'
        : 'var(--green)';

  return (
    <div style={{ padding: '12px 16px', paddingBottom: 24 }}>
      {/* Status header — compact row to leave room for line items + ads */}
      <div style={{
        background: 'var(--bg-white)', borderRadius: 10, padding: '10px 14px', marginBottom: 12,
        border: '1px solid rgba(232,213,184,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
      }}>
        <div style={{ minWidth: 0, textAlign: 'left' }}>
          <div style={{ fontSize: 11, color: 'var(--text-light)', lineHeight: 1.2, marginBottom: 2 }}>{t('customer.orderNumber')}</div>
          <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Noto Serif SC', serif", lineHeight: 1.2 }}>
            {order.dailyOrderNumber ? `#${order.dailyOrderNumber}` : order._id.slice(-8).toUpperCase()}
          </div>
          {order.type === 'dine_in' && order.dineInGuestLabel?.trim() ? (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
              {t('customer.dineInGuestLabelOnOrder')}：{order.dineInGuestLabel.trim()}
            </div>
          ) : null}
        </div>
        <span style={{
          display: 'inline-block', padding: '3px 10px', borderRadius: 14,
          background: statusColor + '20', color: statusColor, fontWeight: 600, fontSize: 12,
          flexShrink: 0,
        }}>{statusLabel}</span>
      </div>

      {order.type === 'takeout' && order.pickupSlotLabel?.trim() ? (
        <div style={{
          marginBottom: 12,
          padding: '8px 12px',
          borderRadius: 8,
          background: '#E3F2FD',
          border: '1px solid #90CAF9',
          fontSize: 13,
          color: '#1565c0',
        }}>
          {lang === 'en-US' ? 'Pickup (approx.)' : '预约取餐'}：<strong>{order.pickupSlotLabel.trim()}</strong>
        </div>
      ) : null}

      {isPending &&
        order.type === 'dine_in' &&
        config.dine_in_workflow_mode === 'pay_after' &&
        order.dineInStaffLockedAt && (
          <div
            style={{
              marginBottom: 12,
              padding: '10px 12px',
              borderRadius: 8,
              background: '#FFF3E0',
              border: '1px solid #FFB74D',
              fontSize: 13,
              color: '#E65100',
              lineHeight: 1.5,
            }}
          >
            {t('customer.dineInStaffLockedHint')}
          </div>
        )}
      {isPending && order.type === 'delivery' && (
        <div style={{
          marginBottom: 12,
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

      {/* Items */}
      <div style={{ background: 'var(--bg-white)', borderRadius: 12, border: '1px solid rgba(232,213,184,0.5)', overflow: 'hidden' }}>
        {order.items.map((item, idx) => (
          <div key={item._id || idx} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
            borderBottom: '1px solid #f0f0f0',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{lang === 'en-US' && item.itemNameEn ? item.itemNameEn : item.itemName}</div>
              {item.selectedOptions && item.selectedOptions.length > 0 && (
                <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 2 }}>
                  {item.selectedOptions.map((o, i) => (
                    <span key={i}>{i > 0 && ' · '}
                      {lang === 'en-US' ? (o.groupNameEn || o.groupName) : o.groupName}: {lang === 'en-US' ? (o.choiceNameEn || o.choiceName) : o.choiceName}
                      {o.extraPrice > 0 && ` +€${o.extraPrice}`}
                    </span>
                  ))}
                </div>
              )}
              <div style={{ fontSize: 12, color: 'var(--text-light)' }}>€{item.unitPrice} / {t('customer.quantity')}</div>
            </div>
            <span style={{ fontSize: 14, fontWeight: 600 }}>×{item.quantity}</span>
            <span style={{ fontWeight: 700, color: 'var(--red-primary)', minWidth: 50, textAlign: 'right', fontFamily: "'Noto Serif SC', serif" }}>
              €{((item.unitPrice + (item.selectedOptions || []).reduce((a, o) => a + (o.extraPrice || 0), 0)) * item.quantity).toFixed(2)}
            </span>
          </div>
        ))}
        {order.appliedBundles && order.appliedBundles.length > 0 && (
          <div style={{ padding: '0 16px 12px' }}>
            {order.appliedBundles.map((b, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#2E7D32', padding: '2px 0' }}>
                <span>🎁 {b.name}{b.nameEn ? ` ${b.nameEn}` : ''}</span>
                <span style={{ fontWeight: 600 }}>-€{b.discount.toFixed(2)}</span>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 16px', fontWeight: 700, fontSize: 16 }}>
          <span>{t('customer.totalAmount')}</span>
          <span style={{ color: 'var(--red-primary)', fontFamily: "'Noto Serif SC', serif" }}>€{computeCustomerFacingPayableEuro(order, config.dine_in_workflow_mode === 'pay_after').toFixed(2)}</span>
        </div>
      </div>

      {/* Actions */}
      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {isPending && (
          <>
            {/* Online Payment Button */}
            <button className="btn" onClick={() => setShowPayment(true)}
              style={{
                width: '100%', padding: '14px 0', fontSize: 16, fontWeight: 700,
                background: '#000', color: '#fff', border: 'none', borderRadius: 12,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}>
              <span style={{ fontSize: 20 }}>💳</span> {t('customer.payNow')} · €{computeCustomerFacingPayableEuro(order, config.dine_in_workflow_mode === 'pay_after').toFixed(2)}
            </button>
            <button
              className="btn btn-outline"
              onClick={() => setShowMemberWallet(true)}
              style={{
                width: '100%',
                padding: '14px 0',
                fontSize: 15,
                fontWeight: 700,
                borderRadius: 12,
                border: '2px solid var(--gold-primary, #C5A059)',
                color: 'var(--text-dark)',
                background: 'linear-gradient(180deg, #fffef8 0%, #faf6eb 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <span style={{ fontSize: 20 }}>👛</span> {t('customer.memberWalletPay')} · €{computeCustomerFacingPayableEuro(order, config.dine_in_workflow_mode === 'pay_after').toFixed(2)}
            </button>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleModifyOrder}>
                {showDineInPrimaryAsAddDishes ? t('customer.addDishes') : t('customer.modifyOrder')}
              </button>
              <button className="btn btn-outline" style={{ flex: 1 }} onClick={() => navigate(menuHref)}>
                {t('customer.backToMenu')}
              </button>
            </div>
            {maySelfCancel && (
            <button
              onClick={async () => {
                if (!confirm(t('customer.confirmCancel'))) return;
                try {
                  const res = await apiFetch(`/api/orders/${order._id}`, { method: 'DELETE' });
                  if (res.ok) navigate(menuHref, { replace: true });
                } catch { /* ignore */ }
              }}
              style={{
                width: '100%', padding: '10px 0', fontSize: 13, fontWeight: 600,
                background: 'none', border: '1px dashed #F44336', borderRadius: 10,
                color: '#F44336', cursor: 'pointer',
              }}>
              ✕ {t('customer.cancelOrder')}
            </button>
            )}
          </>
        )}
        {(isPaidOnline || isDeliveryPaidCheckout) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ padding: '8px 12px', background: '#E8F5E9', border: '1px solid #81C784', borderRadius: 8, textAlign: 'center', fontSize: 13, color: '#2E7D32', fontWeight: 600 }}>
              ✅ {t('customer.paymentSuccess')}
            </div>
            <button className="btn btn-outline" style={{ width: '100%' }} onClick={() => navigate(menuHref)}>
              {t('customer.backToMenu')}
            </button>
          </div>
        )}
        {!isPending && !isPaidOnline && !isDeliveryPaidCheckout && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ color: 'var(--text-light)', fontSize: 13, textAlign: 'center', width: '100%' }}>
              {t('customer.orderNotModifiable')}
            </p>
            <button className="btn btn-outline" style={{ width: '100%' }} onClick={() => navigate(menuHref)}>
              {t('customer.backToMenu')}
            </button>
          </div>
        )}
      </div>

      {order && POST_ORDER_AD_STATUSES.has(order.status) && postOrderAds.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{
            fontSize: 10,
            color: 'var(--text-light)',
            marginBottom: 6,
            letterSpacing: 0.03,
          }}>
            {t('customer.postOrderSponsored')}
          </div>
          {postOrderAds.map((ad) => (
            <a
              key={ad._id}
              href={ad.linkUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                void apiFetch('/api/public/post-order-ads/click', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ adId: ad._id }),
                });
              }}
              style={{
                display: 'block',
                marginBottom: 12,
                borderRadius: 12,
                overflow: 'hidden',
                border: '1px solid rgba(232,213,184,0.45)',
                background: 'var(--bg-white)',
                textDecoration: 'none',
                color: 'inherit',
                boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
              }}
            >
              {ad.slides && ad.slides.length > 0 ? (
                <PostOrderAdCarousel slides={ad.slides} lang={lang} />
              ) : null}
              <div style={{ padding: '10px 14px', fontSize: 14, fontWeight: 600, lineHeight: 1.4 }}>
                {lang === 'en-US' && ad.titleEn?.trim() ? ad.titleEn : ad.titleZh}
              </div>
            </a>
          ))}
        </div>
      )}

      {/* Payment Modal */}
      {showPayment && order && (
        <PaymentModal
          orderId={order._id}
          amount={computeCustomerFacingPayableEuro(order, config.dine_in_workflow_mode === 'pay_after')}
          onSuccess={() => {
            setShowPayment(false);
            fetchOrder(); // Refresh to show checked_out status
          }}
          onClose={() => setShowPayment(false)}
        />
      )}
      {showMemberWallet && order && (
        <MemberWalletPayModal
          orderId={order._id}
          amount={computeCustomerFacingPayableEuro(order, config.dine_in_workflow_mode === 'pay_after')}
          onSuccess={() => {
            setShowMemberWallet(false);
            fetchOrder();
          }}
          onClose={() => setShowMemberWallet(false)}
        />
      )}
    </div>
  );
}
