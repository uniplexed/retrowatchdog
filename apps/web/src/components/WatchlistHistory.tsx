import { useEffect, useState } from "react";
import type { WatchlistHistoryResponse } from "@retrowatchdog/shared";
import { getWatchlistHistory } from "../api/client.js";
import { formatMoney } from "../lib/money.js";
import { HistoryChart } from "./HistoryChart.js";
import { InfoTip } from "../ui/InfoTip.js";

/** The summed cheapest price of every watch per day, with how many watches had one. Fetched only when opened. */
export function WatchlistHistory({ days = 90, defaultOpen = false }: { days?: number; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [data, setData] = useState<WatchlistHistoryResponse | "error" | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getWatchlistHistory(days)
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setData("error"));
    return () => {
      cancelled = true;
    };
  }, [open, days]);

  const last = data !== null && data !== "error" ? data.points.at(-1) : undefined;
  return (
    <details className="price-history" open={defaultOpen || undefined} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary role="button">
        Watchlist price history <InfoTip topic="history.watchlist" />
      </summary>
      {open && data === null && <p className="source-note">Loading history…</p>}
      {open && data === "error" && <p className="source-note">Could not load the history.</p>}
      {open && data !== null && data !== "error" && last === undefined && <p className="source-note">No prices yet.</p>}
      {open && data !== null && data !== "error" && last !== undefined && (
        <>
          <HistoryChart
            series={[{ points: data.points.map((p) => ({ day: p.day, usd: p.totalUsd })) }]}
            from={data.from}
            to={data.to}
            format={(usd) => formatMoney(usd)}
            labels={["Watchlist"]}
            title="your watchlist"
          />
          <p className="source-note">
            Latest day: {last.covered} of {last.of} watches priced
          </p>
        </>
      )}
    </details>
  );
}
