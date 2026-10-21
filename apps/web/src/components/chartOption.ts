/**
 * What a history chart draws, as a plain ECharts option: pure and tested on
 * its own, so HistoryChart only mounts it. Lines break at a missing day (a
 * segment across it would claim an observation nobody made), the x axis spans
 * exactly the window the screen asked for, and the y scale is floored for a
 * near-flat series.
 */
export interface ChartPoint {
  day: string;
  usd: number;
}
export interface ChartSeries {
  points: ChartPoint[];
}

const DAY_MS = 86_400_000;
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

/** [time, value] pairs, with one null after a gap so the line breaks there. */
export function withGaps(points: ChartPoint[]): Array<[number, number | null]> {
  const out: Array<[number, number | null]> = [];
  for (const p of points) {
    const t = dayMs(p.day);
    const prev = out[out.length - 1];
    if (prev !== undefined && t - prev[0] > DAY_MS) out.push([prev[0] + DAY_MS, null]);
    out.push([t, p.usd]);
  }
  return out;
}

/** Below a 2% relative span, the scale is padded around the midpoint. */
export function yDomain(values: number[]): { min: number; max: number } {
  const low = Math.min(...values);
  const high = Math.max(...values);
  const FLOOR = 0.02;
  if (high === low || (high - low) / high >= FLOOR) {
    return high === low ? { min: low * 0.98, max: high * 1.02 || 1 } : { min: low, max: high };
  }
  const mid = (high + low) / 2;
  const half = (high * FLOOR) / 2;
  return { min: mid - half, max: mid + half };
}

export function chartOption(opts: {
  series: ChartSeries[];
  from: string;
  to: string;
  format: (usd: number) => string;
  labels: string[];
  /** resolved colours of the --series-N palette, in order */
  colours: string[];
  /** resolved text colour for axes and legend */
  text: string;
}) {
  const { series, from, to, format, labels, colours, text } = opts;
  const drawn = series.map((s, i) => ({ s, i })).filter(({ s }) => s.points.length > 0);
  const values = drawn.flatMap(({ s }) => s.points.map((p) => p.usd));
  const domain = values.length > 0 ? yDomain(values) : { min: 0, max: 1 };
  return {
    animation: false,
    grid: { left: 64, right: 16, top: 28, bottom: 64 },
    tooltip: {
      trigger: "axis" as const,
      valueFormatter: (v: unknown) => (typeof v === "number" ? format(v) : "—"),
    },
    toolbox: {
      right: 8,
      feature: { saveAsImage: { title: "Save as PNG", name: "retrowatchdog-history" } },
      iconStyle: { borderColor: text },
    },
    xAxis: {
      type: "time" as const,
      min: dayMs(from),
      max: dayMs(to),
      axisLabel: { color: text, hideOverlap: true },
    },
    yAxis: {
      type: "value" as const,
      min: domain.min,
      max: domain.max,
      axisLabel: { color: text, formatter: (v: number) => format(v) },
      splitLine: { lineStyle: { opacity: 0.25 } },
    },
    dataZoom: [
      { type: "inside" as const, xAxisIndex: 0 },
      { type: "slider" as const, xAxisIndex: 0, height: 18, bottom: 8, textStyle: { color: text } },
    ],
    series: drawn.map(({ s, i }) => {
      const colour = colours[i % colours.length];
      return {
        name: labels[i] ?? "",
        type: "line" as const,
        data: withGaps(s.points),
        connectNulls: false,
        showSymbol: true,
        symbolSize: 4,
        itemStyle: { color: colour },
        // a wrapped palette reuses a colour, so wrapped series draw dashed
        lineStyle: { color: colour, width: 2, type: i >= colours.length ? ("dashed" as const) : ("solid" as const) },
        markPoint: {
          symbolSize: 34,
          label: { fontSize: 9, formatter: (p: { value: number }) => format(p.value) },
          data: [{ type: "min" as const }, { type: "max" as const }],
        },
        markLine: {
          symbol: "none",
          label: { color: text, formatter: (p: { value: number }) => `avg ${format(p.value)}` },
          data: [{ type: "average" as const }],
        },
      };
    }),
  };
}
