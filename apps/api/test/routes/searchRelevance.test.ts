import { beforeEach, describe, expect, it } from "vitest";
import {
  ENRICH_CACHE_MAX_ENTRIES,
  enrichCacheSizeForTests,
  markEnriched,
  needsEnrichment,
  recentlyEnriched,
  resetSearchEnrichCacheForTests,
  type RelevanceCandidate,
} from "../../src/routes/search.js";
import { config } from "../../src/config.js";

/**
 * Pure unit tests for the enrichment predicate and its cache — no database,
 * no IGDB. The route-level wiring lives in search.test.ts.
 */

/** A result set long enough that the thin-results clause never fires. */
function padded(...results: RelevanceCandidate[]): RelevanceCandidate[] {
  const lowest = Math.min(...results.map((r) => r.score));
  const filler: RelevanceCandidate[] = [];
  while (results.length + filler.length < config.MIN_LOCAL_RESULTS + 1) {
    filler.push({ title: `Filler ${filler.length}`, score: lowest / 2 });
  }
  return [...results, ...filler];
}

describe("needsEnrichment", () => {
  it("enriches when there are no local results at all", () => {
    expect(needsEnrichment("panzer dragoon saga", [])).toBe(true);
  });

  it("enriches when local results are thinner than MIN_LOCAL_RESULTS (clause 1)", () => {
    const results = Array.from({ length: config.MIN_LOCAL_RESULTS - 1 }, (_, i) => ({
      title: `Panzer Dragoon Sibling ${i}`,
      score: 0.8,
    }));
    expect(needsEnrichment("panzer dragoon", results)).toBe(true);
  });

  it("enriches on thin results even when one of them is the exact title", () => {
    // Ordering matters: the thin clauses are evaluated first and win, so an
    // exact hit does NOT suppress them. Desirable — it is how the siblings of
    // a lone catalogued game ("Turbo OutRun") ever get imported.
    expect(needsEnrichment("outrun", [{ title: "OutRun", score: 1 }])).toBe(true);
  });

  it("enriches when the top score is below LOCAL_SCORE_FLOOR (clause 2)", () => {
    const best = {
      title: "Panzer Dragoon Saga Deluxe Edition Collection",
      score: config.LOCAL_SCORE_FLOOR - 0.01,
    };
    expect(needsEnrichment("panzer dragoon", padded(best))).toBe(true);
  });

  it("suppresses enrichment only for a compact-identical catalogued title", () => {
    expect(needsEnrichment("out run", padded({ title: "OutRun", score: 0.5 }))).toBe(false);
    expect(needsEnrichment("outrun", padded({ title: "Out Run", score: 0.5 }))).toBe(false);
    const kof98 = padded({ title: "The King of Fighters '98", score: 0.9 });
    expect(needsEnrichment("the king of fighters 98", kof98)).toBe(false);
  });

  it("accepts an exact hit that is not the top-scoring row", () => {
    // A sibling can outrank the real thing on trigrams, so the clause looks
    // at the whole result set rather than results[0].
    const results = padded(
      { title: "Mario Kart 64", score: 0.786 },
      { title: "Super Mario Kart", score: 0.7 },
    );
    expect(needsEnrichment("super mario kart", results)).toBe(false);
  });

  it("enriches for a high-scoring sibling that is not the queried title", () => {
    // Both pairs are live-catalog measurements: under the deleted numeral and
    // token-coverage clauses neither query could ever reach IGDB, so the
    // catalog could never acquire the game actually being searched for.
    const castlevania = padded({ title: "Castlevania III: Dracula's Curse", score: 0.857 });
    expect(needsEnrichment("castlevania", castlevania)).toBe(true);
    const marioKart = padded({ title: "Mario Kart 64", score: 0.786 });
    expect(needsEnrichment("mario kart", marioKart)).toBe(true);
  });

  it("enriches an unnumbered query whose best hit is numbered", () => {
    // REVERSED on purpose. The earlier expectation (no enrichment, because a
    // query carrying no numerals cannot "mismatch" one) was wrong: "Sonic the
    // Hedgehog 2" being catalogued is no evidence at all that the original is,
    // and the original is exactly what this user is missing.
    const best = { title: "Sonic the Hedgehog 2", score: 0.7 };
    expect(needsEnrichment("sonic", padded(best))).toBe(true);
  });

  it("does not let a near-exact trigram score stand in for an exact title", () => {
    // Also reversed: 0.96 against "King of Fighters 97" is the sibling defect
    // in its narrowest form — a high score is not a catalogued title.
    expect(
      needsEnrichment("king of fighters 98", padded({ title: "King of Fighters 97", score: 0.96 })),
    ).toBe(true);
  });

  it("skips enrichment for queries below MIN_ENRICH_QUERY_LENGTH", () => {
    const short = "k".repeat(config.MIN_ENRICH_QUERY_LENGTH - 1);
    const long = "k".repeat(config.MIN_ENRICH_QUERY_LENGTH);
    // No local results at all: only the length guard can hold these back.
    expect(needsEnrichment(short, [])).toBe(false);
    expect(needsEnrichment(long, [])).toBe(true);
    // Length is measured after compacting, so separators do not pad a prefix
    // over the bar, while short REAL titles ("ico", "kof") do clear it — the
    // floor exists for keystroke prefixes, not to make short games unfindable.
    expect(needsEnrichment("k o", [])).toBe(false);
    expect(needsEnrichment("ico", [])).toBe(true);
    expect(needsEnrichment("kof 98", [])).toBe(true);
  });
});

describe("search enrichment cache", () => {
  beforeEach(() => resetSearchEnrichCacheForTests());

  it("sweeps expired entries on the next write", () => {
    markEnriched("stale", -1); // negative ttl: already expired when written
    expect(enrichCacheSizeForTests()).toBe(1);

    markEnriched("fresh", 60_000);
    expect(enrichCacheSizeForTests()).toBe(1);
    expect(recentlyEnriched("stale")).toBe(false);
    expect(recentlyEnriched("fresh")).toBe(true);
  });

  it("caps the map, evicting the entry closest to expiring", () => {
    // Strictly increasing ttls, so q0 is always the next to expire.
    for (let i = 0; i < ENRICH_CACHE_MAX_ENTRIES; i++) markEnriched(`q${i}`, 600_000 + i);
    expect(enrichCacheSizeForTests()).toBe(ENRICH_CACHE_MAX_ENTRIES);
    expect(recentlyEnriched("q0")).toBe(true);

    markEnriched("overflow", 600_000 + ENRICH_CACHE_MAX_ENTRIES);
    expect(enrichCacheSizeForTests()).toBe(ENRICH_CACHE_MAX_ENTRIES);
    expect(recentlyEnriched("q0")).toBe(false);
    expect(recentlyEnriched("q1")).toBe(true);
    expect(recentlyEnriched("overflow")).toBe(true);
  });
});
