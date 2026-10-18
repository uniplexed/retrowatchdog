import { splitByConfidence } from "./signalVisibility.js";
import { COLLECTION_FACETS, WATCHLIST_FACETS, facetFilters, hasActiveFacets, rowSignal, sanitizeFacets } from "./facets.js";
import type {
  Condition,
  CopyStatus,
  ItemGrade,
  OwnedCopyDto,
  Platform,
  Region,
  SignalType,
  WatchlistItemDto,
} from "@retrowatchdog/shared";
import { COPY_STATUSES, ITEM_GRADES, PLATFORMS, REGIONS } from "@retrowatchdog/shared";

/** Pure list machinery for the list screens: filter -> sort -> group, no DOM. */

export interface ListGroup<T> {
  key: string;
  label: string;
  items: T[];
}

export interface GroupSpec<T> {
  keyOf: (item: T) => { key: string; label: string };
  /** Canonical key order; unlisted keys sort after, alphabetically by label. */
  keyOrder?: readonly string[];
}

export interface ControlsSpec<T> {
  /** every predicate must pass (AND); [] = no filtering */
  filters: Array<(item: T) => boolean>;
  /** comparator applied after filtering; Array.prototype.sort is stable, so ties keep the base order */
  sort?: (a: T, b: T) => number;
  /** grouping applied last; undefined = one implicit group */
  group?: GroupSpec<T>;
}

/** filter -> sort -> group. Grouping off yields one (possibly empty) group. */
export function applyControls<T>(items: T[], spec: ControlsSpec<T>): Array<ListGroup<T>> {
  const filtered = items.filter((item) => spec.filters.every((passes) => passes(item)));
  const sorted = spec.sort ? [...filtered].sort(spec.sort) : filtered;
  const group = spec.group;
  if (!group) return [{ key: "all", label: "", items: sorted }];
  const byKey = new Map<string, ListGroup<T>>();
  for (const item of sorted) {
    const { key, label } = group.keyOf(item);
    const existing = byKey.get(key);
    if (existing) existing.items.push(item);
    else byKey.set(key, { key, label, items: [item] });
  }
  const order = group.keyOrder;
  return [...byKey.values()].sort((a, b) => {
    if (order) {
      const ai = order.indexOf(a.key);
      const bi = order.indexOf(b.key);
      if (ai !== -1 || bi !== -1) {
        // listed keys keep the canonical order; unlisted ones sort after them
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      }
    }
    return a.label.localeCompare(b.label);
  });
}

// ---------------------------------------------------------------------------
// Collection controls
// ---------------------------------------------------------------------------

export const COLLECTION_REGION_FILTERS = ["all", ...REGIONS] as const;
// accessory-only tiers are reachable via "all"
export const COLLECTION_CONDITION_FILTERS = ["all", "loose", "boxed_no_manual", "cib", "new", "unknown"] as const;
export const COLLECTION_GRADE_FILTERS = ["all", ...ITEM_GRADES, "ungraded"] as const;
export const COLLECTION_SORTS = ["title", "value", "value_asc", "paid", "paid_asc", "newest", "grade"] as const;
export type CollectionSort = (typeof COLLECTION_SORTS)[number];
export const COLLECTION_GROUPS = ["none", "platform", "status", "region"] as const;
export type CollectionGroupKey = (typeof COLLECTION_GROUPS)[number];

export interface CollectionControls {
  region: Region | "all";
  condition: (typeof COLLECTION_CONDITION_FILTERS)[number];
  grade: ItemGrade | "ungraded" | "all";
  status: CopyStatus | "all";
  platform: Platform | "all";
  sort: CollectionSort;
  group: CollectionGroupKey;
  /** the standard-field filters (facets.ts), by facet id */
  facets: Record<string, string>;
}

export const DEFAULT_COLLECTION_CONTROLS: CollectionControls = {
  region: "all",
  condition: "all",
  grade: "all",
  status: "all",
  platform: "all",
  sort: "title",
  group: "none",
  facets: {},
};

export function collectionFilters(c: CollectionControls): Array<(item: OwnedCopyDto) => boolean> {
  const filters: Array<(item: OwnedCopyDto) => boolean> = [];
  if (c.region !== "all") filters.push((i) => i.region === c.region);
  if (c.condition !== "all") filters.push((i) => i.condition === c.condition);
  if (c.grade !== "all") {
    filters.push((i) => (c.grade === "ungraded" ? i.itemGrade === null : i.itemGrade === c.grade));
  }
  if (c.status !== "all") filters.push((i) => i.status === c.status);
  if (c.platform !== "all") filters.push((i) => i.game.platform === c.platform);
  filters.push(...facetFilters(COLLECTION_FACETS, c.facets));
  return filters;
}

/** true when any FILTER (not sort/group) narrows the list — drives the honest "Filtered totals" label */
export function hasActiveCollectionFilters(c: CollectionControls): boolean {
  return (
    c.region !== "all" ||
    c.condition !== "all" ||
    c.grade !== "all" ||
    c.status !== "all" ||
    c.platform !== "all" ||
    hasActiveFacets(c.facets)
  );
}

