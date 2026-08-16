import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../../api/client';
import '../../layouts/cashier-shell.css';
import './sales-forecast.css';

type PeriodType = 'week' | 'month';

type DishRow = {
  itemName: string;
  menuItemId: string | null;
  categoryId: string | null;
  photoUrl: string | null;
  price: number | null;
  unitPriceUsed?: number | null;
  baselinePredicted: number;
  calibrationFactor: number;
  predicted: number;
  actual: number | null;
  predictedRevenue?: number | null;
  actualRevenue?: number | null;
  errorPct: number | null;
  band: string;
  promoAdjusted: boolean;
  explain: {
    historyStart: string;
    historyEnd: string;
    itemGrowth: number;
    weekTrend?: number;
    weekTrendNote?: string | null;
    weekTrendLastItems?: number | null;
    weekTrendBaselineItems?: number | null;
    weekTrendPriorWeeks?: number | null;
    weekTrendLastMon?: string | null;
    weekTrendLastEnd?: string | null;
    weekTrendApplied?: boolean;
    monthGrowthApplied?: boolean;
    totalShareScale?: number | null;
    storeTotalPredicted?: number | null;
    weekdayContributions: Array<{ day: string; weekday: string; avgItems: number }>;
    shareOfHistItems: number | null;
    promoNote: string | null;
    yoyStatus: string;
    calibration: { factor: number; source: string; note?: string };
    formula: string;
    weatherFactorApplied?: number | null;
  };
};

type ForecastPayload = {
  periodType: PeriodType;
  targetStart: string;
  targetEnd: string;
  isPastWindow: boolean;
  sample: {
    ok: boolean;
    messageZh: string;
    messageEn: string;
    effectiveOrderDays: number;
    completeMonths: number;
    monthPeriodAllowed?: boolean;
    minRequiredDays: number;
    minRequiredMonths: number;
    historyWindow: { startDay: string; endDay: string; days: number } | null;
    yoyStatus: string;
  };
  totals: {
    predictedItems: number;
    actualItems: number | null;
    itemsErrorPct: number | null;
    itemsBand: string;
    dishHitRate: number | null;
    dishHitWarnRate: number | null;
    weatherFactor: number | null;
    weekTrendFactor: number | null;
    weekTrendNote: string | null;
    weekTrendLastItems: number | null;
    weekTrendBaselineItems: number | null;
    weekTrendPriorWeeks: number | null;
    weekTrendLastMon: string | null;
    weekTrendLastEnd: string | null;
    predictedRevenue: number | null;
    actualRevenue: number | null;
    revenueErrorPct: number | null;
    revenueBand: string;
  };
  dishes: DishRow[];
  autoCalibratedFrom: { start: string; end: string } | null;
  weather: {
    ok: boolean;
    messageZh: string;
    messageEn: string;
    windowFactor: number;
    address: string;
    days: Array<{
      day: string;
      precipMm: number;
      tmax: number;
      rainBucket: string;
      tempBand: string;
      factor: number;
      source: string;
      cellKey: string;
    }>;
  } | null;
};

type Category = { _id: string; translations?: Array<{ locale: string; name: string }> };

