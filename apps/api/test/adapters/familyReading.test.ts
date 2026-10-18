import { describe, expect, it } from "vitest";
import type { Platform } from "@retrowatchdog/shared";
import { detectPlatformFromCategory, familyCategoryHints } from "../../src/adapters/familyReading.js";

/**
 * The app's reading of CeX's category vocabulary, and the only protection it
 * has against hint drift.
 *
 * Both golden tables below were the deleted CeX adapter's own tests
 * (`categoryHints.test.ts`, `countryCategories.test.ts`) and are recovered here
 * unchanged, because the reading did NOT move when CeX became a plugin: the app
 * classifies every row and a plugin may not send a platform, so
 * `PLATFORMS[p].cexCategoryHints` and the detection order that resolves them
 * are still app-side (spec R12, adapters/familyReading.ts). What DID move is
 * the lists — which categories are swept is the plugin's business now
 * (retrowatchdog-cex-plugin/src/config.ts), pinned against the same live fixture on
 * that side.
 *
 * Every expected column is hand-derived, never computed from the tables under
 * test: deriving it from `cexCategoryHints` or `DETECTION_ORDER` would make a
 * protective test unable to fail.
 */

type CexSourceId = "cex" | "cex_es" | "cex_ie";
const CEX_SOURCES: readonly CexSourceId[] = ["cex", "cex_es", "cex_ie"];

const FIXTURE_CATEGORIES: ReadonlyArray<{
  platform: Platform;
  cex: readonly string[];
  cex_es: readonly string[];
  cex_ie: readonly string[];
}> = [
  { platform: "nes", cex: ["NES Software"], cex_es: ["NES Juegos"], cex_ie: ["NES Software"] },
  { platform: "snes", cex: ["Super NES Software"], cex_es: ["Super NES Juegos"], cex_ie: ["Super NES Software"] },
  { platform: "n64", cex: ["Nintendo 64 Software"], cex_es: ["Nintendo 64 Juegos"], cex_ie: ["Nintendo 64 Software"] },
  { platform: "gb", cex: ["Game Boy Software"], cex_es: ["Game Boy Juegos"], cex_ie: ["Game Boy Software"] },
  { platform: "gbc", cex: ["Game Boy Color Software"], cex_es: ["Game Boy Color Juegos"], cex_ie: ["Game Boy Color Software"] },
  { platform: "gba", cex: ["Gameboy Advance Software"], cex_es: ["GBA Juegos"], cex_ie: ["Gameboy Advance Software"] },
  // two categories in the UK and Ireland, one in Spain: the sync takes both
  // where they exist (fixture, "what this establishes" point 4)
  { platform: "gamecube", cex: ["GameCube Games", "GameCube Rarities"], cex_es: ["Gamecube Juegos"], cex_ie: ["GameCube Games", "GameCube Rarities"] },
  { platform: "ds", cex: ["Nintendo DS Games"], cex_es: ["DS Juegos"], cex_ie: ["Nintendo DS Games"] },
  { platform: "3ds", cex: ["3DS Games"], cex_es: ["3DS Juegos"], cex_ie: ["3DS Games"] },
  { platform: "megadrive", cex: ["Mega Drive Software"], cex_es: ["Mega Drive Juegos"], cex_ie: ["Mega Drive Software"] },
  { platform: "master_system", cex: ["Master System Software"], cex_es: ["Master System Juegos"], cex_ie: ["Master System Software"] },
  { platform: "game_gear", cex: ["Game Gear Games"], cex_es: ["Game Gear Juegos"], cex_ie: ["Game Gear Software"] },
  { platform: "saturn", cex: ["Sega Saturn Games"], cex_es: ["Sega Saturn Juegos"], cex_ie: ["Sega Saturn Software"] },
  { platform: "dreamcast", cex: ["Dreamcast Games"], cex_es: ["Dreamcast Juegos"], cex_ie: ["Dreamcast Software"] },
  { platform: "ps1", cex: ["Playstation1 Games"], cex_es: ["PS1 Juegos"], cex_ie: ["Playstation1 Software"] },
  { platform: "ps2", cex: ["Playstation2 Games"], cex_es: ["Playstation2 Juegos"], cex_ie: ["Playstation2 Games"] },
  { platform: "virtual_boy", cex: ["Virtual Boy Software"], cex_es: [], cex_ie: [] },
  { platform: "neogeo_pocket_color", cex: ["Neo Geo Pocket Color Software"], cex_es: [], cex_ie: [] },
  // live facet query 2026-10-18; the UK's "PC CD-ROM" holds the older discs
  { platform: "pc", cex: ["PC Games", "PC CD-ROM"], cex_es: ["PC Juegos"], cex_ie: ["PC Games"] },
];


