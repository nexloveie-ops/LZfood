import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import ReportSegmentConfigPanel from '../../components/ReportSegmentConfigPanel';
import './report-segments.css';

interface SegmentGroup {
  id: string;
  sortOrder: number;
  nameZh: string;
  nameEn: string;
  categoryIds: string[];
}

interface GroupMetrics {
  groupId: string;
  sales: number;
  qty: number;
  orderCount: number;
  sharePct: number;
}

interface BreakdownRow {
  key: string;
  label: string;
  groups: GroupMetrics[];
  foodTotal: number;
}

interface BreakdownPayload {
  timezone: string;
  granularity: 'day' | 'hour';
  from: string;
  to: string;
  groups: SegmentGroup[];
  rows: BreakdownRow[];
  totals: { foodTotal: number; groups: GroupMetrics[] };
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getWeekRange(offsetWeeks = 0): { start: string; end: string } {
  const today = new Date();
  const day = today.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(today);
  monday.setDate(today.getDate() + diffToMonday + offsetWeeks * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: fmtDate(monday), end: fmtDate(sunday) };
}

function getYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return fmtDate(d);
}

function groupLabel(g: SegmentGroup, locale: string): string {
  return locale.startsWith('zh') ? (g.nameZh || g.nameEn) : (g.nameEn || g.nameZh);
}

function bucketAxisLabel(row: BreakdownRow, granularity: 'day' | 'hour'): string {
  return granularity === 'day' ? row.label : row.key;
}

const CHART_COLORS = ['#3949ab', '#c62828', '#2e7d32', '#ef6c00', '#6a1b9a', '#00838f', '#5d4037'];

type SegmentMetric = 'sales' | 'orders' | 'share';
type ChartType = 'line' | 'bar';

const CHART_LABEL_LANE = 12;
const CHART_LABEL_MIN_GAP = 11;

type ChartNodeLabel = {
  key: string;
  x: number;
  y: number;
  text: string;
  color: string;
  anchor: 'start' | 'middle' | 'end';
  opacity?: number;
};

function resolveLabelCollisions(labels: ChartNodeLabel[], pushDown: boolean): ChartNodeLabel[] {
  if (labels.length <= 1) return labels;
  const sorted = [...labels].sort((a, b) => a.y - b.y);
  if (pushDown) {
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].y - sorted[i - 1].y < CHART_LABEL_MIN_GAP) {
        sorted[i].y = sorted[i - 1].y + CHART_LABEL_MIN_GAP;
      }
    }
  } else {
    for (let i = sorted.length - 2; i >= 0; i--) {
      if (sorted[i + 1].y - sorted[i].y < CHART_LABEL_MIN_GAP) {
        sorted[i].y = sorted[i + 1].y - CHART_LABEL_MIN_GAP;
      }
    }
  }
  return sorted;
}

function buildChartNodeLabels(params: {
  rows: BreakdownRow[];
  compareRows: BreakdownRow[] | null;
  series: SegmentGroup[];
  metric: SegmentMetric;
  xStep: number;
  rowCount: number;
  padL: number;
  innerW: number;
  innerH: number;
  padT: number;
  maxY: number;
  colors: string[];
}): ChartNodeLabel[] {
  const { rows, compareRows, series, metric, xStep, rowCount, padL, innerW, innerH, padT, maxY, colors } = params;
  const byX = new Map<number, ChartNodeLabel[]>();

  const addLabel = (item: ChartNodeLabel) => {
    const bucket = byX.get(Math.round(item.x)) ?? [];
    bucket.push(item);
    byX.set(Math.round(item.x), bucket);
  };

  const pointY = (val: number) => padT + innerH - (val / maxY) * innerH;

  series.forEach((g, gi) => {
    const color = colors[gi % colors.length];
    rows.forEach((row, i) => {
      const m = row.groups.find((x) => x.groupId === g.id);
      const val = metricValue(m, row, metric);
      const text = formatChartNodeLabel(val, metric);
      if (!text) return;
      const x = padL + (rowCount > 1 ? i * xStep : innerW / 2);
      const py = pointY(val);
      addLabel({
        key: `p-${g.id}-${i}`,
        x,
        y: py - 10 - gi * CHART_LABEL_LANE,
        text,
        color,
        anchor: xAxisLabelAnchor(i, rowCount),
      });
    });

    if (compareRows) {
      compareRows.forEach((row, i) => {
        const m = row.groups.find((x) => x.groupId === g.id);
        const val = metricValue(m, row, metric);
        const text = formatChartNodeLabel(val, metric);
        if (!text) return;
        const x = padL + (rowCount > 1 ? i * xStep : innerW / 2);
        const py = pointY(val);
        addLabel({
          key: `c-${g.id}-${i}`,
          x,
          y: py + 14 + gi * CHART_LABEL_LANE,
          text,
          color,
          anchor: xAxisLabelAnchor(i, compareRows.length),
          opacity: 0.85,
        });
      });
    }
  });

  const out: ChartNodeLabel[] = [];
  for (const bucket of byX.values()) {
    const primary = bucket.filter((l) => !l.key.startsWith('c-'));
    const compare = bucket.filter((l) => l.key.startsWith('c-'));
    out.push(...resolveLabelCollisions(primary, false));
    out.push(...resolveLabelCollisions(compare, true));
  }
  return out;
}

