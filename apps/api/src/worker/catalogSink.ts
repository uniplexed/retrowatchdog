import { and, eq, lt, sql } from "drizzle-orm";
import type { SourceId } from "@retrowatchdog/shared";
import type { Db } from "../db/index.js";
import { catalogItems, syncState } from "../db/schema.js";
import type { CatalogItemUpsert, CatalogSink } from "../adapters/types.js";

const CHUNK = 500;

function rowsFrom(items: CatalogItemUpsert[], source: SourceId) {
  return items.map((i) => ({
    source,
    sourceProductId: i.sourceProductId,
    title: i.title,
    categoryText: i.categoryText ?? null,
    prices: i.prices,
    currency: i.currency,
    available: i.available ?? null,
    observedAt: i.observedAt ?? null,
    conditionText: i.conditionText ?? null,
    sampleSizes: i.sampleSizes ?? null,
  }));
}

/** Bulk mode: the unit sync stamps identity, seen-ness and the sync unit. */
export function makeBulkSink(db: Db, source: SourceId, unit: string, runStartedAt: Date): CatalogSink {
  return {
    async upsert(items) {
      for (let i = 0; i < items.length; i += CHUNK) {
        const rows = rowsFrom(items.slice(i, i + CHUNK), source).map((r) => ({
          ...r,
          syncedAt: runStartedAt,
          lastSeenAt: runStartedAt,
          refreshSource: "bulk",
          syncUnit: unit,
        }));
        await db
          .insert(catalogItems)
          .values(rows)
          .onConflictDoUpdate({
            target: [catalogItems.source, catalogItems.sourceProductId],
            set: {
              title: sql`excluded.title`,
              categoryText: sql`excluded.category_text`,
              prices: sql`excluded.prices`,
              currency: sql`excluded.currency`,
              available: sql`excluded.available`,
              observedAt: sql`excluded.observed_at`,
              conditionText: sql`excluded.condition_text`,
              sampleSizes: sql`excluded.sample_sizes`,
              syncedAt: runStartedAt,
              lastSeenAt: runStartedAt,
              refreshSource: "bulk",
              syncUnit: unit,
            },
          });
      }
    },
  };
}

/** Detail mode: refresh data without claiming bulk seen-ness or unit membership. */
export function makeDetailSink(db: Db, source: SourceId): CatalogSink {
  return {
    async upsert(items) {
      const now = new Date();
      for (let i = 0; i < items.length; i += CHUNK) {
        const rows = rowsFrom(items.slice(i, i + CHUNK), source).map((r) => ({
          ...r,
          syncedAt: now,
          lastSeenAt: now, // used only on INSERT of a brand-new row
          refreshSource: "detail",
          syncUnit: null,  // used only on INSERT
        }));
        await db
          .insert(catalogItems)
          .values(rows)
          .onConflictDoUpdate({
            target: [catalogItems.source, catalogItems.sourceProductId],
            // deliberately NOT set: lastSeenAt, syncUnit (bulk-owned columns)
            set: {
              title: sql`excluded.title`,
              categoryText: sql`excluded.category_text`,
              prices: sql`excluded.prices`,
              currency: sql`excluded.currency`,
              available: sql`excluded.available`,
              observedAt: sql`excluded.observed_at`,
              conditionText: sql`excluded.condition_text`,
              sampleSizes: sql`excluded.sample_sizes`,
              syncedAt: now,
              refreshSource: "detail",
            },
          });
      }
    },
  };
}

/** Worker-owned delisting: only after a COMPLETE unit sync. */
export async function deleteUnseen(db: Db, source: SourceId, unit: string, runStartedAt: Date): Promise<number> {
  const deleted = await db
    .delete(catalogItems)
    .where(
      and(
        eq(catalogItems.source, source),
        eq(catalogItems.syncUnit, unit),
        lt(catalogItems.lastSeenAt, runStartedAt),
      ),
    )
    .returning({ id: catalogItems.sourceProductId });
  return deleted.length;
}

/** Catches renamed/removed categories: rows no sync has touched in N days. */
export async function sweepStale(db: Db, source: SourceId, olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const deleted = await db
    .delete(catalogItems)
    .where(and(eq(catalogItems.source, source), lt(catalogItems.syncedAt, cutoff)))
    .returning({ id: catalogItems.sourceProductId });
  return deleted.length;
}

export async function markRan(db: Db, key: string, ranAt: Date): Promise<void> {
  await db
    .insert(syncState)
    .values({ key, ranAt })
    .onConflictDoUpdate({ target: syncState.key, set: { ranAt } });
}

export async function loadRanAt(db: Db, key: string): Promise<Date | null> {
  const [row] = await db.select().from(syncState).where(eq(syncState.key, key));
  return row?.ranAt ?? null;
}
