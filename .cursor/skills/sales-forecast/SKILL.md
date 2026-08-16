---
name: sales-forecast
description: >-
  LZFOOD 备货预测 (dish/prep portions from Mongo): weekday-recency + lag7 mix,
  store-total share-scale, holdout vs actual, promo-aware. Wake when the user
  says 备货预测 (also 销量预测, 预测销量, 菜品销量, sales forecast) or asks for
  prep volume — read-only unless they say ok go.
---

# 备货预测（菜品份数）

## Trigger
Wake phrase: **备货预测**. Also: 销量预测 / 预测销量 / 菜品销量 / sales forecast.

## Product intent
- **Primary**: per-dish **prep portions** (备货), not order totals.
- Do not emphasize predicted order counts in analysis or UI.
- Feature key: `admin.salesForecast.page` → Admin `/admin/sales-forecast`.

## Defaults
- **No code changes** unless the user explicitly asks to implement.
- Query Mongo via `backend` + `dotenv` (`LZFOOD_DBCON` or `DBCON`). Never echo secrets.
- Calendar buckets in **Europe/Dublin**.
- Engine: `backend/src/utils/salesForecast/`; API: `/api/sales-forecast`.
- Sample gates: week ≥56 order days; month ≥3 full months **and** ≥1y span (span via cheap min/max agg). Auto window: 12 weeks / 6 months.
- **Perf**: order payload lookback ~20 weeks (week) / ~8 months (month) — not since 2020; weather HTTP ≤8s + cache; geocode timeout 8s.
- Error bands: ≤20% hit, ≤35% warn, >35% miss (red). Auto-cal: miss-only, half-step, clip 0.75–1.25.
- Dish formula: mix = `0.7 × recency weekday + 0.3 × lag-7`; **store total** = same blend × dampened week trend (`1+(f-1)×0.4`) on week (or month growth on month); dishes **share-scaled** to store total. Promo SKUs: post-promo daily × days before scale.
- **Revenue**: `Σ predicted portions × unit €` (menu price or hist avg; excludes delivery fee). Summary KPI only — prep remains portion-first.
- **Weather cal** (optional, default on): restaurant address → Open-Meteo; learn `rain×temp` cells vs **daily order** weekday residuals; clip 0.85–1.15; multiply each forecast day. Disable with `weatherCal=0`.
- YoY: `yoyStatus` reserved; inactive until ~14 months.

## Workflow
1. Resolve `stores` by slug; disambiguate if multiple.
2. Pull `orders` for history + holdout (`createdAt`, `items`).
3. Lines: `itemName` / `itemNameEn` + `quantity`.
4. Forecast store **total** portions, then **share-scale** each SKU mix to that total.
5. Holdout: dish hit rate / MAPE / Top20 hit — ignore order-count accuracy.
6. Check `offers` for promo-distorted SKUs; exclude promo window from baseline.

## Output
Focus on dish prep tables: predicted vs actual vs error. Flag promo SKUs. Skip order-total scorecards unless asked.

## Reference rule
`.cursor/rules/lzfood-sales-forecast.mdc`