function metricValue(m: GroupMetrics | undefined, row: BreakdownRow, metric: SegmentMetric): number {
  if (!m) return 0;
  if (metric === 'sales') return m.sales;
  if (metric === 'orders') return m.orderCount;
  return m.sharePct;
}

function rowMetricTotal(row: BreakdownRow, metric: SegmentMetric): number {
  if (metric === 'sales') return row.foodTotal;
  if (metric === 'orders') return row.groups.reduce((s, g) => s + g.orderCount, 0);
  return row.groups.reduce((s, g) => s + g.sharePct, 0);
}

function orderSharePct(m: GroupMetrics | undefined, row: BreakdownRow): number {
  if (!m) return 0;
  const total = row.groups.reduce((s, g) => s + g.orderCount, 0);
  return total > 0 ? Math.round((m.orderCount / total) * 1000) / 10 : 0;
}

function formatMetricValue(value: number, metric: SegmentMetric): string {
  if (metric === 'sales') return `€${value.toFixed(2)}`;
  if (metric === 'orders') return `${value.toFixed(2)}单`;
  return `${value.toFixed(2)}%`;
}

function formatTableSharePct(value: number): string {
  return `${value.toFixed(2)}%`;
}

function xAxisLabelAnchor(index: number, total: number): 'start' | 'middle' | 'end' {
  if (total <= 1) return 'middle';
  if (index === 0) return 'start';
  if (index === total - 1) return 'end';
  return 'middle';
}

function formatChartNodeLabel(value: number, metric: SegmentMetric): string {
  if (value <= 0) return '';
  if (metric === 'share') return `${value.toFixed(0)}%`;
  if (metric === 'orders') return String(Math.round(value));
  if (value >= 1000) return `€${(value / 1000).toFixed(1)}k`;
  return `€${Math.round(value)}`;
}

function ChartNodeLabelText({ label }: { label: ChartNodeLabel }) {
  return (
    <text
      x={label.x}
      y={label.y}
      fontSize={9}
      fill={label.color}
      textAnchor={label.anchor}
      fontWeight={600}
      opacity={label.opacity ?? 1}
      stroke="#fff"
      strokeWidth={3}
      paintOrder="stroke"
    >
      {label.text}
    </text>
  );
}

function formatAxisValue(value: number, metric: SegmentMetric): string {
  if (metric === 'share') return `${Math.round(value)}%`;
  if (metric === 'sales') return `€${value.toFixed(0)}`;
  return String(Math.round(value));
}

function totalsMetricShare(groupId: string, totalsGroups: GroupMetrics[], metric: SegmentMetric): number {
  const g = totalsGroups.find((x) => x.groupId === groupId);
  if (!g) return 0;
  if (metric === 'sales' || metric === 'share') return g.sharePct;
  const total = totalsGroups.reduce((s, x) => s + x.orderCount, 0);
  return total > 0 ? Math.round((g.orderCount / total) * 1000) / 10 : 0;
}

function renderMetricCell(
  m: GroupMetrics | undefined,
  row: BreakdownRow,
  metric: SegmentMetric,
  muted?: boolean,
): ReactNode {
  if (metric === 'share') {
    return <>{formatMetricValue(metricValue(m, row, metric), metric)}</>;
  }
  const share = metric === 'sales' ? (m?.sharePct ?? 0) : orderSharePct(m, row);
  return (
    <>
      {formatMetricValue(metricValue(m, row, metric), metric)}{' '}
      <span style={{ color: muted ? '#aaa' : '#888' }}>({formatTableSharePct(share)})</span>
    </>
  );
}

function useChartContainerWidth() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { containerRef, containerWidth };
}

