import type { Condition } from "@retrowatchdog/shared";
import type { watchlist } from "../db/schema.js";
import type { WatchTarget } from "./computeSignals.js";

/**
 * A watch's buy target as a signal amount, or undefined without one. A target
 * stored as USD only (a CSV import) quotes itself in USD.
 */
export function watchTarget(watch: typeof watchlist.$inferSelect): WatchTarget | undefined {
  if (watch.targetPriceUsd === null) return undefined;
  const usd = Number(watch.targetPriceUsd);
  const condition = (watch.condition ?? null) as Condition | null;
  if (watch.targetPriceOriginal === null || watch.targetCurrency === null) {
    return { usd, original: usd, currency: "USD", condition };
  }
  return { usd, original: Number(watch.targetPriceOriginal), currency: watch.targetCurrency, condition };
}
