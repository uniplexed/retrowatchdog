import type { Recommendation, SourceId, WatchlistItemDto } from "@retrowatchdog/shared";
import { money, type SignalConfig } from "../signals/computeSignals.js";
import { window } from "./money.js";
import { sliceFor, type DayReading, type GameSeries } from "./series.js";

/**
 * raise_target: the target was never met over targetWindowDays and the low
 * came within targetNearPct of it. lower_target: the price sat under the
 * target on more than targetOftenPct of the observed days, so it filters
 * nothing. Advice about a setting: always potential, no money at stake.
 */
export function targetAdvice(
  watches: WatchlistItemDto[],
  series: Map<number, GameSeries>,
  cfg: SignalConfig,
  _labels: (id: SourceId) => string,
  now: Date = new Date(),
): Recommendation[] {
  const out: Recommendation[] = [];
  for (const w of watches) {
    if (w.targetPriceUsd === null) continue;
    const observed = window(sliceFor(series.get(w.game.id), w.region, w.condition), cfg.targetWindowDays, now).filter(
      (r) => r.cheapestUsd !== null,
    );
    if (observed.length === 0) continue;
    // the target's own currency when every observed price was quoted in it, else USD
    const quoted = w.targetCurrency !== null && w.targetPriceOriginal !== null && observed.every((r) => r.cheapestOriginal?.currency === w.targetCurrency);
    const target = quoted ? w.targetPriceOriginal! : w.targetPriceUsd;
    const currency = quoted ? w.targetCurrency! : "USD";
    const priceOf = (r: DayReading): number => (quoted ? r.cheapestOriginal!.amount : r.cheapestUsd!);
    const under = observed.filter((r) => priceOf(r) <= target).length;
    const low = Math.min(...observed.map(priceOf));
    const base = { subject: { kind: "watch" as const, watchId: w.id, game: w.game }, gainUsd: null, confidence: "potential" as const, since: observed[0].day };
    if (under === 0 && low <= target * (1 + cfg.targetNearPct / 100)) {
      out.push({
        ...base,
        action: "raise_target",
        title: `Raise your ${w.game.title} target from ${money(target, currency)}`,
        reason: `Your ${money(target, currency)} target was never met in ${cfg.targetWindowDays} days; the low was ${money(low, currency)}`,
      });
    } else if ((under / observed.length) * 100 > cfg.targetOftenPct) {
      out.push({
        ...base,
        action: "lower_target",
        title: `Lower your ${w.game.title} target from ${money(target, currency)}`,
        reason: `The price was under your ${money(target, currency)} target on ${Math.floor((under / observed.length) * 100)}% of ${observed.length} days`,
      });
    }
  }
  return out;
}
