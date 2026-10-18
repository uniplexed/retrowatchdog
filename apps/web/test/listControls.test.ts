import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnedCopyDto, PricePointDto, WatchlistItemDto } from "@retrowatchdog/shared";
import {
  applyControls,
  actionabilityRank,
  bestBy,
  buildCollectionSpec,
  buildWatchlistSpec,
  DEFAULT_COLLECTION_CONTROLS,
  DEFAULT_WATCHLIST_CONTROLS,
  descNullsLast,
  hasActiveCollectionFilters,
  hasActiveWatchlistFilters,
  isBarking,
  loadStoredControls,
  sanitizeCollectionControls,
  sanitizeWatchlistControls,
  saveStoredControls,
  type CollectionControls,
  type WatchlistControls,
} from "../src/lib/listControls.js";

// ---------------------------------------------------------------------------
// Fixtures: minimal DTOs — only the fields the controls actually read matter.
// ---------------------------------------------------------------------------

function copy(overrides: Partial<OwnedCopyDto> & Pick<OwnedCopyDto, "id">): OwnedCopyDto {
  return {
    game: { id: overrides.id, title: `Game ${overrides.id}`, platform: "snes", year: null, coverUrl: null },
    region: "PAL",
    condition: "loose",
    notes: null,
    acquiredAt: null,
    acquiredPriceOriginal: null,
    acquiredCurrency: null,
    acquiredPriceUsd: null,
    status: "owned",
    itemGrade: null,
    workingState: null,
    authenticity: null,
    acquiredSource: null,
    acquiredUrl: null,
    acquisitionId: null,
    soldAt: null,
    soldPriceOriginal: null,
    soldFeesOriginal: null,
    soldCurrency: null,
    soldPriceUsd: null,
    soldFeesUsd: null,
    soldVenue: null,
    returnedAt: null,
    refundOriginal: null,
    returnCostsOriginal: null,
    refundUsd: null,
    returnCostsUsd: null,
    estimatedValueUsd: null,
    valueBasis: null,
    valueFetchedAt: null,
    signals: [],
    matchBasis: null,
    matchScore: null,
    ...overrides,
  };
}

function watch(overrides: Partial<WatchlistItemDto> & Pick<WatchlistItemDto, "id">): WatchlistItemDto {
  return {
    game: { id: overrides.id, title: `Watch ${overrides.id}`, platform: "snes", year: null, coverUrl: null },
    region: null,
    condition: null,
    targetPriceOriginal: null,
    targetCurrency: null,
    targetPriceUsd: null,
    storeOffer: null,
    storeBids: [],
    storeSource: null,
    priceDisplayAt: null, signalsAboveTarget: 0,
    signals: [],
    ...overrides,
  };
}

function point(overrides: Partial<PricePointDto>): PricePointDto {
  return {
    source: "cex",
    kind: "sell",
    region: "PAL",
    condition: "loose",
    priceUsd: 10,
    priceOriginal: 8,
    currencyOriginal: "GBP",
    available: null,
    ...overrides,
  };
}

function collectionControls(overrides: Partial<CollectionControls>): CollectionControls {
  return { ...DEFAULT_COLLECTION_CONTROLS, ...overrides };
}

function watchlistControls(overrides: Partial<WatchlistControls>): WatchlistControls {
  // the Signals chip off: these cases read every watch unless they say otherwise
  return { ...DEFAULT_WATCHLIST_CONTROLS, barkingOnly: false, ...overrides };
}

