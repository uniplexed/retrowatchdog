import type {
  Condition,
  ItemGrade,
  Platform,
  PriceKind,
  PriceRole,
  Region,
  SourceId,
} from "@retrowatchdog/shared";

export interface RawPrice {
  kind: PriceKind;
  amount: number;
  currency: string;
  /** observations this amount stands on, when the SOURCE aggregated it; absent for a single listing's price */
  sampleSize?: number;
}

export interface RawListing {
  sourceProductId: string;
  title: string;
  /** the source's own category text; helps platform detection */
  categoryText?: string;
  /** the source's structured condition field, where it has one */
  conditionText?: string;
  prices: RawPrice[];
  url: string | null;
  /** when the source actually reported these prices; catalog-sync adapters fill it from synced_at */
  observedAt?: Date;
  /**
   * Whether the source reports the listing as buyable right now; absent/null
   * = unknown. The signal engine skips buy-role points whose flag is `false`.
   */
  available?: boolean | null;
}

export interface NormalizedListing extends RawListing {
  cleanTitle: string;
  platformGuess: Platform | null;
  regionGuess: Region;
  conditionGuess: Condition;
  /** cosmetic/physical grade guessed from the listing title; optional, backward compatible */
  gradeGuess?: ItemGrade | null;
  /**
   * The title names a console this app does not track (Xbox, Switch, PS4…)
   * and none it does. Such a listing is never matched: with no tracked
   * platform the matcher's platform filter would fall open and price it as
   * whichever platform carries a game of that name.
   */
  foreignPlatform?: boolean;
}

export class NotConfiguredError extends Error {
  constructor(source: string) {
    super(`${source} adapter is not configured`);
    this.name = "NotConfiguredError";
  }
}

export type SnapshotStrategy = "per_listing" | "median_of_listings";

/**
 * The kind a source has assigned a given role to, or undefined when no
 * declared kind carries it. Every role-keyed reader of a median source goes
 * through this, so literal kind names never matter. The first kind found wins.
 */
export function kindForRole(
  kindRoles: Partial<Record<PriceKind, PriceRole>>,
  role: PriceRole,
): PriceKind | undefined {
  for (const [kind, r] of Object.entries(kindRoles)) {
    if (r === role) return kind as PriceKind;
  }
  return undefined;
}
export interface CatalogItemUpsert {
  sourceProductId: string;
  title: string;
  categoryText?: string | null;
  prices: Record<string, string>;
  currency: string;
  available?: boolean | null;
  /** when the SOURCE says it observed these prices; null/absent = it did not say */
  observedAt?: Date | null;
  /** the source's own structured condition field, verbatim */
  conditionText?: string | null;
  /** observations behind each price, keyed like `prices`; a kind may be absent */
  sampleSizes?: Record<string, number> | null;
}
export interface CatalogSink { upsert(items: CatalogItemUpsert[]): Promise<void>; }
export interface SyncUnitReport { itemsUpserted: number; complete: boolean; notes?: string; }
export interface CatalogSyncCapability {
  readonly schedule: { catalogCron: string; trackedRefreshHours: number };
  listSyncUnits(): Promise<string[]>;
  syncUnit(unit: string, sink: CatalogSink): Promise<SyncUnitReport>;
  refreshItems?(sourceProductIds: string[], sink: CatalogSink): Promise<void>;
}

export interface SearchOptions {
  /**
   * The catalog's other names for the game (its game_names rows). A source
   * building a keyword query may widen recall with them; others ignore them.
   */
  alternativeNames?: readonly string[];
}

export interface PriceSourceAdapter {
  readonly source: SourceId;
  /** how the pricing service turns matched listings into price_points rows */
  readonly snapshotStrategy: SnapshotStrategy;
  /**
   * The roles this source's approved kinds carry, keyed by kind; read through
   * `kindForRole` by `medianPointsFrom`. Present on every `median_of_listings`
   * adapter, from the same `kindRoles` its `snapshotStrategy` came from.
   */
  readonly kindRoles?: Partial<Record<PriceKind, PriceRole>>;
  /** optional per-source TTL override; service falls back to PRICE_TTL_HOURS */
  readonly ttlHours?: number;
  /** present = catalog-sync source (search reads the local catalog); absent = live */
  readonly catalogSync?: CatalogSyncCapability;
  isConfigured(): boolean;
  search(query: string, platformHint?: Platform, opts?: SearchOptions): Promise<RawListing[]>;
  normalize(raw: RawListing): NormalizedListing;
}
