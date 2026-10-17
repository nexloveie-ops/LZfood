import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentRequestButtonElement, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { apiFetch } from '../../api/client';

interface PaymentModalProps {
  orderId: string;
  /** 同桌多笔未结堂食单：与 amount 一起提交，Stripe 按合计收款 */
  orderIds?: string[];
  amount: number;
  onSuccess: (checkoutId: string) => void;
  onClose: () => void;
}

function PaymentErrorBlock({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ color: '#F44336', fontSize: 13, textAlign: 'center', lineHeight: 1.45 }}>{message}</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center', marginTop: 10, lineHeight: 1.5 }}>
        {t('customer.payAtCounterSuggestion')}
      </div>
    </div>
  );
}

function PaymentContent({ orderId, orderIds, amount, onSuccess, onClose }: PaymentModalProps) {
  const payIds = orderIds && orderIds.length > 0 ? orderIds : [orderId];
  const payBody = { orderId, orderIds: payIds };
  const { t } = useTranslation();
  const stripe = useStripe();
  const elements = useElements();
  const [clientSecret, setClientSecret] = useState('');
  const [paymentRequest, setPaymentRequest] = useState<ReturnType<Stripe['paymentRequest']> | null>(null);
  const [canPay, setCanPay] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [restaurantLabel, setRestaurantLabel] = useState('Restaurant');
  const [intentLoading, setIntentLoading] = useState(true);

  // Create payment intent
  useEffect(() => {
    apiFetch('/api/admin/config').then(r => r.ok ? r.json() : {}).then((c: Record<string, string>) => {
      setRestaurantLabel(c.restaurant_name_en || c.restaurant_name_zh || 'Restaurant');
    }).catch(() => {});
    let cancelled = false;
    const intentTimer = window.setTimeout(() => {
      if (cancelled) return;
      setError(t('customer.paymentIntentFailed'));
      setIntentLoading(false);
    }, 35000);
    (async () => {
      try {
        const res = await apiFetch('/api/payments/create-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payBody),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError((data as { error?: { message?: string } }).error?.message || t('customer.paymentIntentFailed'));
          return;
        }
        if (data.clientSecret) setClientSecret(data.clientSecret);
        else setError((data as { error?: { message?: string } }).error?.message || t('customer.paymentIntentFailed'));
      } catch {
        if (!cancelled) setError(t('customer.paymentNetworkError'));
      } finally {
        if (!cancelled) {
          window.clearTimeout(intentTimer);
          setIntentLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(intentTimer);
    };
  }, [orderId, t, payIds.join(',')]);

  // Setup Payment Request (Apple Pay / Google Pay)
  useEffect(() => {
    if (!stripe || !clientSecret) return;

    const pr = stripe.paymentRequest({
      country: 'IE',
      currency: 'eur',
      total: { label: restaurantLabel, amount: Math.round(amount * 100) },
      requestPayerName: false,
      requestPayerEmail: false,
    });

    pr.canMakePayment().then(result => {
      if (result) {
        setPaymentRequest(pr);
        setCanPay(true);
      }
    });

    pr.on('paymentmethod', async (ev) => {
      setProcessing(true);
      const { error: confirmError, paymentIntent } = await stripe.confirmCardPayment(
        clientSecret,
        { payment_method: ev.paymentMethod.id },
        { handleActions: false }
      );

      if (confirmError) {
        ev.complete('fail');
        setError(confirmError.message || t('customer.paymentIntentFailed'));
        setProcessing(false);
      } else if (paymentIntent) {
        ev.complete('success');
        const res = await apiFetch('/api/payments/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payBody, paymentIntentId: paymentIntent.id }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError((data as { error?: { message?: string } }).error?.message || t('customer.paymentConfirmFailed'));
          setProcessing(false);
          return;
        }
        if (data.orderId || data.checkoutId) {
          setSuccess(true);
          setTimeout(() => onSuccess(data.orderId || data.checkoutId), 1000);
        } else {
          setError(t('customer.paymentConfirmFailed'));
        }
        setProcessing(false);
      }
    });
  }, [stripe, clientSecret, amount, orderId, onSuccess, restaurantLabel, t, payIds.join(',')]);

  // Card payment handler
  const handleCardPay = async () => {
    if (!stripe || !elements || !clientSecret) return;
    const cardElement = elements.getElement(CardElement);
    if (!cardElement) return;

    setProcessing(true);
    setError('');

    const { error: confirmError, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
      payment_method: { card: cardElement },
    });

    if (confirmError) {
      setError(confirmError.message || t('customer.paymentIntentFailed'));
      setProcessing(false);
      return;
    }

    if (paymentIntent?.status === 'succeeded') {
      const res = await apiFetch('/api/payments/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payBody, paymentIntentId: paymentIntent.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: { message?: string } }).error?.message || t('customer.paymentConfirmFailed'));
        setProcessing(false);
        return;
      }
      if (data.orderId || data.checkoutId) {
        setSuccess(true);
        setTimeout(() => onSuccess(data.orderId || data.checkoutId), 1000);
      } else {
        setError(t('customer.paymentConfirmFailed'));
      }
    }
    setProcessing(false);
  };

  if (success) {
    return (
      <div style={{ textAlign: 'center', padding: 40 }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#388E3C' }}>{t('customer.paymentSuccess')}</div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--red-primary)', fontFamily: "'Noto Serif SC', serif" }}>
          €{amount.toFixed(2)}
        </div>
      </div>

      {error && <PaymentErrorBlock message={error} />}

      {intentLoading && !error && !clientSecret && (
        <div style={{ textAlign: 'center', padding: 12, color: 'var(--text-light)' }}>{t('customer.paymentPreparingSession')}</div>
      )}

      {/* Apple Pay / Google Pay button */}
      {canPay && paymentRequest && (
        <div style={{ marginBottom: 16 }}>
          <PaymentRequestButtonElement
            options={{ paymentRequest, style: { paymentRequestButton: { height: '48px' } } }}
          />
          <div style={{ textAlign: 'center', margin: '12px 0', fontSize: 12, color: 'var(--text-light)' }}>— or —</div>
        </div>
      )}

      {/* Card input */}
      {clientSecret && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ padding: '12px 14px', border: '1px solid #ddd', borderRadius: 8, background: '#fafafa' }}>
            <CardElement options={{
              style: {
                base: { fontSize: '16px', color: '#333', '::placeholder': { color: '#aab7c4' } },
                invalid: { color: '#F44336' },
              },
            }} />
          </div>
          <button onClick={handleCardPay} disabled={processing || !stripe}
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 12, padding: '14px 0', fontSize: 15 }}>
            {processing ? t('customer.paymentProcessing') : `${t('customer.payNow')} €${amount.toFixed(2)}`}
          </button>
        </div>
      )}

      <div style={{ textAlign: 'center', marginTop: 8 }}>
        <button onClick={onClose} className="btn btn-outline" style={{ padding: '10px 24px' }}>
          {t('customer.payAtCounter')}
        </button>
      </div>
    </div>
  );
}