function chartMaxY(
  rows: BreakdownRow[],
  compareRows: BreakdownRow[] | null,
  visibleGroupIds: Set<string>,
  metric: SegmentMetric,
): number {
  if (metric === 'share') return 100;
  return Math.max(
    1,
    ...rows.flatMap((r) => r.groups.filter((g) => visibleGroupIds.has(g.groupId)).map((g) => metricValue(g, r, metric))),
    ...(compareRows ?? []).flatMap((r) => r.groups.filter((g) => visibleGroupIds.has(g.groupId)).map((g) => metricValue(g, r, metric))),
  );
}

function ChartContainer({
  containerRef,
  containerWidth,
  height,
  children,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  containerWidth: number;
  height: number;
  children: (width: number) => ReactNode;
}) {
  const width = Math.max(containerWidth, 320);
  return (
    <div
      ref={containerRef}
      style={{ width: '100%', border: '1px solid #eee', borderRadius: 8, padding: 8, background: '#fafafa', boxSizing: 'border-box' }}
    >
      {containerWidth > 0 && (
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="segment chart"
          style={{ display: 'block' }}
        >
          {children(width)}
        </svg>
      )}
    </div>
  );
}

function ChartGridLines({
  padL,
  padT,
  innerH,
  innerR,
  maxY,
  metric,
}: {
  padL: number;
  padT: number;
  innerH: number;
  innerR: number;
  maxY: number;
  metric: SegmentMetric;
}) {
  return (
    <>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const y = padT + innerH * (1 - t);
        const val = maxY * t;
        return (
          <g key={t}>
            <line x1={padL} y1={y} x2={innerR} y2={y} stroke="#e0e0e0" strokeWidth={1} />
            <text x={4} y={y + 4} fontSize={10} fill="#888">{formatAxisValue(val, metric)}</text>
          </g>
        );
      })}
    </>
  );
}

function buildBarChartNodeLabels(params: {
  rows: BreakdownRow[];
  compareRows: BreakdownRow[] | null;
  series: SegmentGroup[];
  metric: SegmentMetric;
  padL: number;
  innerW: number;
  innerH: number;
  padT: number;
  maxY: number;
  colors: string[];
}): ChartNodeLabel[] {
  const { rows, compareRows, series, metric, padL, innerW, innerH, padT, maxY, colors } = params;
  const slotW = innerW / Math.max(rows.length, 1);
  const barsPerBucket = series.length * (compareRows ? 2 : 1);
  const clusterW = slotW * 0.85;
  const barW = Math.max(2, (clusterW - Math.max(0, barsPerBucket - 1)) / barsPerBucket);
  const byX = new Map<number, ChartNodeLabel[]>();

  const addLabel = (item: ChartNodeLabel) => {
    const bucket = byX.get(Math.round(item.x)) ?? [];
    bucket.push(item);
    byX.set(Math.round(item.x), bucket);
  };

  const barTopY = (val: number) => padT + innerH - (val / maxY) * innerH;

  rows.forEach((row, i) => {
    const bucketCenterX = padL + slotW * (i + 0.5);
    const clusterStart = bucketCenterX - clusterW / 2;

    series.forEach((g, gi) => {
      const color = colors[gi % colors.length];
      const m = row.groups.find((x) => x.groupId === g.id);
      const val = metricValue(m, row, metric);
      const text = formatChartNodeLabel(val, metric);
      const barIndex = gi * (compareRows ? 2 : 1);
      const barCenterX = clusterStart + barIndex * (barW + 1) + barW / 2;

      if (text) {
        addLabel({
          key: `p-${g.id}-${i}`,
          x: barCenterX,
          y: barTopY(val) - 4,
          text,
          color,
          anchor: 'middle',
        });
      }

      if (compareRows) {
        const cmpRow = compareRows[i];
        const cm = cmpRow?.groups.find((x) => x.groupId === g.id);
        const cmpVal = metricValue(cm, cmpRow ?? row, metric);
        const cmpText = formatChartNodeLabel(cmpVal, metric);
        const cmpBarCenterX = clusterStart + (barIndex + 1) * (barW + 1) + barW / 2;
        if (cmpText) {
          addLabel({
            key: `c-${g.id}-${i}`,
            x: cmpBarCenterX,
            y: barTopY(cmpVal) - 4,
            text: cmpText,
            color,
            anchor: 'middle',
            opacity: 0.85,
          });
        }
      }
    });
  });

  const out: ChartNodeLabel[] = [];
  for (const bucket of byX.values()) {
    out.push(...resolveLabelCollisions([...bucket].sort((a, b) => a.y - b.y), false));
  }
  return out;
}

