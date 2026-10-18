import type { DayReading, GameSeries } from "../../src/insights/series.js";
import { defaultSignalConfig } from "../../src/settings/signals.js";
import type { SignalConfig } from "../../src/signals/computeSignals.js";

export const NOW = new Date("2026-10-18T12:00:00Z");
export const cfg = (over: Partial<SignalConfig> = {}): SignalConfig => ({ ...defaultSignalConfig(), minGainUsd: null, ...over });
const LABELS: Record<string, string> = { cex: "CeX UK", ebay_uk: "eBay UK", ebay_de: "eBay DE" };
export const labels = (id: string): string => LABELS[id] ?? id;
export const game = (id: number, title = `Game ${id}`, platform = "gba") => ({ id, title, platform: platform as never, year: 2001, coverUrl: null });

/** n daily readings ending today, built by f(daysAgo) */
export function days(n: number, f: (daysAgo: number) => Partial<DayReading>): DayReading[] {
  const out: DayReading[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const day = new Date(NOW.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    out.push({
      day,
      cheapestUsd: null,
      cheapestSource: null,
      cheapestOriginal: null,
      cheapestStoreUsd: null,
      bestBidUsd: null,
      bestBidSource: null,
      bestBidOriginal: null,
      referenceUsd: null,
      ...f(i),
    });
  }
  return out;
}

export function seriesOf(gameId: number, slices: Record<string, DayReading[]>): Map<number, GameSeries> {
  return new Map([[gameId, { gameId, bySlice: new Map(Object.entries(slices)) as GameSeries["bySlice"] }]]);
}