const STRIPE_BOOT_TIMEOUT_MS = 28000;

export default function PaymentModal({ orderId, orderIds, amount, onSuccess, onClose }: PaymentModalProps) {
  const { t } = useTranslation();
  const [stripeReady, setStripeReady] = useState(false);
  const [stripePromiseForElements, setStripePromiseForElements] = useState<Promise<Stripe | null> | null>(null);
  const [stripeBootError, setStripeBootError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let bootFinished = false;

    const finishBoot = (apply: () => void) => {
      if (cancelled || bootFinished) return;
      bootFinished = true;
      apply();
    };

    const timer = window.setTimeout(() => {
      finishBoot(() => {
        setStripeBootError(t('customer.paymentBootTimeout'));
        setStripePromiseForElements(null);
        setStripeReady(true);
      });
    }, STRIPE_BOOT_TIMEOUT_MS);

    (async () => {
      try {
        const res = await apiFetch('/api/payments/config');
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          window.clearTimeout(timer);
          finishBoot(() => {
            setStripeBootError((data as { error?: { message?: string } }).error?.message || t('customer.paymentNetworkError'));
            setStripeReady(true);
          });
          return;
        }
        const pk = typeof data.publishableKey === 'string' ? data.publishableKey.trim() : '';
        if (!pk) {
          window.clearTimeout(timer);
          finishBoot(() => {
            setStripeBootError(t('customer.stripeNotConfigured'));
            setStripeReady(true);
          });
          return;
        }
        const stripe = await loadStripe(pk);
        if (cancelled) return;
        if (!stripe) {
          window.clearTimeout(timer);
          finishBoot(() => {
            setStripeBootError(t('customer.stripeJsLoadFailed'));
            setStripeReady(true);
          });
          return;
        }
        window.clearTimeout(timer);
        finishBoot(() => {
          setStripePromiseForElements(Promise.resolve(stripe));
          setStripeReady(true);
        });
      } catch {
        if (cancelled) return;
        window.clearTimeout(timer);
        finishBoot(() => {
          setStripeBootError(t('customer.paymentNetworkError'));
          setStripeReady(true);
        });
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [t]);

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#fff', borderRadius: '16px 16px 0 0',
        width: '100%', maxWidth: 430, padding: '24px 20px 32px',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>💳 {t('customer.payment')}</div>
        </div>

        {!stripeReady && (
          <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-light)' }}>{t('customer.paymentLoading')}</div>
        )}
        {stripeReady && stripeBootError && (
          <div style={{ textAlign: 'center', padding: '12px 8px' }}>
            <PaymentErrorBlock message={stripeBootError} />
            <button onClick={onClose} className="btn btn-outline" style={{ padding: '10px 24px' }}>
              {t('customer.payAtCounter')}
            </button>
          </div>
        )}
        {stripeReady && !stripeBootError && stripePromiseForElements && (
          <Elements stripe={stripePromiseForElements}>
            <PaymentContent orderId={orderId} orderIds={orderIds} amount={amount} onSuccess={onSuccess} onClose={onClose} />
          </Elements>
        )}
      </div>
    </div>
  );
}