function SegmentLineChart({
  rows,
  compareRows,
  groups,
  visibleGroupIds,
  granularity,
  metric,
  height = 280,
}: {
  rows: BreakdownRow[];
  compareRows: BreakdownRow[] | null;
  groups: SegmentGroup[];
  visibleGroupIds: Set<string>;
  granularity: 'day' | 'hour';
  metric: SegmentMetric;
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const width = Math.max(containerWidth, 320);
  const series = groups.filter((g) => visibleGroupIds.has(g.id));
  const pad = {
    l: 48,
    r: 36,
    t: 16 + Math.max(0, series.length - 1) * 10,
    b: 36,
  };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;

  const maxY = metric === 'share'
    ? 100
    : Math.max(
      1,
      ...rows.flatMap((r) => r.groups.filter((g) => visibleGroupIds.has(g.groupId)).map((g) => metricValue(g, r, metric))),
      ...(compareRows ?? []).flatMap((r) => r.groups.filter((g) => visibleGroupIds.has(g.groupId)).map((g) => metricValue(g, r, metric))),
    );

  const xStep = rows.length > 1 ? innerW / (rows.length - 1) : 0;

  const toPointCoords = (data: BreakdownRow[], gid: string) =>
    data.map((row, i) => {
      const m = row.groups.find((g) => g.groupId === gid);
      const val = metricValue(m, row, metric);
      const x = pad.l + (rows.length > 1 ? i * xStep : innerW / 2);
      const y = pad.t + innerH - (val / maxY) * innerH;
      return { x, y, val };
    });

  const toPoints = (data: BreakdownRow[], gid: string) =>
    toPointCoords(data, gid).map((p) => `${p.x},${p.y}`).join(' ');

  const nodeLabels = useMemo(
    () => buildChartNodeLabels({
      rows,
      compareRows,
      series,
      metric,
      xStep,
      rowCount: rows.length,
      padL: pad.l,
      innerW,
      innerH,
      padT: pad.t,
      maxY,
      colors: CHART_COLORS,
    }),
    [rows, compareRows, series, metric, xStep, rows.length, pad.l, innerW, innerH, pad.t, maxY],
  );

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', border: '1px solid #eee', borderRadius: 8, padding: 8, background: '#fafafa', boxSizing: 'border-box' }}
    >
      {containerWidth > 0 && (
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="segment chart"
        style={{ display: 'block' }}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const y = pad.t + innerH * (1 - t);
          const val = maxY * t;
          return (
            <g key={t}>
              <line x1={pad.l} y1={y} x2={width - pad.r} y2={y} stroke="#e0e0e0" strokeWidth={1} />
              <text x={4} y={y + 4} fontSize={10} fill="#888">{formatAxisValue(val, metric)}</text>
            </g>
          );
        })}
        {series.map((g, gi) => {
          const color = CHART_COLORS[gi % CHART_COLORS.length];
          const primaryCoords = toPointCoords(rows, g.id);
          const compareCoords = compareRows ? toPointCoords(compareRows, g.id) : [];
          return (
            <g key={g.id}>
              <polyline
                fill="none"
                stroke={color}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                points={toPoints(rows, g.id)}
              />
              {primaryCoords.map((p, i) => (
                <circle key={`p-${i}`} cx={p.x} cy={p.y} r={3} fill={color} stroke="#fff" strokeWidth={1.5} />
              ))}
              {compareRows && (
                <>
                  <polyline
                    fill="none"
                    stroke={color}
                    strokeWidth={2.5}
                    strokeDasharray="10 6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={1}
                    points={toPoints(compareRows, g.id)}
                  />
                  {compareCoords.map((p, i) => (
                    <circle key={`c-${i}`} cx={p.x} cy={p.y} r={4.5} fill="#fff" stroke={color} strokeWidth={2.5} />
                  ))}
                </>
              )}
            </g>
          );
        })}
        {nodeLabels.map((label) => (
          <ChartNodeLabelText key={label.key} label={label} />
        ))}
        {rows.map((row, i) => {
          const x = pad.l + (rows.length > 1 ? i * xStep : innerW / 2);
          const label = bucketAxisLabel(row, granularity);
          return (
            <text
              key={row.key}
              x={x}
              y={height - 8}
              fontSize={9}
              fill="#666"
              textAnchor={xAxisLabelAnchor(i, rows.length)}
            >
              {label}
            </text>
          );
        })}
      </svg>
      )}
    </div>
  );
}

