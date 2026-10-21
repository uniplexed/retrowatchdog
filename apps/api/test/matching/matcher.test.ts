import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type pg from "pg";
import { setupTestDb } from "../helpers/testDb.js";
import type { Db } from "../../src/db/index.js";
import { eq } from "drizzle-orm";
import { games, gameNames, sourceMappings } from "../../src/db/schema.js";
import { capNumeralMismatch, findGameCandidates, resolveListing } from "../../src/matching/matcher.js";
import { cleanTitle } from "../../src/matching/cleanTitle.js";
import type { NumeralGame } from "../../src/matching/numerals.js";
import { findNumeralMismatchedMappings, isNumeralMismatched } from "../../src/matching/reviewNumeralMismatches.js";
import type { NormalizedListing } from "../../src/adapters/types.js";
import { classifyCatalogListing, classifyListing } from "../../src/adapters/classifyListing.js";
import type { RawListing } from "../../src/adapters/types.js";
import { config } from "../../src/config.js";

/**
 * What the deleted `normalizeCexListing` was: the shared catalogue reading with
 * CeX's own declared region. The CeX shops declare PAL in the plugin manifest.
 */
const normalizeCexListing = (raw: RawListing): NormalizedListing =>
  classifyCatalogListing(raw, "PAL");


async function seedGame(db: Db, title: string, platform: string, igdbId: number): Promise<number> {
  const [g] = await db.insert(games).values({ igdbId, title, platform }).returning({ id: games.id });
  await db.insert(gameNames).values({ gameId: g.id, name: title });
  return g.id;
}

async function seedCatalog(db: Db): Promise<{ zeldaId: number; panzerId: number }> {
  const [zelda] = await db
    .insert(games)
    .values({ igdbId: 1029, title: "The Legend of Zelda: Ocarina of Time", platform: "n64", year: 1998 })
    .returning({ id: games.id });
  const [majora] = await db
    .insert(games)
    .values({ igdbId: 1030, title: "The Legend of Zelda: Majora's Mask", platform: "n64", year: 2000 })
    .returning({ id: games.id });
  const [panzer] = await db
    .insert(games)
    .values({ igdbId: 1671, title: "Panzer Dragoon Saga", platform: "saturn", year: 1998 })
    .returning({ id: games.id });
  await db.insert(gameNames).values([
    { gameId: zelda.id, name: "The Legend of Zelda: Ocarina of Time" },
    { gameId: zelda.id, name: "Zelda no Densetsu: Toki no Ocarina" },
    { gameId: majora.id, name: "The Legend of Zelda: Majora's Mask" },
    { gameId: panzer.id, name: "Panzer Dragoon Saga" },
    { gameId: panzer.id, name: "Azel Panzer Dragoon RPG" },
  ]);
  return { zeldaId: zelda.id, panzerId: panzer.id };
}

const cexListing = (title: string, category: string): RawListing => ({
  sourceProductId: `box-${title.slice(0, 12)}`,
  title,
  categoryText: category,
  url: null,
  prices: [{ kind: "sell", amount: 30, currency: "GBP" }],
});

