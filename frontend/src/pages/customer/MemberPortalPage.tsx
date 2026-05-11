import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { apiFetch, memberApiFetch } from '../../api/client';
import MemberTopUpPaymentModal from '../../components/customer/MemberTopUpPaymentModal';
import { translateMemberWalletTxnNote } from '../../utils/memberTxnNoteI18n';
import { useBusinessStatus } from '../../hooks/useBusinessStatus';

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
};

const TXN_PAGE_SIZE = 10;

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

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setDetailLoading(true);
      setDetailErr('');
      setLines(null);
      setBundles([]);
      try {
        const r = await memberApiFetch(storeSlug, token, `/api/members/me/transactions/${txn._id}/detail`);
        const d = (await r.json().catch(() => null)) as {
          lines?: TxnDetailLine[];
          bundles?: TxnDetailBundle[];
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
  }, [storeSlug, token, txn._id, t]);

  const headlineKey = `member.txnDetailHeadlines.${txn.type}`;
  let headline = t(headlineKey);
  if (headline === headlineKey) headline = t('member.txnDetailTitle', '流水详情');
  const typeLabelKey = `member.txnTypeLabels.${txn.type}`;
  let typeLabel = t(typeLabelKey);
  if (typeLabel === typeLabelKey) typeLabel = txn.type;
  const stripeRef = txn.stripePaymentIntentId?.trim();
  const opId = idStr(txn.operatorAdminId);

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
      return <div style={{ fontSize: 13, color: 'var(--text-light)', padding: '12px 0' }}>{t('member.txnLoading')}</div>;
    }
    if (detailErr) {
      return <div style={{ fontSize: 13, color: 'var(--red-primary)', padding: '12px 0' }}>{detailErr}</div>;
    }
    const hasLines = lines && lines.length > 0;
    const hasBundles = bundles.length > 0;
    if (!hasLines && !hasBundles) {
      if (txn.type === 'spend' || txn.type === 'refund_credit' || txn.type === 'reversal') {
        return (
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '12px 0', lineHeight: 1.45 }}>
            {t('member.txnDetailLinesEmpty')}
          </div>
        );
      }
      return null;
    }
    return (
      <div style={{ padding: '10px 0', borderBottom: '1px solid var(--border, #eee)' }}>
        <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 8 }}>{linesSectionTitle}</div>
        {hasLines ? (
          <ul style={{ margin: '0 0 12px 0', padding: '0 0 0 18px', fontSize: 13, lineHeight: 1.5 }}>
            {lines!.map((line, i) => (
              <li key={i} style={{ marginBottom: 6 }}>
                <span>{line.itemName}</span>
                {line.optionsSummary ? <span style={{ color: 'var(--text-secondary)' }}> · {line.optionsSummary}</span> : null}
                <span>
                  {' '}
                  ×{line.quantity} · €{Number(line.lineEuro).toFixed(2)}
                </span>
                {line.refunded ? (
                  <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-light)' }}>({t('member.txnDetailRefundedTag')})</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {hasBundles ? (
          <div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 6 }}>{t('member.txnDetailBundlesTitle')}</div>
            <ul style={{ margin: 0, padding: '0 0 0 18px', fontSize: 13, lineHeight: 1.5 }}>
              {bundles.map((b, i) => (
                <li key={i} style={{ marginBottom: 4 }}>
                  <span style={{ fontWeight: 600 }}>🎁 {bundleLabel(b)}</span>
                  <span style={{ color: 'var(--green, #2e7d32)', marginLeft: 6 }}>
                    {t('member.txnDetailBundleOff', { amount: Number(b.discountEuro).toFixed(2) })}
                  </span>
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
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        className="card"
        style={{ width: '100%', maxWidth: 400, maxHeight: '85vh', overflowY: 'auto', padding: 16 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>{headline}</div>
        <div style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 12 }}>{typeLabel}</div>

        <div style={{ borderTop: '1px solid var(--border, #eee)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border, #eee)' }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{t('member.txnFieldAmount')}</span>
            <span style={{ fontSize: 15, fontWeight: 700, color: txn.amountEuro < 0 ? 'var(--red-primary)' : 'var(--green, #2e7d32)' }}>
              {txn.amountEuro >= 0 ? '+' : ''}€{Number(txn.amountEuro).toFixed(2)}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border, #eee)' }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{t('member.txnFieldBalanceBefore')}</span>
            <span style={{ fontSize: 13 }}>€{Number(txn.balanceBefore).toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border, #eee)' }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{t('member.txnFieldBalanceAfter')}</span>
            <span style={{ fontSize: 13 }}>€{Number(txn.balanceAfter).toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border, #eee)' }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{t('member.txnFieldTime')}</span>
            <span style={{ fontSize: 13, textAlign: 'right' }}>{new Date(txn.createdAt).toLocaleString()}</span>
          </div>
          {txn.note ? (
            <div style={{ padding: '10px 0', borderBottom: '1px solid var(--border, #eee)' }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 4 }}>{t('member.txnFieldNote')}</div>
              <div style={{ fontSize: 13, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>{translateMemberWalletTxnNote(txn.note, t)}</div>
            </div>
          ) : null}
          {linesBlock}
          {txn.type === 'recharge' && stripeRef ? (
            <div style={{ padding: '10px 0', borderBottom: '1px solid var(--border, #eee)' }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 4 }}>{t('member.txnFieldStripeRef')}</div>
              <div style={{ fontSize: 12, wordBreak: 'break-all', fontFamily: 'monospace' }}>{stripeRef}</div>
            </div>
          ) : null}
          {txn.type === 'adjustment' && opId ? (
            <div style={{ padding: '10px 0' }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 4 }}>{t('member.txnFieldOperator', '操作员 ID')}</div>
              <div style={{ fontSize: 12, wordBreak: 'break-all', fontFamily: 'monospace' }}>{opId}</div>
            </div>
          ) : null}
        </div>

        <button type="button" className="btn btn-primary" style={{ width: '100%', marginTop: 16 }} onClick={onClose}>
          {t('member.txnDetailClose')}
        </button>
      </div>
    </div>
  );
}

function formatMemberApiError(
  status: number,
  body: unknown,
  storeSlug: string,
  statusText: string,
): string {
  const d = body as { error?: { code?: string; message?: string } } | null;
  const code = d?.error?.code;
  const msg = d?.error?.message || statusText || '请求失败';
  if (code === 'STORE_NOT_FOUND') {
    return `店铺「${storeSlug || '…'}」在数据库中不存在（slug 须全小写，与网址第一段一致）。\n\n本地创建门店：在 backend 目录执行\nSEED_STORE_SLUG=${storeSlug || 'your-slug'} npm run seed:store\n（需已配置 backend/.env 中的 MongoDB）。也可在平台后台新建该 slug 的门店。`;
  }
  if (code === 'STORE_REQUIRED') {
    return '缺少店铺标识。请使用「/店铺名/customer/member」打开本页，或在后端配置 DEFAULT_STORE_SLUG。';
  }
  if (status === 404 && !code) {
    if (!storeSlug) {
      return '404：网址中缺少店铺名，或后端未启动 / 代理失败。请启动后端（默认端口 8080）；若仍失败，可在 frontend/.env 设置 VITE_API_ORIGIN=http://127.0.0.1:8080';
    }
    return `HTTP 404（响应里无业务错误码）。常见原因：\n\n① 数据库尚无 slug「${storeSlug}」的门店 → 在 backend 目录执行：\nSEED_STORE_SLUG=${storeSlug} npm run seed:store\n\n② 请求没到后端（代理失败）→ 设 VITE_API_ORIGIN=http://127.0.0.1:8080 并重启前端 dev。\n\n③ slug 格式：仅小写字母、数字、连字符（例如 dragoninn 合法）。`;
  }
  return msg;
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
      return;
    }
    const p = (await r.json()) as MemberProfile;
    setProfile(p);
    setEditName(p.displayName || '');
    setEditPostalCode(p.postalCode || '');
    setEditDeliveryAddress(p.deliveryAddress || '');
    postalEditedByUserRef.current = false;
  }, [authFetch, token, storeSlug]);

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
        throw new Error(formatMemberApiError(r.status, d, storeSlug, r.statusText));
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
      setError(e instanceof Error ? e.message : 'Error');
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
    try {
      const r = await memberApiFetch(storeSlug, null, '/api/members/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, pin, storeSlug }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(formatMemberApiError(r.status, d, storeSlug, r.statusText));
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
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    if (pin !== pin2) {
      setError(t('member.pinMismatch', '两次 PIN 不一致'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      const r = await memberApiFetch(storeSlug, null, '/api/members/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, pin, displayName, storeSlug }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(formatMemberApiError(r.status, d, storeSlug, r.statusText));
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
      setError(e instanceof Error ? e.message : 'Error');
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
      if (!r.ok) throw new Error(formatMemberApiError(r.status, d, storeSlug, r.statusText));
      setProfile(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
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
      if (!r.ok) throw new Error(formatMemberApiError(r.status, d, storeSlug, r.statusText));
      setOldPin('');
      setNewPin('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setLoading(false);
    }
  };

  if (view === 'home' && profile) {
    return (
      <div style={{ maxWidth: 480, margin: '0 auto', padding: '16px 14px 32px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>{t('member.title', '会员中心')}</h1>
          <button type="button" className="btn btn-outline" style={{ fontSize: 12 }} onClick={logout}>
            {t('member.logout', '退出')}
          </button>
        </div>
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: '4px 10px',
              marginBottom: 12,
              rowGap: 6,
            }}
          >
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('member.memberNo', '会员号')}</span>
            <span style={{ fontSize: 20, fontWeight: 700, fontFamily: "'Noto Serif SC', serif" }}>#{profile.memberNo}</span>
            <span style={{ fontSize: 13, color: 'var(--text-light)' }} aria-hidden>
              |
            </span>
            <span style={{ fontSize: 13 }}>{profile.phone}</span>
          </div>
          <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>{t('member.balance', '储值余额')}</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--red-primary)' }}>€{Number(profile.creditBalance).toFixed(2)}</div>
        </div>

        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <button
            type="button"
            onClick={() => setProfileExpanded((v) => !v)}
            aria-expanded={profileExpanded}
            style={{
              width: '100%',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              font: 'inherit',
              textAlign: 'left',
              color: 'inherit',
            }}
          >
            <span style={{ fontWeight: 600 }}>{t('member.profileSection', '资料与送餐')}</span>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{profileExpanded ? '▲' : '▼'}</span>
          </button>
          {!profileExpanded ? (
            <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
              <span style={{ fontSize: 11, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>
                {t('member.deliveryAddress', '送餐地址')}
              </span>
              {editDeliveryAddress.trim()
                ? editDeliveryAddress.trim()
                : t('member.deliveryAddressCollapsedEmpty')}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 10, marginBottom: 10, lineHeight: 1.45 }}>
                {t('member.deliveryHint', '填写默认送餐邮编与地址，便于店内识别；扫码下单时仍可在购物车中修改。')}
              </div>
              <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{t('member.editName', '称呼')}</label>
              <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} style={{ width: '100%', marginBottom: 10 }} />
              <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{t('member.postalCode', '邮编')}</label>
              <input
                className="input"
                value={editPostalCode}
                onChange={(e) => {
                  postalEditedByUserRef.current = true;
                  setEditPostalCode(e.target.value);
                }}
                placeholder={t('member.postalCodePlaceholder', '如爱尔兰 Eircode')}
                style={{ width: '100%', marginBottom: 6 }}
                autoCapitalize="characters"
              />
              {addressGeoLoading ? (
                <div style={{ fontSize: 11, color: 'var(--text-light)', marginBottom: 8 }}>{t('member.addressGeoLoading', '正在根据邮编解析地址…')}</div>
              ) : null}
              {addressGeoError ? (
                <div style={{ fontSize: 11, color: 'var(--red-primary)', marginBottom: 8 }}>{addressGeoError}</div>
              ) : null}
              <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{t('member.deliveryAddress', '送餐地址')}</label>
              <textarea
                className="input"
                value={editDeliveryAddress}
                onChange={(e) => setEditDeliveryAddress(e.target.value)}
                placeholder={t('member.deliveryAddressPlaceholder', '门牌号、街道、区域等')}
                rows={3}
                style={{ width: '100%', marginBottom: 12, resize: 'vertical', minHeight: 72 }}
              />
              <button type="button" className="btn btn-primary" style={{ width: '100%' }} disabled={loading} onClick={saveProfile}>
                {t('common.save', '保存')}
              </button>

              <div
                style={{
                  marginTop: 20,
                  paddingTop: 16,
                  borderTop: '1px solid var(--border, #e8e8e8)',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 8 }}>{t('member.changePin', '修改 PIN')}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.45 }}>
                  {t('member.changePinInProfileHint')}
                </div>
                <input
                  className="input"
                  type="password"
                  inputMode="numeric"
                  placeholder={t('member.oldPin', '原 PIN')}
                  value={oldPin}
                  onChange={(e) => setOldPin(e.target.value)}
                  style={{ width: '100%', marginBottom: 8 }}
                />
                <input
                  className="input"
                  type="password"
                  inputMode="numeric"
                  placeholder={t('member.newPin', '新 PIN')}
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value)}
                  style={{ width: '100%', marginBottom: 8 }}
                />
                <button type="button" className="btn btn-outline" style={{ width: '100%' }} disabled={loading} onClick={changePin}>
                  {t('member.changePinSubmit', '更新 PIN')}
                </button>
              </div>
            </>
          )}
        </div>

        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <button
            type="button"
            onClick={() => setTopUpExpanded((v) => !v)}
            aria-expanded={topUpExpanded}
            style={{
              width: '100%',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              font: 'inherit',
              textAlign: 'left',
              color: 'inherit',
            }}
          >
            <span style={{ fontWeight: 600 }}>{t('member.topUpSection')}</span>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{topUpExpanded ? '▲' : '▼'}</span>
          </button>
          {!topUpExpanded ? (
            <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
              {t('member.topUpCollapsedHint', { min: TOPUP_MIN, max: TOPUP_MAX })}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 10, marginBottom: 10, lineHeight: 1.45 }}>
                {t('member.topUpHint', { min: TOPUP_MIN, max: TOPUP_MAX })}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                {TOPUP_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="btn btn-outline"
                    style={{ flex: '1 1 40%', minWidth: 72, padding: '8px 12px' }}
                    onClick={() => setTopUpDraft(String(p))}
                  >
                    €{p}
                  </button>
                ))}
              </div>
              <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{t('member.topUpCustom')}</label>
              <input
                className="input"
                type="number"
                inputMode="decimal"
                min={TOPUP_MIN}
                max={TOPUP_MAX}
                step="0.01"
                value={topUpDraft}
                onChange={(e) => setTopUpDraft(e.target.value)}
                style={{ width: '100%', marginBottom: 12 }}
              />
              <button type="button" className="btn btn-primary" style={{ width: '100%' }} onClick={openTopUpModal}>
                {t('member.topUpOpen')}
              </button>

              <div
                style={{
                  marginTop: 20,
                  paddingTop: 16,
                  borderTop: '1px solid var(--border, #e8e8e8)',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 8 }}>{t('member.topUpCardSection')}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.45 }}>
                  {t('member.topUpCardHint')}
                </div>
                <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{t('member.topUpCardCode')}</label>
                <input
                  className="input"
                  value={cardCodeInput}
                  onChange={(e) => setCardCodeInput(e.target.value.toUpperCase())}
                  maxLength={12}
                  autoCapitalize="characters"
                  style={{ width: '100%', marginBottom: 8, fontFamily: 'monospace', letterSpacing: '0.05em' }}
                />
                <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{t('member.topUpCardPin')}</label>
                <input
                  className="input"
                  type="password"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={cardPinInput}
                  onChange={(e) => setCardPinInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  maxLength={6}
                  style={{ width: '100%', marginBottom: 12 }}
                />
                <button
                  type="button"
                  className="btn btn-outline"
                  style={{ width: '100%' }}
                  disabled={cardRedeemBusy}
                  onClick={() => void redeemTopUpCard()}
                >
                  {cardRedeemBusy ? t('common.loading') : t('member.topUpCardSubmit')}
                </button>
              </div>
            </>
          )}
        </div>

        <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('member.txnHistory', '流水')}</div>
        <div style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 10 }}>{t('member.txnTapForDetail')}</div>
        {txnLoadError ? (
          <div style={{ color: 'var(--red-primary)', fontSize: 13, marginBottom: 10, whiteSpace: 'pre-wrap' }}>{txnLoadError}</div>
        ) : null}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {txnLoading && txns.length === 0 ? (
            <div style={{ color: 'var(--text-light)', fontSize: 13 }}>{t('member.txnLoading')}</div>
          ) : txns.length === 0 ? (
            <div style={{ color: 'var(--text-light)', fontSize: 13 }}>{t('member.noTxns', '暂无记录')}</div>
          ) : (
            txns.map((x) => {
              const tlKey = `member.txnTypeLabels.${x.type}`;
              let typeShort = t(tlKey);
              if (typeShort === tlKey) typeShort = x.type;
              return (
                <button
                  key={x._id}
                  type="button"
                  className="card"
                  onClick={() => setDetailTxn(x)}
                  style={{
                    padding: 12,
                    fontSize: 13,
                    textAlign: 'left',
                    cursor: 'pointer',
                    border: '1px solid var(--border, #eee)',
                    background: 'var(--bg, #fff)',
                    width: '100%',
                    borderRadius: 8,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{typeShort}</span>
                    <span style={{ fontWeight: 700, color: x.amountEuro < 0 ? 'var(--red-primary)' : 'var(--green, #2e7d32)' }}>
                      {x.amountEuro >= 0 ? '+' : ''}€{x.amountEuro.toFixed(2)}
                    </span>
                  </div>
                  <div style={{ color: 'var(--text-light)', fontSize: 11, marginTop: 4 }}>
                    {new Date(x.createdAt).toLocaleString()} · {t('member.balance')} €{x.balanceAfter.toFixed(2)}
                  </div>
                  {x.note ? (
                    <div style={{ fontSize: 11, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {translateMemberWalletTxnNote(x.note, t)}
                    </div>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
        {txnTotal > 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-outline"
              disabled={txnPage <= 1 || txnLoading}
              onClick={() => void loadTxns(txnPage - 1)}
              style={{ flex: '0 0 auto' }}
            >
              {t('member.txnPagePrev')}
            </button>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {t('member.txnPageInfo', {
                page: txnPage,
                pages: Math.max(1, Math.ceil(txnTotal / TXN_PAGE_SIZE)),
                total: txnTotal,
              })}
            </span>
            <button
              type="button"
              className="btn btn-outline"
              disabled={txnPage >= Math.ceil(txnTotal / TXN_PAGE_SIZE) || txnLoading}
              onClick={() => void loadTxns(txnPage + 1)}
              style={{ flex: '0 0 auto' }}
            >
              {t('member.txnPageNext')}
            </button>
          </div>
        ) : null}

        <div style={{ marginTop: 24, textAlign: 'center' }}>
          <Link to={`/${storeSlug}`} style={{ color: 'var(--red-primary)', fontSize: 14 }}>{t('member.backStore', '返回店铺')}</Link>
        </div>
        {walletHint ? (
          <div style={{ color: 'var(--green, #2e7d32)', marginTop: 12, fontSize: 13, whiteSpace: 'pre-line' }}>{walletHint}</div>
        ) : null}
        {error ? <div style={{ color: 'var(--red-primary)', marginTop: 12, fontSize: 13, whiteSpace: 'pre-line' }}>{error}</div> : null}
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
    );
  }

  return (
    <div style={{ maxWidth: 400, margin: '0 auto', padding: '24px 14px' }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>{t('member.title', '会员中心')}</h1>
      {!storeSlug ? (
        <div className="card" style={{ padding: 12, marginBottom: 14, background: '#fff8e1', fontSize: 13, lineHeight: 1.5 }}>
          当前链接缺少店铺名。请从店铺首页点击「会员」进入，或手动访问 <strong>/您的店铺名/customer/member</strong>。
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button type="button" className="btn" style={{ flex: 1, background: view === 'login' ? 'var(--red-primary)' : 'var(--bg)', color: view === 'login' ? '#fff' : 'inherit' }} onClick={() => { setView('login'); setError(''); }}>
          {t('member.loginTab', '登录')}
        </button>
        <button type="button" className="btn" style={{ flex: 1, background: view === 'register' ? 'var(--red-primary)' : 'var(--bg)', color: view === 'register' ? '#fff' : 'inherit' }} onClick={() => { setView('register'); setError(''); }}>
          {t('member.registerTab', '注册')}
        </button>
      </div>

      {error ? <div style={{ color: 'var(--red-primary)', marginBottom: 12, fontSize: 13, whiteSpace: 'pre-line' }}>{error}</div> : null}

      {view === 'login' ? (
        <>
          <input className="input" placeholder={t('member.phone', '手机号')} value={phone} onChange={(e) => setPhone(e.target.value)} style={{ width: '100%', marginBottom: 10 }} />
          <input className="input" type="password" inputMode="numeric" placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value)} style={{ width: '100%', marginBottom: 16 }} />
          <button type="button" className="btn btn-primary" style={{ width: '100%' }} disabled={loading || !storeSlug} onClick={handleLogin}>
            {loading ? '…' : t('member.login', '登录')}
          </button>
        </>
      ) : (
        <>
          <input className="input" placeholder={t('member.phone', '手机号')} value={phone} onChange={(e) => setPhone(e.target.value)} style={{ width: '100%', marginBottom: 10 }} />
          <input className="input" placeholder={t('member.displayName', '称呼（可选）')} value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={{ width: '100%', marginBottom: 10 }} />
          <input className="input" type="password" inputMode="numeric" placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value)} style={{ width: '100%', marginBottom: 10 }} />
          <input className="input" type="password" inputMode="numeric" placeholder={t('member.pinAgain', '确认 PIN')} value={pin2} onChange={(e) => setPin2(e.target.value)} style={{ width: '100%', marginBottom: 16 }} />
          <button type="button" className="btn btn-primary" style={{ width: '100%' }} disabled={loading || !storeSlug} onClick={handleRegister}>
            {loading ? '…' : t('member.register', '注册')}
          </button>
        </>
      )}

      <div style={{ marginTop: 20, textAlign: 'center' }}>
        <Link to={`/${storeSlug}`} style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{t('member.backStore', '返回店铺')}</Link>
      </div>
    </div>
  );
}
