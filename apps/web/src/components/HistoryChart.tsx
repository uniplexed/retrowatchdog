import { useEffect, useRef } from "react";
import { useTheme } from "../lib/theme.js";
import { chartOption, type ChartSeries } from "./chartOption.js";

/**
 * Series colours before the palette wraps; shared with the legends beside the
 * charts. Must match the number of `--series-N` custom properties in styles.css.
 */
export const SERIES_COLOURS = 8;

/** ECharts, loaded on first use: the app's other screens never pay for it. */
const loadECharts = () => import("./echartsSetup.js");

/** the --series-N palette and the muted text colour, as the current theme resolves them */
function themeColours(): { colours: string[]; text: string } {
  const style = getComputedStyle(document.documentElement);
  const colours = Array.from({ length: SERIES_COLOURS }, (_, i) => style.getPropertyValue(`--series-${i}`).trim() || "#888");
  return { colours, text: style.getPropertyValue("--text-muted").trim() || "#888" };
}

/**
 * A multi-series daily line chart over exactly [from, to]: zoom by dragging or
 * with the slider under it, a cursor that reads every series, min/max/average
 * marks and a PNG export. The box carries a text description for screen readers.
 */
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
  const box = useRef<HTMLDivElement>(null);
  const { resolved: theme } = useTheme();
  const drawn = series.filter((s) => s.points.length > 0);

  useEffect(() => {
    const el = box.current;
    // nothing to measure (hidden, or a test DOM): no chart, the description stands
    if (el === null || drawn.length === 0 || el.clientWidth === 0) return;
    let disposed = false;
    let chart: { setOption: (o: unknown, notMerge?: boolean) => void; resize: () => void; dispose: () => void } | null = null;
    const resize = new ResizeObserver(() => chart?.resize());
    void loadECharts().then((echarts) => {
      if (disposed) return;
      chart = echarts.init(el, null, { renderer: "svg" });
      chart.setOption(chartOption({ series, from, to, format, labels, ...themeColours() }), true);
      resize.observe(el);
    });
    return () => {
      disposed = true;
      resize.disconnect();
      chart?.dispose();
    };
    // format is a fresh closure each render; the data and the theme decide a redraw
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, from, to, labels, theme]);

  if (drawn.length === 0) return null;

  const ariaLabel = [
    `History of ${title}, ${from} to ${to}.`,
    ...drawn.map((s) => {
      const latest = s.points[s.points.length - 1];
      return `${labels[series.indexOf(s)] ?? ""}: ${format(latest.usd)} on ${latest.day}.`;
    }),
  ].join(" ");

  return <div ref={box} className="history-chart" role="img" aria-label={ariaLabel} />;
}
