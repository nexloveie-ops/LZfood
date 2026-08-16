/** Sales forecast addon — shared thresholds (Europe/Dublin ops). */

export const FORECAST_TZ = 'Europe/Dublin';

/** Week forecast: minimum calendar days of order history */
export const MIN_SAMPLE_DAYS_WEEK = 56;

/** Month forecast: minimum complete calendar months (once year-span gate passes) */
export const MIN_SAMPLE_MONTHS = 3;

/** Month forecast UI/API: require ≥1 year of order history span */
export const MIN_HISTORY_DAYS_FOR_MONTH = 365;

/** Auto-selected history window when sample is sufficient */
export const DEFAULT_HISTORY_WEEKS = 12;
export const DEFAULT_HISTORY_MONTHS = 6;

/**
 * Mongo lookback for order payloads (not from 2020).
 * Week: history window + lag-7 + week-trend prior weeks + slack.
 * Month: enough for DEFAULT_HISTORY_MONTHS (+ slack); year-span via cheap min/max agg.
 */
export const ORDER_LOAD_LOOKBACK_WEEKS = DEFAULT_HISTORY_WEEKS + 8;
export const ORDER_LOAD_LOOKBACK_MONTHS = DEFAULT_HISTORY_MONTHS + 2;

/** Open-Meteo / geocode HTTP timeout (Cloud Run egress can hang otherwise). */
export const WEATHER_FETCH_TIMEOUT_MS = 8000;
/** In-process weather range cache TTL */
export const WEATHER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Relative error bands (vs actual), when actual >= MIN_ACTUAL_FOR_BAND */
export const HIT_OK = 0.2;
export const HIT_WARN = 0.35;
export const MIN_ACTUAL_FOR_BAND = 5;

/** Auto-calibration: only miss band, half-step toward actual/pred, then clip */
export const CAL_CLIP_LO = 0.75;
export const CAL_CLIP_HI = 1.25;
export const CAL_DAMPEN = 0.5;
export const MIN_PRED_FOR_CAL = 3;

/** YoY curve reserved; inactive until ~14 months history */
export const YOY_MIN_DAYS = 420;

/**
 * Dish / prep forecast blend (holdout-tested on tasteofhongkong):
 * recency-weighted same-weekday mean + lag-7 seasonal naive.
 * Order totals are not a product metric — only SKU portions matter for stocking.
 */
export const DISH_RECENCY_HALF_LIFE_DAYS = 21;
export const DISH_BLEND_RECENCY = 0.7;
export const DISH_BLEND_LAG7 = 0.3;
/** Clip month-over-month item growth applied to dish baselines */
export const ITEM_GROWTH_CLIP_LO = 0.75;
export const ITEM_GROWTH_CLIP_HI = 1.25;

/** Weather × daily-order calibration (store-level multiplier on dish days). */
export const WEATHER_CAL_CLIP_LO = 0.85;
export const WEATHER_CAL_CLIP_HI = 1.15;
/** Min sample days in a rain×temp cell before using that cell factor */
export const WEATHER_CELL_MIN_N = 8;
/** Precipitation buckets (mm / Dublin day) */
export const WEATHER_RAIN_LIGHT_MAX = 5;
export const WEATHER_RAIN_NONE_MAX = 0.2;

/**
 * Store-level week trend: last complete Mon–Sun item total
 * vs mean of the previous N complete weeks (Dublin).
 * Applied only to store total (then share-scaled to dishes), and dampened
 * so it does not stack fully on top of the recency weekday blend.
 */
export const WEEK_TREND_BASELINE_WEEKS = 3;
export const WEEK_TREND_CLIP_LO = 0.85;
export const WEEK_TREND_CLIP_HI = 1.15;
/** Soften week-trend residual: applied = 1 + (clipped − 1) × dampen */
export const WEEK_TREND_DAMPEN = 0.4;