function SegmentBarChart({
  rows,
  compareRows,
  groups,
  visibleGroupIds,
  granularity,
  metric,
  height = 280,
}: {
  rows: BreakdownRow[];
  compareRows: BreakdownRow[] | null;
  groups: SegmentGroup[];
  visibleGroupIds: Set<string>;
  granularity: 'day' | 'hour';
  metric: SegmentMetric;
  height?: number;
}) {
  const { containerRef, containerWidth } = useChartContainerWidth();
  const width = Math.max(containerWidth, 320);
  const series = groups.filter((g) => visibleGroupIds.has(g.id));
  const pad = { l: 48, r: 36, t: 20, b: 36 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const maxY = chartMaxY(rows, compareRows, visibleGroupIds, metric);
  const slotW = innerW / Math.max(rows.length, 1);
  const barsPerBucket = series.length * (compareRows ? 2 : 1);
  const clusterW = slotW * 0.85;
  const barW = Math.max(2, (clusterW - Math.max(0, barsPerBucket - 1)) / barsPerBucket);
  const barGap = 1;

  const nodeLabels = useMemo(
    () => buildBarChartNodeLabels({
      rows,
      compareRows,
      series,
      metric,
      padL: pad.l,
      innerW,
      innerH,
      padT: pad.t,
      maxY,
      colors: CHART_COLORS,
    }),
    [rows, compareRows, series, metric, pad.l, innerW, innerH, pad.t, maxY],
  );

  return (
    <ChartContainer containerRef={containerRef} containerWidth={containerWidth} height={height}>
      {(chartWidth) => (
        <>
          <ChartGridLines padL={pad.l} padT={pad.t} innerH={innerH} innerR={chartWidth - pad.r} maxY={maxY} metric={metric} />
          {rows.map((row, i) => {
            const bucketCenterX = pad.l + slotW * (i + 0.5);
            const clusterStart = bucketCenterX - clusterW / 2;
            return (
              <g key={row.key}>
                {series.map((g, gi) => {
                  const color = CHART_COLORS[gi % CHART_COLORS.length];
                  const m = row.groups.find((x) => x.groupId === g.id);
                  const val = metricValue(m, row, metric);
                  const barIndex = gi * (compareRows ? 2 : 1);
                  const barLeft = clusterStart + barIndex * (barW + barGap);
                  const barHeight = (val / maxY) * innerH;
                  const barTop = pad.t + innerH - barHeight;

                  const cmpRow = compareRows?.[i];
                  const cm = cmpRow?.groups.find((x) => x.groupId === g.id);
                  const cmpVal = metricValue(cm, cmpRow ?? row, metric);
                  const cmpBarLeft = clusterStart + (barIndex + 1) * (barW + barGap);
                  const cmpBarHeight = (cmpVal / maxY) * innerH;
                  const cmpBarTop = pad.t + innerH - cmpBarHeight;

                  return (
                    <Fragment key={g.id}>
                      {val > 0 && (
                        <rect x={barLeft} y={barTop} width={barW} height={barHeight} fill={color} rx={1} />
                      )}
                      {compareRows && cmpVal > 0 && (
                        <rect
                          x={cmpBarLeft}
                          y={cmpBarTop}
                          width={barW}
                          height={cmpBarHeight}
                          fill={color}
                          opacity={0.35}
                          stroke={color}
                          strokeWidth={1}
                          rx={1}
                        />
                      )}
                    </Fragment>
                  );
                })}
              </g>
            );
          })}
          {nodeLabels.map((label) => (
            <ChartNodeLabelText key={label.key} label={label} />
          ))}
          {rows.map((row, i) => {
            const x = pad.l + slotW * (i + 0.5);
            return (
              <text
                key={`x-${row.key}`}
                x={x}
                y={height - 8}
                fontSize={9}
                fill="#666"
                textAnchor={xAxisLabelAnchor(i, rows.length)}
              >
                {bucketAxisLabel(row, granularity)}
              </text>
            );
          })}
        </>
      )}
    </ChartContainer>
  );
}

export default function ReportSegmentDashboard() {
  const { i18n } = useTranslation();
  const locale = i18n.language;
  const { user } = useAuth();
  const canEdit = user?.role === 'owner';

  const [enabled, setEnabled] = useState(false);
  const [groups, setGroups] = useState<SegmentGroup[]>([]);

  const [preset, setPreset] = useState<'this_week' | 'last_week' | 'yesterday' | 'custom'>('this_week');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [compareFrom, setCompareFrom] = useState('');
  const [compareTo, setCompareTo] = useState('');
  const [granularity, setGranularity] = useState<'day' | 'hour'>('day');
  const [metric, setMetric] = useState<SegmentMetric>('sales');

  const [loading, setLoading] = useState(false);
  const [primary, setPrimary] = useState<BreakdownPayload | null>(null);
  const [compare, setCompare] = useState<BreakdownPayload | null>(null);
  const [chartGroups, setChartGroups] = useState<Set<string>>(new Set());
  const [chartType, setChartType] = useState<ChartType>('line');

  const handleConfigSaved = useCallback((payload: { enabled: boolean; groups: SegmentGroup[] }) => {
    setEnabled(payload.enabled);
    setGroups(payload.groups);
    setChartGroups(new Set(payload.groups.map((g) => g.id)));
  }, []);

  useEffect(() => {
    if (preset === 'this_week') {
      const w = getWeekRange(0);
      setFrom(w.start);
      setTo(w.end);
      if (compareEnabled) {
        const lw = getWeekRange(-1);
        setCompareFrom(lw.start);
        setCompareTo(lw.end);
      }
    } else if (preset === 'last_week') {
      const w = getWeekRange(-1);
      setFrom(w.start);
      setTo(w.end);
    } else if (preset === 'yesterday') {
      const y = getYesterday();
      setFrom(y);
      setTo(y);
    }
  }, [preset, compareEnabled]);

  const fetchData = useCallback(async () => {
    if (!from || !to) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ from, to, granularity });
      if (compareEnabled && compareFrom && compareTo) {
        params.set('compareFrom', compareFrom);
        params.set('compareTo', compareTo);
      }
      const res = await apiFetch(`/api/reports/segment-breakdown?${params}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error?.message || j.message || '查询失败');
      setPrimary(j.primary);
      setCompare(j.compare ?? null);
      setGroups(j.groups || []);
    } catch (e) {
      alert(e instanceof Error ? e.message : '查询失败');
    } finally {
      setLoading(false);
    }
  }, [from, to, granularity, compareEnabled, compareFrom, compareTo]);

  useEffect(() => {
    if (enabled && from && to) void fetchData();
  }, [enabled, from, to, fetchData]);

  const displayGroups = primary?.groups ?? groups;

  const toggleChartGroup = (id: string) => {
    setChartGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const tableRows = useMemo(() => primary?.rows ?? [], [primary]);

  return (
    <div className="rs-page">
      <header className="rs-page-header">
        <h2 className="rs-page-title">品类结构</h2>
        <p className="rs-page-sub">
          {metric === 'sales'
            ? '按本店配置的分组统计食品行营业额（含选项分摊，不含送餐费，排除退款行）'
            : metric === 'orders'
              ? '按本店配置的分组统计含该分组菜品的订单数（同一订单可计入多个分组）'
              : '按本店配置的分组统计各时段/各日食品营业额占比（基于金额）'}
        </p>
      </header>

      <ReportSegmentConfigPanel canEdit={canEdit} onLoaded={handleConfigSaved} onSaved={handleConfigSaved} />

      {!enabled && (
        <div className="card rs-empty">
          请先勾选「开通品类结构报表」并保存分组配置，即可查看下方报表。
        </div>
      )}

      {enabled && (
        <>
      <div className="card rs-toolbar">
        <div className="rs-toolbar-head">
          <span className="rs-toolbar-title">查询条件</span>
          {preset !== 'custom' && from && to && (
            <span className="rs-range-chip">
              {from} ~ {to}
              {granularity === 'hour' ? ' · 同时段跨日累加' : ''}
            </span>
          )}
        </div>
        <div className="rs-toolbar-body">
          <div className="rs-toolbar-group">
            <label className="rs-field">
              <span className="rs-field-label">时间段</span>
              <select className="input" value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}>
                <option value="this_week">本周</option>
                <option value="last_week">上周</option>
                <option value="yesterday">昨天</option>
                <option value="custom">自定义</option>
              </select>
            </label>
            {preset === 'custom' && (
              <>
                <label className="rs-field rs-field--date">
                  <span className="rs-field-label">从</span>
                  <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
                </label>
                <label className="rs-field rs-field--date">
                  <span className="rs-field-label">至</span>
                  <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
                </label>
              </>
            )}
            <label className="rs-field">
              <span className="rs-field-label">粒度</span>
              <select className="input" value={granularity} onChange={(e) => setGranularity(e.target.value as 'day' | 'hour')}>
                <option value="day">按日</option>
                <option value="hour">按小时</option>
              </select>
            </label>
            <label className="rs-field">
              <span className="rs-field-label">指标</span>
              <select className="input" value={metric} onChange={(e) => setMetric(e.target.value as SegmentMetric)}>
                <option value="sales">金额</option>
                <option value="orders">单数</option>
                <option value="share">百分比</option>
              </select>
            </label>
            <label className="rs-switch">
              <input
                type="checkbox"
                className="rs-switch-input"
                checked={compareEnabled}
                onChange={(e) => setCompareEnabled(e.target.checked)}
              />
              <span className="rs-switch-track" aria-hidden />
              对比时间段
            </label>
          </div>
          {compareEnabled && (
            <div className="rs-toolbar-group rs-toolbar-group--compare">
              <span className="rs-toolbar-group-label">对比范围</span>
              <label className="rs-field rs-field--date">
                <span className="rs-field-label">从</span>
                <input type="date" className="input" value={compareFrom} onChange={(e) => setCompareFrom(e.target.value)} />
              </label>
              <label className="rs-field rs-field--date">
                <span className="rs-field-label">至</span>
                <input type="date" className="input" value={compareTo} onChange={(e) => setCompareTo(e.target.value)} />
              </label>
            </div>
          )}
          <div className="rs-toolbar-actions">
            <button type="button" className="btn btn-primary rs-run-btn" disabled={loading} onClick={() => void fetchData()}>
              {loading ? '查询中…' : '刷新'}
            </button>
          </div>
        </div>
      </div>

      {displayGroups.length > 0 && (
        <div className="card rs-chart-panel">
          <div className="rs-chart-head">
            <h3 className="rs-chart-title">图表</h3>
            <div className="rs-segmented" role="group" aria-label="图表类型">
              <button
                type="button"
                className={`rs-segmented-btn${chartType === 'line' ? ' is-active' : ''}`}
                onClick={() => setChartType('line')}
              >
                曲线图
              </button>
              <button
                type="button"
                className={`rs-segmented-btn${chartType === 'bar' ? ' is-active' : ''}`}
                onClick={() => setChartType('bar')}
              >
                柱状图
              </button>
            </div>
          </div>
          <div className="rs-segment-pills">
            {displayGroups.map((g, i) => (
              <label key={g.id} className={`rs-pill${chartGroups.has(g.id) ? ' is-active' : ''}`}>
                <input
                  type="checkbox"
                  className="rs-pill-input"
                  checked={chartGroups.has(g.id)}
                  onChange={() => toggleChartGroup(g.id)}
                />
                <span className="rs-pill-dot" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                {groupLabel(g, locale)}
              </label>
            ))}
          </div>
          {primary && chartGroups.size > 0 && (
            <div className="rs-chart-body">
              {chartType === 'line' ? (
                <SegmentLineChart
                  rows={primary.rows}
                  compareRows={compare?.rows ?? null}
                  groups={displayGroups}
                  visibleGroupIds={chartGroups}
                  granularity={granularity}
                  metric={metric}
                />
              ) : (
                <SegmentBarChart
                  rows={primary.rows}
                  compareRows={compare?.rows ?? null}
                  groups={displayGroups}
                  visibleGroupIds={chartGroups}
                  granularity={granularity}
                  metric={metric}
                />
              )}
              {compare && (
                <div className="rs-legend">
                  {chartType === 'line' ? (
                    <>
                      <span className="rs-legend-item">
                        <svg width="28" height="12" aria-hidden><line x1="0" y1="6" x2="28" y2="6" stroke="#3949ab" strokeWidth="2.5" /></svg>
                        实线 · 实心点 = 主时间段
                      </span>
                      <span className="rs-legend-item">
                        <svg width="28" height="12" aria-hidden><line x1="0" y1="6" x2="28" y2="6" stroke="#3949ab" strokeWidth="2.5" strokeDasharray="8 5" /></svg>
                        <svg width="12" height="12" aria-hidden><circle cx="6" cy="6" r="4.5" fill="#fff" stroke="#3949ab" strokeWidth="2" /></svg>
                        虚线 · 空心点 = 对比段
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="rs-legend-item">
                        <svg width="14" height="14" aria-hidden><rect x="2" y="2" width="10" height="10" fill="#3949ab" rx="1" /></svg>
                        实心柱 = 主时间段
                      </span>
                      <span className="rs-legend-item">
                        <svg width="14" height="14" aria-hidden><rect x="2" y="2" width="10" height="10" fill="#3949ab" opacity="0.35" stroke="#3949ab" strokeWidth="1" rx="1" /></svg>
                        浅色柱 = 对比段
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {primary && (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f5f5f5', textAlign: 'left' }}>
                <th style={{ padding: '10px 12px' }}>{granularity === 'hour' ? '小时' : '日期'}</th>
                {displayGroups.map((g) => (
                  <th key={g.id} colSpan={compare ? 2 : 1} style={{ padding: '10px 12px' }}>{groupLabel(g, locale)}</th>
                ))}
                <th style={{ padding: '10px 12px' }}>
                  {metric === 'sales' ? '食品合计' : metric === 'orders' ? '单数合计' : '占比合计'}
                </th>
              </tr>
              {compare && (
                <tr style={{ background: '#fafafa', fontSize: 11, color: '#666' }}>
                  <th style={{ padding: '4px 12px' }} />
                  {displayGroups.map((g) => (
                    <Fragment key={g.id}>
                      <th style={{ padding: '4px 12px' }}>主</th>
                      <th style={{ padding: '4px 12px' }}>对比</th>
                    </Fragment>
                  ))}
                  <th />
                </tr>
              )}
            </thead>
            <tbody>
              {tableRows.map((row, ri) => {
                const cmpRow = compare?.rows[ri];
                return (
                  <tr key={row.key} style={{ borderTop: '1px solid #eee' }}>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{row.label}</td>
                    {displayGroups.map((g) => {
                      const m = row.groups.find((x) => x.groupId === g.id);
                      const cm = cmpRow?.groups.find((x) => x.groupId === g.id);
                      return compare ? (
                        <Fragment key={g.id}>
                          <td style={{ padding: '8px 12px' }}>
                            {renderMetricCell(m, row, metric)}
                          </td>
                          <td style={{ padding: '8px 12px', color: '#666' }}>
                            {renderMetricCell(cm, cmpRow ?? { key: '', label: '', groups: [], foodTotal: 0 }, metric, true)}
                          </td>
                        </Fragment>
                      ) : (
                        <td key={`${g.id}-${row.key}`} style={{ padding: '8px 12px' }}>
                          {renderMetricCell(m, row, metric)}
                        </td>
                      );
                    })}
                    <td style={{ padding: '8px 12px', fontWeight: 600 }}>
                      {formatMetricValue(rowMetricTotal(row, metric), metric)}
                    </td>
                  </tr>
                );
              })}
              <tr style={{ borderTop: '2px solid #ddd', fontWeight: 700, background: '#fafafa' }}>
                <td style={{ padding: '10px 12px' }}>合计</td>
                {displayGroups.map((g) => {
                  const t = primary.totals.groups.find((x) => x.groupId === g.id);
                  const ct = compare?.totals.groups.find((x) => x.groupId === g.id);
                  return compare ? (
                    <Fragment key={g.id}>
                      <td style={{ padding: '10px 12px' }}>
                        {metric === 'share'
                          ? formatMetricValue(totalsMetricShare(g.id, primary.totals.groups, metric), metric)
                          : `${formatMetricValue(metricValue(t, { key: '', label: '', groups: primary.totals.groups, foodTotal: primary.totals.foodTotal }, metric), metric)} (${formatTableSharePct(totalsMetricShare(g.id, primary.totals.groups, metric))})`}
                      </td>
                      <td style={{ padding: '10px 12px', color: '#666' }}>
                        {metric === 'share'
                          ? formatMetricValue(totalsMetricShare(g.id, compare?.totals.groups ?? [], metric), metric)
                          : `${formatMetricValue(metricValue(ct, { key: '', label: '', groups: compare?.totals.groups ?? [], foodTotal: compare?.totals.foodTotal ?? 0 }, metric), metric)} (${formatTableSharePct(totalsMetricShare(g.id, compare?.totals.groups ?? [], metric))})`}
                      </td>
                    </Fragment>
                  ) : (
                    <td key={`tot-${g.id}`} style={{ padding: '10px 12px' }}>
                      {metric === 'share'
                        ? formatMetricValue(totalsMetricShare(g.id, primary.totals.groups, metric), metric)
                        : `${formatMetricValue(metricValue(t, { key: '', label: '', groups: primary.totals.groups, foodTotal: primary.totals.foodTotal }, metric), metric)} (${formatTableSharePct(totalsMetricShare(g.id, primary.totals.groups, metric))})`}
                    </td>
                  );
                })}
                <td style={{ padding: '10px 12px' }}>
                  {metric === 'share'
                    ? formatMetricValue(primary.totals.groups.reduce((s, g) => s + g.sharePct, 0), metric)
                    : metric === 'sales'
                      ? formatMetricValue(primary.totals.foodTotal, metric)
                      : formatMetricValue(primary.totals.groups.reduce((s, g) => s + g.orderCount, 0), metric)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
        </>
      )}
    </div>
  );
}
