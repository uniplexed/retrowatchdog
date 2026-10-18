import type { OwnedCopyDto, Recommendation, WatchlistItemDto } from "@retrowatchdog/shared";
import type { SignalConfig } from "../signals/computeSignals.js";
import { window } from "./money.js";
import { sliceFor, type GameSeries } from "./series.js";

const DAY_MS = 86_400_000;
const isActive = (c: OwnedCopyDto): boolean => c.status !== "sold" && c.status !== "returned";

/**
 * Clean-ups, always potential: a watch with no signal and no real price move
 * for quietDays (judged only once there are quietDays of prices), and a copy
 * no source has priced for quietDays (or ever).
 */
export function quietAdvice(
  watches: WatchlistItemDto[],
  copies: OwnedCopyDto[],
  series: Map<number, GameSeries>,
  loggedByWatch: Map<number, number>,
  cfg: SignalConfig,
  now: Date = new Date(),
): Recommendation[] {
  const out: Recommendation[] = [];
  const today = now.toISOString().slice(0, 10);
  const horizon = new Date(now.getTime() - cfg.quietDays * DAY_MS).toISOString().slice(0, 10);
  for (const w of watches) {
    if (w.signals.some((s) => s.type !== "INSUFFICIENT_DATA") || (loggedByWatch.get(w.id) ?? 0) > 0) continue;
    const all = sliceFor(series.get(w.game.id), w.region, w.condition).filter((r) => r.cheapestUsd !== null);
    // a deployment younger than quietDays cannot call anything quiet
    if (all.length === 0 || all[0].day > horizon) continue;
    const prices = window(all, cfg.quietDays, now).map((r) => r.cheapestUsd!);
    if (prices.length === 0) continue;
    const low = Math.min(...prices);
    if (low <= 0 || (Math.max(...prices) / low - 1) * 100 > cfg.quietPct) continue;
    out.push({
      action: "unwatch",
      subject: { kind: "watch", watchId: w.id, game: w.game },
      title: `Stop watching ${w.game.title}?`,
      reason: `No signal and no price move over ${cfg.quietPct}% in ${cfg.quietDays} days`,
      gainUsd: null,
      confidence: "potential",
      since: horizon,
    });
  }
  for (const c of copies) {
    if (!isActive(c)) continue;
    const pricedAt = c.valueFetchedAt === null ? null : c.valueFetchedAt.slice(0, 10);
    // a fallback-valued copy is not flagged: most listings name no condition, so it is the normal case
    // ponytail: "a fallback for quietDays" needs a basis history; add one if the spec's version is wanted
    const reason =
      pricedAt === null ? "No source has a price for this copy" : pricedAt < horizon ? `No price from any source in ${cfg.quietDays} days` : null;
    if (reason === null) continue;
    out.push({
      action: "review_copy",
      subject: { kind: "copy", copyId: c.id, game: c.game },
      title: `Check your ${c.game.title} copy`,
      reason,
      gainUsd: null,
      confidence: "potential",
      since: pricedAt ?? today,
    });
  }
  return out;
}