function ids<T extends { id: number }>(groups: Array<{ items: T[] }>): number[] {
  return groups.flatMap((g) => g.items.map((i) => i.id));
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("applyControls: collection filters", () => {
  const items = [
    copy({ id: 1, region: "PAL", condition: "cib", status: "owned", itemGrade: "mint" }),
    copy({ id: 2, region: "NTSC_J", condition: "loose", status: "sold" }),
    copy({
      id: 3,
      region: "unknown",
      condition: "new",
      status: "listed",
      itemGrade: "good",
      game: { id: 3, title: "Game 3", platform: "saturn", year: null, coverUrl: null },
    }),
    copy({ id: 4, region: "PAL", condition: "boxed_no_manual", status: "owned", itemGrade: "fair" }),
  ];

  it("region filter keeps only matching items (incl. unknown)", () => {
    expect(ids(applyControls(items, buildCollectionSpec(collectionControls({ region: "PAL" }))))).toEqual([1, 4]);
    expect(ids(applyControls(items, buildCollectionSpec(collectionControls({ region: "unknown" }))))).toEqual([3]);
  });

  it("condition filter keeps only matching items; boxed_no_manual is its own tier, never cib", () => {
    expect(ids(applyControls(items, buildCollectionSpec(collectionControls({ condition: "cib" }))))).toEqual([1]);
    expect(ids(applyControls(items, buildCollectionSpec(collectionControls({ condition: "new" }))))).toEqual([3]);
    expect(ids(applyControls(items, buildCollectionSpec(collectionControls({ condition: "boxed_no_manual" }))))).toEqual([4]);
  });

  it("grade filter matches a specific grade and 'ungraded' matches null grades", () => {
    expect(ids(applyControls(items, buildCollectionSpec(collectionControls({ grade: "mint" }))))).toEqual([1]);
    expect(ids(applyControls(items, buildCollectionSpec(collectionControls({ grade: "ungraded" }))))).toEqual([2]);
  });

  it("status filter keeps only matching items", () => {
    expect(ids(applyControls(items, buildCollectionSpec(collectionControls({ status: "sold" }))))).toEqual([2]);
  });

  it("platform filter keeps only matching items", () => {
    expect(ids(applyControls(items, buildCollectionSpec(collectionControls({ platform: "saturn" }))))).toEqual([3]);
  });

  it("returns the implicit group with zero items when every item is filtered out", () => {
    const groups = applyControls(items, buildCollectionSpec(collectionControls({ region: "NTSC_U" })));
    expect(groups).toEqual([{ key: "all", label: "", items: [] }]);
  });

  it("returns no groups at all when grouping is on and nothing matches", () => {
    const groups = applyControls(
      items,
      buildCollectionSpec(collectionControls({ region: "NTSC_U", group: "platform" })),
    );
    expect(groups).toEqual([]);
  });

  it("hasActiveCollectionFilters flags filters but never sort/group", () => {
    expect(hasActiveCollectionFilters(DEFAULT_COLLECTION_CONTROLS)).toBe(false);
    expect(hasActiveCollectionFilters(collectionControls({ sort: "value", group: "status" }))).toBe(false);
    expect(hasActiveCollectionFilters(collectionControls({ grade: "ungraded" }))).toBe(true);
    expect(hasActiveCollectionFilters(collectionControls({ platform: "snes" }))).toBe(true);
  });
});

describe("applyControls: collection sorts", () => {
  it("title sorts A-Z (the default)", () => {
    const items = [
      copy({ id: 1, game: { id: 1, title: "Zelda", platform: "snes", year: null, coverUrl: null } }),
      copy({ id: 2, game: { id: 2, title: "Aladdin", platform: "snes", year: null, coverUrl: null } }),
      copy({ id: 3, game: { id: 3, title: "Metroid", platform: "snes", year: null, coverUrl: null } }),
    ];
    expect(ids(applyControls(items, buildCollectionSpec(DEFAULT_COLLECTION_CONTROLS)))).toEqual([2, 3, 1]);
  });

  it("value sorts desc with nulls last", () => {
    const items = [
      copy({ id: 1, estimatedValueUsd: null }),
      copy({ id: 2, estimatedValueUsd: 20 }),
      copy({ id: 3, estimatedValueUsd: 38 }),
    ];
    expect(ids(applyControls(items, buildCollectionSpec(collectionControls({ sort: "value" }))))).toEqual([3, 2, 1]);
  });

  it("paid sorts desc with nulls last", () => {
    const items = [
      copy({ id: 1, acquiredPriceUsd: 5 }),
      copy({ id: 2, acquiredPriceUsd: null }),
      copy({ id: 3, acquiredPriceUsd: 12 }),
    ];
    expect(ids(applyControls(items, buildCollectionSpec(collectionControls({ sort: "paid" }))))).toEqual([3, 1, 2]);
  });

  it("newest sorts by id desc (the DTO carries no createdAt)", () => {
    const items = [copy({ id: 2 }), copy({ id: 9 }), copy({ id: 5 })];
    expect(ids(applyControls(items, buildCollectionSpec(collectionControls({ sort: "newest" }))))).toEqual([9, 5, 2]);
  });

  it("grade sorts best-first (mint -> poor) with ungraded last", () => {
    const items = [
      copy({ id: 1, itemGrade: "good" }),
      copy({ id: 2, itemGrade: null }),
      copy({ id: 3, itemGrade: "mint" }),
      copy({ id: 4, itemGrade: "poor" }),
    ];
    expect(ids(applyControls(items, buildCollectionSpec(collectionControls({ sort: "grade" }))))).toEqual([3, 1, 4, 2]);
  });

  it("ties keep the base order (stable sort)", () => {
    const items = [
      copy({ id: 7, estimatedValueUsd: 10 }),
      copy({ id: 3, estimatedValueUsd: 10 }),
      copy({ id: 9, estimatedValueUsd: 10 }),
    ];
    expect(ids(applyControls(items, buildCollectionSpec(collectionControls({ sort: "value" }))))).toEqual([7, 3, 9]);
  });
});

describe("applyControls: collection grouping", () => {
  const items = [
    copy({ id: 1, status: "sold", region: "NTSC_J", game: { id: 1, title: "A", platform: "saturn", year: null, coverUrl: null } }),
    copy({ id: 2, status: "owned", region: "PAL", game: { id: 2, title: "B", platform: "snes", year: null, coverUrl: null } }),
    copy({ id: 3, status: "incoming", region: "PAL", game: { id: 3, title: "C", platform: "snes", year: null, coverUrl: null } }),
  ];

  it("groups by platform with human labels, ordered alphabetically by label", () => {
    const groups = applyControls(items, buildCollectionSpec(collectionControls({ group: "platform" })));
    expect(groups.map((g) => ({ key: g.key, label: g.label, ids: g.items.map((i) => i.id) }))).toEqual([
      { key: "saturn", label: "Saturn", ids: [1] },
      { key: "snes", label: "SNES", ids: [2, 3] },
    ]);
  });

  it("groups by status in canonical lifecycle order (not alphabetical)", () => {
    const groups = applyControls(items, buildCollectionSpec(collectionControls({ group: "status" })));
    expect(groups.map((g) => g.key)).toEqual(["incoming", "owned", "sold"]);
  });

  it("groups by region in canonical order", () => {
    const groups = applyControls(items, buildCollectionSpec(collectionControls({ group: "region" })));
    expect(groups.map((g) => g.key)).toEqual(["PAL", "NTSC_J"]);
  });

  it("grouping off returns a single implicit group with all items", () => {
    const groups = applyControls(items, buildCollectionSpec(DEFAULT_COLLECTION_CONTROLS));
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(3);
  });

  it("combined filter + sort + group: filters first, sorts inside each group", () => {
    const combined = [
      copy({ id: 1, region: "PAL", estimatedValueUsd: 5, game: { id: 1, title: "A", platform: "snes", year: null, coverUrl: null } }),
      copy({ id: 2, region: "PAL", estimatedValueUsd: 50, game: { id: 2, title: "B", platform: "snes", year: null, coverUrl: null } }),
      copy({ id: 3, region: "NTSC_U", estimatedValueUsd: 99, game: { id: 3, title: "C", platform: "snes", year: null, coverUrl: null } }),
      copy({ id: 4, region: "PAL", estimatedValueUsd: 20, game: { id: 4, title: "D", platform: "saturn", year: null, coverUrl: null } }),
    ];
    const groups = applyControls(
      combined,
      buildCollectionSpec(collectionControls({ region: "PAL", sort: "value", group: "platform" })),
    );
    expect(groups.map((g) => ({ key: g.key, ids: g.items.map((i) => i.id) }))).toEqual([
      { key: "saturn", ids: [4] },
      { key: "snes", ids: [2, 1] }, // value desc inside the group; id 3 filtered out
    ]);
  });
});

describe("applyControls: watchlist", () => {
  const items = [
    watch({ id: 1, region: "PAL", condition: "cib" }),
    watch({ id: 2, region: null, condition: null }),
    watch({
      id: 3,
      region: "NTSC_J",
      condition: "loose",
      signals: [{ type: "UNDERPRICED", reasoning: "r", source: "ebay_uk" }],
    }),
    watch({ id: 4, region: null, condition: "cib", signals: [{ type: "INSUFFICIENT_DATA", reasoning: "r" }] }),
    watch({ id: 5, region: "PAL", condition: "boxed_no_manual" }),
  ];

  it("region pref filter matches specific prefs; 'any' matches the null pref", () => {
    expect(ids(applyControls(items, buildWatchlistSpec(watchlistControls({ region: "PAL" }))))).toEqual([1, 5]);
    expect(ids(applyControls(items, buildWatchlistSpec(watchlistControls({ region: "any" }))))).toEqual([2, 4]);
  });

  it("condition pref filter matches specific prefs; 'any' matches the null pref; boxed_no_manual is its own pref", () => {
    expect(ids(applyControls(items, buildWatchlistSpec(watchlistControls({ condition: "cib" }))))).toEqual([1, 4]);
    expect(ids(applyControls(items, buildWatchlistSpec(watchlistControls({ condition: "any" }))))).toEqual([2]);
    expect(ids(applyControls(items, buildWatchlistSpec(watchlistControls({ condition: "boxed_no_manual" }))))).toEqual([5]);
  });

  it("barkingOnly keeps items with actionable signals; INSUFFICIENT_DATA alone is not a bark", () => {
    expect(isBarking(items[2])).toBe(true);
    expect(isBarking(items[3])).toBe(false);
    expect(ids(applyControls(items, buildWatchlistSpec(watchlistControls({ barkingOnly: true }))))).toEqual([3]);
  });

  it("an item whose only signals are low-confidence is not barking", () => {
    const quiet = { ...items[2], signals: items[2].signals.map((sig) => ({ ...sig, confidence: "potential" as const })) };
    expect(isBarking(quiet)).toBe(false);
  });

  it("actionability sort (default) reuses the flips > bargains > warnings > rest ordering", () => {
    const mixed = [
      watch({ id: 1 }),
      watch({ id: 2, signals: [{ type: "OVERPRICED_STORE", reasoning: "r", source: "cex" }] }),
      watch({ id: 3, signals: [{ type: "UNDERPRICED", reasoning: "r", source: "ebay_uk" }] }),
      watch({ id: 4, signals: [{ type: "FLIP", reasoning: "r", buySource: "ebay_uk", sellSource: "cex" }] }),
    ];
    expect(ids(applyControls(mixed, buildWatchlistSpec(watchlistControls({}))))).toEqual([4, 3, 2, 1]);
  });

  it("actionability ranks high confidence before potential within a type group", () => {
    const potential = watch({
      id: 1,
      signals: [{ type: "FLIP", reasoning: "r", buySource: "ebay_uk", sellSource: "cex", confidence: "potential" }],
    });
    const high = watch({
      id: 2,
      signals: [{ type: "FLIP", reasoning: "r", buySource: "ebay_uk", sellSource: "cex", confidence: "high" }],
    });
    expect(actionabilityRank(high)).toBeLessThan(actionabilityRank(potential));
    expect(ids(applyControls([potential, high], buildWatchlistSpec(watchlistControls({}))))).toEqual([2, 1]);
  });

  it("title sort orders A-Z", () => {
    const named = [
      watch({ id: 1, game: { id: 1, title: "Zelda", platform: "snes", year: null, coverUrl: null } }),
      watch({ id: 2, game: { id: 2, title: "Aladdin", platform: "snes", year: null, coverUrl: null } }),
    ];
    expect(ids(applyControls(named, buildWatchlistSpec(watchlistControls({ sort: "title" }))))).toEqual([2, 1]);
  });

  it("groups by platform with labels and counts intact", () => {
    const mixed = [
      watch({ id: 1, game: { id: 1, title: "A", platform: "saturn", year: null, coverUrl: null } }),
      watch({ id: 2, game: { id: 2, title: "B", platform: "snes", year: null, coverUrl: null } }),
      watch({ id: 3, game: { id: 3, title: "C", platform: "snes", year: null, coverUrl: null } }),
    ];
    const groups = applyControls(mixed, buildWatchlistSpec(watchlistControls({ group: "platform" })));
    expect(groups.map((g) => ({ label: g.label, count: g.items.length }))).toEqual([
      { label: "Saturn", count: 1 },
      { label: "SNES", count: 2 },
    ]);
  });

  it("hasActiveWatchlistFilters flags filters but never sort/group", () => {
    expect(hasActiveWatchlistFilters(watchlistControls({}))).toBe(false);
    // the default is the Signals chip on, which is a filter
    expect(DEFAULT_WATCHLIST_CONTROLS.barkingOnly).toBe(true);
    expect(hasActiveWatchlistFilters(watchlistControls({ sort: "title", group: "platform" }))).toBe(false);
    expect(hasActiveWatchlistFilters(watchlistControls({ barkingOnly: true }))).toBe(true);
  });
});

describe("controls persistence", () => {
  it("sanitizers fall back to defaults on garbage and keep valid fields", () => {
    expect(sanitizeCollectionControls(null)).toEqual(DEFAULT_COLLECTION_CONTROLS);
    expect(sanitizeCollectionControls("nonsense")).toEqual(DEFAULT_COLLECTION_CONTROLS);
    expect(
      sanitizeCollectionControls({ region: "PAL", grade: "not-a-grade", sort: "value", extra: 1 }),
    ).toEqual({ ...DEFAULT_COLLECTION_CONTROLS, region: "PAL", sort: "value" });
    // the new tier is an allowed persisted pick for both screens
    expect(sanitizeCollectionControls({ condition: "boxed_no_manual" }).condition).toBe("boxed_no_manual");
    expect(sanitizeWatchlistControls({ condition: "boxed_no_manual" }).condition).toBe("boxed_no_manual");
    expect(sanitizeWatchlistControls({ barkingOnly: true, region: "NTSC_U", sort: 42 })).toEqual({
      ...DEFAULT_WATCHLIST_CONTROLS,
      barkingOnly: true,
      region: "NTSC_U",
    });
  });

  it("round-trips controls through localStorage", () => {
    const stored = { ...DEFAULT_COLLECTION_CONTROLS, region: "PAL" as const, group: "status" as const };
    saveStoredControls("collectionControls", stored);
    expect(loadStoredControls("collectionControls", sanitizeCollectionControls)).toEqual(stored);
  });

  it("returns defaults on unreadable JSON", () => {
    window.localStorage.setItem("collectionControls", "{not json");
    expect(loadStoredControls("collectionControls", sanitizeCollectionControls)).toEqual(
      DEFAULT_COLLECTION_CONTROLS,
    );
  });

  it("returns defaults when localStorage itself throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    expect(loadStoredControls("collectionControls", sanitizeCollectionControls)).toEqual(
      DEFAULT_COLLECTION_CONTROLS,
    );
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    expect(() => saveStoredControls("collectionControls", DEFAULT_COLLECTION_CONTROLS)).not.toThrow();
  });
});

describe("bestBy", () => {
  it("returns null for an empty list rather than throwing", () => {
    expect(bestBy<number>([], (n) => n)).toBeNull();
  });

  it("picks the highest key by default", () => {
    expect(bestBy([3, 9, 5], (n) => n)).toBe(9);
  });

  it("picks the lowest key with side \"min\"", () => {
    expect(bestBy([3, 9, 5], (n) => n, "min")).toBe(3);
  });

  it("keeps the first-seen item on a tie", () => {
    const a = { id: "a", key: 5 };
    const b = { id: "b", key: 5 };
    expect(bestBy([a, b], (x) => x.key)).toBe(a);
  });
});

describe("descNullsLast", () => {
  it("sorts descending when both are known", () => {
    expect(descNullsLast(5, 9)).toBeGreaterThan(0); // 5 sorts after 9
    expect(descNullsLast(9, 5)).toBeLessThan(0);
  });

  it("sorts a null amount after any known one, regardless of which side it's on", () => {
    expect(descNullsLast(null, 5)).toBeGreaterThan(0);
    expect(descNullsLast(5, null)).toBeLessThan(0);
  });

  it("treats two nulls as equal", () => {
    expect(descNullsLast(null, null)).toBe(0);
  });
});
