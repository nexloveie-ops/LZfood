import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { platformApiFetch } from '../../api/client';
import './platform-gift-cards.css';

type Tab = 'cards' | 'settlement';
type SettleChannel = 'wallet' | 'tap_pay';

type CardRow = {
  _id: string;
  cardCode: string;
  batch: string;
  amountEuro: number | null;
  status: string;
  pinFailedAttempts?: number;
  usedAt?: string | null;
  usedByMemberId?: string | null;
  usedBy?: { phone?: string; displayName?: string } | null;
  activatedAt?: string | null;
  wholesaleStoreId?: string | null;
  createdAt?: string;
};

type CardDetail = CardRow & {
  pinFailures?: { at: string; memberId?: string | null; reason?: string }[];
};

type StatsBody = {
  totalCount: number;
  byStatus: Record<string, { count: number; faceValue: number }>;
};

type BatchRow = {
  batch: string;
  count: number;
  inactive: number;
  active: number;
  used: number;
  locked: number;
  faceValue: number;
  createdAt?: string | null;
  wholesaleStoreId?: string | null;
};

type StoreOpt = { _id: string; slug: string; displayName: string };

type SettlementRow = {
  storeId: string;
  slug: string;
  displayName: string;
  status: string;
  channel?: SettleChannel;
  consumedEuro: number;
  paidEuro: number;
  outstandingEuro: number;
  lastPaidAt: string | null;
  payoutCount: number;
};

type PayoutRow = {
  _id: string;
  amountEuro: number;
  paidAt: string;
  method: string;
  ref: string;
  note: string;
  createdAt?: string;
};

type GenRow = { cardCode: string; pin: string };

function errMsg(j: unknown, fallback: string): string {
  const m = (j as { error?: { message?: string } } | null)?.error?.message;
  return m || fallback;
}

function euro(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return `€${Number(n).toFixed(2)}`;
}

function fmtDt(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IE', { timeZone: 'Europe/Dublin' });
}

function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IE', { timeZone: 'Europe/Dublin' });
}

function statusLabel(st: string): string {
  if (st === 'inactive') return '未激活';
  if (st === 'active') return '已激活';
  if (st === 'used') return '已核销';
  if (st === 'locked') return '已锁定';
  return st;
}

function methodLabel(m: string): string {
  if (m === 'bank_transfer') return '银行转账';
  if (m === 'cash') return '现金';
  if (m === 'other') return '其他';
  return m;
}

function StatusPill({ status }: { status: string }) {
  const cls =
    status === 'active' ? 'pgc-pill-active'
    : status === 'used' ? 'pgc-pill-used'
    : status === 'locked' ? 'pgc-pill-locked'
    : 'pgc-pill-inactive';
  return <span className={`pgc-pill ${cls}`}>{statusLabel(status)}</span>;
}

