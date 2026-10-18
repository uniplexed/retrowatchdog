import { sql } from "drizzle-orm";
import pino from "pino";
import type { Platform, PriceKind, PriceRole, Region, SourceId } from "@retrowatchdog/shared";
import type { Db } from "../../db/index.js";
import { classifyCatalogListing } from "../classifyListing.js";
import { familyCategoryHints, matchesAnyHint } from "../familyReading.js";
import { isSampleSize } from "./protocol.js";
import type {
  CatalogSyncCapability,
  NormalizedListing,
  PriceSourceAdapter,
  RawListing,
  RawPrice,
  SnapshotStrategy,
} from "../types.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "warn" });

// type alias, NOT interface: drizzle's execute<T> needs an implicit index signature
type CatalogSearchRow = {
  sourceProductId: string;
  title: string;
  categoryText: string | null;
  prices: Record<string, string>;
  currency: string;
  available: boolean | null;
  syncedAt: Date | string;
  observedAt: Date | string | null;
  conditionText: string | null;
  sampleSizes: Record<string, number> | null;
};

/**
 * A sync source whose sweep has never run: it has no answer to give, which is
 * not the same as "found nothing" and must not render as an empty healthy block.
 */
export class PluginCatalogEmptyError extends Error {
  constructor(source: SourceId) {
    super(`${source} catalog is empty - its catalog sync has never run`);
    this.name = "PluginCatalogEmptyError";
  }
}

export interface PluginCatalogAdapterOptions {
  db: Db;
  source: SourceId;
  baseUrl: string;
  snapshotStrategy: SnapshotStrategy;
  /** the kinds the user approved; a stored price of any other kind is not read back */
  declaredKinds: readonly PriceKind[];
  /**
   * The exact map `snapshotStrategy` was derived from, never recomputed, so the
   * two cannot disagree; `medianPointsFrom` needs it to resolve roles.
   */
  kindRoles?: Partial<Record<PriceKind, PriceRole>>;
  /** the currencies this source's site quotes; empty means "no expectation" */
  expectedCurrencies?: readonly string[];
  /** region for a listing whose title declares none; null = do not guess */
  defaultRegion?: Region | null;
  /** the manifest's `family`: selects the app's reading of its category vocabulary */
  family: string;
  /**
   * The manifest's `productUrl` template, `{id}` and all. A synced row may not
   * carry a link: the app owns where a click lands, and the template's origin
   * is pinned at import. Not cosmetic: `price_points.source_url` is how a stored
   * point is found again, so a source with no link has unfindable points.
   */
  productUrl?: string;
  catalogSync: CatalogSyncCapability;
}

/**
 * A plugin source whose prices come from the app's OWN `catalog_items` table,
 * swept there by the plugin's `catalogSync`. Opening a game searches this
 * catalogue with `pg_trgm` and costs the plugin nothing; a sync plugin has no
 * `/search` endpoint. Price kinds are narrowed to the approved ones, the
 * currency is the row's own, and the link comes from the manifest template.
 */
export class PluginCatalogAdapter implements PriceSourceAdapter {
  readonly source: SourceId;
  readonly snapshotStrategy: SnapshotStrategy;
  readonly catalogSync: CatalogSyncCapability;
  /** what this source may claim */
  readonly declaredKinds: ReadonlySet<PriceKind>;
  readonly kindRoles: Partial<Record<PriceKind, PriceRole>>;
  readonly expectedCurrencies: ReadonlySet<string>;
  private readonly db: Db;
  private readonly baseUrl: string;
  private readonly defaultRegion: Region | null;
  private readonly family: string;
  private readonly productUrl: string | undefined;

  constructor(opts: PluginCatalogAdapterOptions) {
    this.db = opts.db;
    this.source = opts.source;
    this.baseUrl = opts.baseUrl.trim();
    this.snapshotStrategy = opts.snapshotStrategy;
    this.declaredKinds = new Set(opts.declaredKinds);
    this.kindRoles = opts.kindRoles ?? {};
    this.expectedCurrencies = new Set(opts.expectedCurrencies ?? []);
    this.defaultRegion = opts.defaultRegion ?? null;
    this.family = opts.family;
    this.productUrl = opts.productUrl;
    this.catalogSync = opts.catalogSync;
  }

  /** Without a base URL there is nothing to sweep the catalogue from. */
  isConfigured(): boolean {
    return this.baseUrl.length > 0;
  }

