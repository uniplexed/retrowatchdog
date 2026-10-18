import { and, eq, sql } from "drizzle-orm";
import pino from "pino";
import type { Platform, SourceId } from "@retrowatchdog/shared";
import type { Db } from "../db/index.js";
import { sourceMappings } from "../db/schema.js";
import { config } from "../config.js";
import type { NormalizedListing } from "../adapters/types.js";
import { numeralCompatible, type NumeralGame } from "./numerals.js";
import { cleanTitle } from "./cleanTitle.js";
import { foreignTitleWord } from "./foreignWords.js";

/**
 * SQL twin of cleanTitle's diacritic fold ("Pokémon" vs "Pokemon"). These are
 * translate() maps and MUST stay the same length.
 */
const FOLD_FROM = "àáâãäåèéêëìíîïòóôõöùúûüýÿñçāēīōū";
const FOLD_TO = "aaaaaaeeeeiiiiooooouuuuyyncaeiou";

/** Above this score a foreign word is trusted to be a subtitle, not another game. */
const FOREIGN_WORD_CEILING = 0.75;

const log = pino({ level: process.env.LOG_LEVEL ?? "warn" });

export interface Candidate {
  gameId: number;
  /** the game_names row that scored best (primary or alternative name) */
  name: string;
  platform: Platform;
  year: number | null;
  /** effective score: trigram similarity (+ year bonus), numeral-mismatch capped */
  score: number;
  /** the listing's numerals differ from the game title's ({} vs {"2"}, {"6"} vs {}) */
  numeralMismatch: boolean;
}

export interface ResolvedMapping {
  gameId: number;
  score: number;
  status: "confirmed" | "needs_review";
}

// type alias, NOT interface: drizzle's execute<T> needs an implicit index
// signature, which interfaces lack (TS2344 under strict otherwise)
type CandidateRow = {
  gameId: number;
  name: string;
  gameTitle: string;
  platform: Platform;
  year: number | null;
  sim: number;
};

/**
 * A numeral-mismatched candidate is capped just under the confirm threshold:
 * it may become needs_review, never confirmed (confirmed mappings are reused
 * forever). The scoring name is passed too, so a regional retitle confirms
 * through its own name.
 */
export function capNumeralMismatch(
  score: number,
  cleanedListingTitle: string,
  game: NumeralGame,
): Pick<Candidate, "score" | "numeralMismatch"> {
  const numeralMismatch = !numeralCompatible(cleanedListingTitle, game);
  return {
    score: numeralMismatch ? Math.min(score, config.MATCH_CONFIRM_THRESHOLD - 0.01) : score,
    numeralMismatch,
  };
}

export async function findGameCandidates(
  db: Db,
  cleanedTitle: string,
  platform: Platform | null,
): Promise<Candidate[]> {
  const rows = await db.transaction(async (tx) => {
    // Lower the trgm gate so the GIN index still prunes but recall stays high;
    // real filtering happens on the composite score + config thresholds.
    await tx.execute(sql`SET LOCAL pg_trgm.similarity_threshold = 0.2`);
    // HARD platform filter: a cross-platform match must be impossible, not
    // penalized. The trgm gate uses the raw name (GIN index); the score folds.
    const res = await tx.execute<CandidateRow>(sql`
      SELECT gn.game_id AS "gameId", gn.name, g.title AS "gameTitle", g.platform, g.year,
             similarity(translate(lower(gn.name), ${FOLD_FROM}, ${FOLD_TO}), ${cleanedTitle}) AS sim
      FROM game_names gn
      JOIN games g ON g.id = gn.game_id
      WHERE gn.name % ${cleanedTitle}
        AND (${platform ?? null}::text IS NULL OR g.platform = ${platform ?? null})
      ORDER BY sim DESC
      LIMIT 25
    `);
    return res.rows;
  });

  const yearToken = cleanedTitle.match(/\b(19[89]\d|200\d)\b/)?.[1];
  const byGame = new Map<number, Candidate>();
  for (const row of rows) {
    let score = Number(row.sim);
    if (yearToken && row.year === Number(yearToken)) score += 0.05;
    score = Math.min(1, score);
    // cap AFTER the year bonus so no bonus lifts a mismatch back over
    const capped = capNumeralMismatch(score, cleanedTitle, {
      primaryTitle: row.gameTitle,
      names: [row.name],
      year: row.year,
      platform: row.platform,
    });
    // ponytail: a band, not a proof. Measured 2026-09-19 over every confirmed
    // mapping: real foreign-title errors scored 0.60-0.70, and flags at 0.75+
    // were mostly legitimate subtitles and romanisations.
    if (score < FOREIGN_WORD_CEILING && foreignTitleWord(cleanedTitle, cleanTitle(row.name)) !== null) {
      capped.score = Math.min(capped.score, config.MATCH_CONFIRM_THRESHOLD - 0.01);
    }
    const existing = byGame.get(row.gameId);
    if (!existing || existing.score < capped.score) {
      byGame.set(row.gameId, {
        gameId: row.gameId,
        name: row.name,
        platform: row.platform,
        year: row.year,
        score: capped.score,
        numeralMismatch: capped.numeralMismatch,
      });
    }
  }
  return [...byGame.values()].sort((a, b) => b.score - a.score);
}

export async function resolveListing(
  db: Db,
  source: SourceId,
  listing: NormalizedListing,
): Promise<ResolvedMapping | null> {
  const [existing] = await db
    .select()
    .from(sourceMappings)
    .where(
      and(
        eq(sourceMappings.source, source),
        eq(sourceMappings.sourceProductId, listing.sourceProductId),
      ),
    );
  // Confirmed mappings are sticky: reused forever, never re-scored.
  if (existing?.status === "confirmed") {
    return { gameId: existing.gameId, score: existing.matchScore, status: "confirmed" };
  }

  const candidates = await findGameCandidates(db, listing.cleanTitle, listing.platformGuess);
  const best = candidates[0];

  if (existing) {
    // needs_review is NOT sticky: the right game may have entered the catalog
    // since, so it flips to confirmed in place once a candidate clears the bar.
    if (best && best.score >= config.MATCH_CONFIRM_THRESHOLD) {
      await db
        .update(sourceMappings)
        .set({ gameId: best.gameId, matchScore: best.score, status: "confirmed" })
        .where(eq(sourceMappings.id, existing.id));
      log.debug(
        { source, title: listing.title, from: existing.gameId, to: best.gameId, score: best.score },
        "needs_review mapping re-resolved to confirmed",
      );
      return { gameId: best.gameId, score: best.score, status: "confirmed" };
    }
    return { gameId: existing.gameId, score: existing.matchScore, status: "needs_review" };
  }

  if (!best || best.score < config.MATCH_REVIEW_THRESHOLD) {
    log.debug(
      { source, title: listing.title, cleanTitle: listing.cleanTitle, bestScore: best?.score ?? null },
      "listing dropped: no candidate above review threshold",
    );
    return null;
  }

  const status = best.score >= config.MATCH_CONFIRM_THRESHOLD ? "confirmed" : "needs_review";
  await db
    .insert(sourceMappings)
    .values({
      gameId: best.gameId,
      source,
      sourceProductId: listing.sourceProductId,
      sourceTitle: listing.title,
      matchScore: best.score,
      status,
    })
    .onConflictDoNothing();
  return { gameId: best.gameId, score: best.score, status };
}
