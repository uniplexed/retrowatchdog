import type { Recommendation, SourceId, WatchlistItemDto } from "@retrowatchdog/shared";
import { money, type SignalConfig } from "../signals/computeSignals.js";
import { coverageDays, current, meanOf, since, trend, window } from "./money.js";
import { sliceFor, type GameSeries } from "./series.js";

/** under this many days of prices a "lowest in N days" is only potential */
const MIN_COVERAGE_DAYS = 30;

/**
 * buy_now: the cheapest purchasable price of a watch's slice is the lowest of
 * buyLowDays, or buyBelowAvgPct under that window's mean. A falling market,
 * or too little history, makes it potential and says why.
 */
export function buyNow(
  watches: WatchlistItemDto[],
  series: Map<number, GameSeries>,
  cfg: SignalConfig,
  labels: (id: SourceId) => string,
  now: Date = new Date(),
): Recommendation[] {
  const out: Recommendation[] = [];
  for (const w of watches) {
    const readings = window(sliceFor(series.get(w.game.id), w.region, w.condition), cfg.buyLowDays, now);
    const today = current(readings, (r) => r.cheapestUsd, now);
    if (today === null || today.cheapestUsd === null || today.cheapestSource === null) continue;
    const price = today.cheapestUsd;
    const before = readings.filter((r) => r.day < today.day).map((r) => r.cheapestUsd).filter((x): x is number => x !== null);
    const isLow = before.length > 0 && price < Math.min(...before);
    const avg = meanOf(readings, (r) => r.cheapestUsd)!;
    const under = avg > 0 ? (1 - price / avg) * 100 : 0;
    const farUnder = under >= cfg.buyBelowAvgPct;
    if (!isLow && !farUnder) continue;

    const falling = trend(readings, cfg.trendDays, now) === "falling";
    const coverage = coverageDays(readings, (r) => r.cheapestUsd);
    const notes = [
      ...(falling ? ["the market is falling — may get cheaper"] : []),
      ...(coverage < Math.min(MIN_COVERAGE_DAYS, cfg.buyLowDays) ? [`only ${coverage} days of prices`] : []),
    ];
    const quoted = today.cheapestOriginal;
    const shown = quoted === null ? money(price, "USD") : money(quoted.amount, quoted.currency);
    const head = isLow
      ? `the lowest in ${cfg.buyLowDays} days`
      : `${Math.round(under)}% under its ${cfg.buyLowDays}-day average of ${money(Math.round(avg), "USD")}`;
    out.push({
      action: "buy_now",
      subject: { kind: "watch", watchId: w.id, game: w.game },
      title: `Buy ${w.game.title} on ${labels(today.cheapestSource)} for ${shown}`,
      reason: [head, ...notes].join("; "),
      gainUsd: Math.round((avg - price) * 100) / 100,
      confidence: notes.length === 0 ? "high" : "potential",
      since: since(readings, (r) => r.cheapestUsd !== null && r.cheapestUsd <= price) ?? today.day,
    });
  }
  return out;
}
