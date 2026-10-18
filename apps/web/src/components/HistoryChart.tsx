/** what the chart reads of a series: a price line or any other daily USD line */
interface ChartPoint {
  day: string;
  usd: number;
}
interface ChartSeries {
  points: ChartPoint[];
}

/**
 * A multi-series line chart, hand-rolled in SVG: a few polylines don't justify
 * a charting library. Fixed viewBox + width 100%, so no resize observer.
 */
const VIEW_W = 320;
const VIEW_H = 120;
const PAD = { top: 6, right: 6, bottom: 14, left: 34 };

/**
 * Series colours before the palette wraps; shared with PriceHistory's legend.
 * Must match the number of `--series-N` custom properties in styles.css.
 */
export const SERIES_COLOURS = 8;

const dayNumber = (day: string): number => new Date(`${day}T00:00:00Z`).getTime() / 86_400_000;

export function HistoryChart({
  series,
  from,
  to,
  format,
  labels,
  title,
}: {
  series: ChartSeries[];
  from: string;
  to: string;
  format: (usd: number) => string;
  labels: string[];
  title: string;
}) {
  const drawn = series.filter((s) => s.points.length > 0);
  if (drawn.length === 0) return null;

  const values = drawn.flatMap((s) => s.points.map((p) => p.usd));
  const low = Math.min(...values);
  const high = Math.max(...values);
  // one value: draw it centred rather than divide by a zero span
  const flat = high === low;
  const first = dayNumber(from);
  const last = dayNumber(to);
  const dayspan = last - first || 1;

  // Below a 2% relative span, pad the scale around the midpoint so a near-flat
  // price does not stretch into a dramatic climb across the plot height.
  const FLOOR = 0.02;
  const padded = !flat && (high - low) / high < FLOOR;
  const domainMid = (high + low) / 2;
  const domainHalf = padded ? (high * FLOOR) / 2 : (high - low) / 2;
  const domainLow = padded ? domainMid - domainHalf : low;
  const domainHigh = padded ? domainMid + domainHalf : high;

  const x = (day: string): number =>
    PAD.left + ((dayNumber(day) - first) / dayspan) * (VIEW_W - PAD.left - PAD.right);
  const y = (usd: number): number =>
    flat
      ? PAD.top + (VIEW_H - PAD.top - PAD.bottom) / 2
      : PAD.top + (1 - (usd - domainLow) / (domainHigh - domainLow)) * (VIEW_H - PAD.top - PAD.bottom);

  /**
   * A series' points, split into runs of CONSECUTIVE days: a segment across a
   * missing day would claim an observation nobody made. A one-point run is
   * drawn as a dot, since an `M`-only path paints zero pixels.
   */
  const runsOf = (points: ChartPoint[]): ChartPoint[][] => {
    const runs: ChartPoint[][] = [];
    for (const point of points) {
      const n = dayNumber(point.day);
      const current = runs[runs.length - 1];
      const previous = current?.[current.length - 1];
      if (previous !== undefined && n - dayNumber(previous.day) === 1) {
        current.push(point);
      } else {
        runs.push([point]);
      }
    }
    return runs;
  };

  const pathForRun = (run: ChartPoint[]): string =>
    run.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.day).toFixed(1)},${y(p.usd).toFixed(1)}`).join("");

  const ariaLabel = [
    `History of ${title}, ${from} to ${to}.`,
    ...drawn.map((s) => {
      const latest = s.points[s.points.length - 1];
      return `${labels[series.indexOf(s)] ?? ""}: ${format(latest.usd)} on ${latest.day}.`;
    }),
  ].join(" ");

  const ticks = flat ? [high] : [high, low + (high - low) / 2, low];

  return (
    <svg
      className="history-chart"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role="img"
      aria-label={ariaLabel}
    >
      {ticks.map((v, i) => (
        <text key={i} className="history-axis" x={PAD.left - 3} y={y(v) + 3} textAnchor="end">
          {format(v)}
        </text>
      ))}
      <text className="history-axis" x={PAD.left} y={VIEW_H - 3}>
        {from}
      </text>
      <text className="history-axis" x={VIEW_W - PAD.right} y={VIEW_H - 3} textAnchor="end">
        {to}
      </text>
      {drawn.flatMap((s) => {
        const index = series.indexOf(s);
        const colour = `var(--series-${index % SERIES_COLOURS})`;
        // a wrapped palette reuses a colour, so wrapped series draw dashed
        const wrapped = index >= SERIES_COLOURS;
        return runsOf(s.points).map((run) =>
          run.length === 1 ? (
            <circle
              key={`${index}-${run[0].day}`}
              className="history-dot"
              cx={x(run[0].day)}
              cy={y(run[0].usd)}
              r={2.5}
              fill={colour}
            />
          ) : (
            <path
              key={`${index}-${run[0].day}`}
              className="history-line"
              d={pathForRun(run)}
              stroke={colour}
              strokeWidth={2}
              strokeDasharray={wrapped ? "4 3" : undefined}
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
          ),
        );
      })}
    </svg>
  );
}
