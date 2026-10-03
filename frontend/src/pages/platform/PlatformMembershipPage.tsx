import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { platformApiFetch } from '../../api/client';
import { resolveBackendAssetUrl } from '../../utils/backendPublicUrl';
import './platform-apple-wallet.css';

function rgbToHex(rgb: string): string {
  const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(rgb.trim());
  if (!m) return '#ffd60a';
  const to = (n: string) => Number(n).toString(16).padStart(2, '0');
  return `#${to(m[1])}${to(m[2])}${to(m[3])}`;
}

function hexToRgb(hex: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return 'rgb(255, 214, 10)';
  const n = parseInt(m[1], 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

type StripeHealthBody = {
  ok: boolean;
  checks: {
    publishableKeyFormatOk: boolean;
    secretKeyFormatOk: boolean;
    modeMatch: boolean;
    publishableMode: string;
    secretMode: string;
  };
  stripeApi: { ok: true } | { ok: false; code: string; message: string };
};

type MemberRow = {
  _id: string;
  phone: string;
  memberNo?: number;
  displayName: string;
  creditBalance: number;
  status: string;
  staffStoreCount: number;
  staffStores?: StaffStore[];
  hasPin: boolean;
};

type StaffStore = { storeId: string; slug: string; displayName: string; staffBalance: number };
type StoreOpt = { _id: string; slug: string; displayName: string; status: string };
type TxnRow = {
  _id: string;
  wallet: string;
  storeId: string | null;
  storeSlug?: string;
  storeDisplayName?: string;
  type: string;
  amountEuro: number;
  balanceBefore: number;
  balanceAfter: number;
  note: string;
  orderId: string | null;
  createdAt: string;
};

type MemberDetail = {
  _id: string;
  phone: string;
  memberNo?: number;
  displayName: string;
  creditBalance: number;
  status: string;
  hasPin: boolean;
  staffStores: StaffStore[];
  allStores: StoreOpt[];
  txns: TxnRow[];
};

function RoleTag({ kind }: { kind: 'guest' | 'staff' }) {
  const staff = kind === 'staff';
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1.2,
        padding: '3px 8px',
        borderRadius: 999,
        letterSpacing: 0.2,
        color: staff ? '#6a1b9a' : '#1565c0',
        background: staff ? '#f3e5f5' : '#e3f2fd',
        border: `1px solid ${staff ? '#ce93d8' : '#90caf9'}`,
        whiteSpace: 'nowrap',
      }}
    >
      {staff ? '员工' : '客人'}
    </span>
  );
}

function MemberRoleTags({ staffStoreCount }: { staffStoreCount: number }) {
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      <RoleTag kind="guest" />
      {staffStoreCount > 0 ? <RoleTag kind="staff" /> : null}
    </span>
  );
}

type RoleFilter = 'all' | 'guest' | 'staff';

function txnTypeLabel(type: string): string {
  const map: Record<string, string> = {
    recharge: '充值',
    gift_card: '充值卡',
    spend: '消费',
    refund_credit: '退款入账',
    staff_credit: '员工额度充值',
    adjustment: '调整',
    reversal: '冲正',
  };
  return map[type] || type;
}

function txnStoreLabel(t: TxnRow): string {
  const name = (t.storeDisplayName || '').trim();
  const slug = (t.storeSlug || '').trim();
  if (name && slug && name !== slug) return `${name} (${slug})`;
  if (name || slug) return name || slug;
  if (t.storeId) return t.storeId;
  if (t.wallet === 'guest') return '平台 / 客人钱包';
  return '—';
}