function todayDublinApprox(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Dublin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addDaysIso(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

export default function SalesForecastPage() {
  const { t, i18n } = useTranslation();
  const langZh = i18n.language?.startsWith('zh');

  const [periodType, setPeriodType] = useState<PeriodType>('week');
  const [startDay, setStartDay] = useState(() => addDaysIso(todayDublinApprox(), 1));
  const [autoCalibrate, setAutoCalibrate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ForecastPayload | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [activeCat, setActiveCat] = useState<string>('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<DishRow | null>(null);
  const [calFactor, setCalFactor] = useState('1');
  const [calSaving, setCalSaving] = useState(false);
  /** Backtest: show only dishes with error >35% (shape/label based, not color-only). */
  const [focusMiss, setFocusMiss] = useState(false);

  const menuScrollRef = useRef<HTMLDivElement | null>(null);
  const categorySectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const categoryBtnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const menuScrollLockRef = useRef(false);
  const menuScrollLockTimerRef = useRef<number | null>(null);
  const pendingScrollCatRef = useRef<string | null>(null);
  /** Avoid reloading mid date-picker (controlled input remount closes native calendar). */
  const startDayRef = useRef(startDay);
  startDayRef.current = startDay;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({
        periodType,
        startDay: startDayRef.current,
        ...(autoCalibrate ? { autoCalibrate: '1' } : {}),
      });
      const [forecast, cats] = await Promise.all([
        apiFetch(`/api/sales-forecast?${q}`),
        apiFetch(`/api/menu/categories?lang=${encodeURIComponent(i18n.language || 'zh-CN')}`),
      ]);
      if (!forecast.ok) {
        const j = await forecast.json().catch(() => ({}));
        throw new Error(j?.error?.message || `HTTP ${forecast.status}`);
      }
      const payload = (await forecast.json()) as ForecastPayload;
      setData(payload);
      if (cats.ok) {
        const list = (await cats.json()) as Category[];
        setCategories(Array.isArray(list) ? list : []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [periodType, autoCalibrate, i18n.language]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Hide month period when sample history span < 1 year; fall back to week. */
  const monthPeriodAllowed = data?.sample?.monthPeriodAllowed === true;
  useEffect(() => {
    if (!data) return;
    if (data.sample.monthPeriodAllowed === false && periodType === 'month') {
      setPeriodType('week');
      setStartDay(addDaysIso(todayDublinApprox(), 1));
    }
  }, [data, periodType]);

  const catName = (c: Category) => {
    const tr = c.translations || [];
    const hit = tr.find((x) => x.locale?.startsWith(langZh ? 'zh' : 'en')) || tr[0];
    return hit?.name || c._id;
  };

  const dishes = data?.dishes || [];

  const visibleDishes = useMemo(() => {
    if (!focusMiss || !data?.isPastWindow) return dishes;
    return dishes.filter((d) => d.band === 'miss');
  }, [dishes, focusMiss, data?.isPastWindow]);

  const missCount = useMemo(() => dishes.filter((d) => d.band === 'miss').length, [dishes]);

  /** Same as cashier: all dishes on one page, grouped by category sections */
  const menuSections = useMemo(() => {
    const byCat = new Map<string, DishRow[]>();
    for (const d of visibleDishes) {
      const cid = d.categoryId || '';
      if (!byCat.has(cid)) byCat.set(cid, []);
      byCat.get(cid)!.push(d);
    }
    const secs = categories
      .map((cat) => ({ category: cat, items: byCat.get(cat._id) || [] }))
      .filter((sec) => sec.items.length > 0);
    const orphan = byCat.get('') || [];
    if (orphan.length > 0) {
      secs.push({
        category: {
          _id: '__uncat',
          translations: [
            { locale: 'zh-CN', name: t('admin.uncategorized') },
            { locale: 'en-US', name: t('admin.uncategorized') },
          ],
        },
        items: orphan,
      });
    }
    return secs;
  }, [categories, visibleDishes, t]);

  const searchFilteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [] as DishRow[];
    return visibleDishes.filter((d) => d.itemName.toLowerCase().includes(q));
  }, [visibleDishes, search]);

  useEffect(() => {
    if (!data?.isPastWindow && focusMiss) setFocusMiss(false);
  }, [data?.isPastWindow, focusMiss]);

  useEffect(() => {
    if (!activeCat && menuSections[0]) setActiveCat(menuSections[0].category._id);
  }, [activeCat, menuSections]);

  const getSectionScrollTop = useCallback((root: HTMLElement, section: HTMLElement) => {
    const rootRect = root.getBoundingClientRect();
    const sectionRect = section.getBoundingClientRect();
    return Math.max(0, root.scrollTop + (sectionRect.top - rootRect.top) - 4);
  }, []);

  const pickActiveCategoryFromScroll = useCallback(
    (root: HTMLElement) => {
      const anchorY = root.getBoundingClientRect().top + 48;
      let currentId = menuSections[0]?.category._id ?? '';
      for (const sec of menuSections) {
        const el = categorySectionRefs.current[sec.category._id];
        if (!el) continue;
        if (el.getBoundingClientRect().top <= anchorY) currentId = sec.category._id;
      }
      return currentId;
    },
    [menuSections],
  );

  const lockMenuScrollSync = useCallback((root: HTMLElement, ms: number) => {
    menuScrollLockRef.current = true;
    if (menuScrollLockTimerRef.current) window.clearTimeout(menuScrollLockTimerRef.current);
    const unlock = () => {
      menuScrollLockRef.current = false;
      root.removeEventListener('scrollend', unlock);
    };
    menuScrollLockTimerRef.current = window.setTimeout(unlock, ms);
    root.addEventListener('scrollend', unlock, { once: true });
  }, []);

  const scrollToCategory = useCallback(
    (catId: string) => {
      if (search.trim()) {
        pendingScrollCatRef.current = catId;
        setSearch('');
        return;
      }
      const root = menuScrollRef.current;
      const el = categorySectionRefs.current[catId];
      if (!root || !el) {
        setActiveCat(catId);
        return;
      }
      setActiveCat(catId);
      lockMenuScrollSync(root, 900);
      root.scrollTo({ top: getSectionScrollTop(root, el), behavior: 'smooth' });
    },
    [search, getSectionScrollTop, lockMenuScrollSync],
  );

  useEffect(() => {
    const catId = pendingScrollCatRef.current;
    if (!catId || search.trim() || menuSections.length === 0) return;
    pendingScrollCatRef.current = null;
    const root = menuScrollRef.current;
    const el = categorySectionRefs.current[catId];
    if (!root || !el) return;
    setActiveCat(catId);
    lockMenuScrollSync(root, 900);
    root.scrollTo({ top: getSectionScrollTop(root, el), behavior: 'smooth' });
  }, [search, menuSections, getSectionScrollTop, lockMenuScrollSync]);

  useEffect(() => {
    const root = menuScrollRef.current;
    if (!root || search.trim() || menuSections.length === 0) return;
    const onScroll = () => {
      if (menuScrollLockRef.current) return;
      const id = pickActiveCategoryFromScroll(root);
      setActiveCat((prev) => (prev === id ? prev : id));
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, [menuSections, search, pickActiveCategoryFromScroll]);

  useEffect(() => {
    if (search.trim()) return;
    const btn = categoryBtnRefs.current[activeCat];
    btn?.scrollIntoView({ block: 'nearest' });
  }, [activeCat, search]);

  const bandMark = (band: string): { symbol: string; labelKey: string; className: string } => {
    if (band === 'hit') return { symbol: '●', labelKey: 'admin.salesForecast.bandHit', className: 'sf-band-hit' };
    if (band === 'warn') return { symbol: '▲', labelKey: 'admin.salesForecast.bandWarn', className: 'sf-band-warn' };
    if (band === 'miss') return { symbol: '■', labelKey: 'admin.salesForecast.bandMiss', className: 'sf-band-miss' };
    if (band === 'tiny') return { symbol: '○', labelKey: 'admin.salesForecast.bandTiny', className: 'sf-band-tiny' };
    return { symbol: '–', labelKey: 'admin.salesForecast.bandFuture', className: 'sf-band-neutral' };
  };

  /** Signed prep error vs actual: positive = over-suggested. */
  const signedErrorPct = (d: DishRow): number | null => {
    if (d.actual == null || d.actual <= 0 || d.errorPct == null) return null;
    const sign = d.predicted >= d.actual ? 1 : -1;
    return Math.round(sign * d.errorPct * 10) / 10;
  };

  const formatSignedPct = (n: number) => `${n > 0 ? '+' : ''}${n}%`;

  const formatEuro = (n: number) =>
    `€${n.toLocaleString(langZh ? 'zh-CN' : 'en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const weekdayLabel = (wd: string) => {
    if (langZh) {
      const zh: Record<string, string> = {
        Sun: '周日',
        Mon: '周一',
        Tue: '周二',
        Wed: '周三',
        Thu: '周四',
        Fri: '周五',
        Sat: '周六',
      };
      return zh[wd] || wd;
    }
    return wd;
  };

  const rainLabel = (b: string) => {
    if (langZh) {
      if (b === 'none') return '无雨';
      if (b === 'light') return '小雨';
      if (b === 'mod') return '中雨';
    } else {
      if (b === 'none') return 'dry';
      if (b === 'light') return 'light rain';
      if (b === 'mod') return 'mod. rain';
    }
    return b;
  };

  const tempLabel = (b: string) => {
    if (langZh) {
      if (b === 'cool') return '偏凉';
      if (b === 'mild') return '适中';
      if (b === 'warm') return '偏暖';
    } else {
      if (b === 'cool') return 'cool';
      if (b === 'mild') return 'mild';
      if (b === 'warm') return 'warm';
    }
    return b;
  };

  /** Convert multiplier 1.04 → +4% text */
  const factorAsPctText = (factor: number) => {
    const pct = Math.round((factor - 1) * 1000) / 10;
    if (Math.abs(pct) < 0.05) return t('admin.salesForecast.pctFlat');
    return pct > 0
      ? t('admin.salesForecast.pctUp', { pct: Math.abs(pct) })
      : t('admin.salesForecast.pctDown', { pct: Math.abs(pct) });
  };

  const dishExplainMeta = useMemo(() => {
    if (!selected || !data?.sample.ok) return null;
    const growth = selected.explain.itemGrowth;
    const weekTrend =
      selected.explain.weekTrend ?? data.totals.weekTrendFactor ?? 1;
    const wxFactor = selected.explain.weatherFactorApplied ?? data.totals.weatherFactor ?? 1;
    const wxDays = data.weather?.ok ? data.weather.days : [];
    const dayWx = new Map(wxDays.map((d) => [d.day, d]));
    const wxSummaryParts = wxDays.slice(0, 7).map((d) => {
      const impact = factorAsPctText(d.factor);
      return t('admin.salesForecast.weatherDayBit', {
        day: d.day.slice(5),
        rain: rainLabel(d.rainBucket),
        temp: tempLabel(d.tempBand),
        rainMm: d.precipMm,
        tmax: d.tmax,
        impact,
      });
    });
    return {
      growth,
      growthText: factorAsPctText(growth),
      weekTrend,
      weekTrendText: factorAsPctText(weekTrend),
      weekTrendLastItems:
        selected.explain.weekTrendLastItems ?? data.totals.weekTrendLastItems ?? 0,
      weekTrendBaselineItems:
        selected.explain.weekTrendBaselineItems ?? data.totals.weekTrendBaselineItems ?? 0,
      weekTrendPriorWeeks:
        selected.explain.weekTrendPriorWeeks ?? data.totals.weekTrendPriorWeeks ?? 0,
      weekTrendLastMon: selected.explain.weekTrendLastMon ?? data.totals.weekTrendLastMon ?? '—',
      weekTrendLastEnd: selected.explain.weekTrendLastEnd ?? data.totals.weekTrendLastEnd ?? '—',
      totalShareScale: selected.explain.totalShareScale ?? 1,
      storeTotalPredicted: selected.explain.storeTotalPredicted ?? null,
      wxFactor,
      wxText: factorAsPctText(wxFactor),
      wxDays,
      dayWx,
      wxSummary: wxSummaryParts.length
        ? wxSummaryParts.join(langZh ? '；' : '; ')
        : t('admin.salesForecast.weatherNone'),
      calFactor: selected.calibrationFactor,
      calText: factorAsPctText(selected.calibrationFactor),
      dayCount: selected.explain.weekdayContributions.length,
      histDaysHint:
        selected.explain.historyStart && selected.explain.historyEnd
          ? `${selected.explain.historyStart} → ${selected.explain.historyEnd}`
          : '—',
    };
    // factorAsPctText / t / labels are stable enough for this panel
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, data, langZh, i18n.language]);

  const openDish = (d: DishRow) => {
    setSelected(d);
    setCalFactor(String(d.calibrationFactor || 1));
  };

  const renderDishCard = (d: DishRow) => {
    const mark = bandMark(d.band);
    const signed = signedErrorPct(d);
    const showBand = data?.isPastWindow && (d.band === 'hit' || d.band === 'warn' || d.band === 'miss' || d.band === 'tiny');
    return (
      <div
        key={`${d.itemName}-${d.menuItemId || 'x'}`}
        className={`cashier-menu-card sf-dish-card ${showBand ? mark.className : 'sf-band-neutral'}`}
        onClick={() => openDish(d)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') openDish(d);
        }}
        role="button"
        tabIndex={0}
        aria-label={
          showBand
            ? `${d.itemName}, ${t('admin.salesForecast.suggestedPrep')} ${d.predicted}, ${t(mark.labelKey)}${
                signed != null ? ` ${formatSignedPct(signed)}` : ''
              }`
            : `${d.itemName}, ${t('admin.salesForecast.suggestedPrep')} ${d.predicted}`
        }
      >
        {data?.isPastWindow && d.actual != null ? (
          <span className="cashier-menu-card-qty sf-forecast-qty" title={t('admin.salesForecast.actual')}>
            {t('admin.salesForecast.actualShort')} {d.actual}
          </span>
        ) : null}
        {d.promoAdjusted ? (
          <span className="cashier-menu-card-soldout sf-promo-badge">{t('admin.salesForecast.promoTag')}</span>
        ) : null}
        <div className="cashier-menu-card-name">{d.itemName}</div>
        <div className="cashier-menu-card-price sf-prep-num">{d.predicted}</div>
        <div className="sf-prep-caption">{t('admin.salesForecast.suggestedPrep')}</div>
        {d.calibrationFactor !== 1 ? <div className="cashier-menu-card-meta">×{d.calibrationFactor}</div> : null}
        {showBand ? (
          <div className={`sf-band-chip ${mark.className}`}>
            <span className="sf-band-symbol" aria-hidden>
              {mark.symbol}
            </span>
            <span className="sf-band-label">{t(mark.labelKey)}</span>
            {signed != null ? <span className="sf-band-pct">{formatSignedPct(signed)}</span> : null}
          </div>
        ) : null}
      </div>
    );
  };

  const saveCalibration = async () => {
    if (!selected) return;
    setCalSaving(true);
    try {
      const factor = Number(calFactor);
      const res = await apiFetch('/api/sales-forecast/calibrations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemName: selected.itemName,
          menuItemId: selected.menuItemId,
          factor,
          note: 'manual from admin UI',
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error?.message || `HTTP ${res.status}`);
      }
      setSelected(null);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setCalSaving(false);
    }
  };

  const clearCalibration = async () => {
    if (!selected) return;
    setCalSaving(true);
    try {
      const res = await apiFetch(`/api/sales-forecast/calibrations/${encodeURIComponent(selected.itemName)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSelected(null);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setCalSaving(false);
    }
  };

  const runAutoCalibratePast = async () => {
    if (!data?.isPastWindow) {
      alert(t('admin.salesForecast.autoCalPastOnly'));
      return;
    }
    if (!confirm(t('admin.salesForecast.autoCalConfirm'))) return;
    setLoading(true);
    try {
      const res = await apiFetch('/api/sales-forecast/auto-calibrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periodType, startDay }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error?.message || `HTTP ${res.status}`);
      }
      const j = await res.json();
      alert(t('admin.salesForecast.autoCalDone', { count: j.upserted ?? 0 }));
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const sampleMsg = data
    ? langZh
      ? data.sample.messageZh
      : data.sample.messageEn
    : '';

  return (
    <div className="cashier-saas sf-forecast-root">
      <div className="sf-toolbar">
        <div className="sf-toolbar-title">
          <strong>{t('admin.salesForecast.title')}</strong>
          <span className="sf-toolbar-sub">{t('admin.salesForecast.subtitle')}</span>
        </div>
        <div className="sf-toolbar-controls">
          <label className="sf-inline-field">
            <span>{t('admin.salesForecast.periodType')}</span>
            <select
              className="input"
              value={periodType}
              onChange={(e) => {
                const v = e.target.value as PeriodType;
                if (v === 'month' && data?.sample?.monthPeriodAllowed === false) return;
                setPeriodType(v);
                if (v === 'month') {
                  const tdy = todayDublinApprox();
                  const [y, m] = tdy.split('-');
                  let mo = Number(m) + 1;
                  let yy = Number(y);
                  if (mo > 12) {
                    mo = 1;
                    yy += 1;
                  }
                  setStartDay(`${yy}-${String(mo).padStart(2, '0')}-01`);
                } else {
                  setStartDay(addDaysIso(todayDublinApprox(), 1));
                }
              }}
            >
              <option value="week">{t('admin.salesForecast.week')}</option>
              {monthPeriodAllowed ? (
                <option value="month">{t('admin.salesForecast.month')}</option>
              ) : null}
            </select>
          </label>
          <label className="sf-inline-field">
            <span>{t('admin.salesForecast.startDay')}</span>
            <input
              className="input"
              type="date"
              value={startDay}
              onChange={(e) => setStartDay(e.target.value)}
              onBlur={() => void load()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
              }}
            />
          </label>
          <label className="sf-check">
            <input
              type="checkbox"
              checked={autoCalibrate}
              onChange={(e) => setAutoCalibrate(e.target.checked)}
            />
            {t('admin.salesForecast.autoCalPrev')}
          </label>
          <button type="button" className="btn btn-primary" onClick={() => void load()} disabled={loading}>
            {loading ? t('admin.salesForecast.loading') : t('admin.salesForecast.refresh')}
          </button>
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => void runAutoCalibratePast()}
            disabled={loading || !data?.isPastWindow}
          >
            {t('admin.salesForecast.autoCalSave')}
          </button>
        </div>
      </div>

      {error ? (
        <div className="sf-banner sf-banner-err" role="alert">
          <span className="sf-banner-mark" aria-hidden>
            ■
          </span>{' '}
          {error}
        </div>
      ) : null}
      {data && !data.sample.ok ? (
        <div className="sf-banner sf-banner-warn">
          <span className="sf-banner-mark" aria-hidden>
            ▲
          </span>{' '}
          {sampleMsg}
        </div>
      ) : null}
      {data?.sample.ok ? (
        <div className="sf-banner sf-banner-ok">
          <span className="sf-banner-mark" aria-hidden>
            ●
          </span>{' '}
          {sampleMsg}
        </div>
      ) : null}

      {data?.sample.ok ? (
        <div className="sf-summary-bar">
          <div>
            <span className="sf-summary-label">{t('admin.salesForecast.predItems')}</span>
            <strong className="sf-summary-strong">{data.totals.predictedItems}</strong>
            {data.isPastWindow && data.totals.actualItems != null ? (
              <span className="sf-summary-actual">
                / {t('admin.salesForecast.actual')} {data.totals.actualItems}
                {data.totals.itemsErrorPct != null ? ` (${data.totals.itemsErrorPct}%)` : ''}
              </span>
            ) : null}
          </div>
          {data.totals.predictedRevenue != null ? (
            <div>
              <span className="sf-summary-label">{t('admin.salesForecast.predRevenue')}</span>
              <strong className="sf-summary-strong">{formatEuro(data.totals.predictedRevenue)}</strong>
              {data.isPastWindow && data.totals.actualRevenue != null ? (
                <span className="sf-summary-actual">
                  / {formatEuro(data.totals.actualRevenue)}
                  {data.totals.revenueErrorPct != null ? ` (${data.totals.revenueErrorPct}%)` : ''}
                </span>
              ) : null}
            </div>
          ) : null}
          {data.isPastWindow && data.totals.dishHitRate != null ? (
            <div className="sf-summary-perf">
              {t('admin.salesForecast.perfSummary', {
                hit: data.totals.dishHitRate,
                ok: data.totals.dishHitWarnRate ?? '—',
                miss: missCount,
              })}
            </div>
          ) : null}
          {data.weather ? (
            <div className="sf-summary-perf" title={data.weather.address || undefined}>
              {langZh ? data.weather.messageZh : data.weather.messageEn}
              {data.totals.weatherFactor != null && data.totals.weatherFactor !== 1
                ? ` · ×${data.totals.weatherFactor}`
                : ''}
            </div>
          ) : null}
          {data.totals.weekTrendFactor != null ? (
            <div className="sf-summary-perf" title={data.totals.weekTrendNote || undefined}>
              {t('admin.salesForecast.weekTrendSummary', {
                pct:
                  Math.abs(data.totals.weekTrendFactor - 1) < 0.0005
                    ? t('admin.salesForecast.pctFlat')
                    : data.totals.weekTrendFactor > 1
                      ? t('admin.salesForecast.pctUp', {
                          pct: Math.round(Math.abs(data.totals.weekTrendFactor - 1) * 1000) / 10,
                        })
                      : t('admin.salesForecast.pctDown', {
                          pct: Math.round(Math.abs(data.totals.weekTrendFactor - 1) * 1000) / 10,
                        }),
              })}
            </div>
          ) : null}
          {data.isPastWindow && missCount > 0 ? (
            <button
              type="button"
              className={`btn btn-outline sf-focus-miss-btn${focusMiss ? ' is-active' : ''}`}
              onClick={() => setFocusMiss((v) => !v)}
              aria-pressed={focusMiss}
            >
              {focusMiss
                ? t('admin.salesForecast.showAllDishes')
                : t('admin.salesForecast.focusMiss', { count: missCount })}
            </button>
          ) : null}
          <div className="sf-summary-meta">
            {data.targetStart} → {data.targetEnd}
            {' · '}
            {data.isPastWindow ? t('admin.salesForecast.modeBacktest') : t('admin.salesForecast.modeForward')}
            {data.autoCalibratedFrom
              ? ` · ${t('admin.salesForecast.autoFrom')} ${data.autoCalibratedFrom.start}→${data.autoCalibratedFrom.end}`
              : ''}
          </div>
        </div>
      ) : null}

      {/* Match CashierOrder: all dishes on one page; category click scrolls to section */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div
          style={{
            width: 110,
            flexShrink: 0,
            background: 'var(--bg-white)',
            borderRight: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            overflowY: 'auto',
            padding: '8px 0',
          }}
        >
          {menuSections.map((sec) => {
            const cat = sec.category;
            const isActive = activeCat === cat._id;
            return (
              <button
                key={cat._id}
                ref={(el) => {
                  categoryBtnRefs.current[cat._id] = el;
                }}
                type="button"
                className={`cashier-cat-btn${isActive ? ' is-active' : ''}`}
                onClick={() => scrollToCategory(cat._id)}
              >
                {catName(cat)}
              </button>
            );
          })}
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          <div
            style={{
              padding: '10px 12px',
              background: 'var(--bg-white)',
              borderBottom: '1px solid var(--border)',
              flexShrink: 0,
            }}
          >
            <input
              className="input cashier-menu-search"
              placeholder={t('cashier.searchMenuPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {search.trim() ? (
            <div style={{ padding: '10px 12px 6px', fontSize: 14, fontWeight: 700, background: 'var(--bg)', flexShrink: 0 }}>
              {t('cashier.searchResultsFor', { q: search.trim() })}
              <span style={{ fontWeight: 400, color: 'var(--text-light)', marginLeft: 8 }}>
                ({searchFilteredItems.length})
              </span>
            </div>
          ) : null}
          <div
            ref={menuScrollRef}
            style={{ flex: 1, overflowY: 'auto', padding: '8px 10px', minHeight: 0, background: 'var(--bg)' }}
          >
            {loading ? (
              <div className="sf-empty-hint">{t('admin.salesForecast.loading')}</div>
            ) : !data?.sample.ok ? (
              <div className="sf-empty-hint">{sampleMsg || t('admin.salesForecast.empty')}</div>
            ) : search.trim() ? (
              searchFilteredItems.length === 0 ? (
                <div className="sf-empty-hint">{t('cashier.menuSearchEmpty')}</div>
              ) : (
                <div className="cashier-menu-grid">{searchFilteredItems.map(renderDishCard)}</div>
              )
            ) : menuSections.length === 0 ? (
              <div className="sf-empty-hint">
                {focusMiss ? t('admin.salesForecast.emptyFocusMiss') : t('admin.salesForecast.empty')}
              </div>
            ) : (
              menuSections.map((sec) => (
                <section
                  key={sec.category._id}
                  ref={(el) => {
                    categorySectionRefs.current[sec.category._id] = el;
                  }}
                  data-category-id={sec.category._id}
                  style={{ marginBottom: 16 }}
                >
                  <div className="cashier-menu-section-title">
                    {catName(sec.category)}
                    <span style={{ fontWeight: 400, color: 'var(--text-light)', marginLeft: 8 }}>
                      ({sec.items.length})
                    </span>
                  </div>
                  <div className="cashier-menu-grid">{sec.items.map(renderDishCard)}</div>
                </section>
              ))
            )}
          </div>
        </div>

        <div
          className={`sf-side-panel${selected ? ' is-open' : ''}`}
        >
          {selected && data?.sample.ok ? (
            <>
              <div className="sf-side-head">
                <strong>{selected.itemName}</strong>
                <button type="button" className="btn btn-ghost" onClick={() => setSelected(null)}>
                  ✕
                </button>
              </div>
                <div className="sf-side-body">
                <div className="sf-result-block">
                  <div className="sf-result-line">
                    <span className="sf-result-label">{t('admin.salesForecast.suggestedPrep')}</span>
                    <strong className="sf-result-value">
                      {data.isPastWindow && selected.actual != null
                        ? t('admin.salesForecast.predVsActual', {
                            pred: selected.predicted,
                            actual: selected.actual,
                          })
                        : t('admin.salesForecast.predOnly', { pred: selected.predicted })}
                    </strong>
                  </div>
                  {selected.predictedRevenue != null ? (
                    <div className="sf-result-line">
                      <span className="sf-result-label">{t('admin.salesForecast.predRevenue')}</span>
                      <span>
                        {data.isPastWindow && selected.actualRevenue != null
                          ? `${formatEuro(selected.predictedRevenue)} / ${formatEuro(selected.actualRevenue)}`
                          : formatEuro(selected.predictedRevenue)}
                        {selected.unitPriceUsed != null ? (
                          <span className="sf-summary-actual">
                            {' '}
                            {t('admin.salesForecast.atUnitPrice', {
                              price: formatEuro(selected.unitPriceUsed),
                            })}
                          </span>
                        ) : null}
                      </span>
                    </div>
                  ) : null}
                  {data.isPastWindow &&
                  (selected.band === 'hit' ||
                    selected.band === 'warn' ||
                    selected.band === 'miss' ||
                    selected.band === 'tiny') ? (
                    <p className={`sf-band-chip sf-band-chip-inline ${bandMark(selected.band).className}`}>
                      <span className="sf-band-symbol" aria-hidden>
                        {bandMark(selected.band).symbol}
                      </span>
                      <span className="sf-band-label">{t(bandMark(selected.band).labelKey)}</span>
                      {signedErrorPct(selected) != null ? (
                        <span className="sf-band-pct">{formatSignedPct(signedErrorPct(selected)!)}</span>
                      ) : null}
                    </p>
                  ) : null}
                </div>

                <div className="cashier-menu-section-title">{t('admin.salesForecast.howTitle')}</div>
                {dishExplainMeta ? (
                  <>
                    <p className="sf-explain-lead">
                      {t('admin.salesForecast.howLeadFilled', {
                        pred: selected.predicted,
                        growth: dishExplainMeta.growthText,
                        week: dishExplainMeta.weekTrendText,
                        weather: dishExplainMeta.wxText,
                      })}
                    </p>
                    <ol className="sf-explain-steps">
                      <li>
                        {t('admin.salesForecast.howStepHistoryFilled', {
                          start: selected.explain.historyStart,
                          end: selected.explain.historyEnd,
                          days: dishExplainMeta.dayCount,
                        })}
                      </li>
                      <li>
                        {t('admin.salesForecast.howStepWeekdayFilled', {
                          days: dishExplainMeta.dayCount,
                        })}
                      </li>
                      <li>
                        {t('admin.salesForecast.howStepGrowthFilled', {
                          factor: dishExplainMeta.growth,
                          pct: dishExplainMeta.growthText,
                          applied: (selected.explain.monthGrowthApplied ?? data.periodType === 'month')
                            ? t('admin.salesForecast.trendApplied')
                            : t('admin.salesForecast.trendNotApplied'),
                        })}
                      </li>
                      <li>
                        {t('admin.salesForecast.howStepWeekTrendFilled', {
                          factor: dishExplainMeta.weekTrend,
                          pct: dishExplainMeta.weekTrendText,
                          last: dishExplainMeta.weekTrendLastItems,
                          base: dishExplainMeta.weekTrendBaselineItems,
                          n: dishExplainMeta.weekTrendPriorWeeks,
                          lastMon: dishExplainMeta.weekTrendLastMon,
                          lastEnd: dishExplainMeta.weekTrendLastEnd,
                          applied: (selected.explain.weekTrendApplied ?? data.periodType === 'week')
                            ? t('admin.salesForecast.trendApplied')
                            : t('admin.salesForecast.trendNotApplied'),
                        })}
                      </li>
                      <li>
                        {t('admin.salesForecast.howStepShareScaleFilled', {
                          scale: dishExplainMeta.totalShareScale,
                          store: dishExplainMeta.storeTotalPredicted ?? '—',
                        })}
                      </li>
                      <li>
                        {t('admin.salesForecast.howStepWeatherFilled', {
                          factor: dishExplainMeta.wxFactor,
                          pct: dishExplainMeta.wxText,
                          detail: dishExplainMeta.wxSummary,
                        })}
                      </li>
                      <li>
                        {selected.explain.calibration.source === 'none' ||
                        selected.calibrationFactor === 1
                          ? t('admin.salesForecast.howStepCalNone')
                          : t('admin.salesForecast.howStepCalFilled', {
                              factor: selected.calibrationFactor,
                              pct: dishExplainMeta.calText,
                              source:
                                selected.explain.calibration.source === 'stored'
                                  ? t('admin.salesForecast.calSourceManual')
                                  : t('admin.salesForecast.calSourceAuto'),
                            })}
                      </li>
                    </ol>
                  </>
                ) : null}
                {selected.explain.promoNote ? (
                  <p className="sf-note">{t('admin.salesForecast.promoExplain')}</p>
                ) : null}

                <div className="cashier-menu-section-title">{t('admin.salesForecast.weekdayBreakdown')}</div>
                <p className="sf-hint">{t('admin.salesForecast.weekdayBreakdownHint')}</p>
                <ul className="sf-wd-list">
                  {selected.explain.weekdayContributions.map((w) => {
                    const wx = dishExplainMeta?.dayWx.get(w.day);
                    return (
                      <li key={w.day}>
                        {wx
                          ? t('admin.salesForecast.dayPortionWeather', {
                              day: w.day,
                              weekday: weekdayLabel(w.weekday),
                              n: w.avgItems,
                              rain: rainLabel(wx.rainBucket),
                              temp: tempLabel(wx.tempBand),
                              rainMm: wx.precipMm,
                              tmax: wx.tmax,
                              impact: factorAsPctText(wx.factor),
                            })
                          : t('admin.salesForecast.dayPortion', {
                              day: w.day,
                              weekday: weekdayLabel(w.weekday),
                              n: w.avgItems,
                            })}
                      </li>
                    );
                  })}
                </ul>

                <div className="cashier-menu-section-title">{t('admin.salesForecast.calibrate')}</div>
                <p className="sf-hint">{t('admin.salesForecast.calibrateHint')}</p>
                <div className="sf-cal-row">
                  <input
                    className="input cashier-qty-input"
                    type="number"
                    step="0.01"
                    min="0.75"
                    max="1.25"
                    value={calFactor}
                    onChange={(e) => setCalFactor(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={calSaving}
                    onClick={() => void saveCalibration()}
                  >
                    {t('admin.salesForecast.saveCal')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={calSaving}
                    onClick={() => void clearCalibration()}
                  >
                    {t('admin.salesForecast.clearCal')}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="sf-side-empty">{t('admin.salesForecast.clickDishHint')}</div>
          )}
        </div>
      </div>
    </div>
  );
}
