import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { GameSummary, SearchResponse, Platform } from "@retrowatchdog/shared";
import type { Db } from "../db/index.js";
import { importFromIgdb } from "../catalog/importer.js";
import { config } from "../config.js";

// type alias, not interface: required by drizzle's execute<T> constraint
type LocalRow = {
  id: number;
  title: string;
  platform: Platform;
  year: number | null;
  coverUrl: string | null;
  score: number;
};

export async function localSearch(
  db: Db,
  query: string,
  /** filter before the LIMIT, so a crowded title on other consoles cannot hide this one */
  platform?: Platform,
): Promise<Array<GameSummary & { score: number }>> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL pg_trgm.similarity_threshold = 0.2`);
    const res = await tx.execute<LocalRow>(sql`
      SELECT g.id, g.title, g.platform, g.year, g.cover_url AS "coverUrl",
             MAX(similarity(gn.name, ${query})) AS score
      FROM game_names gn
      JOIN games g ON g.id = gn.game_id
      WHERE gn.name % ${query}
        ${platform === undefined ? sql`` : sql`AND g.platform = ${platform}`}
      GROUP BY g.id, g.title, g.platform, g.year, g.cover_url
      ORDER BY score DESC
      LIMIT 20
    `);
    return res.rows;
  });
  return rows.map((r) => ({ ...r, score: Number(r.score) }));
}

/** Lowercase alphanumerics only: "Out Run" and "OutRun" both become "outrun". */
function compactTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The shape needsEnrichment reads off a local search hit. */
export interface RelevanceCandidate {
  title: string;
  score: number;
}

/**
 * Enrich from IGDB unless an exact catalogued title is already present.
 * Similarity heuristics suppressed real misses ("castlevania" scores 0.857
 * against "Castlevania III"); enrichment is idempotent and TTL-capped.
 */
export function needsEnrichment(query: string, results: readonly RelevanceCandidate[]): boolean {
  const compactQuery = compactTitle(query);

  // Keystroke prefixes ("ki") must not import junk.
  if (compactQuery.length < config.MIN_ENRICH_QUERY_LENGTH) return false;

  // Thin results always enrich; that is how siblings ("Turbo OutRun") arrive.
  if (results.length < config.MIN_LOCAL_RESULTS) return true;
  if ((results[0]?.score ?? 0) < config.LOCAL_SCORE_FLOOR) return true;

  // A sibling can outrank the exact hit, so check every row.
  return !results.some((r) => compactTitle(r.title) === compactQuery);
}

/** How long a query stays "already asked of IGDB" after a usable answer. */
const ENRICH_CACHE_TTL_MS = 10 * 60_000;
/** ...and after a failed one: short, so an IGDB blip does not blank enrichment. */
const ENRICH_FAILURE_TTL_MS = 60_000;
/** Hard cap: a burst of distinct queries can outrun the expiry sweep. */
export const ENRICH_CACHE_MAX_ENTRIES = 500;

/** Normalized queries already sent to IGDB -> expiry; stops one import per keystroke. */
const enrichedQueries = new Map<string, number>();

export function resetSearchEnrichCacheForTests(): void {
  enrichedQueries.clear();
}

/** Entry count, for the bounded-growth test. */
export function enrichCacheSizeForTests(): number {
  return enrichedQueries.size;
}

/** Mark `query` as sent, sweeping expired entries and evicting down to the cap. */
export function markEnriched(query: string, ttlMs: number): void {
  const now = Date.now();
  for (const [key, expiresAt] of enrichedQueries) {
    if (expiresAt <= now) enrichedQueries.delete(key);
  }
  enrichedQueries.set(query, now + ttlMs);
  while (enrichedQueries.size > ENRICH_CACHE_MAX_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestExpiry = Number.POSITIVE_INFINITY;
    for (const [key, expiresAt] of enrichedQueries) {
      if (expiresAt < oldestExpiry) {
        oldestExpiry = expiresAt;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    enrichedQueries.delete(oldestKey);
  }
}

export function recentlyEnriched(query: string): boolean {
  const expiresAt = enrichedQueries.get(query);
  if (expiresAt === undefined) return false;
  if (expiresAt > Date.now()) return true;
  enrichedQueries.delete(query);
  return false;
}

const querySchema = z.object({ q: z.string().trim().min(2).max(200) });

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/search", async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "q must be at least 2 characters" });
    }
    const { db, igdb } = app.deps;
    const q = parsed.data.q.toLowerCase();

    let results = await localSearch(db, q);
    if (needsEnrichment(q, results) && igdb.isConfigured() && !recentlyEnriched(q)) {
      // Marked before the attempt so a miss caches too. IGDB is best-effort:
      // local results are served if it fails.
      markEnriched(q, ENRICH_CACHE_TTL_MS);
      try {
        await importFromIgdb(db, igdb, q);
        results = await localSearch(db, q);
      } catch (err) {
        markEnriched(q, ENRICH_FAILURE_TTL_MS);
        req.log.warn({ err, q }, "IGDB import failed; serving local search results only");
      }
    }
    const body: SearchResponse = {
      games: results.map(({ score: _score, ...game }) => game),
    };
    return body;
  });
}