describe("matching", () => {
  let db: Db;
  let pool: pg.Pool;
  let truncateAll: () => Promise<void>;
  let seeded: { zeldaId: number; panzerId: number };

  beforeAll(async () => {
    ({ db, pool, truncateAll } = await setupTestDb());
  });
  beforeEach(async () => {
    await truncateAll();
    seeded = await seedCatalog(db);
  });
  afterAll(async () => await pool.end());

  it("ranks the right game first within the detected platform", async () => {
    const candidates = await findGameCandidates(db, "legend of zelda ocarina of time", "n64");
    expect(candidates[0].gameId).toBe(seeded.zeldaId);
    expect(candidates[0].score).toBeGreaterThan(0.6);
  });

  it("never returns cross-platform candidates when the platform is known", async () => {
    // exact title, wrong platform: must yield NOTHING (a confirmed mapping is forever)
    const candidates = await findGameCandidates(db, "panzer dragoon saga", "snes");
    expect(candidates).toHaveLength(0);
  });

  it("matches without a platform filter when the platform is unknown", async () => {
    const candidates = await findGameCandidates(db, "panzer dragoon saga", null);
    expect(candidates[0].gameId).toBe(seeded.panzerId);
    expect(candidates[0].score).toBeGreaterThan(0.6);
  });

  it("matches via IGDB alternative names (Azel -> Panzer Dragoon Saga)", async () => {
    const listing = normalizeCexListing(
      cexListing("Azel Panzer Dragoon RPG (JAP), Boxed", "Sega Saturn Games"),
    );
    const resolved = await resolveListing(db, "cex", listing);
    expect(resolved?.gameId).toBe(seeded.panzerId);
    expect(resolved?.status).toBe("confirmed");
  });

  it("returns null and persists nothing for garbage titles", async () => {
    const listing = normalizeCexListing(
      cexListing("Memory Card 256KB Third Party, Unboxed", "Nintendo N64 Games"),
    );
    const resolved = await resolveListing(db, "cex", listing);
    expect(resolved).toBeNull();
    expect(await db.select().from(sourceMappings)).toHaveLength(0);
  });

  it("reuses a persisted mapping on the second call instead of re-resolving", async () => {
    const listing = normalizeCexListing(
      cexListing("Legend Of Zelda Ocarina Of Time, Boxed", "Nintendo N64 Games"),
    );
    const first = await resolveListing(db, "cex", listing);
    expect(first?.gameId).toBe(seeded.zeldaId);
    const mappingsAfterFirst = await db.select().from(sourceMappings);
    expect(mappingsAfterFirst).toHaveLength(1);
    // Structural proof of the short-circuit: wipe every game_names row (the FK
    // from source_mappings forbids deleting games themselves). With no names
    // left, a re-resolution via findGameCandidates would find nothing and
    // return null — so the second call only matches `first` if resolveListing
    // actually read the persisted mapping instead of re-resolving.
    await db.delete(gameNames);
    const second = await resolveListing(db, "cex", listing);
    expect(second).toEqual(first);
    expect(await db.select().from(sourceMappings)).toHaveLength(1);
  });
  it("a confirmed mapping on another console is re-resolved, not reused (PC copy stuck on the SNES game)", async () => {
    // Measured 2026-10-21: "SimCity PC Game" stayed on SimCity (SNES) because
    // it was confirmed before the PC platform existed. A title that now names
    // a console other than the mapped game's must not keep that mapping.
    const listing = classifyListing({ sourceProductId: "pc-oot", title: "Zelda Ocarina of Time PC Game", url: null, prices: [] });
    expect(listing.platformGuess).toBe("pc");
    await db.insert(sourceMappings).values({
      gameId: seeded.zeldaId, source: "vinted_uk", sourceProductId: "pc-oot",
      sourceTitle: listing.title, matchScore: 1, status: "confirmed",
    });
    // no PC Zelda in the catalogue: the listing belongs to no game
    expect(await resolveListing(db, "vinted_uk", listing)).toBeNull();
    expect(await db.select().from(sourceMappings).where(eq(sourceMappings.sourceProductId, "pc-oot"))).toEqual([]);
  });
});

/** a game whose only name is its primary title (the common case) */
const primary = (title: string): NumeralGame => ({ primaryTitle: title, names: [title] });

