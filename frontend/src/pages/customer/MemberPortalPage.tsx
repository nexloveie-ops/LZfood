import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { apiFetch, memberApiFetch } from '../../api/client';
import MemberTopUpPaymentModal from '../../components/customer/MemberTopUpPaymentModal';
import LanguageSwitcher from '../../components/LanguageSwitcher';
import { translateMemberWalletTxnNote } from '../../utils/memberTxnNoteI18n';
import { formatMemberApiError, translateMemberApiMessage } from '../../utils/memberApiErrorI18n';
import { useBusinessStatus } from '../../hooks/useBusinessStatus';
import './member-portal.css';

const TOKEN_KEY = (slug: string) => `lzfood_member_${slug}`;

const TOPUP_PRESETS = [10, 20, 50, 100] as const;
const TOPUP_MIN = 1;
const TOPUP_MAX = 500;

type MemberProfile = {
  _id: string;
  memberNo: number;
  phone: string;
  displayName: string;
  deliveryAddress?: string;
  postalCode?: string;
  creditBalance: number;
  stampCount?: number;
  stampRedeemAt?: number;
};

const TXN_PAGE_SIZE = 10;

type TxnStore = { slug: string; displayName: string };

type Txn = {
  _id: string;
  type: string;
  amountEuro: number;
  balanceBefore: number;
  balanceAfter: number;
  note?: string;
  createdAt: string;
  orderId?: string;
  checkoutId?: string;
  stripePaymentIntentId?: string;
  operatorAdminId?: string;
  store?: TxnStore | null;
};

function idStr(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && '_id' in v) return idStr((v as { _id: unknown })._id);
  return String(v);
}

type TxnDetailLine = {
  itemName: string;
  quantity: number;
  lineEuro: number;
  refunded?: boolean;
  optionsSummary?: string;
  lineKind?: string;
};

type TxnDetailBundle = {
  name: string;
  nameEn?: string;
  discountEuro: number;
};

