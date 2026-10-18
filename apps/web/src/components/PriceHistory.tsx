import { useEffect, useState } from "react";
import type { Condition, HistoryPointDto, HistoryResponse, HistorySeriesDto, Region } from "@retrowatchdog/shared";
import { getPriceHistory } from "../api/client.js";
import { formatMoney } from "../lib/money.js";
import { kindLabel, useSources, type SourcesState } from "../lib/sources.js";
import { HistoryChart, SERIES_COLOURS } from "./HistoryChart.js";
import { Panel } from "../ui/Panel.js";

/** fixed window, matching the API's own default */
const HISTORY_DAYS = 30;

type LoadState = { status: "loading" } | { status: "error" } | { status: "ok"; data: HistoryResponse };

/**
 * Signed percentage from a series' own first point to its own last point.
 *
 * ponytail: a first point of exactly 0 has no percentage change to report
 * (division by zero); rendered as "+0%" rather than Infinity/NaN. Revisit if
 * a source ever legitimately quotes $0.
 */
function signedChange(first: number, last: number): string {
  const pct = first === 0 ? 0 : ((last - first) / first) * 100;
  const rounded = Math.round(pct);
  return rounded >= 0 ? `+${rounded}%` : `${rounded}%`;
}

/** The span a series actually used, or `null` when it matches the window. */
function actualSpan(points: HistoryPointDto[], from: string, to: string): string | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (first.day === from && last.day === to) return null;
  return first.day === last.day ? `on ${first.day}` : `${first.day} to ${last.day}`;
}

/**
 * A series quoted in ONE currency, re-expressed so only the QUOTE moves it.
 *
 * Frozen USD twins drift with FX (measured: 62 of 515 real windows moved only
 * because the pound did). Each point becomes `quote x (latest USD / latest
 * quote)`: one factor per series, so the newest point stays its true USD.
 * A mixed-currency series, or a zero newest quote, is returned untouched.
 */
export function atQuotedRate(series: HistorySeriesDto): HistorySeriesDto {
  const last = series.points[series.points.length - 1];
  if (last === undefined || last.original.amount <= 0) return series;
  const currency = last.original.currency;
  if (series.points.some((p) => p.original.currency !== currency)) return series;
  const factor = last.usd / last.original.amount;
  return {
    ...series,
    points: series.points.map((p) => ({ ...p, usd: p.original.amount * factor })),
  };
}

function PriceHistoryBody({
  data,
  sources,
  title,
}: {
  data: HistoryResponse;
  sources: SourcesState;
  title: string;
}) {
  if (!data.series.some((s) => s.points.length > 0)) {
    return <p className="source-note">No prices stored for this window.</p>;
  }

  const labels = data.series.map((s) => kindLabel(s.source, s.kind, sources));
  // chart AND legend read the quoted line, so they agree
  const plotted = data.series.map(atQuotedRate);

  return (
    <>
      <HistoryChart
        series={plotted}
        from={data.from}
        to={data.to}
        format={(usd) => formatMoney(usd)}
        labels={labels}
        title={title}
      />
      <ul className="history-legend">
        {plotted.map((s, i) => {
          if (s.points.length === 0) return null;
          const last = s.points[s.points.length - 1];
          const span = actualSpan(s.points, data.from, data.to);
          return (
            <li key={`${s.source}-${s.kind}`} className="history-legend-row">
              <span
                className="history-swatch"
                aria-hidden="true"
                style={{ background: `var(--series-${i % SERIES_COLOURS})` }}
              />
              <span className="history-legend-label">{labels[i]}</span>{" "}
              {/* the exact quote when the display currency is the quote's */}
              <span className="history-legend-value">{formatMoney(last.usd, last.original)}</span>{" "}
              <span className="history-legend-change">{signedChange(s.points[0].usd, last.usd)}</span>
              {span && <span className="history-legend-span"> ({span})</span>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * The price history panel, open and fetched as soon as the page has a state.
 * On "all" region or condition it asks the user to pick: a line mixing PAL
 * with NTSC-J means nothing.
 */
export function PriceHistory({
  gameId,
  title,
  region,
  condition,
}: {
  gameId: number;
  title: string;
  region: Region | "all";
  condition: Condition | "all";
}) {
  const sources = useSources();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const needsPicker = region === "all" || condition === "all";

  useEffect(() => {
    if (needsPicker) return;
    let cancelled = false;
    setState({ status: "loading" });
    getPriceHistory(gameId, { region, condition, days: HISTORY_DAYS })
      .then((data) => {
        if (!cancelled) setState({ status: "ok", data });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [needsPicker, gameId, region, condition]);

  return (
    <Panel
      title={needsPicker ? "Price history" : `Price history · ${region} · ${condition}`}
      info="game.history"
      className="price-history"
    >
      {needsPicker && <p className="source-note">Pick a region and condition to see price history.</p>}
      {!needsPicker && state.status === "loading" && <p className="source-note">Loading history…</p>}
      {!needsPicker && state.status === "error" && <p className="source-note">Could not load the history.</p>}
      {!needsPicker && state.status === "ok" && <PriceHistoryBody data={state.data} sources={sources} title={title} />}
    </Panel>
  );
}