describe("capNumeralMismatch (pure)", () => {
  const cap = config.MATCH_CONFIRM_THRESHOLD - 0.01;

  it("caps a candidate whose numerals differ from the listing's just under the confirm threshold", () => {
    expect(capNumeralMismatch(0.9, "sonic the hedgehog", primary("Sonic the Hedgehog 2"))).toEqual({ score: cap, numeralMismatch: true });
    expect(capNumeralMismatch(0.62, "final fantasy vi 6 advance", primary("Final Fantasy Tactics Advance"))).toEqual({ score: cap, numeralMismatch: true });
    // the live sweep's other wrong siblings
    expect(capNumeralMismatch(0.9, "probotector", primary("Probotector 2")).score).toBe(cap);
    expect(capNumeralMismatch(0.9, "mega man", primary("Mega Man 4")).score).toBe(cap);
    expect(capNumeralMismatch(0.9, "sim city", primary("SimCity 2000")).score).toBe(cap);
  });

  it("never raises a score: a mismatch already under the cap keeps its own score", () => {
    expect(capNumeralMismatch(0.4, "sonic the hedgehog", primary("Sonic the Hedgehog 2"))).toEqual({ score: 0.4, numeralMismatch: true });
  });

  it("leaves numeral-agreeing candidates alone, roman and arabic being equal", () => {
    expect(capNumeralMismatch(0.9, "mega man iv", primary("Mega Man 4"))).toEqual({ score: 0.9, numeralMismatch: false });
    expect(capNumeralMismatch(0.9, "street fighter ii turbo", primary("Street Fighter II Turbo"))).toEqual({ score: 0.9, numeralMismatch: false });
    expect(capNumeralMismatch(0.72, "final fantasy tactics", primary("Final Fantasy Tactics Advance"))).toEqual({ score: 0.72, numeralMismatch: false });
  });

  it("lets the alternative name that scored carry the numerals (R2)", () => {
    expect(capNumeralMismatch(0.95, "super probotector alien rebels", {
      primaryTitle: "Contra III: The Alien Wars", names: ["Super Probotector: Alien Rebels"],
    })).toEqual({ score: 0.95, numeralMismatch: false });
  });
});

/**
 * The oscillation guard (integrity minor #2): whatever the matcher would
 * confirm, the sweep must not demote. Both sides go through
 * numeralCompatible; this pins that they agree on every fixture, raw title
 * on the sweep side and cleaned title on the matcher side, exactly as the
 * two call sites do.
 */
describe("matcher and sweep agree on numeral compatibility", () => {
  const fixtures: Array<{ title: string; game: NumeralGame; compatible: boolean }> = [
    { title: "Lylat Wars, Boxed", game: { primaryTitle: "Star Fox 64", names: ["Star Fox 64", "Lylat Wars"], platform: "n64" }, compatible: true },
    { title: "Super Probotector: Alien Rebels, Boxed", game: { primaryTitle: "Contra III: The Alien Wars", names: ["Contra III: The Alien Wars", "Super Probotector: Alien Rebels"], platform: "snes" }, compatible: true },
    { title: "Final Fantasy VI (6) Advance, w/ Manual, Boxed", game: { primaryTitle: "Final Fantasy Tactics Advance", names: ["Final Fantasy Tactics Advance"], platform: "gba" }, compatible: false },
    { title: "Sonic the Hedgehog, Unboxed", game: { primaryTitle: "Sonic the Hedgehog 2", names: ["Sonic the Hedgehog 2"], platform: "megadrive" }, compatible: false },
    { title: "Mega Man IV, Boxed", game: { primaryTitle: "Mega Man 4", names: ["Mega Man 4"], platform: "nes" }, compatible: true },
    { title: "Legend Of Zelda Ocarina Of Time (N64), Boxed", game: { primaryTitle: "The Legend of Zelda: Ocarina of Time", names: ["The Legend of Zelda: Ocarina of Time"], platform: "n64" }, compatible: true },
    { title: "Mario Kart N64 Nintendo 64 cart only", game: { primaryTitle: "Mario Kart 64", names: ["Mario Kart 64"], platform: "n64", year: 1996 }, compatible: true },
    { title: "Pokémon Red Version 1999 Nintendo Game Boy PAL", game: { primaryTitle: "Pokémon Red Version", names: ["Pokémon Red Version"], platform: "gb", year: 1996 }, compatible: true },
    { title: "SimCity 2000 SNES", game: { primaryTitle: "SimCity", names: ["SimCity"], platform: "snes", year: 1989 }, compatible: false },
  ];

  it.each(fixtures)("$title -> $game.primaryTitle: both say compatible=$compatible", ({ title, game, compatible }) => {
    const matcherSays = !capNumeralMismatch(0.9, cleanTitle(title), game).numeralMismatch;
    const sweepSays = !isNumeralMismatched(title, game);
    expect(matcherSays).toBe(compatible);
    expect(sweepSays).toBe(matcherSays);
  });
});