function StaffBalancesCell({ stores }: { stores?: StaffStore[] }) {
  if (!stores || stores.length === 0) {
    return <span style={{ color: '#90a4ae' }}>—</span>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {stores.map((s) => (
        <div key={s.storeId} style={{ whiteSpace: 'nowrap' }}>
          <span style={{ color: '#3949ab' }}>{s.displayName || s.slug || s.storeId}</span>
          {' '}
          <span style={{ fontWeight: 700 }}>€{Number(s.staffBalance).toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}
function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontSize: 13,
        fontWeight: 600,
        padding: '6px 12px',
        borderRadius: 999,
        cursor: 'pointer',
        border: `1px solid ${active ? '#3949ab' : '#c5cae9'}`,
        background: active ? '#3949ab' : '#fff',
        color: active ? '#fff' : '#3949ab',
      }}
    >
      {children}
    </button>
  );
}

export default function PlatformMembershipPage() {
  const [publishableKey, setPublishableKey] = useState('');
  const [secretKeyDraft, setSecretKeyDraft] = useState('');
  const [hasSecret, setHasSecret] = useState(false);
  const [stripeLoading, setStripeLoading] = useState(true);
  const [stripeSaving, setStripeSaving] = useState(false);
  const [health, setHealth] = useState<StripeHealthBody | null>(null);
  const [checkRunning, setCheckRunning] = useState(false);
  const [stripeOpen, setStripeOpen] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);

  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [rows, setRows] = useState<MemberRow[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [newName, setNewName] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const [detail, setDetail] = useState<MemberDetail | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [detailName, setDetailName] = useState('');
  const [staffIds, setStaffIds] = useState<string[]>([]);
  const [detailSaving, setDetailSaving] = useState(false);
  const [pin1, setPin1] = useState('');
  const [pin2, setPin2] = useState('');
  const [pinSaving, setPinSaving] = useState(false);
  const [guestCreditAmount, setGuestCreditAmount] = useState('');
  const [guestCreditNote, setGuestCreditNote] = useState('');
  const [guestCreditSaving, setGuestCreditSaving] = useState(false);

  type WalletStoreOpt = { _id: string; slug: string; displayName: string };
  type WalletCertStatus = {
    passTypeId: string;
    teamId: string;
    hasP12: boolean;
    hasWwdr: boolean;
    hasPassword: boolean;
    ready: boolean;
  };
  type WalletSettings = {
    enabled: boolean;
    organizationName: string;
    description: string;
    logoText: string;
    logoUrl: string;
    backgroundColor: string;
    foregroundColor: string;
    labelColor: string;
    maxDistanceMeters: number;
    storeIds: string[];
  };
  const [walletOpen, setWalletOpen] = useState(false);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletSaving, setWalletSaving] = useState(false);
  const [walletSettings, setWalletSettings] = useState<WalletSettings | null>(null);
  const [walletCerts, setWalletCerts] = useState<WalletCertStatus | null>(null);
  const [walletWebServiceURL, setWalletWebServiceURL] = useState<string | null>(null);
  const [walletPassUpdatesEnabled, setWalletPassUpdatesEnabled] = useState(false);
  const [walletStores, setWalletStores] = useState<WalletStoreOpt[]>([]);
  const [walletLocPreview, setWalletLocPreview] = useState<Array<{ storeId: string; displayName: string; ok: boolean }>>([]);
  const [walletPassBusyId, setWalletPassBusyId] = useState<string | null>(null);
  const [walletLogoUploading, setWalletLogoUploading] = useState(false);

  const loadStripe = useCallback(async () => {
    setStripeLoading(true);
    try {
      const res = await platformApiFetch('/api/platform/membership/stripe-config');
      if (!res.ok) return;
      const data = await res.json();
      setPublishableKey(typeof data.publishableKey === 'string' ? data.publishableKey : '');
      setHasSecret(!!data.hasSecret);
      setSecretKeyDraft('');
    } finally {
      setStripeLoading(false);
    }
  }, []);

  useEffect(() => { void loadStripe(); }, [loadStripe]);

  const saveStripe = async (clearSecret: boolean) => {
    setStripeSaving(true);
    setErr('');
    try {
      const body: { publishableKey: string; secretKey?: string; clearSecret?: boolean } = { publishableKey };
      if (clearSecret) body.clearSecret = true;
      else if (secretKeyDraft.trim()) body.secretKey = secretKeyDraft.trim();
      const res = await platformApiFetch('/api/platform/membership/stripe-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr((j as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`);
        return;
      }
      setSecretKeyDraft('');
      await loadStripe();
      setMsg('平台 Stripe 已保存（密钥不会回显）');
    } finally {
      setStripeSaving(false);
    }
  };

  const runHealth = async () => {
    setCheckRunning(true);
    setHealth(null);
    try {
      const res = await platformApiFetch('/api/platform/membership/stripe-health');
      if (!res.ok) return;
      setHealth((await res.json()) as StripeHealthBody);
    } finally {
      setCheckRunning(false);
    }
  };

  const search = useCallback(async () => {
    setListLoading(true);
    setErr('');
    try {
      const params = new URLSearchParams({ q: q.trim() });
      const res = await platformApiFetch(`/api/platform/membership/members?${params}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr((j as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`);
        setRows([]);
        return;
      }
      setRows(await res.json());
    } finally {
      setListLoading(false);
    }
  }, [q]);

  useEffect(() => {
    const t = setTimeout(() => { void search(); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const visibleRows = useMemo(() => {
    if (roleFilter === 'staff') return rows.filter((r) => r.staffStoreCount > 0);
    if (roleFilter === 'guest') return rows.filter((r) => !(r.staffStoreCount > 0));
    return rows;
  }, [rows, roleFilter]);
  const guestOnlyCount = useMemo(() => rows.filter((r) => !(r.staffStoreCount > 0)).length, [rows]);
  const staffCount = rows.length - guestOnlyCount;

  const openDetail = async (id: string) => {
    setErr('');
    setOpeningId(id);
    const res = await platformApiFetch(`/api/platform/membership/members/${id}`);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr((j as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`);
      setOpeningId(null);
      return;
    }
    const d = (await res.json()) as MemberDetail;
    setDetail(d);
    setDetailName(d.displayName);
    setStaffIds(d.staffStores.map((s) => s.storeId));
    setPin1('');
    setPin2('');
    setGuestCreditAmount('');
    setGuestCreditNote('');
    setOpeningId(null);
  };

  const toggleDetail = (id: string) => {
    if (detail?._id === id && openingId == null) {
      setDetail(null);
      return;
    }
    void openDetail(id);
  };

  const register = async () => {
    if (!newPhone.trim()) return;
    setErr('');
    const res = await platformApiFetch('/api/platform/membership/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: newPhone.trim(), displayName: newName.trim() }),
    });
    const j = await res.json().catch(() => ({})) as { _id?: string; created?: boolean; error?: { message?: string } };
    if (!res.ok) {
      setErr(j.error?.message || `HTTP ${res.status}`);
      return;
    }
    setNewPhone('');
    setNewName('');
    setMsg(j.created === false ? '该手机号已登记，已打开档案' : '已登记为平台客人');
    await search();
    if (j._id) await openDetail(j._id);
  };

  const saveDetail = async () => {
    if (!detail) return;
    setDetailSaving(true);
    setErr('');
    try {
      const nameRes = await platformApiFetch(`/api/platform/membership/members/${detail._id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: detailName }),
      });
      if (!nameRes.ok) {
        const j = await nameRes.json().catch(() => ({}));
        setErr((j as { error?: { message?: string } })?.error?.message || '保存姓名失败');
        return;
      }
      const staffRes = await platformApiFetch(`/api/platform/membership/members/${detail._id}/staff-stores`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeIds: staffIds }),
      });
      if (!staffRes.ok) {
        const j = await staffRes.json().catch(() => ({}));
        setErr((j as { error?: { message?: string } })?.error?.message || '保存员工店铺失败');
        return;
      }
      setMsg('已保存');
      await openDetail(detail._id);
      await search();
    } finally {
      setDetailSaving(false);
    }
  };

  const savePin = async () => {
    if (!detail) return;
    if (pin1 !== pin2) {
      setErr('两次 PIN 不一致');
      return;
    }
    setPinSaving(true);
    setErr('');
    try {
      const res = await platformApiFetch(`/api/platform/membership/members/${detail._id}/pin`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pin1, pinConfirm: pin2 }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr((j as { error?: { message?: string } })?.error?.message || '保存 PIN 失败');
        return;
      }
      setPin1('');
      setPin2('');
      setMsg(detail.hasPin ? '员工 PIN 已更新' : '员工 PIN 已设置');
      await openDetail(detail._id);
      await search();
    } finally {
      setPinSaving(false);
    }
  };

  const creditGuestWallet = async () => {
    if (!detail) return;
    const amt = parseFloat(guestCreditAmount);
    if (!Number.isFinite(amt) || amt === 0) {
      setErr('请输入非零金额：正数充值，负数扣减');
      return;
    }
    const nextBal = Number(detail.creditBalance) + amt;
    if (amt < 0 && nextBal < -1e-9) {
      setErr(`扣减不能超过当前余额 €${Number(detail.creditBalance).toFixed(2)}`);
      return;
    }
    const abs = Math.abs(amt).toFixed(2);
    const ok = window.confirm(
      amt < 0
        ? `确认从客人钱包扣减 €${abs}？\n#${detail.memberNo || '—'} · ${detail.phone}${detail.displayName ? ` · ${detail.displayName}` : ''}\n当前 €${Number(detail.creditBalance).toFixed(2)} → €${nextBal.toFixed(2)}`
        : `确认给客人钱包充值 €${abs}？\n#${detail.memberNo || '—'} · ${detail.phone}${detail.displayName ? ` · ${detail.displayName}` : ''}\n当前 €${Number(detail.creditBalance).toFixed(2)} → €${nextBal.toFixed(2)}`,
    );
    if (!ok) return;
    setGuestCreditSaving(true);
    setErr('');
    try {
      const noteTrim = guestCreditNote.trim();
      const res = await platformApiFetch(`/api/platform/membership/members/${detail._id}/guest-credit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amountEuro: amt,
          ...(noteTrim ? { note: noteTrim } : {}),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr((j as { error?: { message?: string } })?.error?.message || '操作失败');
        return;
      }
      setGuestCreditAmount('');
      setGuestCreditNote('');
      const after = Number((j as { creditBalance?: number }).creditBalance);
      setMsg(
        amt < 0
          ? `客人钱包已扣减 €${abs}，当前 €${after.toFixed(2)}`
          : `客人钱包已充值 €${abs}，当前 €${after.toFixed(2)}`,
      );
      await openDetail(detail._id);
      await search();
    } finally {
      setGuestCreditSaving(false);
    }
  };

  const toggleStaff = (storeId: string) => {
    setStaffIds((prev) => (prev.includes(storeId) ? prev.filter((x) => x !== storeId) : [...prev, storeId]));
  };

  const normalizeWalletSettings = useCallback((s: Partial<WalletSettings> | null | undefined): WalletSettings => ({
    enabled: !!s?.enabled,
    organizationName: s?.organizationName || 'LZFOOD',
    description: s?.description || 'LZFOOD Membership',
    logoText: s?.logoText || 'LZFOOD',
    logoUrl: typeof s?.logoUrl === 'string' ? s.logoUrl : '',
    backgroundColor: s?.backgroundColor || 'rgb(255, 214, 10)',
    foregroundColor: s?.foregroundColor || 'rgb(28, 28, 30)',
    labelColor: s?.labelColor || 'rgb(90, 90, 95)',
    maxDistanceMeters: Number(s?.maxDistanceMeters) || 120,
    storeIds: Array.isArray(s?.storeIds) ? s!.storeIds.map(String) : [],
  }), []);

  const loadWallet = useCallback(async () => {
    setWalletLoading(true);
    try {
      const res = await platformApiFetch('/api/platform/membership/apple-wallet-config');
      if (!res.ok) {
        setErr(await res.text());
        return;
      }
      const data = await res.json();
      setWalletSettings(normalizeWalletSettings(data.settings));
      setWalletCerts(data.certificates);
      setWalletWebServiceURL(typeof data.webServiceURL === 'string' ? data.webServiceURL : null);
      setWalletPassUpdatesEnabled(!!data.passUpdatesEnabled);
      setWalletStores(Array.isArray(data.stores) ? data.stores : []);
      setWalletLocPreview(Array.isArray(data.locationPreview) ? data.locationPreview : []);
    } finally {
      setWalletLoading(false);
    }
  }, [normalizeWalletSettings]);

  useEffect(() => {
    if (walletOpen && !walletSettings) void loadWallet();
  }, [walletOpen, walletSettings, loadWallet]);

  const saveWallet = async () => {
    if (!walletSettings) return;
    setWalletSaving(true);
    setErr('');
    setMsg('');
    try {
      const res = await platformApiFetch('/api/platform/membership/apple-wallet-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: walletSettings }),
      });
      if (!res.ok) {
        setErr(await res.text());
        return;
      }
      const data = await res.json();
      setWalletSettings(normalizeWalletSettings(data.settings));
      setWalletCerts(data.certificates);
      setWalletWebServiceURL(typeof data.webServiceURL === 'string' ? data.webServiceURL : null);
      setWalletPassUpdatesEnabled(!!data.passUpdatesEnabled);
      setMsg('Apple Wallet 会员卡设置已保存（已通知已安装卡更新样式）');
      await loadWallet();
    } finally {
      setWalletSaving(false);
    }
  };

  const toggleWalletStore = (storeId: string) => {
    setWalletSettings((prev) => {
      if (!prev) return prev;
      const on = prev.storeIds.includes(storeId);
      if (!on && prev.storeIds.length >= 10) {
        setErr('Apple Wallet 每张卡最多 10 个附近门店坐标');
        return prev;
      }
      return {
        ...prev,
        storeIds: on ? prev.storeIds.filter((x) => x !== storeId) : [...prev.storeIds, storeId],
      };
    });
  };

  const downloadMemberPass = async (memberId: string) => {
    setWalletPassBusyId(memberId);
    setErr('');
    try {
      const res = await platformApiFetch(`/api/platform/membership/members/${memberId}/apple-wallet-pass`);
      if (!res.ok) {
        setErr(await res.text());
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `lzfood-member-${memberId}.pkpass`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setWalletPassBusyId(null);
    }
  };

  const uploadWalletLogo = async (file: File | null) => {
    if (!file || !walletSettings) return;
    setWalletLogoUploading(true);
    setErr('');
    try {
      const fd = new FormData();
      fd.append('image', file);
      const res = await platformApiFetch('/api/platform/membership/apple-wallet-logo', {
        method: 'POST',
        body: fd,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr((j as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`);
        return;
      }
      const imageUrl = String((j as { imageUrl?: string }).imageUrl || '');
      if (!imageUrl) {
        setErr('上传成功但未返回图片地址');
        return;
      }
      setWalletSettings({ ...walletSettings, logoUrl: imageUrl });
      setMsg('Logo 已上传（请再点保存 Wallet 设置）');
    } finally {
      setWalletLogoUploading(false);
    }
  };

  const applyYellowPreset = () => {
    if (!walletSettings) return;
    setWalletSettings({
      ...walletSettings,
      backgroundColor: 'rgb(255, 214, 10)',
      foregroundColor: 'rgb(28, 28, 30)',
      labelColor: 'rgb(90, 90, 95)',
    });
  };

  return (
    <div style={{ width: '100%' }}>
      <h1 style={{ margin: '0 0 8px', fontSize: 22, fontWeight: 700, color: '#1a237e' }}>平台会员</h1>
      <p style={{ margin: '0 0 20px', fontSize: 13, color: '#5c6bc0', lineHeight: 1.5 }}>
        收款 Stripe 仅用于平台礼品卡/在线充值，与各店堂食 Stripe 分开。密钥保存后不会再显示。店铺不能改客人钱包；平台可在档案里手动给客人钱包加额或扣减。各店员工额度仍由店铺后台加。
      </p>

      {err ? (
        <div className="card" style={{ padding: 12, marginBottom: 16, borderColor: '#c62828', color: '#b71c1c' }}>{err}</div>
      ) : null}
      {msg ? (
        <div className="card" style={{ padding: 12, marginBottom: 16, color: '#2e7d32' }}>{msg}</div>
      ) : null}

      <div className="card" style={{ padding: stripeOpen ? 20 : '12px 20px', marginBottom: 24 }}>
        <button
          type="button"
          onClick={() => setStripeOpen((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            gap: 12,
            background: 'none',
            border: 0,
            padding: 0,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16 }}>平台收款 Stripe</h2>
          <span style={{ fontSize: 13, color: '#5c6bc0', whiteSpace: 'nowrap' }}>
            {hasSecret ? '已保存 Secret' : (stripeLoading ? '' : '未配置')}
            {' · '}
            {stripeOpen ? '收起' : '展开'}
          </span>
        </button>
        {stripeOpen ? (
          stripeLoading ? <div style={{ color: '#789', marginTop: 12 }}>加载中…</div> : (
          <>
            <label style={{ display: 'block', fontSize: 12, color: '#789', margin: '12px 0 6px' }}>Publishable key</label>
            <input
              className="input"
              value={publishableKey}
              onChange={(e) => setPublishableKey(e.target.value)}
              placeholder="pk_live_… / pk_test_…"
              autoComplete="off"
              style={{ width: '100%', marginBottom: 12 }}
            />
            <label style={{ display: 'block', fontSize: 12, color: '#789', marginBottom: 6 }}>
              Secret key {hasSecret ? <span>（已保存）</span> : null}
            </label>
            <input
              className="input"
              type="password"
              value={secretKeyDraft}
              onChange={(e) => setSecretKeyDraft(e.target.value)}
              placeholder={hasSecret ? '留空表示不改' : 'sk_live_… / sk_test_…'}
              autoComplete="new-password"
              style={{ width: '100%', marginBottom: 12 }}
            />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button type="button" className="btn btn-primary" onClick={() => void saveStripe(false)} disabled={stripeSaving}>
                {stripeSaving ? '保存中…' : '保存'}
              </button>
              {hasSecret ? (
                <button
                  type="button"
                  className="btn btn-outline"
                  style={{ color: '#c62828' }}
                  onClick={() => { if (confirm('清除平台 Stripe Secret？')) void saveStripe(true); }}
                  disabled={stripeSaving}
                >
                  清除 Secret
                </button>
              ) : null}
              <button type="button" className="btn btn-outline" onClick={() => void runHealth()} disabled={checkRunning}>
                {checkRunning ? '检测中…' : '测试连接'}
              </button>
            </div>
            {health ? (
              <div style={{
                marginTop: 14,
                padding: 12,
                borderRadius: 8,
                background: health.ok ? 'rgba(46,125,50,0.08)' : 'rgba(198,40,40,0.06)',
                border: `1px solid ${health.ok ? 'rgba(46,125,50,0.35)' : 'rgba(198,40,40,0.25)'}`,
              }}>
                <div style={{ fontWeight: 600, color: health.ok ? '#2e7d32' : '#c62828', marginBottom: 8 }}>
                  {health.ok ? '连接正常' : '连接失败'}
                </div>
                <div style={{ fontSize: 13 }}>pk 格式 {health.checks.publishableKeyFormatOk ? 'OK' : '否'} · sk 格式 {health.checks.secretKeyFormatOk ? 'OK' : '否'} · 模式一致 {health.checks.modeMatch ? 'OK' : '否'} · API {health.stripeApi.ok ? 'OK' : '否'}</div>
                {!health.stripeApi.ok ? (
                  <div style={{ fontSize: 12, color: '#c62828', marginTop: 8 }}>[{health.stripeApi.code}] {health.stripeApi.message}</div>
                ) : null}
              </div>
            ) : null}
          </>
          )
        ) : null}
      </div>

      <div className="card" style={{ padding: walletOpen ? 20 : '12px 20px', marginBottom: 24 }}>
        <button
          type="button"
          onClick={() => setWalletOpen((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            gap: 12,
            background: 'none',
            border: 0,
            padding: 0,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16 }}>Apple Wallet 会员卡</h2>
          <span style={{ fontSize: 13, color: '#5c6bc0', whiteSpace: 'nowrap' }}>
            {walletSettings?.enabled ? '已启用' : (walletLoading ? '' : '未启用')}
            {' · '}
            {walletCerts?.ready ? '证书就绪' : '证书未齐'}
            {' · '}
            {walletOpen ? '收起' : '展开'}
          </span>
        </button>
        {walletOpen ? (
          walletLoading || !walletSettings ? (
            <div style={{ color: '#789', marginTop: 12 }}>加载中…</div>
          ) : (
            <>
              <p style={{ margin: '12px 0 0', fontSize: 12, color: '#789', lineHeight: 1.5 }}>
                面向平台客人会员。靠近勾选门店时可能提示会员卡；卡面含 QR（扫码业务后续再接）。证书用服务器环境变量配置，勿上传 Git。
                NFC 碰卡为后续能力，本阶段未启用。
              </p>
              <div style={{
                marginTop: 12,
                padding: 12,
                borderRadius: 8,
                background: walletCerts?.ready ? 'rgba(46,125,50,0.08)' : 'rgba(198,40,40,0.06)',
                border: `1px solid ${walletCerts?.ready ? 'rgba(46,125,50,0.35)' : 'rgba(198,40,40,0.25)'}`,
                fontSize: 13,
              }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>
                  证书状态：{walletCerts?.ready ? '可签发' : '未就绪'}
                </div>
                <div>Pass Type ID：{walletCerts?.passTypeId || '—'}</div>
                <div>Team ID：{walletCerts?.teamId || '（未配置 APPLE_TEAM_ID）'}</div>
                <div>
                  P12 {walletCerts?.hasP12 ? 'OK' : '缺'} · 密码 {walletCerts?.hasPassword ? 'OK' : '缺'} · WWDR{' '}
                  {walletCerts?.hasWwdr ? 'OK' : '缺'}
                </div>
                <div style={{ marginTop: 8 }}>
                  远程更新：{walletPassUpdatesEnabled ? '已启用' : '未启用'}
                  {walletWebServiceURL ? (
                    <div style={{ fontSize: 12, opacity: 0.85, wordBreak: 'break-all' }}>
                      webServiceURL：{walletWebServiceURL}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, opacity: 0.85 }}>
                      需 HTTPS 公网地址（PORTAL_PUBLIC_ORIGIN 或 APPLE_WALLET_WEB_SERVICE_URL）。本地请用 tunnel。
                    </div>
                  )}
                </div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 14 }}>
                <input
                  type="checkbox"
                  checked={walletSettings.enabled}
                  onChange={(e) => setWalletSettings({ ...walletSettings, enabled: e.target.checked })}
                />
                启用顾客「加入 Apple 钱包」
              </label>

              <div className="aw-editor">
                <div className="aw-preview-wrap">
                  <div className="aw-preview-label">实时预览（近似 Wallet，非 1:1）</div>
                  <div
                    className="aw-card"
                    style={{
                      background: walletSettings.backgroundColor,
                      color: walletSettings.foregroundColor,
                    }}
                  >
                    <div className="aw-card-top">
                      {walletSettings.logoUrl ? (
                        <img
                          className="aw-card-logo"
                          src={resolveBackendAssetUrl(walletSettings.logoUrl)}
                          alt="logo"
                        />
                      ) : (
                        <span className="aw-card-logo-fallback" />
                      )}
                      <span className="aw-card-logo-text">{walletSettings.logoText || 'LZFOOD'}</span>
                    </div>
                    <div>
                      <div className="aw-card-primary-label" style={{ color: walletSettings.labelColor }}>
                        BALANCE
                      </div>
                      <div className="aw-card-primary-value">€20.00</div>
                    </div>
                    <div className="aw-card-row">
                      <div className="aw-card-field">
                        <div className="aw-card-field-label" style={{ color: walletSettings.labelColor }}>
                          MEMBER
                        </div>
                        <div className="aw-card-field-value">Guest</div>
                      </div>
                      <div className="aw-card-field">
                        <div className="aw-card-field-label" style={{ color: walletSettings.labelColor }}>
                          NO.
                        </div>
                        <div className="aw-card-field-value">#1001</div>
                      </div>
                    </div>
                    <div className="aw-card-qr" title="QR preview" />
                  </div>
                </div>

                <div className="aw-controls">
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
                    <button type="button" className="btn btn-outline" onClick={applyYellowPreset}>
                      黄色模板
                    </button>
                  </div>

                  <label className="aw-lab">组织名称</label>
                  <input
                    className="input"
                    value={walletSettings.organizationName}
                    onChange={(e) => setWalletSettings({ ...walletSettings, organizationName: e.target.value })}
                    style={{ width: '100%' }}
                  />

                  <label className="aw-lab">Logo 文字</label>
                  <input
                    className="input"
                    value={walletSettings.logoText}
                    onChange={(e) => setWalletSettings({ ...walletSettings, logoText: e.target.value })}
                    style={{ width: '100%' }}
                  />

                  <label className="aw-lab">Logo 图片（PNG）</label>
                  <div className="aw-logo-row">
                    {walletSettings.logoUrl ? (
                      <img
                        className="aw-logo-thumb"
                        src={resolveBackendAssetUrl(walletSettings.logoUrl)}
                        alt=""
                      />
                    ) : null}
                    <label className="btn btn-outline" style={{ cursor: 'pointer', margin: 0 }}>
                      {walletLogoUploading ? '上传中…' : '上传 Logo'}
                      <input
                        type="file"
                        accept="image/png,.png"
                        hidden
                        disabled={walletLogoUploading}
                        onChange={(e) => {
                          const f = e.target.files?.[0] || null;
                          e.target.value = '';
                          void uploadWalletLogo(f);
                        }}
                      />
                    </label>
                    {walletSettings.logoUrl ? (
                      <button
                        type="button"
                        className="btn btn-outline"
                        style={{ color: '#c62828' }}
                        onClick={() => setWalletSettings({ ...walletSettings, logoUrl: '' })}
                      >
                        清除 Logo
                      </button>
                    ) : null}
                  </div>

                  <label className="aw-lab">描述</label>
                  <input
                    className="input"
                    value={walletSettings.description}
                    onChange={(e) => setWalletSettings({ ...walletSettings, description: e.target.value })}
                    style={{ width: '100%' }}
                  />

                  <label className="aw-lab">背景色</label>
                  <div className="aw-color-row">
                    <input
                      type="color"
                      value={rgbToHex(walletSettings.backgroundColor)}
                      onChange={(e) =>
                        setWalletSettings({ ...walletSettings, backgroundColor: hexToRgb(e.target.value) })
                      }
                    />
                    <input
                      className="input"
                      type="text"
                      value={walletSettings.backgroundColor}
                      onChange={(e) => setWalletSettings({ ...walletSettings, backgroundColor: e.target.value })}
                    />
                  </div>

                  <label className="aw-lab">文字色</label>
                  <div className="aw-color-row">
                    <input
                      type="color"
                      value={rgbToHex(walletSettings.foregroundColor)}
                      onChange={(e) =>
                        setWalletSettings({ ...walletSettings, foregroundColor: hexToRgb(e.target.value) })
                      }
                    />
                    <input
                      className="input"
                      type="text"
                      value={walletSettings.foregroundColor}
                      onChange={(e) => setWalletSettings({ ...walletSettings, foregroundColor: e.target.value })}
                    />
                  </div>

                  <label className="aw-lab">标签色</label>
                  <div className="aw-color-row">
                    <input
                      type="color"
                      value={rgbToHex(walletSettings.labelColor)}
                      onChange={(e) =>
                        setWalletSettings({ ...walletSettings, labelColor: hexToRgb(e.target.value) })
                      }
                    />
                    <input
                      className="input"
                      type="text"
                      value={walletSettings.labelColor}
                      onChange={(e) => setWalletSettings({ ...walletSettings, labelColor: e.target.value })}
                    />
                  </div>

                  <label className="aw-lab">附近提醒距离（米，50–5000）</label>
                  <input
                    className="input"
                    type="number"
                    min={50}
                    max={5000}
                    value={walletSettings.maxDistanceMeters}
                    onChange={(e) =>
                      setWalletSettings({
                        ...walletSettings,
                        maxDistanceMeters: Number(e.target.value) || 120,
                      })
                    }
                    style={{ width: 160 }}
                  />

                  <div style={{ fontSize: 13, fontWeight: 600, margin: '14px 0 8px' }}>
                    附近提醒门店（最多 10 家）
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                    {walletStores.map((s) => {
                      const on = walletSettings.storeIds.includes(s._id);
                      const prev = walletLocPreview.find((x) => x.storeId === s._id);
                      return (
                        <label
                          key={s._id}
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 8,
                            padding: 10,
                            border: '1px solid #c5cae9',
                            borderRadius: 8,
                            background: on ? '#e8eaf6' : '#fff',
                          }}
                        >
                          <input type="checkbox" checked={on} onChange={() => toggleWalletStore(s._id)} />
                          <span>
                            <div style={{ fontWeight: 600 }}>{s.displayName}</div>
                            <div style={{ fontSize: 11, color: '#789' }}>
                              {s.slug}
                              {on ? (prev ? (prev.ok ? ' · 坐标 OK' : ' · 坐标未解析') : '') : ''}
                            </div>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
                <button type="button" className="btn btn-primary" onClick={() => void saveWallet()} disabled={walletSaving}>
                  {walletSaving ? '保存中…' : '保存 Wallet 设置'}
                </button>
                <button type="button" className="btn btn-outline" onClick={() => void loadWallet()} disabled={walletLoading}>
                  刷新
                </button>
              </div>
            </>
          )
        ) : null}
      </div>

      <div className="card" style={{ padding: registerOpen ? 20 : '12px 20px', marginBottom: 24 }}>
        <button
          type="button"
          onClick={() => setRegisterOpen((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            gap: 12,
            background: 'none',
            border: 0,
            padding: 0,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16 }}>登记用户</h2>
          <span style={{ fontSize: 13, color: '#5c6bc0', whiteSpace: 'nowrap' }}>
            {registerOpen ? '收起' : '展开'}
          </span>
        </button>
        {registerOpen ? (
          <>
            <p style={{ margin: '12px 0', fontSize: 12, color: '#789', lineHeight: 1.5 }}>
              预建平台客人档案。同一手机号全店通用。要变成某店员工，请在下方列表点开后勾选挂靠店铺。
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <input className="input" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="08xxxxxxxx" />
              <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="姓名（可选）" />
              <button type="button" className="btn btn-primary" onClick={() => void register()} disabled={!newPhone.trim()}>
                登记
              </button>
            </div>
          </>
        ) : null}
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 24 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>用户列表</h2>
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索手机号或姓名"
          style={{ width: '100%', maxWidth: 360, marginBottom: 12 }}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14, alignItems: 'center' }}>
          <FilterChip active={roleFilter === 'all'} onClick={() => setRoleFilter('all')}>
            {`全部 ${rows.length}`}
          </FilterChip>
          <FilterChip active={roleFilter === 'guest'} onClick={() => setRoleFilter('guest')}>
            {`仅客人 ${guestOnlyCount}`}
          </FilterChip>
          <FilterChip active={roleFilter === 'staff'} onClick={() => setRoleFilter('staff')}>
            {`已挂靠员工 ${staffCount}`}
          </FilterChip>
        </div>
        {listLoading ? <div style={{ color: '#789', marginBottom: 8 }}>搜索中…</div> : null}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#5c6bc0' }}>
              <th style={{ padding: '8px 4px' }}>会员号</th>
              <th style={{ padding: '8px 4px' }}>身份</th>
              <th style={{ padding: '8px 4px' }}>手机</th>
              <th style={{ padding: '8px 4px' }}>姓名</th>
              <th style={{ padding: '8px 4px' }}>客人钱包 €</th>
              <th style={{ padding: '8px 4px' }}>各店员工余额</th>
              <th style={{ padding: '8px 4px' }}>PIN</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => {
              const expanded = detail?._id === r._id;
              const loadingThis = openingId === r._id && !expanded;
              return (
                <Fragment key={r._id}>
                  <tr
                    onClick={() => toggleDetail(r._id)}
                    style={{
                      cursor: 'pointer',
                      borderTop: '1px solid #e8eaf6',
                      background: expanded || loadingThis ? '#eef0fb' : undefined,
                    }}
                  >
                    <td style={{ padding: '8px 4px' }}>{r.memberNo ? `#${r.memberNo}` : '—'}</td>
                    <td style={{ padding: '8px 4px' }}>
                      <MemberRoleTags staffStoreCount={r.staffStoreCount} />
                    </td>
                    <td style={{ padding: '8px 4px' }}>{r.phone}</td>
                    <td style={{ padding: '8px 4px' }}>{r.displayName || '—'}</td>
                    <td style={{ padding: '8px 4px' }}>{r.creditBalance.toFixed(2)}</td>
                    <td style={{ padding: '8px 4px' }}>
                      <StaffBalancesCell stores={r.staffStores} />
                    </td>
                    <td style={{ padding: '8px 4px' }}>{r.hasPin ? '已设' : '未设'}</td>
                  </tr>
                  {loadingThis ? (
                    <tr>
                      <td colSpan={7} style={{ padding: '12px 16px', background: '#f7f8ff', color: '#789', borderTop: '1px solid #e8eaf6' }}>
                        加载中…
                      </td>
                    </tr>
                  ) : null}
                  {expanded && detail ? (
                    <tr>
                      <td
                        colSpan={7}
                        style={{ padding: 16, background: '#f7f8ff', borderTop: '1px solid #c5cae9', verticalAlign: 'top' }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 12 }}>
                          <MemberRoleTags staffStoreCount={staffIds.length} />
                          <span style={{ fontSize: 13, color: '#546e7a' }}>
                            客人钱包 €{detail.creditBalance.toFixed(2)} · 状态 {detail.status}
                            {staffIds.length > 0 ? ` · 已挂靠 ${staffIds.length} 家店` : ' · 未挂靠店铺（仅客人）'}
                          </span>
                          <button
                            type="button"
                            className="btn btn-outline"
                            style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: 12 }}
                            onClick={() => setDetail(null)}
                          >
                            收起
                          </button>
                        </div>
                        <label style={{ display: 'block', fontSize: 12, color: '#789', marginBottom: 6 }}>姓名</label>
                        <input className="input" value={detailName} onChange={(e) => setDetailName(e.target.value)} style={{ maxWidth: 320, marginBottom: 16 }} />

                        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>客人钱包充值 / 扣减</div>
                        <p style={{ fontSize: 12, color: '#789', margin: '0 0 10px' }}>
                          正数充值、负数扣减，只动客人钱包。扣减记为调整，不计入店铺消费结算。不能扣成负数。
                        </p>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16, alignItems: 'flex-end' }}>
                          <div>
                            <label style={{ display: 'block', fontSize: 12, color: '#789', marginBottom: 4 }}>金额 (€)</label>
                            <input
                              className="input"
                              type="number"
                              step="0.01"
                              value={guestCreditAmount}
                              onChange={(e) => setGuestCreditAmount(e.target.value)}
                              placeholder="例如 -10"
                              style={{ width: 140 }}
                            />
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: 12, color: '#789', marginBottom: 4 }}>备注（可选）</label>
                            <input
                              className="input"
                              value={guestCreditNote}
                              onChange={(e) => setGuestCreditNote(e.target.value)}
                              placeholder="平台手动充值 / 扣减客人钱包"
                              style={{ width: 240 }}
                            />
                          </div>
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => void creditGuestWallet()}
                            disabled={guestCreditSaving || detail.status !== 'active'}
                          >
                            {guestCreditSaving
                              ? '处理中…'
                              : parseFloat(guestCreditAmount) < 0
                                ? '确认扣减'
                                : '确认充值'}
                          </button>
                        </div>

                        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>员工 PIN</div>
                        <p style={{ fontSize: 12, color: '#789', margin: '0 0 10px' }}>
                          {detail.hasPin ? '已设置。在此输入新 PIN 可覆盖（4–12 位数字）。不会回显原 PIN。' : '尚未设置。收银识别员工需要 PIN。'}
                        </p>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16, alignItems: 'center' }}>
                          <input
                            className="input"
                            type="password"
                            inputMode="numeric"
                            autoComplete="new-password"
                            value={pin1}
                            onChange={(e) => setPin1(e.target.value)}
                            placeholder="新 PIN"
                            style={{ width: 140 }}
                          />
                          <input
                            className="input"
                            type="password"
                            inputMode="numeric"
                            autoComplete="new-password"
                            value={pin2}
                            onChange={(e) => setPin2(e.target.value)}
                            placeholder="再输入一次"
                            style={{ width: 140 }}
                          />
                          <button type="button" className="btn btn-outline" onClick={() => void savePin()} disabled={pinSaving || !pin1}>
                            {pinSaving ? '保存中…' : (detail.hasPin ? '更新 PIN' : '设置 PIN')}
                          </button>
                        </div>

                        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>各店员工剩余额度</div>
                        {detail.staffStores.length === 0 ? (
                          <p style={{ fontSize: 12, color: '#90a4ae', margin: '0 0 16px' }}>尚未挂靠店铺，没有员工额度。</p>
                        ) : (
                          <table style={{ width: '100%', maxWidth: 520, borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
                            <thead>
                              <tr style={{ textAlign: 'left', color: '#5c6bc0' }}>
                                <th style={{ padding: '6px 4px' }}>店铺</th>
                                <th style={{ padding: '6px 4px' }}>slug</th>
                                <th style={{ padding: '6px 4px', textAlign: 'right' }}>剩余 €</th>
                              </tr>
                            </thead>
                            <tbody>
                              {detail.staffStores.map((s) => (
                                <tr key={s.storeId} style={{ borderTop: '1px solid #e8eaf6' }}>
                                  <td style={{ padding: '6px 4px', fontWeight: 600 }}>{s.displayName || '—'}</td>
                                  <td style={{ padding: '6px 4px', color: '#789' }}>{s.slug || '—'}</td>
                                  <td style={{ padding: '6px 4px', textAlign: 'right', fontWeight: 700 }}>
                                    {Number(s.staffBalance).toFixed(2)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}

                        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>员工挂靠店铺</div>
                        <p style={{ fontSize: 12, color: '#789', margin: '0 0 10px' }}>勾选后该店可给此人本店员工加额度。取消挂靠不会清掉已有员工余额。</p>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8, marginBottom: 16 }}>
                          {detail.allStores.map((s) => {
                            const bal = detail.staffStores.find((x) => x.storeId === s._id)?.staffBalance ?? 0;
                            const on = staffIds.includes(s._id);
                            return (
                              <label key={s._id} style={{
                                display: 'flex', alignItems: 'flex-start', gap: 8, padding: 10,
                                border: '1px solid #c5cae9', borderRadius: 8, background: on ? '#e8eaf6' : '#fff',
                              }}>
                                <input type="checkbox" checked={on} onChange={() => toggleStaff(s._id)} />
                                <span>
                                  <div style={{ fontWeight: 600 }}>{s.displayName}</div>
                                  <div style={{ fontSize: 11, color: '#789' }}>{s.slug}{on ? ` · 员工余额 €${bal.toFixed(2)}` : ''}</div>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                        <button type="button" className="btn btn-primary" onClick={() => void saveDetail()} disabled={detailSaving}>
                          {detailSaving ? '保存中…' : '保存姓名与挂靠'}
                        </button>

                        <div style={{ marginTop: 20, marginBottom: 8 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Apple Wallet 测试卡</div>
                          <p style={{ fontSize: 12, color: '#789', margin: '0 0 10px' }}>
                            下载 .pkpass 到 Mac/iPhone 验证签名与卡面（需已启用并配置证书）。
                          </p>
                          <button
                            type="button"
                            className="btn btn-outline"
                            disabled={walletPassBusyId === detail._id || detail.status !== 'active'}
                            onClick={() => void downloadMemberPass(detail._id)}
                          >
                            {walletPassBusyId === detail._id ? '生成中…' : '下载会员 .pkpass'}
                          </button>
                        </div>

                        <h3 style={{ margin: '24px 0 8px', fontSize: 15 }}>消费 / 流水</h3>
                        {detail.txns.length === 0 ? (
                          <div style={{ fontSize: 13, color: '#90a4ae' }}>暂无平台流水（充值与到店核销接上后会出现）</div>
                        ) : (
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                            <thead>
                              <tr style={{ textAlign: 'left', color: '#5c6bc0' }}>
                                <th style={{ padding: '6px 4px' }}>时间</th>
                                <th style={{ padding: '6px 4px' }}>钱包</th>
                                <th style={{ padding: '6px 4px' }}>店铺</th>
                                <th style={{ padding: '6px 4px' }}>类型</th>
                                <th style={{ padding: '6px 4px' }}>金额</th>
                                <th style={{ padding: '6px 4px' }}>余额后</th>
                                <th style={{ padding: '6px 4px' }}>备注</th>
                              </tr>
                            </thead>
                            <tbody>
                              {detail.txns.map((t) => (
                                <tr key={t._id} style={{ borderTop: '1px solid #e8eaf6' }}>
                                  <td style={{ padding: '6px 4px' }}>{t.createdAt ? new Date(t.createdAt).toLocaleString() : ''}</td>
                                  <td style={{ padding: '6px 4px' }}>{t.wallet === 'staff' ? '员工' : '客人'}</td>
                                  <td style={{ padding: '6px 4px' }}>{txnStoreLabel(t)}</td>
                                  <td style={{ padding: '6px 4px' }}>{txnTypeLabel(t.type)}</td>
                                  <td style={{ padding: '6px 4px' }}>{Number(t.amountEuro).toFixed(2)}</td>
                                  <td style={{ padding: '6px 4px' }}>{Number(t.balanceAfter).toFixed(2)}</td>
                                  <td style={{ padding: '6px 4px' }}>{t.note || '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
            {!listLoading && rows.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: 16, color: '#90a4ae' }}>暂无平台会员（与各店旧会员、送餐客户分开）</td></tr>
            ) : null}
            {!listLoading && rows.length > 0 && visibleRows.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: 16, color: '#90a4ae' }}>没有符合筛选的用户</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