/** best-first rank: ITEM_GRADES is already ordered mint -> poor; ungraded sorts last */
function gradeRank(grade: ItemGrade | null): number {
  return grade === null ? ITEM_GRADES.length : ITEM_GRADES.indexOf(grade);
}

/** desc with nulls last: an unknown amount never outranks a known one */
/** ascending, nulls last */
export function ascNullsLast(a: number | null, b: number | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a - b;
}

export function descNullsLast(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/** The item ranking highest (or lowest) by keyOf; null when empty; ties keep the first. */
export function bestBy<T>(items: T[], keyOf: (item: T) => number, side: "min" | "max" = "max"): T | null {
  return items.reduce<T | null>((best, item) => {
    if (best === null) return item;
    return side === "min" ? (keyOf(item) < keyOf(best) ? item : best) : (keyOf(item) > keyOf(best) ? item : best);
  }, null);
}

export function collectionComparator(sort: CollectionSort): (a: OwnedCopyDto, b: OwnedCopyDto) => number {
  switch (sort) {
    case "title":
      return (a, b) => a.game.title.localeCompare(b.game.title);
    case "value":
      return (a, b) => descNullsLast(a.estimatedValueUsd, b.estimatedValueUsd);
    case "value_asc":
      return (a, b) => ascNullsLast(a.estimatedValueUsd, b.estimatedValueUsd);
    case "paid":
      return (a, b) => descNullsLast(a.acquiredPriceUsd, b.acquiredPriceUsd);
    case "paid_asc":
      return (a, b) => ascNullsLast(a.acquiredPriceUsd, b.acquiredPriceUsd);
    case "newest":
      // no createdAt on the DTO; ids are monotonic
      return (a, b) => b.id - a.id;
    case "grade":
      return (a, b) => gradeRank(a.itemGrade) - gradeRank(b.itemGrade);
  }
}

export function collectionGroupSpec(group: CollectionGroupKey): GroupSpec<OwnedCopyDto> | undefined {
  switch (group) {
    case "none":
      return undefined;
    case "platform":
      return { keyOf: (i) => ({ key: i.game.platform, label: PLATFORMS[i.game.platform].label }) };
    case "status":
      return { keyOf: (i) => ({ key: i.status, label: i.status }), keyOrder: COPY_STATUSES };
    case "region":
      return { keyOf: (i) => ({ key: i.region, label: i.region }), keyOrder: REGIONS };
  }
}

export function buildCollectionSpec(c: CollectionControls): ControlsSpec<OwnedCopyDto> {
  return {
    filters: collectionFilters(c),
    sort: collectionComparator(c.sort),
    group: collectionGroupSpec(c.group),
  };
}

// ---------------------------------------------------------------------------
// Watchlist controls
// ---------------------------------------------------------------------------

/** "any" matches a null pref (the watch covers any region/condition) */
export const WATCHLIST_REGION_FILTERS = ["all", "PAL", "NTSC_U", "NTSC_J", "any"] as const;
export type WatchlistRegionFilter = (typeof WATCHLIST_REGION_FILTERS)[number];
export const WATCHLIST_CONDITION_FILTERS = ["all", "loose", "boxed_no_manual", "cib", "new", "any"] as const;
export type WatchlistConditionFilter = (typeof WATCHLIST_CONDITION_FILTERS)[number];
export const WATCHLIST_SORTS = ["actionability", "title", "price_asc", "price_desc"] as const;
export type WatchlistSort = (typeof WATCHLIST_SORTS)[number];
export const WATCHLIST_GROUPS = ["none", "platform"] as const;
export type WatchlistGroupKey = (typeof WATCHLIST_GROUPS)[number];

export interface WatchlistControls {
  region: WatchlistRegionFilter;
  condition: WatchlistConditionFilter;
  /** only items with at least one actionable signal */
  barkingOnly: boolean;
  sort: WatchlistSort;
  group: WatchlistGroupKey;
  /** the standard-field filters (facets.ts), by facet id */
  facets: Record<string, string>;
}

export const DEFAULT_WATCHLIST_CONTROLS: WatchlistControls = {
  region: "all",
  condition: "all",
  // the Signals chip is on by default: a watch without one is quiet
  barkingOnly: true,
  sort: "actionability",
  group: "none",
  facets: {},
};

/** "Barking" = at least one high-confidence signal; INSUFFICIENT_DATA is not a bark. */
export function isBarking(item: WatchlistItemDto): boolean {
  return splitByConfidence(item.signals).high.length > 0;
}

export function watchlistFilters(c: WatchlistControls): Array<(item: WatchlistItemDto) => boolean> {
  const filters: Array<(item: WatchlistItemDto) => boolean> = [];
  if (c.region !== "all") {
    filters.push((i) => (c.region === "any" ? i.region === null : i.region === c.region));
  }
  if (c.condition !== "all") {
    filters.push((i) => (c.condition === "any" ? i.condition === null : i.condition === c.condition));
  }
  if (c.barkingOnly) filters.push(isBarking);
  filters.push(...facetFilters(WATCHLIST_FACETS, c.facets));
  return filters;
}

export function hasActiveWatchlistFilters(c: WatchlistControls): boolean {
  return c.region !== "all" || c.condition !== "all" || c.barkingOnly || hasActiveFacets(c.facets);
}

/**
 * Opportunity-first ordering: flips, then bargains, then overpriced-store
 * warnings, then the rest; within each, high confidence before potential.
 */
export const ACTIONABILITY_ORDER: SignalType[] = ["FLIP", "UNDERPRICED", "OVERPRICED_STORE"];

export function actionabilityRank(item: WatchlistItemDto): number {
  const typeRank = ACTIONABILITY_ORDER.findIndex((type) =>
    item.signals.some((signal) => signal.type === type),
  );
  if (typeRank === -1) return ACTIONABILITY_ORDER.length * 2;
  // two slots per type; a missing confidence counts as high
  const rankedType = ACTIONABILITY_ORDER[typeRank];
  const hasHigh = item.signals.some(
    (signal) => signal.type === rankedType && signal.confidence !== "potential",
  );
  return typeRank * 2 + (hasHigh ? 0 : 1);
}

export function watchlistComparator(sort: WatchlistSort): (a: WatchlistItemDto, b: WatchlistItemDto) => number {
  switch (sort) {
    case "actionability":
      return (a, b) => actionabilityRank(a) - actionabilityRank(b);
    case "title":
      return (a, b) => a.game.title.localeCompare(b.game.title);
    case "price_asc":
      return (a, b) => ascNullsLast(watchPriceUsd(a), watchPriceUsd(b));
    case "price_desc":
      return (a, b) => descNullsLast(watchPriceUsd(a), watchPriceUsd(b));
  }
}

/** the price a watch's row shows, in frozen USD: its verdict's, else the shop's offer; null without either */
export function watchPriceUsd(item: WatchlistItemDto): number | null {
  return rowSignal(item)?.price?.usd ?? item.storeOffer?.priceUsd ?? null;
}

export function watchlistGroupSpec(group: WatchlistGroupKey): GroupSpec<WatchlistItemDto> | undefined {
  switch (group) {
    case "none":
      return undefined;
    case "platform":
      return { keyOf: (i) => ({ key: i.game.platform, label: PLATFORMS[i.game.platform].label }) };
  }
}

export function buildWatchlistSpec(c: WatchlistControls): ControlsSpec<WatchlistItemDto> {
  return {
    filters: watchlistFilters(c),
    sort: watchlistComparator(c.sort),
    group: watchlistGroupSpec(c.group),
  };
}

// ---------------------------------------------------------------------------
// Persistence (per-browser convenience only)
// ---------------------------------------------------------------------------

/** localStorage may throw or hold garbage: guarded, and sanitized field by field. */
export function loadStoredControls<T>(key: string, sanitize: (raw: unknown) => T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return sanitize(raw === null ? null : JSON.parse(raw));
  } catch {
    return sanitize(null);
  }
}

