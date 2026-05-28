import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';
import { translateMemberWalletTxnNote } from '../../utils/memberTxnNoteI18n';
import MemberTopUpCardsPanel from './MemberTopUpCardsPanel';

interface MemberRow {
  _id: string;
  memberNo: number;
  phone: string;
  displayName: string;
  creditBalance: number;
  createdAt?: string;
}

type WalletTxnRow = {
  _id: string;
  type: string;
  amountEuro: number;
  balanceBefore: number;
  balanceAfter: number;
  note?: string;
  orderId?: string;
  checkoutId?: string;
  stripePaymentIntentId?: string;
  operatorAdminId?: string;
  topUpCardId?: string | null;
  createdAt: string;
};

export default function MemberManager() {
  const { t } = useTranslation();
  const { token } = useAuth();
  const [q, setQ] = useState('');
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<MemberRow | null>(null);
  const [rechargeMode, setRechargeMode] = useState<'amount' | 'target'>('amount');
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [rechargeTarget, setRechargeTarget] = useState('');
  const [rechargeNote, setRechargeNote] = useState('');
  const [msg, setMsg] = useState('');
  const [msgOk, setMsgOk] = useState(false);
  const [retryCheckoutId, setRetryCheckoutId] = useState('');
  const [retryBusy, setRetryBusy] = useState(false);
  const [ledgerMember, setLedgerMember] = useState<MemberRow | null>(null);
  const [ledgerTxns, setLedgerTxns] = useState<WalletTxnRow[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerErr, setLedgerErr] = useState('');
  const [adminTab, setAdminTab] = useState<'members' | 'cards'>('members');

  const authH = { Authorization: `Bearer ${token}` };

  const fetchMembers = useCallback(async () => {
    setLoading(true);
    setMsg('');
    setMsgOk(false);
    try {
      const params = new URLSearchParams({ limit: '80' });
      if (q.trim()) params.set('q', q.trim());
      const res = await apiFetch(`/api/admin/members?${params}`, { headers: authH });
      if (res.ok) setMembers(await res.json());
      else {
        const d = await res.json().catch(() => null);
        setMsg(d?.error?.message || 'Error');
      }
    } finally {
      setLoading(false);
    }
  }, [token, q]);

  useEffect(() => {
    const tmr = setTimeout(() => { fetchMembers(); }, 300);
    return () => clearTimeout(tmr);
  }, [fetchMembers]);

  const openLedger = useCallback(
    async (m: MemberRow) => {
      setLedgerMember(m);
      setLedgerTxns([]);
      setLedgerErr('');
      setLedgerLoading(true);
      try {
        const res = await apiFetch(`/api/admin/members/${m._id}/transactions?limit=100`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const d = await res.json().catch(() => null);
        if (!res.ok) {
          setLedgerErr((d as { error?: { message?: string } } | null)?.error?.message || t('admin.memberLedgerLoadError'));
          return;
        }
        setLedgerTxns(Array.isArray(d) ? (d as WalletTxnRow[]) : []);
      } catch {
        setLedgerErr(t('admin.memberLedgerLoadError'));
      } finally {
        setLedgerLoading(false);
      }
    },
    [token, t],
  );

  const txnTypeLabel = (type: string) => {
    const key = `member.txnTypeLabels.${type}`;
    const lbl = t(key);
    return lbl === key ? type : lbl;
  };

  const targetPreview = (() => {
    if (!selected || rechargeMode !== 'target') return null;
    const target = parseFloat(rechargeTarget);
    if (!Number.isFinite(target) || target < 0) return null;
    const current = Number(selected.creditBalance) || 0;
    const delta = Math.round((target - current) * 100) / 100;
    return { current, target, delta };
  })();

  const memberRechargeLabel = (m: MemberRow) =>
    `#${m.memberNo} · ${m.phone}${m.displayName ? ` · ${m.displayName}` : ''}`;

  const confirmRecharge = (): boolean => {
    if (!selected) return false;
    if (rechargeMode === 'target') {
      const target = parseFloat(rechargeTarget);
      if (!Number.isFinite(target) || target < 0) {
        setMsg(t('admin.memberRechargeTargetInvalid', '请输入有效的目标余额'));
        setMsgOk(false);
        return false;
      }
      const current = Number(selected.creditBalance) || 0;
      const delta = Math.round((target - current) * 100) / 100;
      let detail: string;
      if (delta > 0) {
        detail = t('admin.memberRechargeConfirmTargetUp', '将充值 €{{a}}，余额 €{{c}} → €{{t}}', {
          a: delta.toFixed(2),
          c: current.toFixed(2),
          t: target.toFixed(2),
        });
      } else if (delta < 0) {
        detail = t('admin.memberRechargeConfirmTargetDown', '将扣减 €{{a}}，余额 €{{c}} → €{{t}}', {
          a: (-delta).toFixed(2),
          c: current.toFixed(2),
          t: target.toFixed(2),
        });
      } else {
        detail = t('admin.memberRechargeConfirmTargetSame', '余额已是 €{{t}}，确认后不变', {
          t: target.toFixed(2),
        });
      }
      return window.confirm(
        `${t('admin.memberRechargeConfirmTitle', '请再次核对充值信息')}\n\n${memberRechargeLabel(selected)}\n${detail}`,
      );
    }
    const amt = parseFloat(rechargeAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setMsg(t('admin.memberRechargeInvalid', '请输入有效充值金额'));
      setMsgOk(false);
      return false;
    }
    return window.confirm(
      `${t('admin.memberRechargeConfirmTitle', '请再次核对充值信息')}\n\n${memberRechargeLabel(selected)}\n${t('admin.memberRechargeConfirmAmount', '将充值 €{{a}}', { a: amt.toFixed(2) })}`,
    );
  };

  const doRecharge = async () => {
    if (!selected) return;
    if (!confirmRecharge()) return;
    setMsg('');
    setMsgOk(false);

    let body: { amountEuro?: number; targetBalanceEuro?: number; note?: string };
    const noteTrim = rechargeNote.trim();

    if (rechargeMode === 'target') {
      const target = parseFloat(rechargeTarget);
      body = {
        targetBalanceEuro: target,
        ...(noteTrim ? { note: noteTrim } : {}),
      };
    } else {
      const amt = parseFloat(rechargeAmount);
      body = {
        amountEuro: amt,
        note: noteTrim || t('admin.memberRechargeDefaultNote', '后台充值'),
      };
    }

    const res = await apiFetch(`/api/admin/members/${selected._id}/recharge`, {
      method: 'POST',
      headers: { ...authH, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      setMsg(d?.error?.message || 'Failed');
      return;
    }
    setRechargeAmount('');
    setRechargeTarget('');
    setRechargeNote('');
    setSelected(null);
    setMsgOk(true);
    const credited = Number(d.creditedEuro) || 0;
    const debited = Number(d.debitedEuro) || 0;
    if (rechargeMode === 'target' && debited > 0) {
      setMsg(
        t('admin.memberRechargeTargetDebitOk', '已扣减 €{{a}}，当前余额 €{{b}}', {
          a: debited.toFixed(2),
          b: Number(d.creditBalance).toFixed(2),
        }),
      );
    } else if (rechargeMode === 'target' && credited <= 0 && debited <= 0) {
      setMsg(
        t('admin.memberRechargeTargetNoChangeOk', '余额未变，当前 €{{b}}', {
          b: Number(d.creditBalance).toFixed(2),
        }),
      );
    } else if (rechargeMode === 'target' && credited > 0) {
      setMsg(
        t('admin.memberRechargeTargetOk', '已充值 €{{a}}，当前余额 €{{b}}', {
          a: credited.toFixed(2),
          b: Number(d.creditBalance).toFixed(2),
        }),
      );
    } else {
      setMsg(t('admin.memberRechargeOk', '充值成功，当前余额 €{{b}}', { b: Number(d.creditBalance).toFixed(2) }));
    }
    fetchMembers();
  };

  const doDeleteMember = async (m: MemberRow) => {
    const ok = window.confirm(
      t('admin.memberDeleteConfirm', '确认删除该会员？此操作用于误注册清理，且不可恢复。'),
    );
    if (!ok) return;
    setMsg('');
    setMsgOk(false);
    const res = await apiFetch(`/api/admin/members/${m._id}`, {
      method: 'DELETE',
      headers: authH,
    });
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      setMsg(d?.error?.message || t('admin.memberDeleteFailed', '删除失败'));
      setMsgOk(false);
      return;
    }
    if (selected?._id === m._id) setSelected(null);
    if (ledgerMember?._id === m._id) setLedgerMember(null);
    setMsg(t('admin.memberDeleteOk', '会员已删除'));
    setMsgOk(true);
    fetchMembers();
  };

  const doRetryWalletRefund = async () => {
    const id = retryCheckoutId.trim();
    if (!id || !mongooseObjectIdOk(id)) {
      setMsg(t('admin.retryRefundInvalidId', '请输入有效的 Checkout ID'));
      setMsgOk(false);
      return;
    }
    setRetryBusy(true);
    setMsg('');
    setMsgOk(false);
    try {
      const res = await apiFetch(`/api/admin/checkouts/${id}/retry-member-credit-refund`, {
        method: 'POST',
        headers: authH,
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setMsg(d?.error?.message || 'Failed');
        return;
      }
      setMsgOk(true);
      if (d?.skipped) {
        setMsg(t('admin.retryRefundSkipped', '无需补录或已足额：{{m}}', { m: d.message || '' }));
      } else {
        setMsg(
          t('admin.retryRefundOk', '已补录 €{{e}}，累计退回储值 €{{t}}', {
            e: Number(d.creditedEuro || 0).toFixed(2),
            t: Number(d.memberCreditRefundedEuro || 0).toFixed(2),
          }),
        );
      }
    } finally {
      setRetryBusy(false);
    }
  };

  function mongooseObjectIdOk(s: string): boolean {
    return /^[a-fA-F0-9]{24}$/.test(s);
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>👤 {t('admin.membersTitle', '会员与储值')}</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button
          type="button"
          className={adminTab === 'members' ? 'btn btn-primary' : 'btn btn-outline'}
          style={{ fontSize: 13 }}
          onClick={() => { setAdminTab('members'); }}
        >
          {t('admin.membersNav')}
        </button>
        <button
          type="button"
          className={adminTab === 'cards' ? 'btn btn-primary' : 'btn btn-outline'}
          style={{ fontSize: 13 }}
          onClick={() => { setAdminTab('cards'); }}
        >
          {t('admin.topupCardsTab')}
        </button>
      </div>

      {adminTab === 'cards' ? (
        <MemberTopUpCardsPanel />
      ) : (
        <>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
        {t('admin.membersHint', '按手机号、会员号、姓名搜索；顾客自助入口：/店铺/customer/member')}
      </p>
      <p style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 16 }}>
        {t('admin.memberLedgerRowHint')}
      </p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          className="input"
          placeholder={t('admin.membersSearch', '搜索…')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ minWidth: 220 }}
        />
        <button type="button" className="btn btn-outline" onClick={() => { setQ(''); }}>{t('admin.membersClear', '清空')}</button>
        {loading ? <span style={{ fontSize: 13 }}>{t('common.loading')}</span> : null}
      </div>

      {msg ? <div style={{ marginBottom: 12, fontSize: 14, color: msgOk ? 'var(--green, #2e7d32)' : 'var(--red-primary)' }}>{msg}</div> : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 20, alignItems: 'start' }}>
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '10px 12px' }}>#</th>
                <th style={{ textAlign: 'left', padding: '10px 12px' }}>{t('member.phone')}</th>
                <th style={{ textAlign: 'left', padding: '10px 12px' }}>{t('member.editName')}</th>
                <th style={{ textAlign: 'right', padding: '10px 12px' }}>{t('member.balance')}</th>
                <th style={{ padding: '10px 12px' }} />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr
                  key={m._id}
                  style={{ borderBottom: '1px solid var(--border-light)', cursor: 'pointer' }}
                  onClick={() => { void openLedger(m); }}
                  title={t('admin.memberLedgerTitle')}
                >
                  <td style={{ padding: '10px 12px', fontWeight: 600 }}>{m.memberNo}</td>
                  <td style={{ padding: '10px 12px' }}>{m.phone}</td>
                  <td style={{ padding: '10px 12px' }}>{m.displayName || '—'}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700 }}>€{Number(m.creditBalance).toFixed(2)}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        className="btn btn-outline"
                        style={{ fontSize: 12, padding: '4px 10px' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelected(m);
                          setRechargeMode('amount');
                          setRechargeAmount('');
                          setRechargeTarget('');
                          setRechargeNote('');
                          setMsg('');
                        }}
                      >
                        {t('admin.memberRecharge', '充值')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline"
                        style={{ fontSize: 12, padding: '4px 10px', color: 'var(--red-primary)', borderColor: 'var(--red-primary)' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          void doDeleteMember(m);
                        }}
                      >
                        {t('admin.memberDelete', '删除')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {members.length === 0 && !loading ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-light)' }}>{t('admin.membersEmpty', '暂无会员')}</div>
          ) : null}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, position: 'sticky', top: 12 }}>
          <div className="card" style={{ padding: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 12 }}>{t('admin.memberRechargeTitle', '手动充值')}</div>
            {selected ? (
              <>
                <div style={{ fontSize: 13, marginBottom: 8 }}>
                  #{selected.memberNo} · {selected.phone}
                  {selected.displayName ? ` · ${selected.displayName}` : ''}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                  {t('member.balance')}: €{Number(selected.creditBalance).toFixed(2)}
                </div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                  <button
                    type="button"
                    className={rechargeMode === 'amount' ? 'btn btn-primary' : 'btn btn-outline'}
                    style={{ flex: 1, fontSize: 12, padding: '6px 8px' }}
                    onClick={() => setRechargeMode('amount')}
                  >
                    {t('admin.memberRechargeModeAmount', '按金额')}
                  </button>
                  <button
                    type="button"
                    className={rechargeMode === 'target' ? 'btn btn-primary' : 'btn btn-outline'}
                    style={{ flex: 1, fontSize: 12, padding: '6px 8px' }}
                    onClick={() => setRechargeMode('target')}
                  >
                    {t('admin.memberRechargeModeTarget', '至目标余额')}
                  </button>
                </div>
                <p style={{ fontSize: 11, color: 'var(--text-light)', margin: '0 0 10px', lineHeight: 1.4 }}>
                  {t('admin.memberRechargeTargetHint', '输入目标余额：高于当前则充值，低于当前则扣减。提交前请仔细核对。')}
                </p>
                {rechargeMode === 'amount' ? (
                  <>
                    <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{t('admin.memberRechargeAmount', '金额 (€)')}</label>
                    <input className="input" type="number" step="0.01" min="0.01" value={rechargeAmount} onChange={(e) => setRechargeAmount(e.target.value)} style={{ width: '100%', marginBottom: 10 }} />
                  </>
                ) : (
                  <>
                    <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{t('admin.memberRechargeTargetBalance', '目标余额 (€)')}</label>
                    <input className="input" type="number" step="0.01" min="0" value={rechargeTarget} onChange={(e) => setRechargeTarget(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
                    {targetPreview ? (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.45 }}>
                        {targetPreview.delta > 0
                          ? t('admin.memberRechargeTargetPreview', '将充值 €{{a}}（€{{c}} → €{{t}}）', {
                              a: targetPreview.delta.toFixed(2),
                              c: targetPreview.current.toFixed(2),
                              t: targetPreview.target.toFixed(2),
                            })
                          : targetPreview.delta < 0
                            ? t('admin.memberRechargeTargetPreviewDown', '将扣减 €{{a}}（€{{c}} → €{{t}}）', {
                                a: (-targetPreview.delta).toFixed(2),
                                c: targetPreview.current.toFixed(2),
                                t: targetPreview.target.toFixed(2),
                              })
                            : t('admin.memberRechargeTargetPreviewSame', '余额已是 €{{t}}，确认后不变', {
                                t: targetPreview.target.toFixed(2),
                              })}
                      </div>
                    ) : null}
                  </>
                )}
                <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{t('admin.memberRechargeNote', '备注')}</label>
                <input className="input" value={rechargeNote} onChange={(e) => setRechargeNote(e.target.value)} style={{ width: '100%', marginBottom: 12 }} />
                <button type="button" className="btn btn-primary" style={{ width: '100%' }} onClick={doRecharge}>
                  {t('admin.memberRechargeSubmit', '确认充值')}
                </button>
                <button type="button" className="btn btn-outline" style={{ width: '100%', marginTop: 8 }} onClick={() => { setSelected(null); setMsg(''); }}>
                  {t('common.cancel')}
                </button>
              </>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--text-light)' }}>{t('admin.memberRechargePick', '在左侧列表点「充值」选择会员')}</div>
            )}
          </div>

          <div className="card" style={{ padding: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>{t('admin.retryMemberRefundTitle', '储值退款补录')}</div>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.45 }}>
              {t('admin.retryMemberRefundHint', '当退单已成功但储值退回钱包失败时，输入结账记录 Checkout ID（24 位），按差额补入账。')}
            </p>
            <input
              className="input"
              placeholder="Checkout ID"
              value={retryCheckoutId}
              onChange={(e) => setRetryCheckoutId(e.target.value)}
              style={{ width: '100%', marginBottom: 10, fontFamily: 'monospace', fontSize: 13 }}
            />
            <button type="button" className="btn btn-outline" style={{ width: '100%' }} disabled={retryBusy} onClick={doRetryWalletRefund}>
              {retryBusy ? t('common.loading') : t('admin.retryMemberRefundSubmit', '执行补录')}
            </button>
          </div>
        </div>
      </div>

      {ledgerMember ? (
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
          onClick={() => { setLedgerMember(null); setLedgerErr(''); }}
        >
          <div
            className="card"
            style={{
              width: 960,
              maxWidth: '100%',
              maxHeight: '85vh',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              padding: 0,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{t('admin.memberLedgerTitle')}</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
                  #{ledgerMember.memberNo} · {ledgerMember.phone}
                  {ledgerMember.displayName ? ` · ${ledgerMember.displayName}` : ''}
                  {' · '}
                  {t('member.balance')}: €{Number(ledgerMember.creditBalance).toFixed(2)}
                </div>
              </div>
              <button type="button" className="btn btn-outline" onClick={() => { setLedgerMember(null); setLedgerErr(''); }}>
                {t('admin.memberLedgerClose')}
              </button>
            </div>
            <div style={{ padding: 12, overflow: 'auto', flex: 1 }}>
              {ledgerLoading ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-light)' }}>{t('common.loading')}</div>
              ) : ledgerErr ? (
                <div style={{ padding: 16, color: 'var(--red-primary)' }}>{ledgerErr}</div>
              ) : ledgerTxns.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-light)' }}>{t('admin.memberLedgerEmpty')}</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
                      <th style={{ textAlign: 'left', padding: '8px 10px' }}>{t('member.txnFieldTime')}</th>
                      <th style={{ textAlign: 'left', padding: '8px 10px' }}>{t('member.txnFieldType')}</th>
                      <th style={{ textAlign: 'right', padding: '8px 10px' }}>{t('member.txnFieldAmount')}</th>
                      <th style={{ textAlign: 'right', padding: '8px 10px' }}>{t('member.txnFieldBalanceAfter')}</th>
                      <th style={{ textAlign: 'left', padding: '8px 10px', whiteSpace: 'nowrap' }}>{t('admin.memberLedgerTopUpCardId', '充值卡 ID')}</th>
                      <th style={{ textAlign: 'left', padding: '8px 10px' }}>{t('member.txnFieldNote')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledgerTxns.map((x) => {
                      const amt = Number(x.amountEuro);
                      const amtColor = amt < 0 ? 'var(--red-primary)' : '#2e7d32';
                      const cardId = x.topUpCardId?.trim();
                      return (
                        <tr key={x._id} style={{ borderBottom: '1px solid var(--border-light)' }}>
                          <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                            {x.createdAt ? new Date(x.createdAt).toLocaleString() : '—'}
                          </td>
                          <td style={{ padding: '8px 10px' }}>{txnTypeLabel(x.type)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: amtColor }}>
                            {amt >= 0 ? '+' : ''}
                            €{amt.toFixed(2)}
                          </td>
                          <td style={{ padding: '8px 10px', textAlign: 'right' }}>€{Number(x.balanceAfter).toFixed(2)}</td>
                          <td style={{ padding: '8px 10px', fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all', color: 'var(--text-secondary)' }}>
                            {cardId || '—'}
                          </td>
                          <td style={{ padding: '8px 10px', color: 'var(--text-secondary)', wordBreak: 'break-word' }}>
                            {translateMemberWalletTxnNote(x.note, t)}
                            {x.stripePaymentIntentId?.trim() ? (
                              <span style={{ display: 'block', fontSize: 11, marginTop: 4, fontFamily: 'monospace' }}>{x.stripePaymentIntentId.trim()}</span>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      ) : null}
        </>
      )}
    </div>
  );
}