function TxnDetailModal({
  txn,
  storeSlug,
  token,
  onClose,
}: {
  txn: Txn;
  storeSlug: string;
  token: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [lines, setLines] = useState<TxnDetailLine[] | null>(null);
  const [bundles, setBundles] = useState<TxnDetailBundle[]>([]);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailErr, setDetailErr] = useState('');
  const [store, setStore] = useState<TxnStore | null>(txn.store ?? null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setDetailLoading(true);
      setDetailErr('');
      setLines(null);
      setBundles([]);
      setStore(txn.store ?? null);
      try {
        const r = await memberApiFetch(storeSlug, token, `/api/members/me/transactions/${txn._id}/detail`);
        const d = (await r.json().catch(() => null)) as {
          lines?: TxnDetailLine[];
          bundles?: TxnDetailBundle[];
          store?: TxnStore | null;
          error?: { message?: string };
        } | null;
        if (cancelled) return;
        if (!r.ok) {
          setDetailErr(d?.error?.message || `HTTP ${r.status}`);
          setLines([]);
          return;
        }
        setLines(Array.isArray(d?.lines) ? d.lines : []);
        setBundles(Array.isArray(d?.bundles) ? d.bundles : []);
        if (d?.store?.displayName || d?.store?.slug) setStore(d.store);
      } catch {
        if (!cancelled) {
          setDetailErr(t('member.txnDetailLoadError', '明细加载失败'));
          setLines([]);
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [storeSlug, token, txn._id, txn.store, t]);

  const headlineKey = `member.txnDetailHeadlines.${txn.type}`;
  let headline = t(headlineKey);
  if (headline === headlineKey) headline = t('member.txnDetailTitle', '流水详情');
  const typeLabelKey = `member.txnTypeLabels.${txn.type}`;
  let typeLabel = t(typeLabelKey);
  if (typeLabel === typeLabelKey) typeLabel = txn.type;
  const stripeRef = txn.stripePaymentIntentId?.trim();
  const opId = idStr(txn.operatorAdminId);
  const storeLabel = (store?.displayName || store?.slug || '').trim();

  let linesSectionTitle: string;
  if (txn.type === 'refund_credit') linesSectionTitle = t('member.txnDetailLinesRefund');
  else if (txn.type === 'reversal') linesSectionTitle = t('member.txnDetailLinesReversal');
  else if (txn.type === 'spend') linesSectionTitle = t('member.txnDetailLinesSpend');
  else linesSectionTitle = t('member.txnDetailLinesOther');

  const bundleLabel = (b: TxnDetailBundle) => {
    const lang = (i18n.language || '').toLowerCase();
    if (lang.startsWith('en') && b.nameEn?.trim()) return b.nameEn.trim();
    return b.name;
  };

  const linesBlock: ReactNode = (() => {
    if (detailLoading) {
      return <div className="mp-loading">{t('member.txnLoading')}</div>;
    }
    if (detailErr) {
      return <div className="mp-alert mp-alert-error">{detailErr}</div>;
    }
    const hasLines = lines && lines.length > 0;
    const hasBundles = bundles.length > 0;
    if (!hasLines && !hasBundles) {
      if (txn.type === 'spend' || txn.type === 'refund_credit' || txn.type === 'reversal') {
        return <div className="mp-acc-preview">{t('member.txnDetailLinesEmpty')}</div>;
      }
      return null;
    }
    return (
      <div className="mp-lines">
        <div className="mp-kv-block-k">{linesSectionTitle}</div>
        {hasLines ? (
          <ul>
            {lines!.map((line, i) => (
              <li key={i}>
                <span>
                  {line.itemName}
                  {line.optionsSummary ? <span className="mp-line-opt"> · {line.optionsSummary}</span> : null}
                  {line.refunded ? <span className="mp-tag">({t('member.txnDetailRefundedTag')})</span> : null}
                </span>
                <span>
                  ×{line.quantity} · €{Number(line.lineEuro).toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {hasBundles ? (
          <div style={{ marginTop: hasLines ? 10 : 0 }}>
            <div className="mp-kv-block-k">{t('member.txnDetailBundlesTitle')}</div>
            <ul>
              {bundles.map((b, i) => (
                <li key={i}>
                  <span>{bundleLabel(b)}</span>
                  <span className="mp-bundle-off">{t('member.txnDetailBundleOff', { amount: Number(b.discountEuro).toFixed(2) })}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
  })();

  return (
    <div
      className="mp-modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="mp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mp-modal-title">{headline}</div>
        <div className="mp-modal-sub">{typeLabel}</div>

        {storeLabel ? (
          <div className="mp-kv">
            <span>{t('member.txnFieldStore')}</span>
            <span>{storeLabel}</span>
          </div>
        ) : null}
        <div className="mp-kv">
          <span>{t('member.txnFieldAmount')}</span>
          <span className={`mp-kv-amt ${txn.amountEuro < 0 ? 'is-out' : 'is-in'}`}>
            {txn.amountEuro >= 0 ? '+' : ''}€{Number(txn.amountEuro).toFixed(2)}
          </span>
        </div>
        <div className="mp-kv">
          <span>{t('member.txnFieldBalanceBefore')}</span>
          <span>€{Number(txn.balanceBefore).toFixed(2)}</span>
        </div>
        <div className="mp-kv">
          <span>{t('member.txnFieldBalanceAfter')}</span>
          <span>€{Number(txn.balanceAfter).toFixed(2)}</span>
        </div>
        <div className="mp-kv">
          <span>{t('member.txnFieldTime')}</span>
          <span>{new Date(txn.createdAt).toLocaleString()}</span>
        </div>
        {txn.note ? (
          <div className="mp-kv-block">
            <div className="mp-kv-block-k">{t('member.txnFieldNote')}</div>
            <div className="mp-kv-block-v">{translateMemberWalletTxnNote(txn.note, t)}</div>
          </div>
        ) : null}
        {linesBlock}
        {txn.type === 'recharge' && stripeRef ? (
          <div className="mp-kv-block">
            <div className="mp-kv-block-k">{t('member.txnFieldStripeRef')}</div>
            <div className="mp-mono">{stripeRef}</div>
          </div>
        ) : null}
        {txn.type === 'adjustment' && opId ? (
          <div className="mp-kv-block">
            <div className="mp-kv-block-k">{t('member.txnFieldOperator', '操作员 ID')}</div>
            <div className="mp-mono">{opId}</div>
          </div>
        ) : null}

        <button type="button" className="mp-btn mp-btn-primary" style={{ marginTop: 16 }} onClick={onClose}>
          {t('member.txnDetailClose')}
        </button>
      </div>
    </div>
  );
}

export default function MemberPortalPage() {
  const { storeSlug = '' } = useParams<{ storeSlug: string }>();
  const navigate = useNavigate();
  const { loading: bizCapsLoading, memberWalletEnabled } = useBusinessStatus();
  const { t } = useTranslation();

  useEffect(() => {
    if (bizCapsLoading) return;
    if (memberWalletEnabled === false) {
      navigate(`/${storeSlug}`, { replace: true });
    }
  }, [bizCapsLoading, memberWalletEnabled, navigate, storeSlug]);

  if (!bizCapsLoading && memberWalletEnabled === false) {
    return null;
  }
  const [token, setToken] = useState<string | null>(() =>
    storeSlug ? sessionStorage.getItem(TOKEN_KEY(storeSlug)) : null,
  );
  const [view, setView] = useState<'login' | 'register' | 'home'>(() => 'login');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [txnPage, setTxnPage] = useState(1);
  const [txnTotal, setTxnTotal] = useState(0);
  const [txnLoading, setTxnLoading] = useState(false);
  const [detailTxn, setDetailTxn] = useState<Txn | null>(null);
  const [txnLoadError, setTxnLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pinResetLoading, setPinResetLoading] = useState(false);
  const [pinResetNotice, setPinResetNotice] = useState('');
  const [editName, setEditName] = useState('');
  const [editPostalCode, setEditPostalCode] = useState('');
  const [editDeliveryAddress, setEditDeliveryAddress] = useState('');
  const [oldPin, setOldPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [addressGeoLoading, setAddressGeoLoading] = useState(false);
  const [addressGeoError, setAddressGeoError] = useState('');
  const eircodeReqRef = useRef(0);
  /** 仅用户编辑邮编后再请求地理接口，避免登录载入时用短地址覆盖已保存的详细地址 */
  const postalEditedByUserRef = useRef(false);
  const [topUpDraft, setTopUpDraft] = useState('20');
  const [topUpModalOpen, setTopUpModalOpen] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState(20);
  const [profileExpanded, setProfileExpanded] = useState(false);
  const [topUpExpanded, setTopUpExpanded] = useState(false);
  const [cardCodeInput, setCardCodeInput] = useState('');
  const [cardPinInput, setCardPinInput] = useState('');
  const [cardRedeemBusy, setCardRedeemBusy] = useState(false);
  const [walletHint, setWalletHint] = useState('');
  const [appleWalletAvailable, setAppleWalletAvailable] = useState(false);
  const [appleWalletBusy, setAppleWalletBusy] = useState(false);

  const authFetch = useMemo(
    () => (path: string, init?: RequestInit) => memberApiFetch(storeSlug, token, path, init),
    [storeSlug, token],
  );

  const loadMe = useCallback(async () => {
    if (!token) return;
    const r = await authFetch('/api/members/me');
    if (!r.ok) {
      setToken(null);
      sessionStorage.removeItem(TOKEN_KEY(storeSlug));
      setView('login');
      setAppleWalletAvailable(false);
      return;
    }
    const p = (await r.json()) as MemberProfile;
    setProfile(p);
    setEditName(p.displayName || '');
    setEditPostalCode(p.postalCode || '');
    setEditDeliveryAddress(p.deliveryAddress || '');
    postalEditedByUserRef.current = false;
    try {
      const wr = await authFetch('/api/members/me/apple-wallet');
      if (wr.ok) {
        const w = (await wr.json()) as { available?: boolean };
        setAppleWalletAvailable(!!w.available);
      } else {
        setAppleWalletAvailable(false);
      }
    } catch {
      setAppleWalletAvailable(false);
    }
  }, [authFetch, token, storeSlug]);

  const addToAppleWallet = async () => {
    setAppleWalletBusy(true);
    setError('');
    try {
      const r = await authFetch('/api/members/me/apple-wallet-pass');
      if (!r.ok) {
        setError(t('member.addToAppleWalletError', '无法生成会员卡'));
        return;
      }
      const raw = await r.arrayBuffer();
      const blob = new Blob([raw], { type: 'application/vnd.apple.pkpass' });
      const url = URL.createObjectURL(blob);
      // iOS Safari 对 application/vnd.apple.pkpass 会唤起「添加到钱包」
      const a = document.createElement('a');
      a.href = url;
      a.download = 'lzfood-membership.pkpass';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setError(t('member.addToAppleWalletError', '无法生成会员卡'));
    } finally {
      setAppleWalletBusy(false);
    }
  };

  const loadTxns = useCallback(
    async (page: number) => {
      if (!token) return;
      setTxnLoading(true);
      setTxnLoadError('');
      try {
        const r = await authFetch(`/api/members/me/transactions?page=${page}&pageSize=${TXN_PAGE_SIZE}`);
        const d = (await r.json().catch(() => null)) as unknown;
        if (r.ok) {
          /** 旧后端只返回数组；新后端返回 { items, total, page } */
          if (Array.isArray(d)) {
            const list = d as Txn[];
            const total = list.length;
            const start = (page - 1) * TXN_PAGE_SIZE;
            setTxns(list.slice(start, start + TXN_PAGE_SIZE));
            setTxnTotal(total);
            setTxnPage(page);
          } else if (d && typeof d === 'object' && Array.isArray((d as { items?: unknown }).items)) {
            const o = d as { items: Txn[]; total?: number; page?: number };
            setTxns(o.items);
            setTxnTotal(Number(o.total) || 0);
            setTxnPage(Number(o.page) || page);
          } else {
            setTxns([]);
            setTxnTotal(0);
            setTxnPage(page);
          }
        } else {
          setTxns([]);
          setTxnTotal(0);
          const err = d as { error?: { message?: string } } | null;
          setTxnLoadError(err?.error?.message || `HTTP ${r.status}`);
        }
      } catch {
        setTxns([]);
        setTxnTotal(0);
        setTxnLoadError(t('member.txnLoadNetworkError', '加载流水失败'));
      } finally {
        setTxnLoading(false);
      }
    },
    [authFetch, token, t],
  );

  const handleTopUpSuccess = useCallback(
    (creditBalance: number) => {
      setProfile((p) => (p ? { ...p, creditBalance } : null));
      setTopUpModalOpen(false);
      void loadTxns(1);
    },
    [loadTxns],
  );

  const redeemTopUpCard = async () => {
    if (!token) return;
    const code = cardCodeInput.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const pin = cardPinInput.trim();
    if (code.length !== 6 || !/^\d{6}$/.test(pin)) {
      setWalletHint('');
      setError(t('member.topUpCardHint'));
      return;
    }
    setCardRedeemBusy(true);
    setError('');
    setWalletHint('');
    try {
      const r = await authFetch('/api/members/me/wallet/redeem-topup-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardCode: code, pin, storeSlug }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(formatMemberApiError(r.status, d, storeSlug, r.statusText, t));
      }
      const bal = Number((d as { creditBalance?: number }).creditBalance);
      const credited = Number((d as { creditedEuro?: number }).creditedEuro);
      setProfile((p) => (p ? { ...p, creditBalance: bal } : null));
      setCardCodeInput('');
      setCardPinInput('');
      setWalletHint(
        t('member.topUpCardSuccess', {
          amount: Number.isFinite(credited) ? credited.toFixed(2) : '',
          balance: Number.isFinite(bal) ? bal.toFixed(2) : '',
        }),
      );
      void loadTxns(1);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('member.apiErrors.requestFailed'));
    } finally {
      setCardRedeemBusy(false);
    }
  };

  const openTopUpModal = () => {
    const n = Number.parseFloat(String(topUpDraft).replace(',', '.'));
    if (!Number.isFinite(n)) {
      setError(t('member.topUpInvalidAmount'));
      return;
    }
    const r = Math.round(n * 100) / 100;
    if (r < TOPUP_MIN || r > TOPUP_MAX) {
      setError(t('member.topUpRangeHint', { min: TOPUP_MIN, max: TOPUP_MAX }));
      return;
    }
    setError('');
    setTopUpAmount(r);
    setTopUpModalOpen(true);
  };

  const lookupEircodeForAddress = useCallback(
    async (raw: string) => {
      const norm = raw.toUpperCase().replace(/[\s-]/g, '');
      if (norm.length !== 7 || !/^[A-Z][0-9][0-9W][0-9A-Z]{4}$/.test(norm)) {
        setAddressGeoLoading(false);
        setAddressGeoError('');
        return;
      }
      const id = ++eircodeReqRef.current;
      setAddressGeoLoading(true);
      setAddressGeoError('');
      try {
        const codeParam = `${norm.slice(0, 3)} ${norm.slice(3)}`;
        const res = await apiFetch(`/api/geo/customer-eircode?code=${encodeURIComponent(codeParam)}`);
        const data = (await res.json().catch(() => null)) as { formattedAddress?: string; error?: { message?: string } } | null;
        if (id !== eircodeReqRef.current) return;
        if (!res.ok) {
          const msg = data?.error?.message || `HTTP ${res.status}`;
          throw new Error(msg);
        }
        const line = (data?.formattedAddress || '').trim();
        if (line) setEditDeliveryAddress(line);
      } catch (e) {
        if (id !== eircodeReqRef.current) return;
        setAddressGeoError(e instanceof Error ? e.message : t('member.addressLookupFailed', '地址解析失败'));
      } finally {
        if (id === eircodeReqRef.current) setAddressGeoLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    if (!profile || view !== 'home' || !postalEditedByUserRef.current) return;
    const tmr = window.setTimeout(() => {
      void lookupEircodeForAddress(editPostalCode);
    }, 500);
    return () => window.clearTimeout(tmr);
  }, [editPostalCode, profile, view, lookupEircodeForAddress]);

  useEffect(() => {
    if (token) {
      setView('home');
      loadMe();
      loadTxns(1);
    }
  }, [token, loadMe, loadTxns]);

  const handleLogin = async () => {
    setLoading(true);
    setError('');
    setPinResetNotice('');
    try {
      const r = await memberApiFetch(storeSlug, null, '/api/members/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, pin, storeSlug }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(formatMemberApiError(r.status, d, storeSlug, r.statusText, t));
      const tk = d.token as string;
      sessionStorage.setItem(TOKEN_KEY(storeSlug), tk);
      setToken(tk);
      const m = d.member as MemberProfile | undefined;
      setProfile(m ?? null);
      setEditName(m?.displayName || '');
      setEditPostalCode(m?.postalCode || '');
      setEditDeliveryAddress(m?.deliveryAddress || '');
      postalEditedByUserRef.current = false;
      setView('home');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('member.apiErrors.requestFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleRequestPinReset = async () => {
    setError('');
    setPinResetNotice('');
    if (!phone.trim()) {
      setError(t('member.forgotPinNeedPhone', '请先输入手机号'));
      return;
    }
    if (!storeSlug) return;
    setPinResetLoading(true);
    try {
      const r = await memberApiFetch(storeSlug, null, '/api/members/request-pin-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, storeSlug }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: { code?: string; message?: string };
      };
      if (!r.ok) throw new Error(formatMemberApiError(r.status, d, storeSlug, r.statusText, t));
      setPinResetNotice(
        typeof d?.message === 'string' && d.message.trim()
          ? translateMemberApiMessage(d.message.trim(), t) || t('member.forgotPinSuccess')
          : t('member.forgotPinSuccess'),
      );
      setPin('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('member.apiErrors.requestFailed'));
    } finally {
      setPinResetLoading(false);
    }
  };

  const handleRegister = async () => {
    if (pin !== pin2) {
      setError(t('member.pinMismatch', '两次 PIN 不一致'));
      return;
    }
    setLoading(true);
    setError('');
    setPinResetNotice('');
    try {
      const r = await memberApiFetch(storeSlug, null, '/api/members/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, pin, displayName, storeSlug }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(formatMemberApiError(r.status, d, storeSlug, r.statusText, t));
      const tk = d.token as string;
      sessionStorage.setItem(TOKEN_KEY(storeSlug), tk);
      setToken(tk);
      const m = d.member as MemberProfile | undefined;
      setProfile(m ?? null);
      setEditName(m?.displayName || '');
      setEditPostalCode(m?.postalCode || '');
      setEditDeliveryAddress(m?.deliveryAddress || '');
      postalEditedByUserRef.current = false;
      setView('home');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('member.apiErrors.requestFailed'));
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    sessionStorage.removeItem(TOKEN_KEY(storeSlug));
    setToken(null);
    setProfile(null);
    setTxns([]);
    setTxnPage(1);
    setTxnTotal(0);
    setDetailTxn(null);
    setTxnLoadError('');
    setView('login');
    postalEditedByUserRef.current = false;
    setAddressGeoError('');
    setAddressGeoLoading(false);
    setPinResetNotice('');
    setPinResetLoading(false);
    eircodeReqRef.current++;
  };

  const saveProfile = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await authFetch('/api/members/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: editName,
          deliveryAddress: editDeliveryAddress,
          postalCode: editPostalCode,
          storeSlug,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(formatMemberApiError(r.status, d, storeSlug, r.statusText, t));
      setProfile(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('member.apiErrors.requestFailed'));
    } finally {
      setLoading(false);
    }
  };

  const changePin = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await authFetch('/api/members/me/change-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPin, newPin, storeSlug }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(formatMemberApiError(r.status, d, storeSlug, r.statusText, t));
      setOldPin('');
      setNewPin('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('member.apiErrors.requestFailed'));
    } finally {
      setLoading(false);
    }
  };

  if (view === 'home' && profile) {
    return (
      <div className="order-status-page mp-shell">
        <div className="order-status-scroll">
      <div className="mp-page">
        <div className="mp-top">
          <Link to={`/${storeSlug}`} className="mp-back">{t('member.backStore', '返回店铺')}</Link>
          <div className="mp-top-actions">
            <LanguageSwitcher variant="text" />
            <button type="button" className="mp-btn mp-btn-ghost" onClick={logout}>
              {t('member.logout')}
            </button>
          </div>
        </div>
        <div className="mp-wallet">
          <div className="mp-wallet-meta">
            <span className="mp-wallet-no">#{profile.memberNo}</span>
            <span className="mp-wallet-phone">{profile.phone}</span>
          </div>
          <div className="mp-wallet-row">
            <div>
              <div className="mp-wallet-k">{t('member.balance', '储值余额')}</div>
              <div className="mp-wallet-bal">€{Number(profile.creditBalance).toFixed(2)}</div>
            </div>
            <div className="mp-wallet-stamps">
              <div className="mp-wallet-k">{t('member.stamps', '印花')}</div>
              <div className="mp-wallet-stamp-row">
                <img className="mp-wallet-stamp-img" src="/stamps/duck.jpg" alt="" />
                <div className="mp-wallet-stamp-val">
                  {t('member.stampsProgress', '{{count}} / {{goal}}', {
                    count: Math.max(0, Math.floor(Number(profile.stampCount) || 0)),
                    goal: Math.max(1, Math.floor(Number(profile.stampRedeemAt) || 9)),
                  })}
                </div>
              </div>
            </div>
          </div>
          {appleWalletAvailable ? (
            <div style={{ marginTop: 14 }}>
              <button
                type="button"
                className="mp-btn mp-btn-primary"
                style={{ width: '100%' }}
                disabled={appleWalletBusy}
                onClick={() => void addToAppleWallet()}
              >
                {appleWalletBusy ? '…' : t('member.addToAppleWallet', '加入 Apple 钱包')}
              </button>
              <p className="mp-hint" style={{ marginTop: 8, marginBottom: 0 }}>
                {t('member.addToAppleWalletHint')}
              </p>
            </div>
          ) : null}
        </div>

        {walletHint ? <div className="mp-alert mp-alert-ok">{walletHint}</div> : null}
        {error ? <div className="mp-alert mp-alert-error">{error}</div> : null}

        <div className="mp-card">
          <button
            type="button"
            className="mp-acc-hd"
            onClick={() => setProfileExpanded((v) => !v)}
            aria-expanded={profileExpanded}
          >
            <span className="mp-acc-title">{t('member.profileSection', '资料与送餐')}</span>
            <span className="mp-chevron" aria-hidden />
          </button>
          {!profileExpanded ? (
            <div className="mp-acc-preview">
              <span className="mp-acc-preview-k">{t('member.deliveryAddress', '送餐地址')}</span>
              {editDeliveryAddress.trim()
                ? editDeliveryAddress.trim()
                : t('member.deliveryAddressCollapsedEmpty')}
            </div>
          ) : (
            <div className="mp-acc-body">
              <p className="mp-hint" style={{ marginTop: 0 }}>{t('member.deliveryHint', '填写默认送餐邮编与地址，便于店内识别；扫码下单时仍可在购物车中修改。')}</p>
              <label className="mp-field">
                <span className="mp-label">{t('member.editName', '称呼')}</span>
                <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} />
              </label>
              <label className="mp-field">
                <span className="mp-label">{t('member.postalCode', '邮编')}</span>
                <input
                  className="input"
                  value={editPostalCode}
                  onChange={(e) => {
                    postalEditedByUserRef.current = true;
                    setEditPostalCode(e.target.value);
                  }}
                  placeholder={t('member.postalCodePlaceholder', '如爱尔兰 Eircode')}
                  autoCapitalize="characters"
                />
              </label>
              {addressGeoLoading ? (
                <div className="mp-hint">{t('member.addressGeoLoading', '正在根据邮编解析地址…')}</div>
              ) : null}
              {addressGeoError ? (
                <div className="mp-alert mp-alert-error">{addressGeoError}</div>
              ) : null}
              <label className="mp-field">
                <span className="mp-label">{t('member.deliveryAddress', '送餐地址')}</span>
                <textarea
                  className="input"
                  value={editDeliveryAddress}
                  onChange={(e) => setEditDeliveryAddress(e.target.value)}
                  placeholder={t('member.deliveryAddressPlaceholder', '门牌号、街道、区域等')}
                  rows={3}
                />
              </label>
              <button type="button" className="mp-btn mp-btn-primary" disabled={loading} onClick={saveProfile}>
                {t('common.save', '保存')}
              </button>

              <div className="mp-split">
                <div className="mp-split-title">{t('member.changePin', '修改 PIN')}</div>
                <p className="mp-hint">{t('member.changePinInProfileHint')}</p>
                <input
                  className="input"
                  type="password"
                  inputMode="numeric"
                  placeholder={t('member.oldPin', '原 PIN')}
                  value={oldPin}
                  onChange={(e) => setOldPin(e.target.value)}
                  style={{ marginBottom: 8 }}
                />
                <input
                  className="input"
                  type="password"
                  inputMode="numeric"
                  placeholder={t('member.newPin', '新 PIN')}
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value)}
                  style={{ marginBottom: 10 }}
                />
                <button type="button" className="mp-btn mp-btn-secondary" disabled={loading} onClick={changePin}>
                  {t('member.changePinSubmit', '更新 PIN')}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="mp-card">
          <button
            type="button"
            className="mp-acc-hd"
            onClick={() => setTopUpExpanded((v) => !v)}
            aria-expanded={topUpExpanded}
          >
            <span className="mp-acc-title">{t('member.topUpSection')}</span>
            <span className="mp-chevron" aria-hidden />
          </button>
          {!topUpExpanded ? (
            <div className="mp-acc-preview">
              {t('member.topUpCollapsedHint', { min: TOPUP_MIN, max: TOPUP_MAX })}
            </div>
          ) : (
            <div className="mp-acc-body">
              <p className="mp-hint" style={{ marginTop: 0 }}>{t('member.topUpHint', { min: TOPUP_MIN, max: TOPUP_MAX })}</p>
              <div className="mp-chips">
                {TOPUP_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`mp-chip${topUpDraft === String(p) ? ' is-on' : ''}`}
                    onClick={() => setTopUpDraft(String(p))}
                  >
                    €{p}
                  </button>
                ))}
              </div>
              <label className="mp-field">
                <span className="mp-label">{t('member.topUpCustom')}</span>
                <input
                  className="input"
                  type="number"
                  inputMode="decimal"
                  min={TOPUP_MIN}
                  max={TOPUP_MAX}
                  step="0.01"
                  value={topUpDraft}
                  onChange={(e) => setTopUpDraft(e.target.value)}
                />
              </label>
              <button type="button" className="mp-btn mp-btn-primary" onClick={openTopUpModal}>
                {t('member.topUpOpen')}
              </button>

              <div className="mp-split">
                <div className="mp-split-title">{t('member.topUpCardSection')}</div>
                <p className="mp-hint">{t('member.topUpCardHint')}</p>
                <label className="mp-field">
                  <span className="mp-label">{t('member.topUpCardCode')}</span>
                  <input
                    className="input mp-mono"
                    value={cardCodeInput}
                    onChange={(e) => setCardCodeInput(e.target.value.toUpperCase())}
                    maxLength={12}
                    autoCapitalize="characters"
                    style={{ letterSpacing: '0.08em' }}
                  />
                </label>
                <label className="mp-field">
                  <span className="mp-label">{t('member.topUpCardPin')}</span>
                  <input
                    className="input"
                    type="password"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={cardPinInput}
                    onChange={(e) => setCardPinInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    maxLength={6}
                  />
                </label>
                <button
                  type="button"
                  className="mp-btn mp-btn-secondary"
                  disabled={cardRedeemBusy}
                  onClick={() => void redeemTopUpCard()}
                >
                  {cardRedeemBusy ? t('common.loading') : t('member.topUpCardSubmit')}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="mp-section-hd">
          <h2>{t('member.txnHistory', '流水')}</h2>
          <span>{t('member.txnTapForDetail')}</span>
        </div>
        {txnLoadError ? <div className="mp-alert mp-alert-error">{txnLoadError}</div> : null}
        <div className="mp-card mp-card--flush">
          {txnLoading && txns.length === 0 ? (
            <div className="mp-loading">{t('member.txnLoading')}</div>
          ) : txns.length === 0 ? (
            <div className="mp-empty">{t('member.noTxns', '暂无记录')}</div>
          ) : (
            txns.map((x) => {
              const tlKey = `member.txnTypeLabels.${x.type}`;
              let typeShort = t(tlKey);
              if (typeShort === tlKey) typeShort = x.type;
              return (
                <button
                  key={x._id}
                  type="button"
                  className="mp-txn"
                  onClick={() => setDetailTxn(x)}
                >
                  <div>
                    <div className="mp-txn-type">{typeShort}</div>
                    <div className="mp-txn-meta">
                      {x.store?.displayName || x.store?.slug
                        ? `${x.store.displayName || x.store.slug} · `
                        : ''}
                      {new Date(x.createdAt).toLocaleString()} · {t('member.balance')} €{x.balanceAfter.toFixed(2)}
                    </div>
                    {x.note ? (
                      <div className="mp-txn-note">{translateMemberWalletTxnNote(x.note, t)}</div>
                    ) : null}
                  </div>
                  <span className={`mp-txn-amt ${x.amountEuro < 0 ? 'is-out' : 'is-in'}`}>
                    {x.amountEuro >= 0 ? '+' : ''}€{x.amountEuro.toFixed(2)}
                  </span>
                </button>
              );
            })
          )}
        </div>
        {txnTotal > 0 ? (
          <div className="mp-pager">
            <button
              type="button"
              className="mp-btn mp-btn-secondary"
              disabled={txnPage <= 1 || txnLoading}
              onClick={() => void loadTxns(txnPage - 1)}
            >
              {t('member.txnPagePrev')}
            </button>
            <span className="mp-pager-info">
              {t('member.txnPageInfo', {
                page: txnPage,
                pages: Math.max(1, Math.ceil(txnTotal / TXN_PAGE_SIZE)),
                total: txnTotal,
              })}
            </span>
            <button
              type="button"
              className="mp-btn mp-btn-secondary"
              disabled={txnPage >= Math.ceil(txnTotal / TXN_PAGE_SIZE) || txnLoading}
              onClick={() => void loadTxns(txnPage + 1)}
            >
              {t('member.txnPageNext')}
            </button>
          </div>
        ) : null}

        {detailTxn && token ? (
          <TxnDetailModal txn={detailTxn} storeSlug={storeSlug} token={token} onClose={() => setDetailTxn(null)} />
        ) : null}
        {topUpModalOpen && token ? (
          <MemberTopUpPaymentModal
            storeSlug={storeSlug}
            memberToken={token}
            amountEuro={topUpAmount}
            onSuccess={handleTopUpSuccess}
            onClose={() => setTopUpModalOpen(false)}
          />
        ) : null}
      </div>
        </div>
      </div>
    );
  }

  return (
    <div className="order-status-page mp-shell">
      <div className="order-status-scroll">
    <div className="mp-page">
      <div className="mp-top">
        <Link to={`/${storeSlug}`} className="mp-back">{t('member.backStore')}</Link>
        <LanguageSwitcher variant="text" />
      </div>
      <div className="mp-hero">
        <h1>{t('member.title')}</h1>
      </div>
      {!storeSlug ? (
        <div className="mp-alert mp-alert-warn">{t('member.missingStoreSlugHint')}</div>
      ) : null}

      <div className="mp-card">
        <div className="mp-tabs">
          <button
            type="button"
            className={`mp-tab${view === 'login' ? ' is-on' : ''}`}
            onClick={() => { setView('login'); setError(''); setPinResetNotice(''); }}
          >
            {t('member.loginTab')}
          </button>
          <button
            type="button"
            className={`mp-tab${view === 'register' ? ' is-on' : ''}`}
            onClick={() => { setView('register'); setError(''); setPinResetNotice(''); }}
          >
            {t('member.registerTab')}
          </button>
        </div>

        {error ? <div className="mp-alert mp-alert-error">{error}</div> : null}
        {pinResetNotice ? <div className="mp-alert mp-alert-ok">{pinResetNotice}</div> : null}

        {view === 'login' ? (
          <>
            <label className="mp-field">
              <span className="mp-label">{t('member.phone')}</span>
              <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" />
            </label>
            <label className="mp-field">
              <span className="mp-label">{t('member.pin')}</span>
              <input className="input" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="current-password" />
            </label>
            <button type="button" className="mp-btn mp-btn-primary" disabled={loading || !storeSlug} onClick={() => void handleLogin()}>
              {loading ? t('common.loading') : t('member.login')}
            </button>
            <p className="mp-hint">{t('member.forgotPinHint')}</p>
            <button
              type="button"
              className="mp-btn mp-btn-secondary"
              disabled={pinResetLoading || loading || !storeSlug}
              onClick={() => void handleRequestPinReset()}
            >
              {pinResetLoading ? t('common.loading') : t('member.forgotPinSubmit')}
            </button>
          </>
        ) : (
          <>
            <label className="mp-field">
              <span className="mp-label">{t('member.phone')}</span>
              <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" />
            </label>
            <label className="mp-field">
              <span className="mp-label">{t('member.displayName')}</span>
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
            <label className="mp-field">
              <span className="mp-label">{t('member.pin')}</span>
              <input className="input" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
            </label>
            <label className="mp-field">
              <span className="mp-label">{t('member.pinAgain')}</span>
              <input className="input" type="password" inputMode="numeric" value={pin2} onChange={(e) => setPin2(e.target.value)} />
            </label>
            <button type="button" className="mp-btn mp-btn-primary" disabled={loading || !storeSlug} onClick={handleRegister}>
              {loading ? t('common.loading') : t('member.register')}
            </button>
          </>
        )}
      </div>
    </div>
      </div>
    </div>
  );
}
