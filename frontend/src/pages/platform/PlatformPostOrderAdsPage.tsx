import { useCallback, useEffect, useRef, useState } from 'react';
import { platformApiFetch } from '../../api/client';
import { resolveBackendAssetUrl } from '../../utils/backendPublicUrl';

interface PostOrderSlideRow {
  imageUrl: string;
  captionZh?: string;
  captionEn?: string;
}

type StoreScope = 'all' | 'include' | 'exclude';

interface StoreOpt {
  _id: string;
  slug: string;
  displayName: string;
  status?: string;
}

interface PostOrderAdRow {
  _id: string;
  titleZh: string;
  titleEn?: string;
  imageUrl?: string;
  slides?: PostOrderSlideRow[];
  linkUrl: string;
  validFrom: string;
  validTo: string;
  windowStart?: string;
  windowEnd?: string;
  storeScope?: StoreScope;
  storeIds?: string[];
  sortOrder: number;
  isActive: boolean;
  impressionCount?: number;
  clickCount?: number;
  maxImpressions?: number | null;
  maxClicks?: number | null;
}

function asStoreIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => {
      if (typeof x === 'string') return x;
      if (x && typeof x === 'object' && '_id' in x) return String((x as { _id: unknown })._id);
      return String(x ?? '');
    })
    .filter(Boolean);
}

function formatStoreTarget(scope: StoreScope | undefined, ids: string[], stores: StoreOpt[]): string {
  const sc = scope || 'all';
  if (sc === 'all') return '全部店铺';
  const names = ids.map((id) => {
    const s = stores.find((st) => st._id === id);
    return s ? (s.displayName || s.slug) : id.slice(-6);
  });
  const preview = names.slice(0, 3).join('、');
  const extra = names.length > 3 ? ` 等${names.length}家` : '';
  if (sc === 'include') return names.length ? `指定：${preview}${extra}` : '指定（未选店）';
  return names.length ? `排除：${preview}${extra}` : '排除（未选店）';
}

function slidesFromApiRow(row: PostOrderAdRow): PostOrderSlideRow[] {
  if (row.slides && row.slides.length > 0) {
    return row.slides.map(s => ({
      imageUrl: s.imageUrl || '',
      captionZh: s.captionZh || '',
      captionEn: s.captionEn || '',
    }));
  }
  if (row.imageUrl?.trim()) {
    return [{ imageUrl: row.imageUrl.trim(), captionZh: '', captionEn: '' }];
  }
  return [{ imageUrl: '', captionZh: '', captionEn: '' }];
}

function slideCount(row: PostOrderAdRow): number {
  if (row.slides && row.slides.length > 0) return row.slides.filter(s => s.imageUrl?.trim()).length;
  return row.imageUrl?.trim() ? 1 : 0;
}

function formatCtr(impressions: number, clicks: number): string {
  if (impressions <= 0) return '—';
  return `${((clicks / impressions) * 100).toFixed(2)}%`;
}

function formatCountWithCap(count: number, cap?: number | null): string {
  if (cap != null && cap > 0) return `${count} / ${cap}`;
  return String(count);
}

