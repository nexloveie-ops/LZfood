import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { printBuiltReceipt } from '../../components/cashier/ReceiptPrint';
import { receiptOptionBilingualLines, receiptOptionExtraEuro, receiptOptionExtraSuffix } from '../../utils/receiptOptionPrice';
import { bundleAdjustedLineTotals, lineGrossEuro, type AppliedBundleLite } from '../../utils/bundleLineAllocation';
import { apiFetch } from '../../api/client';

interface OrderItem {
  _id: string;
  menuItemId?: string;
  lineKind?: string;
  itemName: string;
  itemNameEn?: string;
  quantity: number;
  unitPrice: number;
  refunded?: boolean;
  selectedOptions?: { groupName?: string; groupNameEn?: string; choiceName?: string; choiceNameEn?: string; extraPrice?: number }[];
}

function isVirtualCheckoutId(checkoutId: string): boolean {
  return typeof checkoutId === 'string' && checkoutId.startsWith('virtual:');
}

function todayLocalYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface SearchResult {
  checkoutId: string;
  type: string;
  tableNumber?: number;
  totalAmount: number;
  paymentMethod: string;
  cashAmount?: number;
  cardAmount?: number;
  checkedOutAt: string;
  refunded?: boolean;
  partialRefund?: boolean;
  orders: {
    _id: string;
    type: string;
    tableNumber?: number;
    seatNumber?: number;
    dailyOrderNumber?: number;
    dineInOrderNumber?: string;
    status?: string;
    customerName?: string;
    customerPhone?: string;
    deliveryAddress?: string;
    postalCode?: string;
    deliveryFeeEuro?: number;
    appliedBundles?: AppliedBundleLite[];
    items: OrderItem[];
  }[];
}