describe("alternative-name numerals (R2)", () => {
  let db: Db;
  let pool: pg.Pool;
  let truncateAll: () => Promise<void>;
  let starFoxId: number;
  let contraId: number;
  let fftaId: number;

  beforeAll(async () => {
    ({ db, pool, truncateAll } = await setupTestDb());
  });
  beforeEach(async () => {
    await truncateAll();
    starFoxId = await seedGame(db, "Star Fox 64", "n64", 3001);
    await db.insert(gameNames).values({ gameId: starFoxId, name: "Lylat Wars" });
    contraId = await seedGame(db, "Contra III: The Alien Wars", "snes", 3002);
    await db.insert(gameNames).values({ gameId: contraId, name: "Super Probotector: Alien Rebels" });
    fftaId = await seedGame(db, "Final Fantasy Tactics Advance", "gba", 3003);
  });
  afterAll(async () => await pool.end());

  it("'Lylat Wars, Boxed' confirms to Star Fox 64 through its alt name", async () => {
    const listing = normalizeCexListing(cexListing("Lylat Wars, Boxed", "Nintendo 64 Software"));
    const resolved = await resolveListing(db, "cex", listing);
    expect(resolved).toMatchObject({ gameId: starFoxId, status: "confirmed" });
  });

  it("'Super Probotector: Alien Rebels' confirms to Contra III through its alt name (the primary's III is not held against it)", async () => {
    const listing = normalizeCexListing(cexListing("Super Probotector: Alien Rebels, Boxed", "Super NES Software"));
    const candidates = await findGameCandidates(db, listing.cleanTitle, listing.platformGuess);
    expect(candidates[0]).toMatchObject({ gameId: contraId, numeralMismatch: false });
    const resolved = await resolveListing(db, "cex", listing);
    expect(resolved).toMatchObject({ gameId: contraId, status: "confirmed" });
  });

  it("FFTA: 'Final Fantasy VI (6) Advance' is still capped — no name of the game carries a 6", async () => {
    const listing = normalizeCexListing(cexListing("Final Fantasy VI (6) Advance, Mint", "Gameboy Advance Software"));
    const resolved = await resolveListing(db, "cex", listing);
    expect(resolved).toMatchObject({ gameId: fftaId, status: "needs_review" });
    expect(resolved?.score).toBeLessThan(config.MATCH_CONFIRM_THRESHOLD);
  });

  it("the sweep never demotes what the matcher just confirmed (no oscillation)", async () => {
    for (const [title, category] of [
      ["Lylat Wars, Boxed", "Nintendo 64 Software"],
      ["Super Probotector: Alien Rebels, Unboxed", "Super NES Software"],
    ] as const) {
      expect((await resolveListing(db, "cex", normalizeCexListing(cexListing(title, category))))?.status).toBe("confirmed");
    }
    const sweep = await findNumeralMismatchedMappings(db, "cex");
    expect(sweep.scanned).toBe(2);
    expect(sweep.mismatched).toEqual([]);
  });
});