  /**
   * Trigram similarity over `catalog_items.title`, most similar first.
   *
   * The non-game reading is NOT applied, measured: it misreads a shop's SKU
   * vocabulary ("…, w/ Manual, Boxed" reads as an accessory, because
   * COMPLETENESS_QUALIFIER lacks the bare "w/"), which would delete a shop's
   * whole complete-in-box tier. The platform hint is read only for a family the
   * app has a reading for.
   */
  async search(query: string, platformHint?: Platform): Promise<RawListing[]> {
    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL pg_trgm.similarity_threshold = 0.2`);
      const res = await tx.execute<CatalogSearchRow>(sql`
        SELECT source_product_id AS "sourceProductId", title,
               category_text AS "categoryText", prices, currency, available,
               synced_at AS "syncedAt", observed_at AS "observedAt",
               condition_text AS "conditionText", sample_sizes AS "sampleSizes"
        FROM catalog_items
        WHERE source = ${this.source} AND title % ${query}
        ORDER BY similarity(title, ${query}) DESC
        LIMIT 50
      `);
      return res.rows;
    });
    if (rows.length === 0) {
      const [{ count }] = (
        await this.db.execute<{ count: string }>(
          sql`SELECT count(*) AS count FROM catalog_items WHERE source = ${this.source}`,
        )
      ).rows;
      if (Number(count) === 0) throw new PluginCatalogEmptyError(this.source);
    }
    const toListings = (list: CatalogSearchRow[]): RawListing[] => {
      const listings: RawListing[] = [];
      for (const row of list) {
        const listing = this.toListing(row);
        if (listing !== null) listings.push(listing);
      }
      return listings;
    };
    const hints = platformHint === undefined ? [] : familyCategoryHints(this.family, platformHint);
    if (hints.length > 0) {
      // Recall-widening only: the matcher's hard platform filter guarantees
      // correctness, so a filter that empties the set falls back to all of it.
      // Tested on LISTINGS, not rows: a row with no usable price yields none.
      const kept = toListings(rows.filter((row) => matchesAnyHint(row.categoryText, hints)));
      if (kept.length > 0) return kept;
    }
    return toListings(rows);
  }

  /**
   * The id is percent-encoded so it cannot add a query parameter of its own;
   * the import-time check pins only the origin.
   */
  private productUrlFor(sourceProductId: string): string | null {
    if (this.productUrl === undefined) return null;
    return this.productUrl.replace("{id}", encodeURIComponent(sourceProductId));
  }

  /**
   * A stored row read back under TODAY's approval: a kind unchecked or a
   * currency dropped since the sweep must stop being priced from. A row left
   * with no usable price is dropped whole.
   */
  private toListing(row: CatalogSearchRow): RawListing | null {
    if (this.expectedCurrencies.size > 0 && !this.expectedCurrencies.has(row.currency)) {
      log.warn(
        { source: this.source, sourceProductId: row.sourceProductId, currency: row.currency },
        "catalog row quotes a currency this source's site does not",
      );
      return null;
    }
    const prices: RawPrice[] = [];
    for (const [kind, amount] of Object.entries(row.prices ?? {})) {
      if (!this.declaredKinds.has(kind as PriceKind)) continue;
      const value = Number(amount);
      if (!Number.isFinite(value) || value < 0) continue;
      const sample = row.sampleSizes?.[kind];
      prices.push({
        kind: kind as PriceKind,
        amount: value,
        currency: row.currency,
        // re-checked on the way out: jsonb outlives the validator that admitted it
        ...(isSampleSize(sample) ? { sampleSize: sample } : {}),
      });
    }
    if (prices.length === 0) return null;
    // the source's own observation when it gave one, else the sweep's clock
    const seenAt = row.observedAt ?? row.syncedAt;
    return {
      sourceProductId: row.sourceProductId,
      title: row.title,
      ...(row.categoryText === null ? {} : { categoryText: row.categoryText }),
      ...(row.conditionText === null ? {} : { conditionText: row.conditionText }),
      prices,
      url: this.productUrlFor(row.sourceProductId),
      observedAt: seenAt instanceof Date ? seenAt : new Date(seenAt),
      available: row.available,
    };
  }

  /**
   * Shared classification with the shop's category read before the title: a
   * SKU title often names no console, or names the original's ("Super Mario
   * Advance"), and a wrong platform confirms against the wrong release forever.
   * Unrecognised categories fall through to the title.
   */
  normalize(raw: RawListing): NormalizedListing {
    return classifyCatalogListing(raw, this.defaultRegion);
  }
}