export function saveStoredControls(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: the controls still work for this session
  }
}

/** keep a stored string only when it is one of the allowed values */
function pickAllowed<V extends string>(value: unknown, allowed: readonly V[], fallback: V): V {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as V)
    : fallback;
}

export function sanitizeCollectionControls(raw: unknown): CollectionControls {
  const d = DEFAULT_COLLECTION_CONTROLS;
  if (typeof raw !== "object" || raw === null) return { ...d };
  const r = raw as Record<string, unknown>;
  return {
    region: pickAllowed(r.region, COLLECTION_REGION_FILTERS, d.region),
    condition: pickAllowed(r.condition, COLLECTION_CONDITION_FILTERS, d.condition),
    grade: pickAllowed(r.grade, COLLECTION_GRADE_FILTERS, d.grade),
    status: pickAllowed(r.status, ["all", ...COPY_STATUSES] as const, d.status),
    platform: pickAllowed(r.platform, ["all", ...(Object.keys(PLATFORMS) as Platform[])] as const, d.platform),
    sort: pickAllowed(r.sort, COLLECTION_SORTS, d.sort),
    group: pickAllowed(r.group, COLLECTION_GROUPS, d.group),
    facets: sanitizeFacets(r.facets),
  };
}

export function sanitizeWatchlistControls(raw: unknown): WatchlistControls {
  const d = DEFAULT_WATCHLIST_CONTROLS;
  if (typeof raw !== "object" || raw === null) return { ...d };
  const r = raw as Record<string, unknown>;
  return {
    region: pickAllowed(r.region, WATCHLIST_REGION_FILTERS, d.region),
    condition: pickAllowed(r.condition, WATCHLIST_CONDITION_FILTERS, d.condition),
    barkingOnly: typeof r.barkingOnly === "boolean" ? r.barkingOnly : d.barkingOnly,
    sort: pickAllowed(r.sort, WATCHLIST_SORTS, d.sort),
    group: pickAllowed(r.group, WATCHLIST_GROUPS, d.group),
    facets: sanitizeFacets(r.facets),
  };
}

