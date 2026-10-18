import type { GameSummary, PcImportCandidate, Platform } from "@retrowatchdog/shared";
import type { Db } from "../db/index.js";
import type { IgdbClient } from "../catalog/igdb.js";
import { localSearch } from "../routes/search.js";
import { importFromIgdb } from "../catalog/importer.js";
import { config } from "../config.js";
import { numeralTokens, numeralSetsEqual } from "../matching/numerals.js";

/**
 * Fuzzy title matching shared by the PriceCharting and CSV importers. One
 * matcher instance per request so the per-title caches cover the import.
 */

// Auto-import needs an exact name hit: fuzzy scores collapsed distinct games
// onto wrong siblings ("Monster Hunter X" -> "Monster Hunter 4 Ultimate").
export const EXACT_MATCH_SCORE = 0.999;

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

type SearchHit = GameSummary & { score: number };

interface ScoredCandidate {
  game: GameSummary;
  /** raw score after the numeral-mismatch cap, the score everything ranks by */
  effectiveScore: number;
  numeralMismatch: boolean;
}

export interface TitleMatch {
  matchStatus: "matched" | "review" | "unmatched";
  /** effective score of the top candidate; only set for matched/review */
  matchScore: number | null;
  game: GameSummary | null;
  /** matched: just the winner; review: top 5 options; unmatched: empty */
  candidates: PcImportCandidate[];
}

export interface TitleMatcherDeps {
  db: Db;
  igdb: IgdbClient;
}

export interface TitleMatcher {
  match(title: string, platform: Platform): Promise<TitleMatch>;
}

export function createTitleMatcher(deps: TitleMatcherDeps): TitleMatcher {
  const { db, igdb } = deps;
  // imports repeat titles (regional variants): one search per distinct title and console
  const candidateCache = new Map<string, SearchHit[]>();
  // ...and one enrichment attempt per distinct title, even when it throws
  const enrichedTitles = new Set<string>();

  const searchTitle = async (query: string, platform: Platform): Promise<SearchHit[]> => {
    const key = `${platform}|${query}`;
    const cached = candidateCache.get(key);
    if (cached) return cached;
    const results = await localSearch(db, query, platform);
    candidateCache.set(key, results);
    return results;
  };

  const match = async (title: string, platform: Platform): Promise<TitleMatch> => {
    const query = title.toLowerCase();
    const rowNumerals = numeralTokens(title);
    const scoreCandidates = (results: SearchHit[]): ScoredCandidate[] =>
      results
        .filter((c) => c.platform === platform)
        .map((c) => {
          // Primary title only: an alternate-name hit may take a false
          // penalty, which fails safe (the row drops to review).
          const numeralMismatch = !numeralSetsEqual(rowNumerals, numeralTokens(c.title));
          // never auto-matches, stays review-eligible
          const effectiveScore = numeralMismatch
            ? Math.min(c.score, config.PC_IMPORT_MATCH_THRESHOLD - 0.01)
            : c.score;
          return {
            game: { id: c.id, title: c.title, platform: c.platform, year: c.year, coverUrl: c.coverUrl },
            effectiveScore,
            numeralMismatch,
          };
        })
        .sort((a, b) => b.effectiveScore - a.effectiveScore);
    const hasExact = (list: ScoredCandidate[]): boolean =>
      list.length > 0 && list[0].effectiveScore >= EXACT_MATCH_SCORE && !list[0].numeralMismatch;

    let candidates = scoreCandidates(await searchTitle(query, platform));
    if (!hasExact(candidates) && igdb.isConfigured() && !enrichedTitles.has(query)) {
      // Best-effort: IGDB down must never fail the import. Runs on ANY
      // non-exact result, so a wrong sibling at 0.72 cannot block the real one.
      enrichedTitles.add(query);
      try {
        await importFromIgdb(db, igdb, query);
        candidateCache.delete(`${platform}|${query}`);
        candidates = scoreCandidates(await searchTitle(query, platform));
      } catch {
        // keep the local-only result
      }
    }

    const top = candidates[0];
    const matched =
      top !== undefined && top.effectiveScore >= EXACT_MATCH_SCORE && !top.numeralMismatch;
    const review =
      !matched && top !== undefined && top.effectiveScore >= config.PC_IMPORT_REVIEW_THRESHOLD;
    const toDto = (c: ScoredCandidate): PcImportCandidate => ({
      game: c.game,
      score: round3(c.effectiveScore),
      numeralMismatch: c.numeralMismatch,
    });
    const candidateDtos = matched
      ? [toDto(top)]
      : candidates
          .filter((c) => c.effectiveScore >= config.PC_IMPORT_REVIEW_THRESHOLD)
          .slice(0, 5)
          .map(toDto);
    return {
      matchStatus: matched ? "matched" : review ? "review" : "unmatched",
      matchScore: matched || review ? round3(top.effectiveScore) : null,
      game: matched || review ? top.game : null,
      candidates: candidateDtos,
    };
  };

  return { match };
}