const REAL_CEX_CATEGORIES: Array<[category: string, expected: string | null]> = [
  ["Super NES Software", "snes"],
  ["Game Boy Software", "gb"],
  ["Game Boy Color Software", "gbc"],
  ["Mega Drive Software", "megadrive"],
  ["Playstation1 Games", "ps1"],
  ["NES Software", "nes"],
  ["Nintendo 64 Software", "n64"],
  ["GameCube Games", "gamecube"],
  // the UK's second GameCube category (183 live boxes), added to the sync
  // list 2026-09-03; countryCategories.test.ts holds the per-country table
  ["GameCube Rarities", "gamecube"],
  ["Gameboy Advance Software", "gba"],
  ["Master System Software", "master_system"],
  ["Game Gear Games", "game_gear"],
  ["Sega Saturn Games", "saturn"],
  ["Dreamcast Games", "dreamcast"],
  ["Playstation2 Games", "ps2"],
  ["Neo Geo Pocket Color Software", "neogeo_pocket_color"],
  ["Nintendo DS Games", "ds"],
  ["3DS Games", "3ds"],
  ["Virtual Boy Software", "virtual_boy"],
  ["Game & Watch", "game_and_watch"],
  ["PC Games", "pc"],
  ["PC CD-ROM", "pc"],
  ["PC Juegos", "pc"],
  // swept by nobody, and must not read as a game either way
  ["PC Accessories", null],
  ["Handheld Gaming PCs", null],
];

describe("detectPlatformFromCategory against every real CeX sync category", () => {
  it.each(REAL_CEX_CATEGORIES)("%s -> %s", (category, expected) => {
    expect(detectPlatformFromCategory(category)).toBe(expected);
  });

  it("never confuses the DS and 3DS categories with each other", () => {
    // "3DS" has no internal word boundary, so ds's "nintendo ds" hint can't
    // fire on it — and 3ds's "3ds" hint has nothing to match in the DS text.
    expect(detectPlatformFromCategory("3DS Games")).not.toBe("ds");
    expect(detectPlatformFromCategory("Nintendo DS Games")).not.toBe("3ds");
  });

  it("does not map the unsynced digital 'DS Ware' category to ds by category text alone", () => {
    // "DS Ware" holds digital DSiWare/eShop titles (mixed DS/3DS) and is
    // deliberately absent from DEFAULT_CEX_CATEGORIES; documenting the
    // detector's view of it here. The standalone "ds" word is only a
    // titleKeyword, not a cexCategoryHint, so the category resolves to null.
    expect(detectPlatformFromCategory("DS Ware")).toBeNull();
  });
});
describe("detectPlatformFromCategory over every country's live facet strings", () => {
  const rows = FIXTURE_CATEGORIES.flatMap((row) =>
    CEX_SOURCES.flatMap((source) =>
      row[source].map((category) => [source, category, row.platform] as const),
    ),
  );

  it.each(rows)("%s: %s -> %s", (_source, category, platform) => {
    expect(detectPlatformFromCategory(category)).toBe(platform);
  });

  it("does not read Spain's DS category as a 3DS one", () => {
    // "DS Juegos" is ds's own per-country hint; 3ds runs first in
    // DETECTION_ORDER and its "3ds" hint has nothing to match here.
    expect(detectPlatformFromCategory("DS Juegos")).toBe("ds");
    expect(detectPlatformFromCategory("DS Juegos")).not.toBe("3ds");
    expect(detectPlatformFromCategory("3DS Juegos")).not.toBe("ds");
  });

  it("does not read Spain's Game Boy category as a Game Boy Color one", () => {
    // gbc's hints are the generic words "color"/"colour" and gbc runs BEFORE
    // gb, so a Spanish Game Boy category is only safe while it carries
    // neither word — the trap the UK's "Game Boy Software" has always had.
    expect(detectPlatformFromCategory("Game Boy Juegos")).toBe("gb");
    expect(detectPlatformFromCategory("Game Boy Juegos")).not.toBe("gbc");
    expect(detectPlatformFromCategory("Game Boy Color Juegos")).toBe("gbc");
  });

  it("reads both GameCube spellings and the Rarities category as gamecube", () => {
    // Spain writes "Gamecube" with a lowercase c where the UK and Ireland
    // write "GameCube"; the UK and Ireland carry a second "Rarities"
    // category. All three are the same console.
    expect(detectPlatformFromCategory("GameCube Rarities")).toBe("gamecube");
    expect(detectPlatformFromCategory("Gamecube Juegos")).toBe("gamecube");
    expect(detectPlatformFromCategory("GameCube Games")).toBe("gamecube");
  });
});

describe("familyCategoryHints selects the reading by family", () => {
  it("gives the CeX family its measured words and every other family none", () => {
    // The R12 decision, at the one place that DROPS rows: these words are facts
    // about CeX's shelves, and another shop's shelves are its own vocabulary.
    expect(familyCategoryHints("cex", "snes")).toContain("super nes");
    expect(familyCategoryHints("boutique", "snes")).toEqual([]);
    expect(familyCategoryHints("ebay", "snes")).toEqual([]);
  });

  it("agrees with the detector about every category it narrows by", () => {
    // One vocabulary, two readers: a hint that narrows a catalogue search must
    // be one the classifier reads the same way, or the price table and the
    // search behind it would disagree about what a category means.
    for (const [category, expected] of REAL_CEX_CATEGORIES) {
      if (expected === null) continue;
      const hints = familyCategoryHints("cex", expected as Platform);
      expect(hints.some((hint) => category.toLowerCase().includes(hint))).toBe(true);
    }
  });
});