export default function PlatformPostOrderAdsPage() {
  const [err, setErr] = useState('');
  const [postOrderAds, setPostOrderAds] = useState<PostOrderAdRow[]>([]);
  const [stores, setStores] = useState<StoreOpt[]>([]);
  const [adsLoading, setAdsLoading] = useState(false);
  const [adSaving, setAdSaving] = useState(false);
  const [slideUploading, setSlideUploading] = useState<number | null>(null);
  const [adFormOpen, setAdFormOpen] = useState(false);
  const formWrapRef = useRef<HTMLDivElement>(null);
  const [adForm, setAdForm] = useState({
    editingId: null as string | null,
    titleZh: '',
    titleEn: '',
    slides: [{ imageUrl: '', captionZh: '', captionEn: '' }] as PostOrderSlideRow[],
    linkUrl: '',
    validFrom: '',
    validTo: '',
    windowStart: '',
    windowEnd: '',
    sortOrder: 0,
    isActive: true,
    maxImpressionsInput: '',
    maxClicksInput: '',
    storeScope: 'all' as StoreScope,
    storeIds: [] as string[],
  });

  const loadPostOrderAds = useCallback(async () => {
    const [adsRes, storesRes] = await Promise.all([
      platformApiFetch('/api/platform/post-order-ads'),
      platformApiFetch('/api/platform/stores'),
    ]);
    if (adsRes.ok) {
      setPostOrderAds(await adsRes.json());
    } else {
      setPostOrderAds([]);
    }
    if (storesRes.ok) {
      const list = (await storesRes.json()) as StoreOpt[];
      setStores(Array.isArray(list) ? list : []);
    } else {
      setStores([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setAdsLoading(true);
      await loadPostOrderAds();
      if (!cancelled) setAdsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [loadPostOrderAds]);

  useEffect(() => {
    if (!adFormOpen) return;
    const id = requestAnimationFrame(() => {
      formWrapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => cancelAnimationFrame(id);
  }, [adFormOpen, adForm.editingId]);

  const clearAdFormFields = () => {
    setAdForm({
      editingId: null,
      titleZh: '',
      titleEn: '',
      slides: [{ imageUrl: '', captionZh: '', captionEn: '' }],
      linkUrl: '',
      validFrom: '',
      validTo: '',
      windowStart: '',
      windowEnd: '',
      sortOrder: 0,
      isActive: true,
      maxImpressionsInput: '',
      maxClicksInput: '',
      storeScope: 'all',
      storeIds: [],
    });
  };

  const resetAdForm = () => {
    clearAdFormFields();
    setAdFormOpen(false);
  };

  const openNewAdForm = () => {
    clearAdFormFields();
    setAdFormOpen(true);
  };

  const uploadSlideToBucket = async (idx: number, file: File) => {
    setSlideUploading(idx);
    setErr('');
    try {
      const fd = new FormData();
      fd.append('image', file);
      const res = await platformApiFetch('/api/platform/post-order-ads/upload-image', { method: 'POST', body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.error?.message || '上传失败');
        return;
      }
      const url = typeof j.imageUrl === 'string' ? j.imageUrl : '';
      if (!url) {
        setErr('上传响应无效');
        return;
      }
      setAdForm(f => ({
        ...f,
        slides: f.slides.map((s, i) => (i === idx ? { ...s, imageUrl: url } : s)),
      }));
    } finally {
      setSlideUploading(null);
    }
  };

  const savePostOrderAd = async (e: React.FormEvent) => {
    e.preventDefault();
    const slidesPayload = adForm.slides
      .map(s => ({
        imageUrl: s.imageUrl.trim(),
        captionZh: (s.captionZh || '').trim(),
        captionEn: (s.captionEn || '').trim(),
      }))
      .filter(s => s.imageUrl);
    if (!adForm.titleZh.trim() || slidesPayload.length === 0 || !adForm.linkUrl.trim() || !adForm.validFrom || !adForm.validTo) {
      setErr('请填写中文标题、至少一张图片（上传或 URL）、跳转链接与生效日期');
      return;
    }
    const maxImpRaw = adForm.maxImpressionsInput.trim();
    const maxClkRaw = adForm.maxClicksInput.trim();
    if (maxImpRaw && (!/^\d+$/.test(maxImpRaw) || parseInt(maxImpRaw, 10) < 1)) {
      setErr('展示次数上限须为正整数或留空');
      return;
    }
    if (maxClkRaw && (!/^\d+$/.test(maxClkRaw) || parseInt(maxClkRaw, 10) < 1)) {
      setErr('点击次数上限须为正整数或留空');
      return;
    }
    if (adForm.storeScope !== 'all' && adForm.storeIds.length === 0) {
      setErr(adForm.storeScope === 'include' ? '指定投放请至少选择一家店铺' : '排除投放请至少选择一家店铺');
      return;
    }
    setAdSaving(true);
    setErr('');
    try {
      const payload = {
        titleZh: adForm.titleZh.trim(),
        titleEn: adForm.titleEn.trim(),
        slides: slidesPayload,
        linkUrl: adForm.linkUrl.trim(),
        validFrom: adForm.validFrom,
        validTo: adForm.validTo,
        windowStart: adForm.windowStart.trim(),
        windowEnd: adForm.windowEnd.trim(),
        sortOrder: adForm.sortOrder,
        isActive: adForm.isActive,
        maxImpressions: maxImpRaw ? parseInt(maxImpRaw, 10) : null,
        maxClicks: maxClkRaw ? parseInt(maxClkRaw, 10) : null,
        storeScope: adForm.storeScope,
        storeIds: adForm.storeScope === 'all' ? [] : adForm.storeIds,
      };
      const res = adForm.editingId
        ? await platformApiFetch(`/api/platform/post-order-ads/${adForm.editingId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        : await platformApiFetch('/api/platform/post-order-ads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(j.error?.message || '保存广告失败');
        return;
      }
      resetAdForm();
      await loadPostOrderAds();
    } finally {
      setAdSaving(false);
    }
  };

  const editPostOrderAd = (row: PostOrderAdRow) => {
    const slides = slidesFromApiRow(row);
    setAdForm({
      editingId: row._id,
      titleZh: row.titleZh,
      titleEn: row.titleEn || '',
      slides: slides.length > 0 ? slides : [{ imageUrl: '', captionZh: '', captionEn: '' }],
      linkUrl: row.linkUrl,
      validFrom: row.validFrom,
      validTo: row.validTo,
      windowStart: row.windowStart || '',
      windowEnd: row.windowEnd || '',
      sortOrder: row.sortOrder ?? 0,
      isActive: row.isActive !== false,
      maxImpressionsInput:
        row.maxImpressions != null && row.maxImpressions > 0 ? String(row.maxImpressions) : '',
      maxClicksInput: row.maxClicks != null && row.maxClicks > 0 ? String(row.maxClicks) : '',
      storeScope: row.storeScope === 'include' || row.storeScope === 'exclude' ? row.storeScope : 'all',
      storeIds: asStoreIdList(row.storeIds),
    });
    setAdFormOpen(true);
  };

  const deletePostOrderAd = async (id: string) => {
    if (!confirm('删除该广告？')) return;
    const res = await platformApiFetch(`/api/platform/post-order-ads/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error?.message || '删除失败');
      return;
    }
    if (adForm.editingId === id) resetAdForm();
    await loadPostOrderAds();
  };

  const toggleAdActive = async (row: PostOrderAdRow) => {
    const res = await platformApiFetch(`/api/platform/post-order-ads/${row._id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !row.isActive }),
    });
    if (res.ok) await loadPostOrderAds();
    else {
      const j = await res.json().catch(() => ({}));
      setErr(j.error?.message || '更新失败');
    }
  };

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a237e', marginBottom: 8 }}>下单完成页广告</h1>
      <p style={{ fontSize: 14, color: '#555', marginBottom: 24, lineHeight: 1.6 }}>
        配置顾客<strong>订单状态页</strong>的推广横幅（顾客<strong>下单后</strong>进入该页即可看到，含待支付）。支持多张图轮播；统计<strong>展示次数</strong>与<strong>点击次数</strong>（打开该页时上报展示，点击跳转时上报点击）。
        投放范围可选：<strong>全部店铺</strong>、<strong>指定店铺</strong>或<strong>排除某些店铺</strong>。店铺若已关闭广告或为 Enterprise 套餐，仍不会展示。
        <strong>停止投放</strong>满足任一即生效并自动关闭「启用」：<strong>① 时间</strong>——未到开始日、已过结束日或不在每日时段内；<strong>② 展示次数</strong>——达到所设展示上限；<strong>③ 点击次数</strong>——达到所设点击上限。上限留空表示该项不限制。
      </p>

      {err && (
        <div style={{ padding: 12, background: '#ffebee', color: '#c62828', borderRadius: 8, marginBottom: 16, fontSize: 14 }}>
          {err}
        </div>
      )}

      <div className="card" style={{ padding: 20, marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>广告列表与数据</h2>
        <p style={{ fontSize: 13, color: '#555', marginBottom: 16, lineHeight: 1.6 }}>
          图片可<strong>上传到存储桶</strong>（<code>GCS_BUCKET</code>）或填写 URL。日期与每日时段时区：<code>PLATFORM_AD_TIMEZONE</code>（默认 <code>Asia/Hong_Kong</code>）。点击率 = 点击 / 展示。列表中展示/点击列带「当前/上限」时表示已设上限。
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16, alignItems: 'center' }}>
          {!adFormOpen ? (
            <button type="button" className="btn btn-primary" style={{ background: '#1a237e' }} onClick={openNewAdForm}>
              新增广告
            </button>
          ) : (
            <button type="button" className="btn btn-outline" onClick={resetAdForm}>
              关闭表单
            </button>
          )}
        </div>
        {adsLoading ? (
          <div style={{ padding: 24, textAlign: 'center', color: '#888' }}>加载广告…</div>
        ) : postOrderAds.length === 0 ? (
          <div style={{ padding: 12, color: '#888', fontSize: 14, marginBottom: 12 }}>暂无广告，点击「新增广告」添加。</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 20, minWidth: 720 }}>
              <thead>
                <tr style={{ background: '#f5f5f5', textAlign: 'left' }}>
                  <th style={{ padding: '8px 10px' }}>标题</th>
                  <th style={{ padding: '8px 10px' }}>图</th>
                  <th style={{ padding: '8px 10px' }}>展示</th>
                  <th style={{ padding: '8px 10px' }}>点击</th>
                  <th style={{ padding: '8px 10px' }}>点击率</th>
                  <th style={{ padding: '8px 10px' }}>生效</th>
                  <th style={{ padding: '8px 10px' }}>投放</th>
                  <th style={{ padding: '8px 10px' }}>每日时段</th>
                  <th style={{ padding: '8px 10px' }}>排序</th>
                  <th style={{ padding: '8px 10px' }}>启用</th>
                  <th style={{ padding: '8px 10px' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {postOrderAds.map((a) => {
                  const imp = a.impressionCount ?? 0;
                  const clk = a.clickCount ?? 0;
                  const capImp = a.maxImpressions;
                  const capClk = a.maxClicks;
                  return (
                    <tr key={a._id} style={{ borderTop: '1px solid #eee', verticalAlign: 'top' }}>
                      <td style={{ padding: '8px 10px' }}>
                        <div style={{ fontWeight: 600 }}>{a.titleZh}</div>
                        {a.titleEn ? <div style={{ color: '#666', fontSize: 12 }}>{a.titleEn}</div> : null}
                      </td>
                      <td style={{ padding: '8px 10px' }}>{slideCount(a)} 张</td>
                      <td style={{ padding: '8px 10px' }} title={capImp != null && capImp > 0 ? `上限 ${capImp}` : undefined}>{formatCountWithCap(imp, capImp)}</td>
                      <td style={{ padding: '8px 10px' }} title={capClk != null && capClk > 0 ? `上限 ${capClk}` : undefined}>{formatCountWithCap(clk, capClk)}</td>
                      <td style={{ padding: '8px 10px' }}>{formatCtr(imp, clk)}</td>
                      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{a.validFrom} — {a.validTo}</td>
                      <td style={{ padding: '8px 10px', maxWidth: 220 }}>
                        {formatStoreTarget(a.storeScope, asStoreIdList(a.storeIds), stores)}
                      </td>
                      <td style={{ padding: '8px 10px' }}>
                        {a.windowStart && a.windowEnd ? `${a.windowStart}–${a.windowEnd}` : '全天'}
                      </td>
                      <td style={{ padding: '8px 10px' }}>{a.sortOrder}</td>
                      <td style={{ padding: '8px 10px' }}>
                        <button type="button" className="btn btn-outline" style={{ fontSize: 12, padding: '4px 10px' }}
                          onClick={() => toggleAdActive(a)}>{a.isActive !== false ? '开' : '关'}</button>
                      </td>
                      <td style={{ padding: '8px 10px' }}>
                        <button type="button" className="btn btn-outline" style={{ fontSize: 12, marginRight: 8 }}
                          onClick={() => editPostOrderAd(a)}>编辑</button>
                        <button type="button" className="btn btn-outline" style={{ fontSize: 12, color: '#c62828', borderColor: '#ffcdd2' }}
                          onClick={() => deletePostOrderAd(a._id)}>删除</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {adFormOpen ? (
        <div ref={formWrapRef}>
        <form onSubmit={savePostOrderAd} style={{
          padding: 16,
          background: '#fafafa',
          borderRadius: 8,
          border: '1px solid #e0e0e0',
        }}>
          <div style={{ fontWeight: 600, marginBottom: 12, fontSize: 14 }}>
            {adForm.editingId ? '编辑广告' : '新增广告'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>中文标题</label>
              <input className="input" style={{ width: '100%' }} value={adForm.titleZh}
                onChange={e => setAdForm(f => ({ ...f, titleZh: e.target.value }))} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>英文标题（可选）</label>
              <input className="input" style={{ width: '100%' }} value={adForm.titleEn}
                onChange={e => setAdForm(f => ({ ...f, titleEn: e.target.value }))} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 8 }}>广告图片（可多张）</label>
              {adForm.slides.map((slide, idx) => (
                <div key={idx} style={{
                  border: '1px solid #e0e0e0',
                  padding: 12,
                  marginBottom: 10,
                  borderRadius: 8,
                  background: '#fff',
                }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/gif,image/webp"
                      id={`platform-ad-slide-${idx}`}
                      style={{ display: 'none' }}
                      onChange={(ev) => {
                        const file = ev.target.files?.[0];
                        if (file) void uploadSlideToBucket(idx, file);
                        ev.target.value = '';
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-outline"
                      style={{ fontSize: 12 }}
                      disabled={slideUploading === idx}
                      onClick={() => document.getElementById(`platform-ad-slide-${idx}`)?.click()}
                    >
                      {slideUploading === idx ? '上传中…' : '上传到存储桶'}
                    </button>
                    {slide.imageUrl ? (
                      <img
                        src={resolveBackendAssetUrl(slide.imageUrl)}
                        alt=""
                        style={{ maxHeight: 72, borderRadius: 6, objectFit: 'cover' }}
                      />
                    ) : null}
                    <input
                      className="input"
                      style={{ flex: '1 1 200px', minWidth: 160 }}
                      placeholder="图片 URL（上传后自动填入，或手动粘贴）"
                      value={slide.imageUrl}
                      onChange={e => setAdForm(f => ({
                        ...f,
                        slides: f.slides.map((s, i) => (i === idx ? { ...s, imageUrl: e.target.value } : s)),
                      }))}
                    />
                    {adForm.slides.length > 1 ? (
                      <button
                        type="button"
                        className="btn btn-outline"
                        style={{ fontSize: 12, color: '#c62828', borderColor: '#ffcdd2' }}
                        onClick={() => setAdForm(f => ({
                          ...f,
                          slides: f.slides.filter((_, i) => i !== idx),
                        }))}
                      >
                        删除此图
                      </button>
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
                    <input
                      className="input"
                      style={{ flex: 1, minWidth: 140 }}
                      placeholder="本图中文说明（可选）"
                      value={slide.captionZh || ''}
                      onChange={e => setAdForm(f => ({
                        ...f,
                        slides: f.slides.map((s, i) => (i === idx ? { ...s, captionZh: e.target.value } : s)),
                      }))}
                    />
                    <input
                      className="input"
                      style={{ flex: 1, minWidth: 140 }}
                      placeholder="本图英文说明（可选）"
                      value={slide.captionEn || ''}
                      onChange={e => setAdForm(f => ({
                        ...f,
                        slides: f.slides.map((s, i) => (i === idx ? { ...s, captionEn: e.target.value } : s)),
                      }))}
                    />
                  </div>
                </div>
              ))}
              <button
                type="button"
                className="btn btn-outline"
                style={{ fontSize: 12, marginTop: 4 }}
                onClick={() => setAdForm(f => ({
                  ...f,
                  slides: [...f.slides, { imageUrl: '', captionZh: '', captionEn: '' }],
                }))}
              >
                + 再加一张图
              </button>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>点击跳转（完整 URL）</label>
              <input className="input" style={{ width: '100%' }} placeholder="https://…" value={adForm.linkUrl}
                onChange={e => setAdForm(f => ({ ...f, linkUrl: e.target.value }))} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>开始日期</label>
              <input className="input" type="date" style={{ width: '100%' }} value={adForm.validFrom}
                onChange={e => setAdForm(f => ({ ...f, validFrom: e.target.value }))} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>结束日期</label>
              <input className="input" type="date" style={{ width: '100%' }} value={adForm.validTo}
                onChange={e => setAdForm(f => ({ ...f, validTo: e.target.value }))} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>每日开始（HH:mm，可选）</label>
              <input className="input" placeholder="09:00" value={adForm.windowStart}
                onChange={e => setAdForm(f => ({ ...f, windowStart: e.target.value }))} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>每日结束（HH:mm，可选）</label>
              <input className="input" placeholder="22:00" value={adForm.windowEnd}
                onChange={e => setAdForm(f => ({ ...f, windowEnd: e.target.value }))} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>展示次数上限（可选）</label>
              <input
                className="input"
                type="text"
                inputMode="numeric"
                placeholder="留空=不限制，达标自动停用"
                value={adForm.maxImpressionsInput}
                onChange={e => setAdForm(f => ({ ...f, maxImpressionsInput: e.target.value.replace(/\D/g, '') }))}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>点击次数上限（可选）</label>
              <input
                className="input"
                type="text"
                inputMode="numeric"
                placeholder="留空=不限制，达标自动停用"
                value={adForm.maxClicksInput}
                onChange={e => setAdForm(f => ({ ...f, maxClicksInput: e.target.value.replace(/\D/g, '') }))}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>排序（小在前）</label>
              <input className="input" type="number" value={adForm.sortOrder}
                onChange={e => setAdForm(f => ({ ...f, sortOrder: Number(e.target.value) || 0 }))} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 8 }}>投放店铺</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 10 }}>
                {([
                  ['all', '全部店铺'],
                  ['include', '指定店铺'],
                  ['exclude', '排除店铺'],
                ] as const).map(([value, label]) => (
                  <label key={value} style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="ad-store-scope"
                      checked={adForm.storeScope === value}
                      onChange={() => setAdForm(f => ({
                        ...f,
                        storeScope: value,
                        storeIds: value === 'all' ? [] : f.storeIds,
                      }))}
                    />
                    {label}
                  </label>
                ))}
              </div>
              {adForm.storeScope !== 'all' ? (
                <div style={{
                  border: '1px solid #e0e0e0',
                  borderRadius: 8,
                  background: '#fff',
                  padding: 10,
                  maxHeight: 220,
                  overflowY: 'auto',
                }}>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <button
                      type="button"
                      className="btn btn-outline"
                      style={{ fontSize: 12, padding: '2px 8px' }}
                      onClick={() => setAdForm(f => ({ ...f, storeIds: stores.map(s => s._id) }))}
                    >
                      全选
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline"
                      style={{ fontSize: 12, padding: '2px 8px' }}
                      onClick={() => setAdForm(f => ({ ...f, storeIds: [] }))}
                    >
                      清空
                    </button>
                    <span style={{ fontSize: 12, color: '#888', alignSelf: 'center' }}>
                      已选 {adForm.storeIds.length} / {stores.length}
                    </span>
                  </div>
                  {stores.length === 0 ? (
                    <div style={{ fontSize: 13, color: '#888' }}>暂无店铺</div>
                  ) : stores.map((s) => {
                    const checked = adForm.storeIds.includes(s._id);
                    return (
                      <label key={s._id} style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 13,
                        padding: '4px 2px',
                        cursor: 'pointer',
                      }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setAdForm(f => ({
                            ...f,
                            storeIds: checked
                              ? f.storeIds.filter(id => id !== s._id)
                              : [...f.storeIds, s._id],
                          }))}
                        />
                        <span>{s.displayName || s.slug}</span>
                        <span style={{ color: '#888', fontSize: 12 }}>/{s.slug}</span>
                        {s.status && s.status !== 'active' ? (
                          <span style={{ color: '#c62828', fontSize: 12 }}>{s.status}</span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: '#888' }}>所有未关闭广告、非 Enterprise 的店铺都会看到此广告。</div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
              <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={adForm.isActive}
                  onChange={e => setAdForm(f => ({ ...f, isActive: e.target.checked }))} />
                启用
              </label>
            </div>
          </div>
          <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <button type="submit" className="btn btn-primary" disabled={adSaving} style={{ background: '#1a237e' }}>
              {adSaving ? '保存中…' : '保存'}
            </button>
            <button type="button" className="btn btn-outline" onClick={resetAdForm}>取消</button>
          </div>
        </form>
        </div>
        ) : null}
      </div>
    </div>
  );
}
