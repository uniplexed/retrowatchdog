import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { SourceFamily, SourceId } from "@retrowatchdog/shared";
import type { Db } from "../db/index.js";
import { gameNames, games, pricePoints, sourceFetches, sourceMappings } from "../db/schema.js";
import { cleanTitle } from "./cleanTitle.js";
import { numeralCompatible, type NumeralGame } from "./numerals.js";

/**
 * One-off sweep behind scripts/review-numeral-mismatched-mappings.ts:
 * demotes confirmed mappings whose numerals disagree with their game
 * ("Sonic the Hedgehog" -> "Sonic the Hedgehog 2") to needs_review, since
 * confirmed mappings are sticky and the matcher never revisits them.
 *
 * It judges with the SAME predicate the matcher confirms with, over every
 * name of the game, so a row cannot oscillate between the two.
 */

export interface NumeralMismatchedMapping {
  mappingId: number;
  gameId: number;
  gameTitle: string;
  platform: string;
  sourceProductId: string;
  sourceTitle: string;
  matchScore: number;
}

export interface StaleGame {
  gameId: number;
  gameTitle: string;
  platform: string;
  /** price_points rows attributed to this game through a needs_review mapping's listing */
  pricePoints: number;
}

export interface StaleCacheInvalidation {
  supported: boolean;
  /** stale price_points rows found (would be deleted on a dry run) */
  stalePricePoints: number;
  /** rows actually deleted (always 0 on a dry run) */
  pricePointsDeleted: number;
  /** (game, source) fetch markers actually expired (always 0 on a dry run) */
  fetchMarkersExpired: number;
  /** per affected game, sorted by title */
  games: StaleGame[];
}

export interface NumeralMismatchSweepResult {
  /** confirmed mappings of the source that were scanned */
  scanned: number;
  /** every confirmed mapping whose source-title numerals differ from its game title's */
  mismatched: NumeralMismatchedMapping[];
  /** rows actually demoted to needs_review (always 0 on a dry run) */
  demoted: number;
  /** stale price_points / fetch markers of the demoted (and any other needs_review) mappings */
  invalidation: StaleCacheInvalidation;
}

/** Cleaned title, so platform words like "N64"/"PS2" never read as numerals. */
export function isNumeralMismatched(sourceTitle: string, game: NumeralGame): boolean {
  return !numeralCompatible(cleanTitle(sourceTitle), game);
}

export async function findNumeralMismatchedMappings(
  db: Db,
  source: SourceId,
): Promise<{ scanned: number; mismatched: NumeralMismatchedMapping[] }> {
  const rows = await db
    .select({
      mappingId: sourceMappings.id,
      gameId: games.id,
      gameTitle: games.title,
      platform: games.platform,
      year: games.year,
      names: sql<string[]>`array_remove(array_agg(${gameNames.name}), NULL)`,
      sourceProductId: sourceMappings.sourceProductId,
      sourceTitle: sourceMappings.sourceTitle,
      matchScore: sourceMappings.matchScore,
    })
    .from(sourceMappings)
    .innerJoin(games, eq(games.id, sourceMappings.gameId))
    .leftJoin(gameNames, eq(gameNames.gameId, games.id))
    .where(and(eq(sourceMappings.source, source), eq(sourceMappings.status, "confirmed")))
    .groupBy(sourceMappings.id, games.id)
    .orderBy(games.title, sourceMappings.sourceTitle);
  const mismatched = rows
    .filter((r) =>
      isNumeralMismatched(r.sourceTitle, {
        primaryTitle: r.gameTitle,
        names: r.names,
        year: r.year,
        platform: r.platform,
      }),
    )
    .map(({ year: _year, names: _names, ...row }) => row);
  return { scanned: rows.length, mismatched };
}

type StaleRow = { id: number; gameId: number; gameTitle: string; platform: string };

/**
 * price_points rows a needs_review (or about-to-be-demoted) mapping attributed
 * to its own game: stale by definition, since pricing writes only through
 * confirmed mappings. Covering every needs_review mapping keeps it idempotent
 * and self-healing after an interrupted run.
 */
async function findStalePricePoints(
  db: Db,
  source: SourceId,
  aboutToDemote: number[],
): Promise<StaleRow[]> {
  const demoteIds = aboutToDemote.length > 0 ? aboutToDemote : [-1];
  const res = await db.execute<StaleRow>(sql`
    SELECT DISTINCT pp.id, pp.game_id AS "gameId", g.title AS "gameTitle", g.platform
    FROM price_points pp
    JOIN source_mappings sm
      ON sm.source = pp.source
     AND sm.game_id = pp.game_id
     AND (sm.status = 'needs_review' OR sm.id IN ${demoteIds})
     AND pp.source_product_id = sm.source_product_id
    JOIN games g ON g.id = pp.game_id
    WHERE pp.source = ${source}
    ORDER BY pp.id
  `);
  return res.rows;
}

function groupStale(rows: StaleRow[]): StaleGame[] {
  const byGame = new Map<number, StaleGame>();
  for (const row of rows) {
    const entry = byGame.get(row.gameId) ?? { gameId: row.gameId, gameTitle: row.gameTitle, platform: row.platform, pricePoints: 0 };
    entry.pricePoints += 1;
    byGame.set(row.gameId, entry);
  }
  return [...byGame.values()].sort((a, b) => a.gameTitle.localeCompare(b.gameTitle));
}

/** A fetch marker set to the epoch: the next view sees it as stale and refetches (deleting it would not — the TTL check falls back to price_points.fetched_at). */
const EXPIRED = new Date(0);

/**
 * Demotes every numeral-mismatched confirmed mapping of `source`, deletes the
 * stale price_points they poisoned and expires the affected fetch markers so
 * the next view refetches. Idempotent. `dryRun` reports without writing.
 * Stale points are joined on price_points.source_product_id, so this works
 * for every source.
 */
export async function demoteNumeralMismatchedMappings(
  db: Db,
  opts: { source: SourceId; dryRun: boolean },
): Promise<NumeralMismatchSweepResult> {
  const { scanned, mismatched } = await findNumeralMismatchedMappings(db, opts.source);
  const ids = mismatched.map((m) => m.mappingId);
  const stale = await findStalePricePoints(db, opts.source, ids);
  const invalidation: StaleCacheInvalidation = {
    supported: true,
    stalePricePoints: stale.length,
    pricePointsDeleted: 0,
    fetchMarkersExpired: 0,
    games: groupStale(stale),
  };
  if (opts.dryRun) return { scanned, mismatched, demoted: 0, invalidation };

  let demoted = 0;
  if (ids.length > 0) {
    const updated = await db
      .update(sourceMappings)
      .set({ status: "needs_review" })
      .where(and(inArray(sourceMappings.id, ids), eq(sourceMappings.status, "confirmed")))
      .returning({ id: sourceMappings.id });
    demoted = updated.length;
  }
  if (stale.length > 0) {
    const deleted = await db
      .delete(pricePoints)
      .where(inArray(pricePoints.id, stale.map((r) => r.id)))
      .returning({ id: pricePoints.id });
    invalidation.pricePointsDeleted = deleted.length;
    // upsert: a game without a marker would otherwise still read as fresh
    for (const game of invalidation.games) {
      await db
        .insert(sourceFetches)
        .values({ gameId: game.gameId, source: opts.source, fetchedAt: EXPIRED })
        .onConflictDoUpdate({
          target: [sourceFetches.gameId, sourceFetches.source],
          set: { fetchedAt: EXPIRED },
        });
      invalidation.fetchMarkersExpired += 1;
    }
  }
  return { scanned, mismatched, demoted, invalidation };
}
