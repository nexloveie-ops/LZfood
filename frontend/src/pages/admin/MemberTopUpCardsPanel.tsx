import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';

type TopUpCardRow = {
  _id: string;
  cardCode: string;
  batch: string;
  amountEuro: number | null;
  status: string;
  pinFailedAttempts?: number;
  usedAt?: string | null;
  usedByMemberId?: string | null;
  usedByMemberNo?: number | null;
  createdAt?: string;
};

type TopUpCardDetail = TopUpCardRow & {
  pinFailures?: { at: string; memberId?: string | null }[];
  usedByMemberPhone?: string | null;
  usedByMemberDisplayName?: string | null;
};

type TopUpGenRow = { cardCode: string; pin: string };

function rowStyle(status: string): CSSProperties {
  switch (status) {
    case 'used':
      return { background: 'rgba(0,0,0,0.045)' };
    case 'locked':
      return { background: '#fff8e1' };
    case 'active':
      return { background: 'rgba(46, 125, 50, 0.07)' };
    default:
      return {};
  }
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

export default function MemberTopUpCardsPanel() {
  const { t } = useTranslation();
  const { token } = useAuth();
  const headers = useMemo(
    () => (token ? { Authorization: `Bearer ${token}` } : ({} as Record<string, string>)),
    [token],
  );

  const [batchLabel, setBatchLabel] = useState('');
  const [genCount, setGenCount] = useState('20');
  const [downloadXlsx, setDownloadXlsx] = useState(true);
  const [actCodes, setActCodes] = useState('');
  const [actAmt, setActAmt] = useState('');
  const [filterBatch, setFilterBatch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [items, setItems] = useState<TopUpCardRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgOk, setMsgOk] = useState(false);
  const [detail, setDetail] = useState<TopUpCardDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [oneActivateAmt, setOneActivateAmt] = useState('');
  const [lastGen, setLastGen] = useState<{ batch: string; rows: TopUpGenRow[] } | null>(null);
  const [copyFeedback, setCopyFeedback] = useState('');
  const [genExpanded, setGenExpanded] = useState(false);
  const [activateExpanded, setActivateExpanded] = useState(false);

  const statusLabel = useCallback(
    (st: string) => {
      const keyMap: Record<string, string> = {
        inactive: 'admin.topupCardsStatusInactive',
        active: 'admin.topupCardsStatusActive',
        used: 'admin.topupCardsStatusUsed',
        locked: 'admin.topupCardsStatusLocked',
      };
      const key = keyMap[st];
      if (!key) return st;
      const lbl = t(key);
      return lbl === key ? st : lbl;
    },
    [t],
  );

  const fetchList = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '120' });
      if (filterBatch.trim()) params.set('batch', filterBatch.trim());
      if (filterStatus) params.set('status', filterStatus);
      const res = await apiFetch(`/api/admin/topup-cards?${params}`, { headers });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setMsg((d as { error?: { message?: string } } | null)?.error?.message || 'Error');
        setMsgOk(false);
        return;
      }
      const body = d as { items?: TopUpCardRow[] } | null;
      setItems(Array.isArray(body?.items) ? body!.items! : []);
    } finally {
      setLoading(false);
    }
  }, [token, headers, filterBatch, filterStatus]);

  useEffect(() => {
    void fetchList();
  }, [fetchList]);

  const openDetail = async (id: string) => {
    if (!token) return;
    setDetail(null);
    setDetailLoading(true);
    setOneActivateAmt('');
    try {
      const res = await apiFetch(`/api/admin/topup-cards/${id}`, { headers });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setMsg((d as { error?: { message?: string } } | null)?.error?.message || 'Error');
        setMsgOk(false);
        return;
      }
      setDetail(d as TopUpCardDetail);
    } finally {
      setDetailLoading(false);
    }
  };

  const doGenerate = async () => {
    if (!token) return;
    const batch = batchLabel.trim();
    if (!batch) {
      setMsg(t('admin.topupCardsBatchRequired', '请填写批次名称'));
      setMsgOk(false);
      return;
    }
    const count = Math.min(300, Math.max(1, parseInt(genCount, 10) || 0));
    setMsg('');
    setMsgOk(false);
    setLastGen(null);
    setCopyFeedback('');
    try {
      if (downloadXlsx) {
        const res = await apiFetch(`/api/admin/topup-cards/batch?download=1`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ count, batch }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => null);
          setMsg((d as { error?: { message?: string } } | null)?.error?.message || 'Error');
          return;
        }
        await downloadBlobResponse(res, `topup-${batch}-${Date.now()}.xlsx`);
        setMsgOk(true);
        setMsg(t('admin.topupCardsGenOk', { n: count }));
      } else {
        const res = await apiFetch(`/api/admin/topup-cards/batch`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ count, batch }),
        });
        const d = await res.json().catch(() => null);
        if (!res.ok) {
          setMsg((d as { error?: { message?: string } } | null)?.error?.message || 'Error');
          return;
        }
        const body = d as { batch?: string; count?: number; rows?: TopUpGenRow[] };
        const rows = Array.isArray(body.rows) ? body.rows : [];
        setLastGen({ batch: String(body.batch || batch), rows });
        setMsgOk(true);
        setMsg(t('admin.topupCardsGenOk', { n: Number(body.count) || rows.length || count }));
      }
      void fetchList();
    } catch {
      setMsg('Network error');
      setMsgOk(false);
    }
  };

  const tsvForClipboard = useMemo(() => {
    if (!lastGen?.rows.length) return '';
    const h = `${t('admin.topupCardsColCode')}\t${t('admin.topupCardsColPin')}`;
    const b = lastGen.rows.map((r) => `${r.cardCode}\t${r.pin}`).join('\n');
    return `${h}\n${b}`;
  }, [lastGen, t]);

  const copyGenTsv = async () => {
    if (!tsvForClipboard) return;
    try {
      await navigator.clipboard.writeText(tsvForClipboard);
      setCopyFeedback(t('admin.topupCardsCopied', '已复制到剪贴板'));
      window.setTimeout(() => setCopyFeedback(''), 2500);
    } catch {
      setCopyFeedback(t('admin.topupCardsCopyFailed', '复制失败，请手动选中表格'));
      window.setTimeout(() => setCopyFeedback(''), 3000);
    }
  };

  const doActivateByCodes = async () => {
    if (!token) return;
    const amt = parseFloat(actAmt);
    if (!Number.isFinite(amt) || amt <= 0) return;
    const cardCodes = actCodes
      .split(/[\s,;，；]+/)
      .map((s) => s.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))
      .filter((c) => c.length === 6);
    if (cardCodes.length === 0) {
      setMsg(t('admin.topupCardsActivateCodesInvalid', '请填写至少一个 6 位卡号'));
      setMsgOk(false);
      return;
    }
    setMsg('');
    const res = await apiFetch(`/api/admin/topup-cards/activate-by-codes`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardCodes: [...new Set(cardCodes)], amountEuro: amt }),
    });
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      setMsg((d as { error?: { message?: string } } | null)?.error?.message || 'Error');
      setMsgOk(false);
      return;
    }
    const body = d as { modified?: number; requested?: number };
    setMsgOk(true);
    setMsg(
      t('admin.topupCardsActivateByCodesOk', {
        modified: Number(body.modified) || 0,
        requested: Number(body.requested) || cardCodes.length,
      }),
    );
    void fetchList();
  };

  const doExport = async () => {
    if (!token) return;
    const params = new URLSearchParams();
    if (filterBatch.trim()) params.set('batch', filterBatch.trim());
    if (filterStatus) params.set('status', filterStatus);
    const res = await apiFetch(`/api/admin/topup-cards-export.xlsx?${params}`, { headers });
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      setMsg((d as { error?: { message?: string } } | null)?.error?.message || 'Error');
      setMsgOk(false);
      return;
    }
    await downloadBlobResponse(res, `topup-export-${Date.now()}.xlsx`);
  };

  const doUnlock = async () => {
    if (!token || !detail) return;
    const res = await apiFetch(`/api/admin/topup-cards/${detail._id}/unlock`, {
      method: 'POST',
      headers,
    });
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      setMsg((d as { error?: { message?: string } } | null)?.error?.message || 'Error');
      setMsgOk(false);
      return;
    }
    setDetail(null);
    setMsgOk(true);
    setMsg(t('admin.topupCardsUnlockOk', '已解锁'));
    void fetchList();
  };

  const doActivateOne = async () => {
    if (!token || !detail) return;
    const amt = parseFloat(oneActivateAmt);
    if (!Number.isFinite(amt) || amt <= 0) return;
    const res = await apiFetch(`/api/admin/topup-cards/${detail._id}/activate`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountEuro: amt }),
    });
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      setMsg((d as { error?: { message?: string } } | null)?.error?.message || 'Error');
      setMsgOk(false);
      return;
    }
    setDetail(null);
    setMsgOk(true);
    setMsg(t('admin.topupCardsActivateOk', '已激活'));
    void fetchList();
  };

  if (!token) {
    return <div style={{ fontSize: 13, color: 'var(--text-light)' }}>{t('login.failed')}</div>;
  }

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.45 }}>
        {t('admin.membersHint')}
      </p>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <button
          type="button"
          onClick={() => setGenExpanded((v) => !v)}
          aria-expanded={genExpanded}
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
          <span style={{ fontWeight: 700 }}>{t('admin.topupCardsGenerate')}</span>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{genExpanded ? '▲' : '▼'}</span>
        </button>
        {!genExpanded ? (
          <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
            {t('admin.topupCardsGenCollapsedHint')}
          </div>
        ) : (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
              <div>
                <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{t('admin.topupCardsBatchLabel')}</label>
                <input className="input" value={batchLabel} onChange={(e) => setBatchLabel(e.target.value)} style={{ width: 180 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{t('admin.topupCardsCount')}</label>
                <input className="input" type="number" min={1} max={300} value={genCount} onChange={(e) => setGenCount(e.target.value)} style={{ width: 90 }} />
              </div>
              <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={downloadXlsx} onChange={(e) => setDownloadXlsx(e.target.checked)} />
                {t('admin.topupCardsDownloadXlsx')}
              </label>
              <button type="button" className="btn btn-primary" onClick={() => void doGenerate()}>
                {t('admin.topupCardsGenerate')}
              </button>
            </div>
          </div>
        )}
      </div>

      {lastGen && lastGen.rows.length > 0 ? (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <div style={{ fontWeight: 700 }}>
              {t('admin.topupCardsLastGenTitle', '本次生成（仅页面展示，请复制保存）')}
              <span style={{ fontWeight: 400, fontSize: 13, color: 'var(--text-secondary)', marginLeft: 8 }}>
                {t('admin.topupCardsBatchLabel')}: {lastGen.batch}
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <button type="button" className="btn btn-primary" style={{ fontSize: 13 }} onClick={() => void copyGenTsv()}>
                {t('admin.topupCardsCopyTsv', '复制表头+TSV')}
              </button>
              <button type="button" className="btn btn-outline" style={{ fontSize: 13 }} onClick={() => { setLastGen(null); setCopyFeedback(''); }}>
                {t('admin.topupCardsDismissGen', '隐藏')}
              </button>
            </div>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.45 }}>
            {t('admin.topupCardsCopyTableHint', '可直接选中表格复制，或使用上方按钮粘贴到 Excel。')}
          </p>
          {copyFeedback ? (
            <div style={{ fontSize: 13, marginBottom: 8, color: 'var(--green, #2e7d32)' }}>{copyFeedback}</div>
          ) : null}
          <div style={{ overflow: 'auto', maxHeight: 280, border: '1px solid var(--border)', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, userSelect: 'text' }}>
              <thead>
                <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0 }}>
                  <th style={{ textAlign: 'left', padding: '8px 10px' }}>{t('admin.topupCardsColCode')}</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px' }}>{t('admin.topupCardsColPin')}</th>
                </tr>
              </thead>
              <tbody>
                {lastGen.rows.map((r) => (
                  <tr key={`${r.cardCode}-${r.pin}`} style={{ borderBottom: '1px solid var(--border-light)' }}>
                    <td style={{ padding: '8px 10px', fontFamily: 'monospace', fontWeight: 600 }}>{r.cardCode}</td>
                    <td style={{ padding: '8px 10px', fontFamily: 'monospace' }}>{r.pin}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label style={{ fontSize: 11, color: 'var(--text-light)', display: 'block', marginTop: 8 }}>{t('admin.topupCardsTsvTextareaLabel', '原始 TSV')}</label>
          <textarea
            className="input"
            readOnly
            value={tsvForClipboard}
            style={{ width: '100%', marginTop: 4, fontFamily: 'monospace', fontSize: 12, minHeight: 72, resize: 'vertical' }}
          />
        </div>
      ) : null}

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <button
          type="button"
          onClick={() => setActivateExpanded((v) => !v)}
          aria-expanded={activateExpanded}
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
          <span style={{ fontWeight: 700 }}>{t('admin.topupCardsActivateByCodes')}</span>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{activateExpanded ? '▲' : '▼'}</span>
        </button>
        {!activateExpanded ? (
          <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
            {t('admin.topupCardsActivateCollapsedHint')}
          </div>
        ) : (
          <div style={{ marginTop: 14 }}>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.45 }}>
              {t('admin.topupCardsActivateCodesHint')}
            </p>
            <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{t('admin.topupCardsActivateCodesLabel')}</label>
            <textarea
              className="input"
              value={actCodes}
              onChange={(e) => setActCodes(e.target.value)}
              placeholder={t('admin.topupCardsActivateCodesPlaceholder')}
              rows={4}
              style={{ width: '100%', marginBottom: 12, resize: 'vertical', fontFamily: 'monospace', fontSize: 13 }}
            />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
              <div>
                <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{t('admin.topupCardsActivateAmount')}</label>
                <input className="input" type="number" step="0.01" min="0.01" value={actAmt} onChange={(e) => setActAmt(e.target.value)} style={{ width: 120 }} />
              </div>
              <button type="button" className="btn btn-outline" onClick={() => void doActivateByCodes()}>
                {t('admin.topupCardsActivateByCodes')}
              </button>
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12, alignItems: 'center' }}>
        <input
          className="input"
          placeholder={t('admin.topupCardsFilterBatch')}
          value={filterBatch}
          onChange={(e) => setFilterBatch(e.target.value)}
          style={{ minWidth: 160 }}
        />
        <select className="input" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={{ minWidth: 140 }}>
          <option value="">{t('admin.topupCardsAllStatus')}</option>
          <option value="inactive">{t('admin.topupCardsStatusInactive')}</option>
          <option value="active">{t('admin.topupCardsStatusActive')}</option>
          <option value="used">{t('admin.topupCardsStatusUsed')}</option>
          <option value="locked">{t('admin.topupCardsStatusLocked')}</option>
        </select>
        <button type="button" className="btn btn-outline" onClick={() => void fetchList()}>
          {t('admin.topupCardsRefresh')}
        </button>
        <button type="button" className="btn btn-outline" onClick={() => void doExport()}>
          {t('admin.topupCardsExportXlsx')}
        </button>
        {loading ? <span style={{ fontSize: 13 }}>{t('common.loading')}</span> : null}
      </div>

      {msg ? (
        <div style={{ marginBottom: 12, fontSize: 14, color: msgOk ? 'var(--green, #2e7d32)' : 'var(--red-primary)' }}>{msg}</div>
      ) : null}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
              <th style={{ textAlign: 'left', padding: '10px 12px' }}>{t('admin.topupCardsColCode')}</th>
              <th style={{ textAlign: 'left', padding: '10px 12px' }}>{t('admin.topupCardsColBatch')}</th>
              <th style={{ textAlign: 'right', padding: '10px 12px' }}>{t('admin.topupCardsColAmount')}</th>
              <th style={{ textAlign: 'left', padding: '10px 12px' }}>{t('admin.topupCardsColStatus')}</th>
              <th style={{ textAlign: 'left', padding: '10px 12px' }}>{t('admin.topupCardsColUsed')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr
                key={c._id}
                style={{ borderBottom: '1px solid var(--border-light)', cursor: 'pointer', ...rowStyle(c.status) }}
                onClick={() => void openDetail(c._id)}
              >
                <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontWeight: 700 }}>{c.cardCode}</td>
                <td style={{ padding: '10px 12px' }}>{c.batch}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                  {c.amountEuro != null && Number.isFinite(Number(c.amountEuro)) ? `€${Number(c.amountEuro).toFixed(2)}` : '—'}
                </td>
                <td style={{ padding: '10px 12px' }}>{statusLabel(c.status)}</td>
                <td style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-secondary)' }}>
                  {c.usedAt
                    ? `${new Date(c.usedAt).toLocaleString()}${c.usedByMemberNo != null ? ` · #${c.usedByMemberNo}` : ''}`
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && !loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-light)' }}>—</div>
        ) : null}
      </div>

      {detail || detailLoading ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            zIndex: 2100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={() => { setDetail(null); }}
        >
          <div className="card" style={{ width: 480, maxWidth: '100%', padding: 16 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>{t('admin.topupCardsDetailTitle')}</div>
            {detailLoading || !detail ? (
              <div style={{ padding: 16 }}>{t('common.loading')}</div>
            ) : (
              <>
                <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 12 }}>
                  <div>
                    <strong>{t('admin.topupCardsColCode')}:</strong>{' '}
                    <span style={{ fontFamily: 'monospace' }}>{detail.cardCode}</span>
                  </div>
                  <div>
                    <strong>{t('admin.topupCardsColBatch')}:</strong> {detail.batch}
                  </div>
                  <div>
                    <strong>{t('admin.topupCardsColStatus')}:</strong> {statusLabel(detail.status)}
                  </div>
                  <div>
                    <strong>{t('admin.topupCardsColAmount')}:</strong>{' '}
                    {detail.amountEuro != null ? `€${Number(detail.amountEuro).toFixed(2)}` : '—'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
                    {t('admin.topupCardsFailAttempts', 'PIN 失败次数')}: {detail.pinFailedAttempts ?? 0}
                  </div>
                  {detail.status === 'active' ? (
                    <div
                      style={{
                        marginTop: 12,
                        padding: 10,
                        background: 'var(--bg, #f5f5f5)',
                        borderRadius: 8,
                        fontSize: 12,
                        color: 'var(--text-secondary)',
                        lineHeight: 1.5,
                      }}
                    >
                      {t('admin.topupCardsActiveMemberHint')}
                    </div>
                  ) : null}
                  {detail.status === 'used' || detail.usedByMemberId ? (
                    <div
                      style={{
                        marginTop: 12,
                        padding: 10,
                        background: 'rgba(46, 125, 50, 0.08)',
                        borderRadius: 8,
                        fontSize: 13,
                        lineHeight: 1.55,
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('admin.topupCardsRedeemMemberTitle')}</div>
                      <div>
                        <strong>{t('member.memberNo')}:</strong> #{detail.usedByMemberNo ?? '—'}
                      </div>
                      <div>
                        <strong>{t('member.phone')}:</strong>{' '}
                        {detail.usedByMemberPhone != null && String(detail.usedByMemberPhone).trim() !== ''
                          ? String(detail.usedByMemberPhone).trim()
                          : '—'}
                      </div>
                      <div>
                        <strong>{t('member.editName')}:</strong>{' '}
                        {detail.usedByMemberDisplayName != null && String(detail.usedByMemberDisplayName).trim() !== ''
                          ? String(detail.usedByMemberDisplayName).trim()
                          : '—'}
                      </div>
                      {detail.usedByMemberId && detail.usedByMemberNo == null ? (
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
                          {t('admin.topupCardsRedeemMemberMissing')}
                        </div>
                      ) : null}
                      {detail.usedAt ? (
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
                          {t('admin.topupCardsRedeemAt')}: {new Date(detail.usedAt).toLocaleString()}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {detail.pinFailures && detail.pinFailures.length > 0 ? (
                  <div style={{ marginBottom: 12, maxHeight: 160, overflow: 'auto', fontSize: 12 }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('admin.topupCardsLastFailures')}</div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {detail.pinFailures.slice(-12).map((f, i) => (
                        <li key={i} style={{ marginBottom: 4 }}>
                          {new Date(f.at).toLocaleString()}
                          {f.memberId ? ` · ${f.memberId}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {detail.status === 'inactive' ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
                    <input
                      className="input"
                      type="number"
                      step="0.01"
                      min="0.01"
                      placeholder={t('admin.topupCardsActivateAmount')}
                      value={oneActivateAmt}
                      onChange={(e) => setOneActivateAmt(e.target.value)}
                      style={{ width: 120 }}
                    />
                    <button type="button" className="btn btn-primary" onClick={() => void doActivateOne()}>
                      {t('admin.topupCardsActivateOne')}
                    </button>
                  </div>
                ) : null}
                {detail.status === 'locked' ? (
                  <button type="button" className="btn btn-outline" style={{ marginBottom: 12 }} onClick={() => void doUnlock()}>
                    {t('admin.topupCardsUnlock')}
                  </button>
                ) : null}
                <button type="button" className="btn btn-outline" style={{ width: '100%' }} onClick={() => { setDetail(null); }}>
                  {t('admin.memberLedgerClose')}
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
