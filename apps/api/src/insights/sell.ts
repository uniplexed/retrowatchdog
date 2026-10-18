import type { OwnedCopyDto, Recommendation, SourceId } from "@retrowatchdog/shared";
import { money, type SignalConfig } from "../signals/computeSignals.js";
import { current, since, trend, window } from "./money.js";
import { sliceFor, type DayReading, type GameSeries } from "./series.js";

const isActive = (c: OwnedCopyDto): boolean => c.status !== "sold" && c.status !== "returned";

/**
 * sell_now: a store pays at least paid × profitFactor today, and either that
 * payout is the highest of sellHighDays, or the market rose and is falling.
 * The copy's exact slice speaks with high confidence; a slice borrowed from
 * any condition only as potential.
 */
export function sellNow(
  copies: OwnedCopyDto[],
  series: Map<number, GameSeries>,
  cfg: SignalConfig,
  labels: (id: SourceId) => string,
  now: Date = new Date(),
): Recommendation[] {
  const out: Recommendation[] = [];
  for (const copy of copies) {
    const paidUsd = copy.acquiredPriceUsd;
    if (!isActive(copy) || paidUsd === null || paidUsd <= 0) continue;
    const exact = window(sliceFor(series.get(copy.game.id), copy.region, copy.condition), cfg.sellHighDays, now);
    const exactHasBid = exact.some((r) => r.bestBidUsd !== null);
    const readings = exactHasBid ? exact : window(sliceFor(series.get(copy.game.id), copy.region, null), cfg.sellHighDays, now);
    const today = current(readings, (r) => r.bestBidUsd, now);
    if (today === null || today.bestBidUsd === null || today.bestBidSource === null) continue;

    // same currency on both sides: compare and quote the originals; else USD
    const original = today.bestBidOriginal;
    const sameCurrency = original !== null && copy.acquiredCurrency !== null && copy.acquiredPriceOriginal !== null && original.currency === copy.acquiredCurrency;
    const bidOf = (r: DayReading): number | null =>
      sameCurrency ? (r.bestBidOriginal?.currency === original.currency ? r.bestBidOriginal.amount : null) : r.bestBidUsd;
    const bid = bidOf(today)!;
    const paid = sameCurrency ? copy.acquiredPriceOriginal! : paidUsd;
    const currency = sameCurrency ? original.currency : "USD";
    const covers = (r: DayReading): boolean => {
      const b = bidOf(r);
      return b !== null && b >= paid * cfg.profitFactor;
    };
    if (!covers(today)) continue;

    // over every earlier day: in the quoted currency where that day shares it, in USD where it does not
    const before = readings.filter((r) => r.day < today.day && r.bestBidUsd !== null);
    const isHigh = before.length > 0 && before.every((r) => (bidOf(r) !== null ? bid > bidOf(r)! : today.bestBidUsd! > r.bestBidUsd!));
    const refs = readings.map((r) => r.referenceUsd).filter((x): x is number => x !== null);
    const rose = refs.length > 0 && Math.max(...refs) >= refs[0] * 1.05;
    const turning = rose && trend(readings, cfg.trendDays, now) === "falling";
    if (!isHigh && !turning) continue;

    const shop = labels(today.bestBidSource);
    out.push({
      action: "sell_now",
      subject: { kind: "copy", copyId: copy.id, game: copy.game },
      title: `Sell ${copy.game.title} to ${shop} for ${money(bid, currency)}`,
      reason: isHigh
        ? `${shop} pays ${money(bid, currency)}, the most in ${cfg.sellHighDays} days; you paid ${money(paid, currency)}`
        : `the market for this copy rose and has been falling for ${cfg.trendDays} days; ${shop} pays ${money(bid, currency)}, you paid ${money(paid, currency)}`,
      gainUsd: Math.round((today.bestBidUsd - paidUsd) * 100) / 100,
      confidence: exactHasBid ? "high" : "potential",
      since: since(readings, covers) ?? today.day,
    });
  }
  return out;
}
