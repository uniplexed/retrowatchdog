import { sparkChange } from "../lib/insights.js";

const W = 64;
const H = 20;

/** A row's price over its window: decoration only, the percent is what a screen reader gets. */
export function Sparkline({ points }: { points: ReadonlyArray<{ day: string; usd: number }> }) {
  const change = sparkChange(points);
  if (change === null) return null;
  const values = points.map((p) => p.usd);
  const lo = Math.min(...values);
  const span = Math.max(...values) - lo || 1;
  const line = values
    .map((v, i) => `${((i / (values.length - 1)) * W).toFixed(1)},${(H - 1 - ((v - lo) / span) * (H - 2)).toFixed(1)}`)
    .join(" ");
  return (
    <span className="spark">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <span className="spark-change">{change > 0 ? `+${change}%` : change < 0 ? `−${-change}%` : "0%"}</span>
    </span>
  );
}
