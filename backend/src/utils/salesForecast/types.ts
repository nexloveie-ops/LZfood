export type PeriodType = 'week' | 'month';

export type ErrorBand = 'hit' | 'warn' | 'miss' | 'future' | 'tiny' | 'n/a';

export type YoyStatus = 'unavailable' | 'ready' | 'applied' | 'suppressed_by_promo';

export type SampleStatus = {
  ok: boolean;
  periodType: PeriodType;
  minRequiredDays: number;
  minRequiredMonths: number;
  effectiveOrderDays: number;
  completeMonths: number;
  /** True when order history span ≥ ~1 year (month period selectable). */
  monthPeriodAllowed: boolean;
  earliestOrderDay: string | null;
  latestOrderDay: string | null;
  messageZh: string;
  messageEn: string;
  historyWindow: { startDay: string; endDay: string; days: number } | null;
  yoyStatus: YoyStatus;
};

export type DishForecastRow = {
  itemName: string;
  menuItemId: string | null;
  categoryId: string | null;
  photoUrl: string | null;
  price: number | null;
  /** Unit € used for revenue (menu price or hist avg). */
  unitPriceUsed: number | null;
  baselinePredicted: number;
  calibrationFactor: number;
  predicted: number;
  actual: number | null;
  predictedRevenue: number | null;
  actualRevenue: number | null;
  errorPct: number | null;
  band: ErrorBand;
  promoAdjusted: boolean;
  explain: DishExplain;
};

export type DishExplain = {
  historyStart: string;
  historyEnd: string;
  itemGrowth: number;
  /** Last complete week vs prior weeks (store item total), clipped. */
  weekTrend: number;
  weekTrendNote: string | null;
  weekTrendLastItems: number | null;
  weekTrendBaselineItems: number | null;
  weekTrendPriorWeeks: number | null;
  weekTrendLastMon: string | null;
  weekTrendLastEnd: string | null;
  /** Whether week/month trend was actually multiplied into the baseline. */
  weekTrendApplied: boolean;
  monthGrowthApplied: boolean;
  /**
   * Two-stage: store-total forecast ÷ raw dish sum (≈1 when mix already matches).
   * Week trend (dampened) lives in the store total, not per-SKU multiply.
   */
  totalShareScale: number | null;
  storeTotalPredicted: number | null;
  weekdayContributions: Array<{ day: string; weekday: string; avgItems: number }>;
  shareOfHistItems: number | null;
  promoNote: string | null;
  yoyStatus: YoyStatus;
  calibration: {
    factor: number;
    source: 'none' | 'stored' | 'auto_prev_window';
    note?: string;
  };
  formula: string;
  /** Store weather×order day factor already baked into weekdayContributions / baseline. */
  weatherFactorApplied: number | null;
};

export type ForecastResult = {
  storeId: string;
  timezone: string;
  periodType: PeriodType;
  targetStart: string;
  targetEnd: string;
  isPastWindow: boolean;
  sample: SampleStatus;
  /** Aggregate of dish prep forecasts only (orders are intentionally omitted). */
  totals: {
    predictedItems: number;
    actualItems: number | null;
    itemsErrorPct: number | null;
    itemsBand: ErrorBand;
    /** Eligible dishes with actual ≥ band floor (backtest only). */
    dishHitRate: number | null;
    dishHitWarnRate: number | null;
    /** Mean weather×order calibration over target days (1 = none). */
    weatherFactor: number | null;
    /** Last complete week vs prior weeks (store portions), clipped. */
    weekTrendFactor: number | null;
    weekTrendNote: string | null;
    weekTrendLastItems: number | null;
    weekTrendBaselineItems: number | null;
    weekTrendPriorWeeks: number | null;
    weekTrendLastMon: string | null;
    weekTrendLastEnd: string | null;
    /** Food GMV ≈ Σ predicted portions × unit price (excludes delivery fee). */
    predictedRevenue: number | null;
    actualRevenue: number | null;
    revenueErrorPct: number | null;
    revenueBand: ErrorBand;
  };
  dishes: DishForecastRow[];
  autoCalibratedFrom: { start: string; end: string } | null;
  /** Store-level weather calibration from restaurant address (optional). */
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