async function downloadBlobResponse(res: Response, filename: string): Promise<void> {
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function TabChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button type="button" className={`pgc-tab${active ? ' is-on' : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}

export default function PlatformGiftCardsPage() {
  const [tab, setTab] = useState<Tab>('cards');
  const [settleChannel, setSettleChannel] = useState<SettleChannel>('wallet');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [stores, setStores] = useState<StoreOpt[]>([]);

  const [stats, setStats] = useState<StatsBody | null>(null);
  const [batchLabel, setBatchLabel] = useState('');
  const [genCount, setGenCount] = useState('20');
  const [downloadXlsx, setDownloadXlsx] = useState(true);
  const [wholesaleStoreId, setWholesaleStoreId] = useState('');
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [openBatch, setOpenBatch] = useState<string | null>(null);
  const [batchCards, setBatchCards] = useState<CardRow[]>([]);
  const [batchCardsLoading, setBatchCardsLoading] = useState(false);
  const [codeQuery, setCodeQuery] = useState('');
  const [codeHits, setCodeHits] = useState<CardRow[] | null>(null);
  const [hitCodes, setHitCodes] = useState<Set<string>>(() => new Set());
  const [codeSearchBusy, setCodeSearchBusy] = useState(false);
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [freshPin, setFreshPin] = useState<{ cardId: string; cardCode: string; pin: string } | null>(null);
  const [resetPinBusy, setResetPinBusy] = useState(false);
  const [oneActivateAmt, setOneActivateAmt] = useState('');
  const [batchActivateAmt, setBatchActivateAmt] = useState('');
  const [batchActivateBusy, setBatchActivateBusy] = useState(false);
  const [lastGen, setLastGen] = useState<{ batch: string; rows: GenRow[] } | null>(null);
  const [copyFeedback, setCopyFeedback] = useState('');
  const [genBusy, setGenBusy] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [importBatch, setImportBatch] = useState('');
  const [importText, setImportText] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importAmt, setImportAmt] = useState('');
  const [importWholesale, setImportWholesale] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; skippedCount: number; skipped: { cardCode?: string; reason: string }[] } | null>(null);

  const [settlements, setSettlements] = useState<SettlementRow[]>([]);
  const [settleLoading, setSettleLoading] = useState(false);
  const [openStoreId, setOpenStoreId] = useState<string | null>(null);
  const [payouts, setPayouts] = useState<PayoutRow[]>([]);
  const [payoutOutstanding, setPayoutOutstanding] = useState<number | null>(null);
  const [payoutsLoading, setPayoutsLoading] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payAt, setPayAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [payMethod, setPayMethod] = useState<'bank_transfer' | 'cash' | 'other'>('bank_transfer');
  const [payRef, setPayRef] = useState('');
  const [payNote, setPayNote] = useState('');
  const [payBusy, setPayBusy] = useState(false);

  const storeName = useCallback(
    (id?: string | null) => {
      if (!id) return '';
      const s = stores.find((x) => x._id === id);
      if (!s) return id;
      return s.displayName && s.slug && s.displayName !== s.slug ? `${s.displayName} (${s.slug})` : s.displayName || s.slug;
    },
    [stores],
  );

  const loadStores = useCallback(async () => {
    const res = await platformApiFetch('/api/platform/stores');
    if (!res.ok) return;
    const list = (await res.json()) as StoreOpt[];
    setStores(Array.isArray(list) ? list.map((s) => ({ _id: String(s._id), slug: s.slug || '', displayName: s.displayName || '' })) : []);
  }, []);

  const loadStats = useCallback(async () => {
    const res = await platformApiFetch('/api/platform/gift-cards/stats');
    if (!res.ok) return;
    setStats(await res.json());
  }, []);

  const loadBatches = useCallback(async () => {
    setLoading(true);
    try {
      const res = await platformApiFetch('/api/platform/gift-cards/batches');
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setErr(errMsg(d, `HTTP ${res.status}`));
        return;
      }
      const body = d as { items?: BatchRow[] };
      setBatches(Array.isArray(body.items) ? body.items : []);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBatchCards = useCallback(async (batch: string) => {
    setBatchCardsLoading(true);
    try {
      const params = new URLSearchParams({ limit: '300', batch });
      const res = await platformApiFetch(`/api/platform/gift-cards?${params}`);
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setErr(errMsg(d, `HTTP ${res.status}`));
        return;
      }
      const body = d as { items?: CardRow[] };
      setBatchCards(Array.isArray(body.items) ? body.items : []);
    } finally {
      setBatchCardsLoading(false);
    }
  }, []);

  const searchCardCode = async () => {
    const q = codeQuery.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!q) {
      setCodeHits(null);
      setHitCodes(new Set());
      return;
    }
    setErr('');
    setCodeSearchBusy(true);
    try {
      const params = new URLSearchParams({ cardCode: q, limit: '50' });
      const res = await platformApiFetch(`/api/platform/gift-cards?${params}`);
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setErr(errMsg(d, `HTTP ${res.status}`));
        return;
      }
      const items = Array.isArray((d as { items?: CardRow[] }).items) ? (d as { items: CardRow[] }).items : [];
      setCodeHits(items);
      setHitCodes(new Set(items.map((c) => c.cardCode)));
      if (items.length === 0) return;
      const batch = items[0].batch;
      setOpenBatch(batch);
      setDetail(null);
      setBatchActivateAmt('');
      await loadBatchCards(batch);
      if (items.length === 1) await openDetail(items[0]._id);
    } finally {
      setCodeSearchBusy(false);
    }
  };

  const loadSettlements = useCallback(async () => {
    setSettleLoading(true);
    try {
      const params = new URLSearchParams({ channel: settleChannel });
      const res = await platformApiFetch(`/api/platform/store-settlements?${params}`);
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setErr(errMsg(d, `HTTP ${res.status}`));
        return;
      }
      setSettlements(Array.isArray((d as { items?: SettlementRow[] }).items) ? (d as { items: SettlementRow[] }).items : []);
    } finally {
      setSettleLoading(false);
    }
  }, [settleChannel]);

  const loadPayouts = useCallback(async (storeId: string) => {
    setPayoutsLoading(true);
    try {
      const params = new URLSearchParams({ channel: settleChannel });
      const res = await platformApiFetch(`/api/platform/store-settlements/${storeId}/payouts?${params}`);
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setErr(errMsg(d, `HTTP ${res.status}`));
        return;
      }
      const body = d as { items?: PayoutRow[]; outstandingEuro?: number };
      setPayouts(Array.isArray(body.items) ? body.items : []);
      setPayoutOutstanding(typeof body.outstandingEuro === 'number' ? body.outstandingEuro : null);
    } finally {
      setPayoutsLoading(false);
    }
  }, [settleChannel]);

  useEffect(() => {
    void loadStores();
    void loadStats();
  }, [loadStores, loadStats]);

  useEffect(() => {
    if (tab === 'cards') void loadBatches();
    else void loadSettlements();
  }, [tab, loadBatches, loadSettlements]);

  useEffect(() => {
    if (tab !== 'settlement') return;
    setOpenStoreId(null);
    setPayouts([]);
    setPayoutOutstanding(null);
  }, [settleChannel, tab]);

  const tsvForClipboard = useMemo(() => {
    if (!lastGen?.rows.length) return '';
    const h = '卡号\tPIN';
    const b = lastGen.rows.map((r) => `${r.cardCode}\t${r.pin}`).join('\n');
    return `${h}\n${b}`;
  }, [lastGen]);

  const copyGenTsv = async () => {
    if (!tsvForClipboard) return;
    try {
      await navigator.clipboard.writeText(tsvForClipboard);
      setCopyFeedback('已复制到剪贴板');
      window.setTimeout(() => setCopyFeedback(''), 2500);
    } catch {
      setCopyFeedback('复制失败，请手动选中表格');
      window.setTimeout(() => setCopyFeedback(''), 3000);
    }
  };

  const doGenerate = async () => {
    const batch = batchLabel.trim();
    if (!batch) {
      setErr('请填写批次名称');
      return;
    }
    const count = Math.min(300, Math.max(1, parseInt(genCount, 10) || 0));
    setErr('');
    setMsg('');
    setLastGen(null);
    setGenBusy(true);
    try {
      const body: { count: number; batch: string; download?: boolean; wholesaleStoreId?: string } = { count, batch };
      if (wholesaleStoreId) body.wholesaleStoreId = wholesaleStoreId;
      if (downloadXlsx) body.download = true;
      const res = await platformApiFetch('/api/platform/gift-cards/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setErr(errMsg(d, `HTTP ${res.status}`));
        return;
      }
      if (downloadXlsx) {
        await downloadBlobResponse(res, `platform-gift-cards-${batch}-${Date.now()}.xlsx`);
        setMsg(`已发行 ${count} 张并下载 Excel（PIN 只出现在这次文件里）`);
      } else {
        const d = (await res.json()) as { batch?: string; count?: number; rows?: GenRow[] };
        const rows = Array.isArray(d.rows) ? d.rows : [];
        setLastGen({ batch: String(d.batch || batch), rows });
        setMsg(`已发行 ${Number(d.count) || rows.length} 张（PIN 只显示这一次）`);
      }
      setGenOpen(true);
      await Promise.all([loadBatches(), loadStats()]);
    } finally {
      setGenBusy(false);
    }
  };

  const doImport = async () => {
    const batch = importBatch.trim();
    if (!batch) {
      setErr('请填写导入批次名称');
      return;
    }
    if (!importFile && !importText.trim()) {
      setErr('请粘贴卡号和 PIN，或选择原来的 Excel');
      return;
    }
    setErr('');
    setMsg('');
    setImportResult(null);
    setImportBusy(true);
    try {
      let res: Response;
      if (importFile) {
        const fd = new FormData();
        fd.append('batch', batch);
        fd.append('file', importFile);
        if (importWholesale) fd.append('wholesaleStoreId', importWholesale);
        if (importAmt.trim()) fd.append('amountEuro', importAmt.trim());
        if (importText.trim()) fd.append('text', importText.trim());
        res = await platformApiFetch('/api/platform/gift-cards/import', { method: 'POST', body: fd });
      } else {
        const body: { batch: string; text: string; wholesaleStoreId?: string; amountEuro?: number } = {
          batch,
          text: importText,
        };
        if (importWholesale) body.wholesaleStoreId = importWholesale;
        const amt = parseFloat(importAmt);
        if (Number.isFinite(amt) && amt > 0) body.amountEuro = amt;
        res = await platformApiFetch('/api/platform/gift-cards/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setErr(errMsg(d, `HTTP ${res.status}`));
        return;
      }
      const body = d as {
        imported?: number;
        skippedCount?: number;
        skipped?: { cardCode?: string; reason: string }[];
      };
      const imported = Number(body.imported) || 0;
      const skippedCount = Number(body.skippedCount) || 0;
      setImportResult({
        imported,
        skippedCount,
        skipped: Array.isArray(body.skipped) ? body.skipped : [],
      });
      setMsg(`已导入 ${imported} 张${skippedCount ? `，跳过 ${skippedCount} 张` : ''}`);
      setImportOpen(true);
      setImportText('');
      setImportFile(null);
      await Promise.all([loadBatches(), loadStats()]);
    } finally {
      setImportBusy(false);
    }
  };

  const toggleBatch = async (batch: string) => {
    if (openBatch === batch) {
      setOpenBatch(null);
      setBatchCards([]);
      setDetail(null);
      return;
    }
    setOpenBatch(batch);
    setDetail(null);
    setBatchActivateAmt('');
    await loadBatchCards(batch);
  };

  const activateBatch = async () => {
    if (!openBatch) return;
    const amt = parseFloat(batchActivateAmt);
    if (!Number.isFinite(amt) || amt <= 0) {
      setErr('请填写有效面额');
      return;
    }
    setErr('');
    setBatchActivateBusy(true);
    try {
      const res = await platformApiFetch('/api/platform/gift-cards/activate-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch: openBatch, amountEuro: amt }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setErr(errMsg(d, `HTTP ${res.status}`));
        return;
      }
      const body = d as { modified?: number };
      setMsg(`批次「${openBatch}」已激活 ${Number(body.modified) || 0} 张 · ${euro(amt)}`);
      await Promise.all([loadBatches(), loadStats(), loadBatchCards(openBatch)]);
    } finally {
      setBatchActivateBusy(false);
    }
  };

  const openDetail = async (id: string) => {
    if (detail?._id === id) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    setOneActivateAmt('');
    if (freshPin && freshPin.cardId !== id) setFreshPin(null);
    try {
      const res = await platformApiFetch(`/api/platform/gift-cards/${id}`);
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setErr(errMsg(d, `HTTP ${res.status}`));
        return;
      }
      setDetail(d as CardDetail);
    } finally {
      setDetailLoading(false);
    }
  };

  const activateOne = async () => {
    if (!detail) return;
    const amt = parseFloat(oneActivateAmt);
    if (!Number.isFinite(amt) || amt <= 0) return;
    const res = await platformApiFetch(`/api/platform/gift-cards/${detail._id}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountEuro: amt }),
    });
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      setErr(errMsg(d, `HTTP ${res.status}`));
      return;
    }
    setMsg(`卡 ${detail.cardCode} 已激活 ${euro(amt)}`);
    setDetail(null);
    await Promise.all([loadBatches(), loadStats(), openBatch ? loadBatchCards(openBatch) : Promise.resolve()]);
  };

  const lockOne = async () => {
    if (!detail || detail.status !== 'active') return;
    if (!window.confirm(`锁定后无法充值。确认挂失锁定卡 ${detail.cardCode}？`)) return;
    const res = await platformApiFetch(`/api/platform/gift-cards/${detail._id}/lock`, { method: 'POST' });
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      setErr(errMsg(d, `HTTP ${res.status}`));
      return;
    }
    setMsg(`卡 ${detail.cardCode} 已锁定，无法充值`);
    setDetail(null);
    await Promise.all([loadBatches(), loadStats(), openBatch ? loadBatchCards(openBatch) : Promise.resolve()]);
  };

  const resetPinOne = async () => {
    if (!detail || detail.status !== 'locked') return;
    if (!window.confirm(`旧 PIN 将立即失效，新 PIN 只显示一次。确认给卡 ${detail.cardCode} 生成新 PIN？`)) return;
    setResetPinBusy(true);
    try {
      const res = await platformApiFetch(`/api/platform/gift-cards/${detail._id}/reset-pin`, { method: 'POST' });
      const d = await res.json().catch(() => null) as { cardCode?: string; pin?: string } | null;
      if (!res.ok) {
        setErr(errMsg(d, `HTTP ${res.status}`));
        return;
      }
      const pin = String(d?.pin || '');
      const cardCode = String(d?.cardCode || detail.cardCode);
      if (!pin) {
        setErr('已生成但未返回 PIN，请勿重复操作');
        return;
      }
      setFreshPin({ cardId: detail._id, cardCode, pin });
      setMsg(`卡 ${cardCode} 已生成新 PIN（只显示一次）`);
    } finally {
      setResetPinBusy(false);
    }
  };

  const copyFreshPin = async () => {
    if (!freshPin) return;
    try {
      await navigator.clipboard.writeText(`${freshPin.cardCode}\t${freshPin.pin}`);
      setCopyFeedback('已复制');
      window.setTimeout(() => setCopyFeedback(''), 1600);
    } catch {
      setCopyFeedback('复制失败');
    }
  };

  const unlockOne = async () => {
    if (!detail) return;
    const res = await platformApiFetch(`/api/platform/gift-cards/${detail._id}/unlock`, { method: 'POST' });
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      setErr(errMsg(d, `HTTP ${res.status}`));
      return;
    }
    setMsg(`卡 ${detail.cardCode} 已解锁`);
    setDetail(null);
    await Promise.all([loadBatches(), loadStats(), openBatch ? loadBatchCards(openBatch) : Promise.resolve()]);
  };

  const exportXlsx = async (batch?: string) => {
    const params = new URLSearchParams();
    if (batch) params.set('batch', batch);
    const res = await platformApiFetch(`/api/platform/gift-cards-export.xlsx?${params}`);
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      setErr(errMsg(d, `HTTP ${res.status}`));
      return;
    }
    await downloadBlobResponse(res, `platform-gift-cards-export-${Date.now()}.xlsx`);
  };

  const toggleStore = async (storeId: string) => {
    if (openStoreId === storeId) {
      setOpenStoreId(null);
      setPayouts([]);
      return;
    }
    setOpenStoreId(storeId);
    setPayAmount('');
    setPayRef('');
    setPayNote('');
    await loadPayouts(storeId);
  };

  const addPayout = async () => {
    if (!openStoreId) return;
    const amt = parseFloat(payAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setErr('请填写有效支付金额');
      return;
    }
    if (payMethod === 'bank_transfer' && !payRef.trim()) {
      setErr('银行转账请填写 ref');
      return;
    }
    setErr('');
    setPayBusy(true);
    try {
      const res = await platformApiFetch(`/api/platform/store-settlements/${openStoreId}/payouts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amountEuro: amt,
          paidAt: payAt ? new Date(`${payAt}T12:00:00`).toISOString() : undefined,
          method: payMethod,
          ref: payRef.trim(),
          note: payNote.trim(),
          channel: settleChannel,
        }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setErr(errMsg(d, `HTTP ${res.status}`));
        return;
      }
      setMsg(`已记录支付 ${euro(amt)}`);
      setPayAmount('');
      setPayRef('');
      setPayNote('');
      await Promise.all([loadSettlements(), loadPayouts(openStoreId)]);
    } finally {
      setPayBusy(false);
    }
  };

  const openStore = settlements.find((s) => s.storeId === openStoreId) || null;
  const by = stats?.byStatus || {};

  return (
    <div className="pgc-page">
      <div className="pgc-head">
        <div>
          <h1>充值卡与结算</h1>
          <p className="pgc-sub">
            充值卡核销进客人钱包；Tap to Pay 由平台 Stripe 代收。店铺结算按渠道分开记账（逻辑相同：消耗 − 已付 = 待付）。打款为人工记录，不会自动转账。
          </p>
        </div>
        <div className="pgc-tabs">
          <TabChip active={tab === 'cards'} onClick={() => setTab('cards')}>充值卡</TabChip>
          <TabChip active={tab === 'settlement'} onClick={() => setTab('settlement')}>店铺结算</TabChip>
        </div>
      </div>

      {err ? <div className="pgc-banner pgc-banner-err">{err}</div> : null}
      {msg ? <div className="pgc-banner pgc-banner-ok">{msg}</div> : null}

      {tab === 'cards' ? (
        <>
          <div className="pgc-stats">
            {(['inactive', 'active', 'used', 'locked'] as const).map((st) => (
              <div key={st} className="pgc-stat">
                <div className="pgc-stat-k">{statusLabel(st)}</div>
                <div className="pgc-stat-v">{by[st]?.count ?? 0}</div>
                <div className="pgc-stat-s">面额 {euro(by[st]?.faceValue ?? 0)}</div>
              </div>
            ))}
            <div className="pgc-stat">
              <div className="pgc-stat-k">合计</div>
              <div className="pgc-stat-v">{stats?.totalCount ?? 0}</div>
              <div className="pgc-stat-s">张</div>
            </div>
          </div>

          <div className="pgc-card">
            <div className="pgc-card-hd">
              <h2>批次列表 {batches.length ? `(${batches.length})` : ''}</h2>
              <div className="pgc-search">
                <input
                  className="input"
                  value={codeQuery}
                  onChange={(e) => setCodeQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void searchCardCode();
                    }
                  }}
                  placeholder="搜索卡号"
                  aria-label="搜索卡号"
                  style={{ width: 160 }}
                />
                <button type="button" className="btn btn-primary" onClick={() => void searchCardCode()} disabled={codeSearchBusy}>
                  {codeSearchBusy ? '搜索中…' : '搜索'}
                </button>
                {codeHits != null ? (
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => {
                      setCodeQuery('');
                      setCodeHits(null);
                      setHitCodes(new Set());
                    }}
                  >
                    清除
                  </button>
                ) : null}
                <button type="button" className="btn btn-outline" onClick={() => void exportXlsx()}>导出全部（无 PIN）</button>
              </div>
            </div>
            <div className="pgc-table-wrap">
              {codeHits != null ? (
                <div className="pgc-search-hits">
                  {codeHits.length === 0
                    ? '未找到该卡号'
                    : `找到 ${codeHits.length} 张${codeHits.length === 1 ? ` · 批次 ${codeHits[0].batch}` : ''}`}
                  {codeHits.length > 1 ? (
                    <div className="pgc-search-hit-list">
                      {codeHits.slice(0, 12).map((c) => (
                        <button
                          key={c._id}
                          type="button"
                          className="pgc-search-hit"
                          onClick={() => {
                            void (async () => {
                              setOpenBatch(c.batch);
                              setDetail(null);
                              setBatchActivateAmt('');
                              await loadBatchCards(c.batch);
                            })();
                          }}
                        >
                          <span className="pgc-mono">{c.cardCode}</span>
                          <span className="pgc-muted">{c.batch}</span>
                          <StatusPill status={c.status} />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {loading ? <div className="pgc-loading" style={{ padding: '12px 18px' }}>加载中…</div> : null}
              <table className="pgc-table">
                <thead>
                  <tr>
                    <th>批次</th>
                    <th>张数</th>
                    <th>未激活</th>
                    <th>已激活</th>
                    <th>已核销</th>
                    <th>已锁定</th>
                    <th>面额合计</th>
                    <th>批发店</th>
                    <th>创建</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => {
                    const expanded = openBatch === b.batch;
                    return (
                      <Fragment key={b.batch}>
                        <tr className={`pgc-row${expanded ? ' is-open' : ''}`} onClick={() => void toggleBatch(b.batch)}>
                          <td className="pgc-name">{b.batch}</td>
                          <td className="pgc-num">{b.count}</td>
                          <td className="pgc-num">{b.inactive}</td>
                          <td className="pgc-num">{b.active}</td>
                          <td className="pgc-num">{b.used}</td>
                          <td className="pgc-num">{b.locked}</td>
                          <td className="pgc-num">{euro(b.faceValue)}</td>
                          <td>{storeName(b.wholesaleStoreId) || <span className="pgc-muted">—</span>}</td>
                          <td className="pgc-muted">{fmtDate(b.createdAt)}</td>
                        </tr>
                        {expanded ? (
                          <tr className="pgc-expand">
                            <td colSpan={9} onClick={(e) => e.stopPropagation()}>
                              <div className="pgc-nested">
                                <div className="pgc-nested-actions">
                                  {b.inactive > 0 ? (
                                    <>
                                      <div className="pgc-field">
                                        <label htmlFor="pgc-batch-amt">激活未激活卡 · 面额 €</label>
                                        <input
                                          id="pgc-batch-amt"
                                          className="input"
                                          value={batchActivateAmt}
                                          onChange={(e) => setBatchActivateAmt(e.target.value)}
                                          style={{ width: 120 }}
                                        />
                                      </div>
                                      <button
                                        type="button"
                                        className="btn btn-primary"
                                        onClick={() => void activateBatch()}
                                        disabled={batchActivateBusy}
                                      >
                                        {batchActivateBusy ? '激活中…' : `激活 ${b.inactive} 张`}
                                      </button>
                                    </>
                                  ) : null}
                                  <button type="button" className="btn btn-outline" onClick={() => void exportXlsx(b.batch)}>
                                    导出本批（无 PIN）
                                  </button>
                                </div>
                                {freshPin && detail?._id !== freshPin.cardId ? (
                                  <div className="pgc-fresh-pin">
                                    <div className="pgc-fresh-pin-k">新 PIN（只显示一次）</div>
                                    <div className="pgc-fresh-pin-v pgc-mono">{freshPin.cardCode} · {freshPin.pin}</div>
                                    <button type="button" className="btn btn-outline" onClick={() => void copyFreshPin()}>
                                      {copyFeedback || '复制'}
                                    </button>
                                    <button type="button" className="btn btn-outline" onClick={() => setFreshPin(null)}>
                                      已记下
                                    </button>
                                  </div>
                                ) : null}
                                {batchCardsLoading ? <div className="pgc-loading">加载卡…</div> : null}
                                <table className="pgc-table">
                                  <thead>
                                    <tr>
                                      <th>卡号</th>
                                      <th>面额</th>
                                      <th>状态</th>
                                      <th>核销</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {batchCards.map((r) => {
                                      const cardOpen = detail?._id === r._id;
                                      return (
                                        <Fragment key={r._id}>
                                          <tr
                                            className={`pgc-row${cardOpen ? ' is-open' : ''}${hitCodes.has(r.cardCode) ? ' is-hit' : ''}`}
                                            onClick={() => void openDetail(r._id)}
                                          >
                                            <td className="pgc-mono">{r.cardCode}</td>
                                            <td className="pgc-num">{euro(r.amountEuro)}</td>
                                            <td><StatusPill status={r.status} /></td>
                                            <td>
                                              {r.usedBy?.phone || r.usedBy?.displayName
                                                ? `${r.usedBy.displayName || ''} ${r.usedBy.phone || ''}`.trim()
                                                : (r.usedAt ? fmtDt(r.usedAt) : <span className="pgc-muted">—</span>)}
                                            </td>
                                          </tr>
                                          {detailLoading && cardOpen ? (
                                            <tr>
                                              <td colSpan={4} className="pgc-loading">加载中…</td>
                                            </tr>
                                          ) : null}
                                          {cardOpen && detail ? (
                                            <tr>
                                              <td colSpan={4}>
                                                <div className="pgc-card-meta">
                                                  创建 {fmtDt(detail.createdAt)} · 激活 {fmtDt(detail.activatedAt)} · PIN 失败 {detail.pinFailedAttempts || 0} 次
                                                </div>
                                                {detail.status === 'inactive' ? (
                                                  <div className="pgc-nested-actions">
                                                    <div className="pgc-field">
                                                      <label htmlFor="pgc-one-amt">设定面额 €</label>
                                                      <input id="pgc-one-amt" className="input" value={oneActivateAmt} onChange={(e) => setOneActivateAmt(e.target.value)} style={{ width: 120 }} />
                                                    </div>
                                                    <button type="button" className="btn btn-primary" onClick={(e) => { e.stopPropagation(); void activateOne(); }}>激活这张</button>
                                                  </div>
                                                ) : null}
                                                {detail.status === 'active' ? (
                                                  <div className="pgc-nested-actions">
                                                    <button type="button" className="btn pgc-btn-lock" onClick={(e) => { e.stopPropagation(); void lockOne(); }}>挂失锁定</button>
                                                    <span className="pgc-muted">丢失后锁定，未充值的卡将无法再充值</span>
                                                  </div>
                                                ) : null}
                                                {detail.status === 'locked' ? (
                                                  <div className="pgc-nested-actions">
                                                    <button type="button" className="btn btn-outline" onClick={(e) => { e.stopPropagation(); void unlockOne(); }}>解锁</button>
                                                    <button type="button" className="btn btn-primary" disabled={resetPinBusy} onClick={(e) => { e.stopPropagation(); void resetPinOne(); }}>
                                                      {resetPinBusy ? '生成中…' : '生成新 PIN'}
                                                    </button>
                                                    <span className="pgc-muted">旧 PIN 立即失效。新 PIN 只显示一次，记下后再解锁充值</span>
                                                  </div>
                                                ) : null}
                                                {freshPin && freshPin.cardId === detail._id ? (
                                                  <div className="pgc-fresh-pin">
                                                    <div className="pgc-fresh-pin-k">新 PIN（只显示一次）</div>
                                                    <div className="pgc-fresh-pin-v pgc-mono">{freshPin.cardCode} · {freshPin.pin}</div>
                                                    <button type="button" className="btn btn-outline" onClick={(e) => { e.stopPropagation(); void copyFreshPin(); }}>
                                                      {copyFeedback || '复制'}
                                                    </button>
                                                    <button type="button" className="btn btn-outline" onClick={(e) => { e.stopPropagation(); setFreshPin(null); }}>
                                                      已记下
                                                    </button>
                                                  </div>
                                                ) : null}
                                                {Array.isArray(detail.pinFailures) && detail.pinFailures.length > 0 ? (
                                                  <div className="pgc-muted" style={{ marginTop: 8 }}>
                                                    {detail.pinFailures.slice(-8).map((f, i) => (
                                                      <div key={`${f.at}-${i}`}>{fmtDt(f.at)} · {f.reason || 'bad_pin'}</div>
                                                    ))}
                                                  </div>
                                                ) : null}
                                              </td>
                                            </tr>
                                          ) : null}
                                        </Fragment>
                                      );
                                    })}
                                    {!batchCardsLoading && batchCards.length === 0 ? (
                                      <tr>
                                        <td colSpan={4} className="pgc-empty">本批暂无卡</td>
                                      </tr>
                                    ) : null}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                  {!loading && batches.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="pgc-empty">暂无批次</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
          <div className="pgc-card">
            <button
              type="button"
              className="pgc-card-hd pgc-card-hd-btn"
              aria-expanded={genOpen}
              onClick={() => setGenOpen((v) => !v)}
            >
              <h2>发行批次</h2>
              <span className="pgc-muted">{genOpen ? '收起' : '展开'}</span>
            </button>
            {genOpen ? (
            <div className="pgc-card-bd">
              <p className="pgc-hint">
                新卡默认未激活、无面额。PIN 只在发行时出现一次。批发到某店只作记录，不会给客人钱包加额。
              </p>
              <div className="pgc-form">
                <div className="pgc-field">
                  <label htmlFor="pgc-batch">批次名称</label>
                  <input id="pgc-batch" className="input" value={batchLabel} onChange={(e) => setBatchLabel(e.target.value)} placeholder="2026-10 礼品卡" />
                </div>
                <div className="pgc-field">
                  <label htmlFor="pgc-count">张数</label>
                  <input id="pgc-count" className="input" value={genCount} onChange={(e) => setGenCount(e.target.value)} style={{ width: 88 }} />
                </div>
                <div className="pgc-field">
                  <label htmlFor="pgc-wholesale">批发店铺（可选）</label>
                  <select id="pgc-wholesale" className="input" value={wholesaleStoreId} onChange={(e) => setWholesaleStoreId(e.target.value)} style={{ minWidth: 180 }}>
                    <option value="">不指定</option>
                    {stores.map((s) => (
                      <option key={s._id} value={s._id}>{s.displayName || s.slug}</option>
                    ))}
                  </select>
                </div>
                <label className="pgc-check">
                  <input type="checkbox" checked={downloadXlsx} onChange={(e) => setDownloadXlsx(e.target.checked)} />
                  下载 Excel（含 PIN）
                </label>
                <button type="button" className="btn btn-primary" onClick={() => void doGenerate()} disabled={genBusy}>
                  {genBusy ? '发行中…' : '发行'}
                </button>
              </div>
              {lastGen?.rows.length ? (
                <div className="pgc-pin">
                  <div className="pgc-pin-hd">
                    <span>本批 PIN（只显示一次）</span>
                    <button type="button" className="btn btn-outline" onClick={() => void copyGenTsv()}>复制卡号+PIN</button>
                    {copyFeedback ? <span className="pgc-ok">{copyFeedback}</span> : null}
                  </div>
                  <div className="pgc-pin-list">
                    {lastGen.rows.map((r) => (
                      <div key={r.cardCode}>{r.cardCode} · {r.pin}</div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            ) : (
              <div className="pgc-card-bd pgc-card-bd-collapsed">生成新卡号和 PIN。</div>
            )}
          </div>
          <div className="pgc-card">
            <button
              type="button"
              className="pgc-card-hd pgc-card-hd-btn"
              aria-expanded={importOpen}
              onClick={() => setImportOpen((v) => !v)}
            >
              <h2>导入已有卡</h2>
              <span className="pgc-muted">{importOpen ? '收起' : '展开'}</span>
            </button>
            {importOpen ? (
            <div className="pgc-card-bd">
              <p className="pgc-hint">
                把原来的卡号和 PIN 登记进来，客人才能核销。PIN 入库后只存哈希，不会再显示。每行：卡号 + PIN（空格 / 逗号 / Tab）。也可上传当初下载的 Excel（需有「卡号」「PIN」列）。已存在的卡号会跳过。
              </p>
              <div className="pgc-form">
                <div className="pgc-field">
                  <label htmlFor="pgc-import-batch">批次名称</label>
                  <input id="pgc-import-batch" className="input" value={importBatch} onChange={(e) => setImportBatch(e.target.value)} placeholder="历史卡-2025" />
                </div>
                <div className="pgc-field">
                  <label htmlFor="pgc-import-amt">面额 €（可选，填写则直接激活）</label>
                  <input id="pgc-import-amt" className="input" value={importAmt} onChange={(e) => setImportAmt(e.target.value)} style={{ width: 140 }} />
                </div>
                <div className="pgc-field">
                  <label htmlFor="pgc-import-wholesale">批发店铺（可选）</label>
                  <select id="pgc-import-wholesale" className="input" value={importWholesale} onChange={(e) => setImportWholesale(e.target.value)} style={{ minWidth: 180 }}>
                    <option value="">不指定</option>
                    {stores.map((s) => (
                      <option key={s._id} value={s._id}>{s.displayName || s.slug}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="pgc-field pgc-field-full" style={{ marginTop: 14 }}>
                <label htmlFor="pgc-import-text">粘贴卡号和 PIN</label>
                <textarea
                  id="pgc-import-text"
                  className="input"
                  rows={6}
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder={'G3RNC8 482910\nKSEQ5K,193847'}
                />
              </div>
              <div className="pgc-form" style={{ marginTop: 12 }}>
                <div className="pgc-field">
                  <label htmlFor="pgc-import-file">或上传 Excel</label>
                  <input
                    id="pgc-import-file"
                    className="input"
                    type="file"
                    accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    onChange={(e) => setImportFile(e.target.files?.[0] || null)}
                  />
                  {importFile ? <span className="pgc-muted">{importFile.name}</span> : null}
                </div>
                <button type="button" className="btn btn-primary" onClick={() => void doImport()} disabled={importBusy}>
                  {importBusy ? '导入中…' : '导入'}
                </button>
              </div>
              {importResult ? (
                <div className="pgc-import-result">
                  <div>成功 {importResult.imported} 张 · 跳过 {importResult.skippedCount} 张</div>
                  {importResult.skipped.length > 0 ? (
                    <div className="pgc-pin-list" style={{ marginTop: 8 }}>
                      {importResult.skipped.slice(0, 40).map((s, i) => (
                        <div key={`${s.cardCode || ''}-${i}`}>{s.cardCode ? `${s.cardCode} · ` : ''}{s.reason}</div>
                      ))}
                      {importResult.skippedCount > importResult.skipped.length ? (
                        <div>…还有 {importResult.skippedCount - importResult.skipped.length} 条</div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            ) : (
              <div className="pgc-card-bd pgc-card-bd-collapsed">粘贴或上传原来的卡号和 PIN。</div>
            )}
          </div>
        </>
      ) : (
        <div className="pgc-card">
          <div className="pgc-card-hd" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>各店应付</h2>
            <div className="pgc-tabs" style={{ margin: 0 }}>
              <TabChip active={settleChannel === 'wallet'} onClick={() => setSettleChannel('wallet')}>充值卡消费</TabChip>
              <TabChip active={settleChannel === 'tap_pay'} onClick={() => setSettleChannel('tap_pay')}>Tap to Pay</TabChip>
            </div>
          </div>
          <div className="pgc-card-bd">
            <p className="pgc-hint">
              {settleChannel === 'wallet'
                ? '消耗 = 客人钱包在该店消费减去退回客人钱包的金额。已付来自本页录入的打款记录。员工消费不计入。'
                : '消耗 = 该店 Tap to Pay（paymentMethod=tap_pay）结账合计减去已退菜金额。已付为本渠道单独录入的打款，与充值卡账目互不影响。'}
            </p>
          </div>
          <div className="pgc-table-wrap">
            {settleLoading ? <div className="pgc-loading" style={{ padding: '0 18px 12px' }}>加载中…</div> : null}
            <table className="pgc-table">
              <thead>
                <tr>
                  <th>店铺</th>
                  <th>已消耗</th>
                  <th>已支付</th>
                  <th>待支付</th>
                  <th>上次支付</th>
                  <th>笔数</th>
                </tr>
              </thead>
              <tbody>
                {settlements.map((s) => {
                  const expanded = openStoreId === s.storeId;
                  const due = s.outstandingEuro > 0.004;
                  return (
                    <Fragment key={s.storeId}>
                      <tr className={`pgc-row${expanded ? ' is-open' : ''}`} onClick={() => void toggleStore(s.storeId)}>
                        <td>
                          <div className="pgc-name">{s.displayName || s.slug}</div>
                          <div className="pgc-slug">{s.slug}</div>
                        </td>
                        <td className="pgc-num">{euro(s.consumedEuro)}</td>
                        <td className="pgc-num">{euro(s.paidEuro)}</td>
                        <td className={due ? 'pgc-due' : 'pgc-ok'}>{euro(s.outstandingEuro)}</td>
                        <td className="pgc-muted">{fmtDate(s.lastPaidAt)}</td>
                        <td className="pgc-num">{s.payoutCount}</td>
                      </tr>
                      {expanded ? (
                        <tr className="pgc-expand">
                          <td colSpan={6} onClick={(e) => e.stopPropagation()}>
                            <div className="pgc-nested">
                              <div className="pgc-card-meta">
                                {openStore?.displayName || ''} 待支付 {euro(payoutOutstanding ?? s.outstandingEuro)}
                              </div>
                              <div className="pgc-nested-actions">
                                <div className="pgc-field">
                                  <label htmlFor="pgc-pay-amt">金额 €</label>
                                  <input id="pgc-pay-amt" className="input" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} style={{ width: 110 }} />
                                </div>
                                <div className="pgc-field">
                                  <label htmlFor="pgc-pay-at">日期</label>
                                  <input id="pgc-pay-at" className="input" type="date" value={payAt} onChange={(e) => setPayAt(e.target.value)} />
                                </div>
                                <div className="pgc-field">
                                  <label htmlFor="pgc-pay-method">方式</label>
                                  <select id="pgc-pay-method" className="input" value={payMethod} onChange={(e) => setPayMethod(e.target.value as typeof payMethod)}>
                                    <option value="bank_transfer">银行转账</option>
                                    <option value="cash">现金</option>
                                    <option value="other">其他</option>
                                  </select>
                                </div>
                                <div className="pgc-field">
                                  <label htmlFor="pgc-pay-ref">Ref {payMethod === 'bank_transfer' ? '（必填）' : ''}</label>
                                  <input id="pgc-pay-ref" className="input" value={payRef} onChange={(e) => setPayRef(e.target.value)} style={{ width: 160 }} />
                                </div>
                                <div className="pgc-field">
                                  <label htmlFor="pgc-pay-note">备注</label>
                                  <input id="pgc-pay-note" className="input" value={payNote} onChange={(e) => setPayNote(e.target.value)} style={{ width: 180 }} />
                                </div>
                                <button type="button" className="btn btn-primary" onClick={() => void addPayout()} disabled={payBusy}>
                                  {payBusy ? '保存中…' : '记录支付'}
                                </button>
                              </div>
                              {payoutsLoading ? <div className="pgc-loading">加载支付记录…</div> : null}
                              <table className="pgc-table">
                                <thead>
                                  <tr>
                                    <th>日期</th>
                                    <th>金额</th>
                                    <th>方式</th>
                                    <th>Ref</th>
                                    <th>备注</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {payouts.map((p) => (
                                    <tr key={p._id}>
                                      <td>{fmtDt(p.paidAt)}</td>
                                      <td className="pgc-num">{euro(p.amountEuro)}</td>
                                      <td>{methodLabel(p.method)}</td>
                                      <td className="pgc-mono">{p.ref || '—'}</td>
                                      <td>{p.note || <span className="pgc-muted">—</span>}</td>
                                    </tr>
                                  ))}
                                  {!payoutsLoading && payouts.length === 0 ? (
                                    <tr>
                                      <td colSpan={5} className="pgc-empty">尚无支付记录</td>
                                    </tr>
                                  ) : null}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
                {!settleLoading && settlements.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="pgc-empty">暂无店铺</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