describe("numeral-honest mappings", () => {
  let db: Db;
  let pool: pg.Pool;
  let truncateAll: () => Promise<void>;
  let fftaId: number;
  let sonic2Id: number;
  let megaMan4Id: number;

  beforeAll(async () => {
    ({ db, pool, truncateAll } = await setupTestDb());
  });
  beforeEach(async () => {
    await truncateAll();
    fftaId = await seedGame(db, "Final Fantasy Tactics Advance", "gba", 2001);
    sonic2Id = await seedGame(db, "Sonic the Hedgehog 2", "megadrive", 2002);
    megaMan4Id = await seedGame(db, "Mega Man 4", "nes", 2003);
  });
  afterAll(async () => await pool.end());

  it("FFTA: 'Final Fantasy VI (6) Advance' is capped to needs_review, 'Final Fantasy Tactics' confirms", async () => {
    // the measured defect: 13 of 17 CeX rows on the FFTA page were other
    // Final Fantasy Advance games confirmed by trigram similarity alone
    const wrong = normalizeCexListing(
      cexListing("Final Fantasy VI (6) Advance, w/ Manual, Boxed", "Gameboy Advance Software"),
    );
    const resolvedWrong = await resolveListing(db, "cex", wrong);
    expect(resolvedWrong?.gameId).toBe(fftaId);
    expect(resolvedWrong?.status).toBe("needs_review");
    expect(resolvedWrong?.score).toBeLessThan(config.MATCH_CONFIRM_THRESHOLD);

    const right = normalizeCexListing(
      cexListing("Final Fantasy Tactics, w/ Manual, Boxed", "Gameboy Advance Software"),
    );
    const resolvedRight = await resolveListing(db, "cex", right);
    expect(resolvedRight?.gameId).toBe(fftaId);
    expect(resolvedRight?.status).toBe("confirmed");
  });

  it("'Sonic the Hedgehog, Unboxed' vs the only catalogued 'Sonic the Hedgehog 2' is needs_review, never confirmed", async () => {
    const listing = normalizeCexListing(cexListing("Sonic the Hedgehog, Unboxed", "Mega Drive Software"));
    const candidates = await findGameCandidates(db, listing.cleanTitle, listing.platformGuess);
    expect(candidates[0].gameId).toBe(sonic2Id);
    expect(candidates[0].numeralMismatch).toBe(true);
    expect(candidates[0].score).toBeLessThan(config.MATCH_CONFIRM_THRESHOLD);
    const resolved = await resolveListing(db, "cex", listing);
    expect(resolved?.status).toBe("needs_review");
    const [row] = await db.select().from(sourceMappings);
    expect(row.status).toBe("needs_review");
    expect(row.gameId).toBe(sonic2Id);
  });

  it("'Mega Man IV' vs 'Mega Man 4' is NOT capped: roman and arabic numerals agree", async () => {
    const listing = normalizeCexListing(cexListing("Mega Man IV, Boxed", "NES Software"));
    const candidates = await findGameCandidates(db, listing.cleanTitle, listing.platformGuess);
    expect(candidates[0].gameId).toBe(megaMan4Id);
    expect(candidates[0].numeralMismatch).toBe(false);
    expect(candidates[0].score).toBeGreaterThanOrEqual(config.MATCH_REVIEW_THRESHOLD);
  });

  it("a needs_review mapping flips to confirmed once the right game enters the catalog", async () => {
    const listing = normalizeCexListing(cexListing("Sonic the Hedgehog, Unboxed", "Mega Drive Software"));
    const first = await resolveListing(db, "cex", listing);
    expect(first).toMatchObject({ gameId: sonic2Id, status: "needs_review" });

    // still nothing better: the row is left exactly as it is
    const again = await resolveListing(db, "cex", listing);
    expect(again).toEqual(first);
    expect(await db.select().from(sourceMappings)).toHaveLength(1);

    // the real game arrives (e.g. imported from IGDB by a later search)
    const sonic1Id = await seedGame(db, "Sonic the Hedgehog", "megadrive", 2004);
    const flipped = await resolveListing(db, "cex", listing);
    expect(flipped?.gameId).toBe(sonic1Id);
    expect(flipped?.status).toBe("confirmed");
    expect(flipped?.score).toBeGreaterThanOrEqual(config.MATCH_CONFIRM_THRESHOLD);
    // updated in place: one row, re-pointed, re-scored, confirmed
    const rows = await db.select().from(sourceMappings).where(eq(sourceMappings.sourceProductId, listing.sourceProductId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gameId: sonic1Id, status: "confirmed" });
    expect(rows[0].matchScore).toBeGreaterThanOrEqual(config.MATCH_CONFIRM_THRESHOLD);

    // ...and from then on it is sticky like any confirmed mapping
    await db.delete(gameNames);
    expect(await resolveListing(db, "cex", listing)).toEqual(flipped);
  });

  it("a confirmed mapping stays sticky even when its game later looks like a numeral sibling", async () => {
    // pre-existing confirmed rows are the sweep script's business, not the
    // matcher's: resolveListing never re-scores a confirmed mapping
    const listing = normalizeCexListing(cexListing("Sonic the Hedgehog, Unboxed", "Mega Drive Software"));
    await db.insert(sourceMappings).values({
      gameId: sonic2Id, source: "cex", sourceProductId: listing.sourceProductId,
      sourceTitle: listing.title, matchScore: 0.9, status: "confirmed",
    });
    expect(await resolveListing(db, "cex", listing)).toEqual({ gameId: sonic2Id, score: 0.9, status: "confirmed" });
  });
});
