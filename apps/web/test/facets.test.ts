import { describe, expect, it } from "vitest";
import type { OwnedCopyDto, Signal, WatchlistItemDto } from "@retrowatchdog/shared";
import { COLLECTION_FACETS, WATCHLIST_FACETS, facetFilters, facetOptions, sanitizeFacets } from "../src/lib/facets.js";
import {
  applyControls,
  buildCollectionSpec,
  buildWatchlistSpec,
  DEFAULT_COLLECTION_CONTROLS,
  DEFAULT_WATCHLIST_CONTROLS,
  hasActiveWatchlistFilters,
  sanitizeWatchlistControls,
  watchPriceUsd,
} from "../src/lib/listControls.js";

const game = (id: number, platform = "snes") => ({ id, title: `Game ${id}`, platform: platform as never, year: null, coverUrl: null });
const sig = (over: Partial<Signal>): Signal => ({ type: "UNDERPRICED", reasoning: "r", confidence: "high", ...over });
const watch = (id: number, over: Partial<WatchlistItemDto> = {}): WatchlistItemDto =>
  ({
    id, game: game(id), region: null, condition: null, targetPriceOriginal: null, targetCurrency: null, targetPriceUsd: null,
    storeOffer: null, storeBids: [], storeSource: null, priceDisplayAt: null, signalsAboveTarget: 0, signals: [], ...over,
  }) as WatchlistItemDto;
const copy = (id: number, over: Partial<OwnedCopyDto> = {}): OwnedCopyDto =>
  ({ id, game: game(id), region: "PAL", condition: "loose", status: "owned", itemGrade: null, workingState: null, authenticity: null,
    acquiredSource: null, acquiredCurrency: null, acquiredPriceUsd: null, estimatedValueUsd: null, valueBasis: null, signals: [], ...over }) as OwnedCopyDto;

const wl = (facets: Record<string, string>, over = {}) => ({ ...DEFAULT_WATCHLIST_CONTROLS, barkingOnly: false, facets, ...over });

describe("facets", () => {
  const items = [
    watch(1, { signals: [sig({ source: "ebay_uk", price: { usd: 20, original: 16, currency: "GBP" } })] }),
    watch(2, { storeSource: "cex", storeOffer: { kind: "sell", label: "CeX UK sells for", priceUsd: 30, priceOriginal: 24, currencyOriginal: "GBP" } }),
    watch(3, { game: game(3, "gba"), targetPriceUsd: 10, targetPriceOriginal: 8, targetCurrency: "GBP" }),
  ];

  it("options come from the values present, after 'all'", () => {
    const source = WATCHLIST_FACETS.find((f) => f.id === "source")!;
    expect(facetOptions(source, items)).toEqual(["all", "cex", "ebay_uk", "none"]);
  });

  it("a watch's source is the one behind the price its row shows", () => {
    const shown = applyControls(items, buildWatchlistSpec(wl({ source: "cex" }))).flatMap((g) => g.items);
    expect(shown.map((w) => w.id)).toEqual([2]);
  });

  it("every standard watch field can filter", () => {
    const ids = (facets: Record<string, string>) => applyControls(items, buildWatchlistSpec(wl(facets))).flatMap((g) => g.items).map((w) => w.id);
    expect(ids({ platform: "gba" })).toEqual([3]);
    expect(ids({ target: "set" })).toEqual([3]);
    expect(ids({ signal: "UNDERPRICED" })).toEqual([1]);
    expect(ids({ confidence: "none" })).toEqual([2, 3]);
  });

  it("price sorts put rows without a price last", () => {
    const asc = applyControls(items, buildWatchlistSpec(wl({}, { sort: "price_asc" }))).flatMap((g) => g.items).map((w) => w.id);
    const desc = applyControls(items, buildWatchlistSpec(wl({}, { sort: "price_desc" }))).flatMap((g) => g.items).map((w) => w.id);
    expect(asc).toEqual([1, 2, 3]);
    expect(desc).toEqual([2, 1, 3]);
    expect(watchPriceUsd(items[2])).toBeNull();
  });

  it("a facet counts as an active filter and survives storage", () => {
    expect(hasActiveWatchlistFilters(wl({ source: "cex" }))).toBe(true);
    expect(hasActiveWatchlistFilters(wl({ source: "all" }))).toBe(false);
    expect(sanitizeWatchlistControls({ facets: { source: "cex", bad: 3 } }).facets).toEqual({ source: "cex" });
    expect(sanitizeFacets("junk")).toEqual({});
  });

  it("every standard copy field can filter, and value sorts both ways", () => {
    const copies = [
      copy(1, { estimatedValueUsd: 30, valueBasis: { readAs: "reading", source: "cex", priceKind: "sell", viaUnknownCondition: false, viaUnknownRegion: false }, workingState: "working", acquiredSource: "ebay", acquiredCurrency: "GBP" }),
      copy(2, { estimatedValueUsd: 10, authenticity: "suspect", acquiredCurrency: "EUR" }),
    ];
    const ids = (facets: Record<string, string>, sort = DEFAULT_COLLECTION_CONTROLS.sort) =>
      applyControls(copies, buildCollectionSpec({ ...DEFAULT_COLLECTION_CONTROLS, facets, sort })).flatMap((g) => g.items).map((c) => c.id);
    expect(ids({ source: "cex" })).toEqual([1]);
    expect(ids({ source: "none" })).toEqual([2]);
    expect(ids({ working: "working" })).toEqual([1]);
    expect(ids({ authenticity: "suspect" })).toEqual([2]);
    expect(ids({ acquiredFrom: "ebay" })).toEqual([1]);
    expect(ids({ currency: "EUR" })).toEqual([2]);
    expect(ids({}, "value_asc")).toEqual([2, 1]);
    expect(COLLECTION_FACETS.map((f) => f.id)).toEqual(["source", "working", "authenticity", "acquiredFrom", "currency"]);
  });

  it("facetFilters skips 'all' and unknown facets", () => {
    expect(facetFilters(WATCHLIST_FACETS, { source: "all", nope: "x" })).toHaveLength(0);
  });
});
