import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentRequestButtonElement, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { apiFetch, memberApiFetch } from '../../api/client';

type Props = {
  storeSlug: string;
  memberToken: string;
  amountEuro: number;
  onSuccess: (creditBalance: number) => void;
  onClose: () => void;
};

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

function TopUpPaymentContent({ storeSlug, memberToken, amountEuro, onSuccess, onClose }: Props) {
  const { t, i18n } = useTranslation();
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

  const confirmTopUp = useCallback(
    async (paymentIntentId: string) => {
      const res = await memberApiFetch(storeSlug, memberToken, '/api/members/me/wallet/stripe-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentIntentId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: { message?: string } }).error?.message || t('customer.paymentConfirmFailed'));
        return false;
      }
      const bal = (data as { creditBalance?: number }).creditBalance;
      if (typeof bal === 'number' && Number.isFinite(bal)) {
        setSuccess(true);
        setTimeout(() => onSuccess(bal), 800);
        return true;
      }
      setError(t('customer.paymentConfirmFailed'));
      return false;
    },
    [storeSlug, memberToken, t, onSuccess],
  );

  useEffect(() => {
    apiFetch('/api/admin/config')
      .then((r) => (r.ok ? r.json() : {}))
      .then((c: Record<string, string>) => {
        const lang = i18n.language || '';
        const zh = (c.restaurant_name_zh || '').trim();
        const en = (c.restaurant_name_en || '').trim();
        if (lang.startsWith('zh')) {
          setRestaurantLabel(zh || en || 'Restaurant');
        } else {
          setRestaurantLabel(en || zh || 'Restaurant');
        }
      })
      .catch(() => {});
  }, [i18n.language]);

  useEffect(() => {
    let cancelled = false;
    const intentTimer = window.setTimeout(() => {
      if (cancelled) return;
      setError(t('customer.paymentIntentFailed'));
      setIntentLoading(false);
    }, 35000);
    (async () => {
      try {
        const res = await memberApiFetch(storeSlug, memberToken, '/api/members/me/wallet/stripe-create-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amountEuro }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError((data as { error?: { message?: string } }).error?.message || t('customer.paymentIntentFailed'));
          return;
        }
        if (data.clientSecret) setClientSecret(data.clientSecret as string);
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
  }, [storeSlug, memberToken, amountEuro, t]);

  useEffect(() => {
    if (!stripe || !clientSecret) return;

    const pr = stripe.paymentRequest({
      country: 'IE',
      currency: 'eur',
      total: { label: restaurantLabel, amount: Math.round(amountEuro * 100) },
      requestPayerName: false,
      requestPayerEmail: false,
    });

    pr.canMakePayment().then((result) => {
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
        { handleActions: false },
      );

      if (confirmError) {
        ev.complete('fail');
        setError(confirmError.message || t('customer.paymentIntentFailed'));
        setProcessing(false);
      } else if (paymentIntent?.id) {
        ev.complete('success');
        await confirmTopUp(paymentIntent.id);
        setProcessing(false);
      }
    });
  }, [stripe, clientSecret, amountEuro, restaurantLabel, confirmTopUp, t]);

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

    if (paymentIntent?.status === 'succeeded' && paymentIntent.id) {
      await confirmTopUp(paymentIntent.id);
    }
    setProcessing(false);
  };

  if (success) {
    return (
      <div style={{ textAlign: 'center', padding: 40 }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#388E3C' }}>{t('member.topUpSuccess')}</div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--red-primary)', fontFamily: "'Noto Serif SC', serif" }}>
          €{amountEuro.toFixed(2)}
        </div>
      </div>

      {error && <PaymentErrorBlock message={error} />}

      {intentLoading && !error && !clientSecret && (
        <div style={{ textAlign: 'center', padding: 12, color: 'var(--text-light)' }}>{t('customer.paymentPreparingSession')}</div>
      )}

      {canPay && paymentRequest && (
        <div style={{ marginBottom: 16 }}>
          <PaymentRequestButtonElement options={{ paymentRequest, style: { paymentRequestButton: { height: '48px' } } }} />
          <div style={{ textAlign: 'center', margin: '12px 0', fontSize: 12, color: 'var(--text-light)' }}>— or —</div>
        </div>
      )}

      {clientSecret && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ padding: '12px 14px', border: '1px solid #ddd', borderRadius: 8, background: '#fafafa' }}>
            <CardElement
              options={{
                style: {
                  base: { fontSize: '16px', color: '#333', '::placeholder': { color: '#aab7c4' } },
                  invalid: { color: '#F44336' },
                },
              }}
            />
          </div>
          <button
            type="button"
            onClick={handleCardPay}
            disabled={processing || !stripe}
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 12, padding: '14px 0', fontSize: 15 }}
          >
            {processing ? t('customer.paymentProcessing') : `${t('member.topUpPay')} €${amountEuro.toFixed(2)}`}
          </button>
        </div>
      )}

      <div style={{ textAlign: 'center', marginTop: 8 }}>
        <button type="button" onClick={onClose} className="btn btn-outline" style={{ padding: '10px 24px' }}>
          {t('common.cancel', '取消')}
        </button>
      </div>
    </div>
  );
}

const STRIPE_BOOT_TIMEOUT_MS = 28000;

export default function MemberTopUpPaymentModal(props: Props) {
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
    <div
      role="presentation"
      onClick={props.onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="member-topup-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: '16px 16px 0 0',
          width: '100%',
          maxWidth: 430,
          padding: '24px 20px 32px',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <h2 id="member-topup-title" style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>
            💳 {t('member.topUpTitle')}
          </h2>
        </div>

        {!stripeReady && (
          <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-light)' }}>{t('customer.paymentLoading')}</div>
        )}
        {stripeReady && stripeBootError && (
          <div style={{ textAlign: 'center', padding: '12px 8px' }}>
            <PaymentErrorBlock message={stripeBootError} />
            <button type="button" onClick={props.onClose} className="btn btn-outline" style={{ padding: '10px 24px' }}>
              {t('common.cancel')}
            </button>
          </div>
        )}
        {stripeReady && !stripeBootError && stripePromiseForElements && (
          <Elements stripe={stripePromiseForElements}>
            <TopUpPaymentContent {...props} />
          </Elements>
        )}
      </div>
    </div>
  );
}