export default function ReprintReceipt() {
  const { t } = useTranslation();
  const { storeSlug = '' } = useParams<{ storeSlug: string }>();
  const { token } = useAuth();
  const [orderNumber, setOrderNumber] = useState('');
  const [date, setDate] = useState(todayLocalYmd);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [noResults, setNoResults] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [printing, setPrinting] = useState<string | null>(null);
  const [config, setConfig] = useState<Record<string, string>>({});

  // Expanded order & selected items for refund
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [refunding, setRefunding] = useState(false);

  useEffect(() => {
    apiFetch('/api/admin/config').then(r => r.ok ? r.json() : {}).then(setConfig).catch(() => {});
  }, []);

  const handleSearch = useCallback(async (searchNum?: string) => {
    if (!token) {
      setSearchError('请先登录');
      return;
    }
    const num = searchNum ?? orderNumber;
    setSearching(true);
    setNoResults(false);
    setSearchError('');
    setResults([]);
    setExpandedId(null);
    setSelectedItems(new Set());
    try {
      const params = new URLSearchParams({ date });
      if (num.trim()) params.set('orderNumber', num.trim());
      const res = await apiFetch(`/api/checkout/search?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => null)) as SearchResult[] | { error?: { message?: string } } | null;
      if (!res.ok) {
        const msg =
          data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object'
            ? (data.error as { message?: string }).message
            : null;
        setSearchError(msg || `加载失败（${res.status}）`);
        setNoResults(false);
        return;
      }
      const list = Array.isArray(data) ? data : [];
      setResults(list);
      setNoResults(list.length === 0);
    } catch {
      setSearchError('网络错误');
      setNoResults(false);
    } finally {
      setSearching(false);
    }
  }, [orderNumber, date, token]);

  useEffect(() => {
    if (!token) return;
    void handleSearch('');
    // 仅登录后拉一次当日列表；改日期/单号请点搜索，避免 orderNumber 输入时反复请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handlePrint = (r: SearchResult) => {
    setPrinting(r.checkoutId);
    const receiptData = {
      checkoutId: r.checkoutId,
      type: r.type as 'table' | 'seat',
      tableNumber: r.tableNumber,
      totalAmount: r.totalAmount,
      paymentMethod: r.paymentMethod as 'cash' | 'card' | 'mixed' | 'online',
      cashAmount: r.cashAmount,
      cardAmount: r.cardAmount,
      checkedOutAt: r.checkedOutAt,
      orders: r.orders.map(o => ({
        _id: o._id,
        type: o.type as 'dine_in' | 'takeout' | 'phone' | 'delivery',
        tableNumber: o.tableNumber,
        seatNumber: o.seatNumber,
        dailyOrderNumber: o.dailyOrderNumber,
        dineInOrderNumber: o.dineInOrderNumber,
        status: 'checked_out',
        customerName: o.customerName,
        customerPhone: o.customerPhone,
        deliveryAddress: o.deliveryAddress,
        postalCode: o.postalCode,
        deliveryFeeEuro: o.deliveryFeeEuro,
        items: o.items,
      })),
    };
    void printBuiltReceipt(receiptData, config, { copies: 1 });
    setTimeout(() => setPrinting(null), 2000);
  };

  const toggleExpand = (checkoutId: string) => {
    if (expandedId === checkoutId) {
      setExpandedId(null);
      setSelectedItems(new Set());
    } else {
      setExpandedId(checkoutId);
      setSelectedItems(new Set());
    }
  };

  const toggleItem = (itemId: string) => {
    setSelectedItems(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const selectAllItems = (r: SearchResult) => {
    const refundable = r.orders.flatMap(o => o.items).filter(i => !i.refunded);
    setSelectedItems(new Set(refundable.map(i => i._id)));
  };

  const buildLineNetByItemId = (r: SearchResult) => {
    const m = new Map<string, number>();
    for (const o of r.orders) {
      bundleAdjustedLineTotals(o.items, o.appliedBundles).forEach((v, k) => m.set(k, v));
    }
    return m;
  };

  const getRefundTotal = (r: SearchResult, lineNets: Map<string, number>) => {
    let total = 0;
    for (const order of r.orders) {
      for (const item of order.items) {
        if (selectedItems.has(item._id)) {
          total += lineNets.get(item._id) ?? lineGrossEuro(item);
        }
      }
    }
    return total;
  };

  const handleRefund = async (r: SearchResult) => {
    if (selectedItems.size === 0) return;
    const lineNets = buildLineNetByItemId(r);
    const refundTotal = getRefundTotal(r, lineNets);
    if (!confirm(`确认退单？\n退单菜品: ${selectedItems.size} 项\n退款金额: €${refundTotal.toFixed(2)}\n此操作不可撤销。`)) return;

    setRefunding(true);
    try {
      const res = await apiFetch(`/api/checkout/${r.checkoutId}/refund`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds: [...selectedItems] }),
      });
      const data = (await res.json().catch(() => null)) as {
        refundChannelBreakdown?: { memberWalletEuro?: number; cashEuro?: number; cardEuro?: number; onlineEuro?: number };
        memberWalletRefundError?: string;
        error?: { message?: string };
      } | null;
      if (res.ok) {
        const hints: string[] = [];
        const b = data?.refundChannelBreakdown;
        if (b) {
          if ((b.memberWalletEuro ?? 0) > 0.001) hints.push(`储值退回钱包 €${Number(b.memberWalletEuro).toFixed(2)}`);
          if ((b.cashEuro ?? 0) > 0.001) hints.push(`现金退回 €${Number(b.cashEuro).toFixed(2)}`);
          if ((b.cardEuro ?? 0) > 0.001) hints.push(`刷卡原路 €${Number(b.cardEuro).toFixed(2)}`);
          if ((b.onlineEuro ?? 0) > 0.001) hints.push(`线上原路 €${Number(b.onlineEuro).toFixed(2)}`);
        }
        if (data?.memberWalletRefundError) {
          hints.push(
            `注意：储值退回失败（${data.memberWalletRefundError}）。请在管理后台「会员与储值」中使用 Checkout ID ${r.checkoutId} 执行补录。`,
          );
        }
        if (hints.length) alert(`退单已完成。\n\n${hints.join('\n')}`);
        setExpandedId(null);
        setSelectedItems(new Set());
        handleSearch(orderNumber);
      } else {
        alert(data?.error?.message || '退单失败');
      }
    } catch {
      alert('退单失败');
    } finally {
      setRefunding(false);
    }
  };

  return (
    <div>
      <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>重印小票</h2>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        {storeSlug ? (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5 }}>
            当前网址店铺为 <strong>/{storeSlug}</strong>，查询的是该店订单。若 11 号单在别的分店下的，请从对应店铺的收银链接进入重印，或确认登录时选的店铺与网址一致。
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>订单号码</label>
            <input className="input" value={orderNumber} onChange={e => setOrderNumber(e.target.value)}
              placeholder="例: 143025、10 或 #10（外卖号）"
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              style={{ width: 180, fontSize: 16, fontWeight: 600 }} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>日期</label>
            <input className="input" type="date" value={date} onChange={e => setDate(e.target.value)} style={{ width: 160 }} />
          </div>
          <button className="btn btn-primary" onClick={() => handleSearch()} disabled={searching} style={{ padding: '8px 20px' }}>
            {searching ? t('common.loading') : t('common.search')}
          </button>
        </div>
      </div>

      {searchError && (
        <div style={{ textAlign: 'center', padding: 16, color: 'var(--red-primary)', fontSize: 14 }}>{searchError}</div>
      )}
      {noResults && !searchError && (
        <>
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-light)' }}>未找到匹配的订单</div>
          <div style={{ textAlign: 'center', padding: '0 24px 24px', color: 'var(--text-light)', fontSize: 12, lineHeight: 1.6 }}>
            提示：输入外卖号后请点击「搜索」。无单号时：列表含当日结账（Checkout）及当日完结/下单、且无结账流水的订单。部分记录会标「无结账流水（仅重印）」。
          </div>
        </>
      )}

      {results.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {results.map(r => {
            const lineNets = buildLineNetByItemId(r);
            const isDineIn = r.orders[0]?.type === 'dine_in';
            const isDelivery = r.orders[0]?.type === 'delivery';
            const typeLabel = isDineIn ? '堂食 Dine-in' : isDelivery ? '送餐 Delivery' : '外卖 Takeout';
            const virtual = isVirtualCheckoutId(r.checkoutId);
            const orderNum = r.orders[0]?.dineInOrderNumber || (r.orders[0]?.dailyOrderNumber ? `#${r.orders[0].dailyOrderNumber}` : '');
            const time = new Date(r.checkedOutAt).toLocaleTimeString();
            const isExpanded = expandedId === r.checkoutId;
            const allItems = r.orders.flatMap(o => o.items);
            const hasRefundableItems = allItems.some(i => !i.refunded);
            const refundTag = r.refunded ? '已全部退单' : r.partialRefund ? '部分退单' : '';

            return (
              <div key={r.checkoutId} className="card" style={{
                overflow: 'hidden',
                background: r.refunded ? '#FFF3E0' : r.partialRefund ? '#FFFDE7' : undefined,
                opacity: r.refunded ? 0.7 : 1,
              }}>
                {/* Order header row */}
                <div style={{
                  padding: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  cursor: 'pointer',
                }}
                  onClick={() => toggleExpand(r.checkoutId)}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 16, color: isDineIn ? 'var(--red-primary)' : '#1976D2' }}>
                      {typeLabel} {orderNum && `· ${orderNum}`} · €{r.totalAmount.toFixed(2)}
                      {refundTag && (
                        <span style={{
                          marginLeft: 8, fontSize: 11, padding: '2px 8px', borderRadius: 4,
                          background: r.refunded ? '#F44336' : '#FF9800', color: '#fff', fontWeight: 600,
                        }}>{refundTag}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-light)', marginTop: 2 }}>
                      {r.tableNumber != null && r.tableNumber > 0 && `Table ${r.tableNumber} · `}
                      {r.paymentMethod}{virtual ? ' · 无结账流水（仅重印）' : ''} · {time} · {allItems.length} 项菜品
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                    <button className="btn btn-primary" style={{ padding: '8px 16px', fontSize: 13 }}
                      disabled={printing === r.checkoutId}
                      onClick={(e) => { e.stopPropagation(); handlePrint(r); }}>
                      {printing === r.checkoutId ? '🖨️...' : '🖨️ 打印'}
                    </button>
                    <span style={{ fontSize: 18, color: 'var(--text-light)', transition: 'transform 0.2s', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
                  </div>
                </div>

                {/* Expanded item list */}
                {isExpanded && (
                  <div style={{ borderTop: '1px solid var(--border, #eee)', padding: '12px 16px', background: 'var(--bg, #f9f9f9)' }}>
                    {/* Select all / refund bar */}
                    {hasRefundableItems && !virtual && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }}
                          onClick={() => selectAllItems(r)}>
                          全选
                        </button>
                        {selectedItems.size > 0 && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontSize: 13, fontWeight: 600 }}>
                              已选 {selectedItems.size} 项 · 退款 €{getRefundTotal(r, lineNets).toFixed(2)}
                            </span>
                            <button className="btn" style={{
                              padding: '6px 16px', fontSize: 13,
                              background: '#F44336', color: '#fff', border: 'none',
                            }}
                              disabled={refunding}
                              onClick={() => handleRefund(r)}>
                              {refunding ? '处理中...' : '↩ 确认退单'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Item list */}
                    {allItems.map(item => {
                      const gross = lineGrossEuro(item);
                      const itemTotal = lineNets.get(item._id) ?? gross;
                      const showStrike = Math.abs(itemTotal - gross) > 0.005;
                      const isRefunded = item.refunded;
                      const isSelected = selectedItems.has(item._id);

                      return (
                        <div key={item._id}
                          onClick={() => { if (!isRefunded) toggleItem(item._id); }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '8px 10px', marginBottom: 4, borderRadius: 6,
                            background: isRefunded ? '#FFEBEE' : isSelected ? '#E3F2FD' : '#fff',
                            border: isSelected ? '2px solid #1976D2' : '1px solid #eee',
                            cursor: isRefunded ? 'default' : 'pointer',
                            opacity: isRefunded ? 0.6 : 1,
                            transition: 'all 0.15s',
                          }}>
                          {/* Checkbox */}
                          <div style={{
                            width: 20, height: 20, borderRadius: 4, flexShrink: 0,
                            border: isRefunded ? '2px solid #ccc' : isSelected ? '2px solid #1976D2' : '2px solid #bbb',
                            background: isRefunded ? '#eee' : isSelected ? '#1976D2' : '#fff',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}>
                            {isRefunded && <span style={{ fontSize: 12, color: '#999' }}>—</span>}
                            {isSelected && !isRefunded && <span style={{ fontSize: 12, color: '#fff' }}>✓</span>}
                          </div>

                          {/* Item info */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', gap: 6, alignItems: 'center' }}>
                              <span style={{ textDecoration: isRefunded ? 'line-through' : 'none' }}>{item.itemName}</span>
                              {isRefunded && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: '#F44336', color: '#fff' }}>已退</span>}
                            </div>
                            {item.itemNameEn && item.itemNameEn !== item.itemName && (
                              <div style={{ fontSize: 11, color: 'var(--text-light)' }}>{item.itemNameEn}</div>
                            )}
                            {item.selectedOptions && item.selectedOptions.length > 0 && (
                              <div style={{ fontSize: 10, color: 'var(--text-light)' }}>
                                {item.selectedOptions.map((o, i) => {
                                  const { primary, secondary } = receiptOptionBilingualLines(o);
                                  const main =
                                    primary ||
                                    secondary ||
                                    (receiptOptionExtraEuro(o.extraPrice) > 0 ? 'Option' : '');
                                  const suf = receiptOptionExtraSuffix(o.extraPrice);
                                  const text = main
                                    ? `${main}${suf}${secondary && primary ? ` / ${secondary}` : ''}`
                                    : suf.trim()
                                      ? `Option${suf}`
                                      : '';
                                  return (
                                    <span key={i}>
                                      {i > 0 && ' · '}
                                      {text}
                                    </span>
                                  );
                                })}
                              </div>
                            )}
                          </div>

                          {/* Qty & price */}
                          <div style={{ textAlign: 'right', flexShrink: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: isRefunded ? '#999' : 'var(--red-primary)' }}>
                              {showStrike && (
                                <span style={{ textDecoration: 'line-through', color: 'var(--text-light)', fontWeight: 500, fontSize: 12, marginRight: 6 }}>
                                  €{gross.toFixed(2)}
                                </span>
                              )}
                              €{itemTotal.toFixed(2)}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-light)' }}>×{item.quantity}</div>
                          </div>
                        </div>
                      );
                    })}

                    {!hasRefundableItems && (
                      <div style={{ textAlign: 'center', padding: 12, color: 'var(--text-light)', fontSize: 13 }}>
                        所有菜品已退单
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
