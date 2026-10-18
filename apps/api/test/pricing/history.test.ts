import { describe, expect, it } from "vitest";
import type { PriceKind, SourceInfo } from "@retrowatchdog/shared";
import { buildHistorySeries, type HistoryRow } from "../../src/pricing/history.js";

const sources: Record<string, SourceInfo> = {
  shop: {
    label: "Shop",
    kindRoles: { sell: "buy_store", cash: "bid", voucher: "bid", guide: "guide" },
  } as unknown as SourceInfo,
  market: {
    label: "Market",
    kindRoles: { active_listing: "buy_listing", active_median: "reference" },
  } as unknown as SourceInfo,
};

const row = (over: Partial<HistoryRow> = {}): HistoryRow => {
  const base = {
    source: "shop" as HistoryRow["source"],
    kind: "sell" as PriceKind,
    region: "PAL" as const,
    condition: "cib" as const,
    grade: null,
    priceUsd: 40,
    available: true,
    sampleSize: null,
    fetchedAt: new Date("2026-09-15T03:00:00Z"),
    ...over,
  };
  // a quoted amount that tracks the USD one unless a case says otherwise, so
  // the reduction cases below read exactly as they did before it existed
  return { ...base, original: over.original ?? { amount: base.priceUsd, currency: "GBP" } };
};

/** The series, its points narrowed to the two fields the reduction is about. */
const series = (rows: HistoryRow[], source: string, kind: string) => {
  const found = buildHistorySeries(rows, sources).find((s) => s.source === source && s.kind === kind);
  return found && { ...found, points: found.points.map(({ day, usd }) => ({ day, usd })) };
};

describe("buildHistorySeries", () => {
  it("carries the quoted amount of the SAME row that won the day", () => {
    // The chart plots the quoted amount for a single-currency series, so it has
    // to be the winning row's own — not the day's first, not an average. Here
    // the lowest USD is also the lowest quote, as it is for one fetch at one
    // day's rate.
    const [s] = buildHistorySeries(
      [
        row({ priceUsd: 53.4, original: { amount: 40, currency: "GBP" } }),
        row({ priceUsd: 46.7, original: { amount: 35, currency: "GBP" } }),
      ],
      sources,
    );
    expect(s.points).toEqual([{ day: "2026-09-15", usd: 46.7, original: { amount: 35, currency: "GBP" } }]);
  });

  it("gives a store offer the lowest price that source asked that day", () => {
    const s = series([row({ priceUsd: 40 }), row({ priceUsd: 35 }), row({ priceUsd: 50 })], "shop", "sell");
    expect(s?.role).toBe("buy_store");
    expect(s?.points).toEqual([{ day: "2026-09-15", usd: 35 }]);
  });

  it("gives a bid the highest that source offered, and keeps cash and voucher apart", () => {
    const rows = [
      row({ kind: "cash" as PriceKind, priceUsd: 20 }),
      row({ kind: "cash" as PriceKind, priceUsd: 25 }),
      row({ kind: "voucher" as PriceKind, priceUsd: 30 }),
    ];
    expect(series(rows, "shop", "cash")?.points).toEqual([{ day: "2026-09-15", usd: 25 }]);
    expect(series(rows, "shop", "voucher")?.points).toEqual([{ day: "2026-09-15", usd: 30 }]);
  });

  it("takes a reference from the day's LAST fetch, not the best of the day", () => {
    const ref = (usd: number, at: string): HistoryRow =>
      row({
        source: "market" as HistoryRow["source"],
        kind: "active_median" as PriceKind,
        sampleSize: 9,
        priceUsd: usd,
        fetchedAt: new Date(at),
      });
    const s = series(
      [ref(55, "2026-09-15T03:00:00Z"), ref(60, "2026-09-15T12:00:00Z"), ref(58, "2026-09-15T21:00:00Z")],
      "market",
      "active_median",
    );
    expect(s?.points).toEqual([{ day: "2026-09-15", usd: 58 }]);
  });

  it("sorts days ascending and leaves a day with no fetch out entirely", () => {
    const s = series(
      [
        row({ priceUsd: 30, fetchedAt: new Date("2026-09-17T03:00:00Z") }),
        row({ priceUsd: 40, fetchedAt: new Date("2026-09-15T03:00:00Z") }),
      ],
      "shop",
      "sell",
    );
    expect(s?.points).toEqual([
      { day: "2026-09-15", usd: 40 },
      { day: "2026-09-17", usd: 30 },
    ]);
  });

  it("charts no buy_listing series: per-listing prices are scatter, not a series", () => {
    const rows = [
      row({ source: "market" as HistoryRow["source"], kind: "active_listing" as PriceKind, priceUsd: 48 }),
    ];
    expect(buildHistorySeries(rows, sources)).toEqual([]);
  });

  it("drops exactly what the engine drops", () => {
    const rows = [
      row({ priceUsd: 0 }), // zero
      row({ priceUsd: 50, available: false }), // unavailable store offer
      row({ kind: "guide" as PriceKind, priceUsd: 99 }), // guide
      row({ source: "nobody" as HistoryRow["source"], priceUsd: 10 }), // unknown source
      row({
        source: "market" as HistoryRow["source"],
        kind: "active_median" as PriceKind,
        priceUsd: 60,
        sampleSize: null, // reference with no sample
      }),
    ];
    expect(buildHistorySeries(rows, sources)).toEqual([]);
  });

  it("buckets by UTC day, so a late-evening fetch does not land on tomorrow", () => {
    const s = series([row({ fetchedAt: new Date("2026-09-15T23:59:59Z"), priceUsd: 41 })], "shop", "sell");
    expect(s?.points).toEqual([{ day: "2026-09-15", usd: 41 }]);
  });

  it("returns an empty array for no rows", () => {
    expect(buildHistorySeries([], sources)).toEqual([]);
  });
});
