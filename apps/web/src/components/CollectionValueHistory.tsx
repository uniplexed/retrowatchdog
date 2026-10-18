import { useEffect, useState } from "react";
import type { CollectionHistoryResponse, ValuationBasis, ValuationMarkets } from "@retrowatchdog/shared";
import { getCollectionHistory } from "../api/client.js";
import { formatMoney } from "../lib/money.js";
import { HistoryChart } from "./HistoryChart.js";
import { InfoTip } from "../ui/InfoTip.js";

const HISTORY_DAYS = 180;
const LABELS = ["Estimated", "Paid"];

/**
 * The collection's estimated value and paid total per day, under the basis and
 * markets the screen shows. Fetched only when opened. A point exists for each
 * day the totals were computed (the worker does so after every refresh).
 */
export function CollectionValueHistory({
  basis,
  markets,
  days = HISTORY_DAYS,
  defaultOpen = false,
}: {
  basis: ValuationBasis;
  markets: ValuationMarkets;
  days?: number;
  /** the dashboard shows it open; the collection keeps it folded */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [data, setData] = useState<CollectionHistoryResponse | "error" | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setData(null);
    getCollectionHistory(basis, markets, days)
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setData("error"));
    return () => {
      cancelled = true;
    };
  }, [open, basis, days, markets.country, markets.includeForeign]);

  const series =
    data === null || data === "error"
      ? []
      : [
          { points: data.points.map((p) => ({ day: p.day, usd: p.estimatedUsd })) },
          { points: data.points.map((p) => ({ day: p.day, usd: p.paidUsd })) },
        ];

  return (
    <details className="price-history" open={defaultOpen || undefined} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary role="button">
        Value history <InfoTip topic="history.value" />
      </summary>
      {open && data === null && <p className="source-note">Loading history…</p>}
      {open && data === "error" && <p className="source-note">Could not load the history.</p>}
      {open && data !== null && data !== "error" && data.points.length === 0 && (
        <p className="source-note">No days recorded yet: a point is added each day the value is computed.</p>
      )}
      {open && data !== null && data !== "error" && data.points.length > 0 && (
        <>
          <HistoryChart
            series={series}
            from={data.from}
            to={data.to}
            format={(usd) => formatMoney(usd)}
            labels={LABELS}
            title="your collection"
          />
          <ul className="history-legend">
            {series.map((s, i) => (
              <li key={LABELS[i]} className="history-legend-row">
                <span className="history-swatch" aria-hidden="true" style={{ background: `var(--series-${i})` }} />
                <span className="history-legend-label">{LABELS[i]}</span>{" "}
                <span className="history-legend-value">{formatMoney(s.points[s.points.length - 1].usd)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
