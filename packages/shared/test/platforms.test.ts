import { describe, it, expect } from "vitest";
import { ALL_IGDB_PLATFORM_IDS, PLATFORMS, PLATFORM_IGDB_IDS } from "../src/index.js";

describe("platform map", () => {
  it("covers every platform with verified IGDB ids", () => {
    // 14 original + neogeo_aes + neogeo_pocket_color
    // + ds/3ds/virtual_boy/game_and_watch + pc
    expect(Object.keys(PLATFORMS)).toHaveLength(21);
    // Verified live against IGDB /v4/platforms on 2026-08-30
    expect(PLATFORM_IGDB_IDS.gbc).toBe(22); // 57 is WonderSwan, not GBC
    expect(PLATFORM_IGDB_IDS.n64).toBe(4);
    expect(PLATFORM_IGDB_IDS.saturn).toBe(32);
    expect(PLATFORM_IGDB_IDS.megadrive).toBe(29);
    expect(PLATFORM_IGDB_IDS.neogeo_aes).toBe(80);
    expect(PLATFORM_IGDB_IDS.neogeo_pocket_color).toBe(120);
    // Verified live against IGDB /v4/platforms on 2026-09-01
    expect(PLATFORM_IGDB_IDS.ds).toBe(20); // 159 is the DSi, not the DS
    expect(PLATFORM_IGDB_IDS["3ds"]).toBe(37); // 137 is the New 3DS, not the 3DS
    expect(PLATFORM_IGDB_IDS.virtual_boy).toBe(87);
    expect(PLATFORM_IGDB_IDS.game_and_watch).toBe(307);
  });

  it("reads PC as both IGDB's Windows (6) and DOS (13)", () => {
    expect(PLATFORM_IGDB_IDS.pc).toBe(6);
    expect(PLATFORMS.pc.extraIgdbIds).toEqual([13]);
    expect(ALL_IGDB_PLATFORM_IDS).toContain(6);
    expect(ALL_IGDB_PLATFORM_IDS).toContain(13);
    expect(new Set(ALL_IGDB_PLATFORM_IDS).size).toBe(ALL_IGDB_PLATFORM_IDS.length);
  });
});

describe("seller spellings", () => {
  it("gives every platform at least one spelling, and the first carries no stray whitespace", () => {
    for (const [id, info] of Object.entries(PLATFORMS)) {
      expect(info.sellerSpellings.length, id).toBeGreaterThan(0);
      expect(info.sellerSpellings[0].trim(), id).toBe(info.sellerSpellings[0]);
    }
  });

  it("keeps the four platform groups the live probes sent verbatim", () => {
    // fixtures/query-probes-2026-09-02.md: "(Game Boy, Gameboy)" (probe 3),
    // "(N64, Nintendo 64)" (probe 1), "(SNES, Super Nintendo, Super Famicom)"
    // and "(GBA, Game Boy Advance, Gameboy Advance)" (probe 6b, 2a). A probed
    // group is not re-spelled: the recall it measured belongs to those exact
    // strings.
    expect(PLATFORMS.gb.sellerSpellings).toEqual(["Game Boy", "Gameboy"]);
    expect(PLATFORMS.n64.sellerSpellings).toEqual(["N64", "Nintendo 64"]);
    expect(PLATFORMS.snes.sellerSpellings).toEqual(["SNES", "Super Nintendo", "Super Famicom"]);
    expect(PLATFORMS.gba.sellerSpellings).toEqual(["GBA", "Game Boy Advance", "Gameboy Advance"]);
  });

  /**
   * Console NAMES sellers also write closed up, spaced form -> closed form.
   *
   * Evidence line 130: `(King of Fighters: Heat of Battle, Heat of Battle)
   * (Game Boy)` -> 0, noted there as `single-spelling platform group: the
   * phrase "Game Boy" does not match "Gameboy"`; the working row (line 131)
   * is the same query with `(Game Boy, Gameboy)` -> 1. A group member is
   * matched as a contiguous phrase, so a console written both ways needs both
   * spellings or the group silently misses one set of listings.
   *
   * Names, never whole spellings: "Nintendo Entertainment System" and "Super
   * Nintendo" are not written closed up, and Game & Watch's "&" forms are
   * outside this rule (no probe ever sent an "&" in any shape).
   */
  const CLOSED_UP_CONSOLE_NAMES: ReadonlyArray<readonly [string, string]> = [
    ["game boy", "gameboy"],
    ["game gear", "gamegear"],
    ["game cube", "gamecube"],
    ["mega drive", "megadrive"],
    ["neo geo", "neogeo"],
    ["virtual boy", "virtualboy"],
  ];

  /** The closed-up spellings a list implies but does not ship, lowercased. */
  const missingClosedUpTwins = (spellings: readonly string[]): string[] => {
    const shipped = new Set(spellings.map((s) => s.toLowerCase()));
    const missing: string[] = [];
    for (const spelling of spellings) {
      const lower = spelling.toLowerCase();
      for (const [spaced, closed] of CLOSED_UP_CONSOLE_NAMES) {
        if (!lower.includes(spaced)) continue;
        const twin = lower.replace(spaced, closed);
        if (!shipped.has(twin)) missing.push(twin);
      }
    }
    return missing;
  };

  it("D1: the guard fails a spelling list that forgets a closed-up twin", () => {
    // Defect: this block used to build its lookup set from the very list it
    // then probed (`new Set(info.sellerSpellings.map(closedUp))`), so every
    // spelling matched itself and the assertion held for ANY list — the guard
    // platforms.ts step 4 and the README's "Adding a console" advertise did
    // not exist. It exists now; this is its negative control.
    expect(missingClosedUpTwins(["Game Boy"])).toEqual(["gameboy"]);
    expect(missingClosedUpTwins(["Game Boy Color", "Game Boy Colour"])).toEqual([
      "gameboy color",
      "gameboy colour",
    ]);
    expect(missingClosedUpTwins(["Mega Drive", "Genesis"])).toEqual(["megadrive"]);
    expect(missingClosedUpTwins(["Neo Geo Pocket Colour"])).toEqual(["neogeo pocket colour"]);
    // a console whose name is never closed up is never asked for a twin
    expect(missingClosedUpTwins(["NES", "Nintendo Entertainment System", "Famicom"])).toEqual([]);
    expect(missingClosedUpTwins(["Game Boy", "Gameboy"])).toEqual([]);
  });

  it("D1: every console ships the closed-up spelling sellers type", () => {
    for (const [id, info] of Object.entries(PLATFORMS)) {
      expect(missingClosedUpTwins(info.sellerSpellings), id).toEqual([]);
    }
  });

  it("D2: the query never asks for a name no seller types (the UI label is not a spelling)", () => {
    // "NG Pocket Color" is UI shorthand; word-ANDed onto a plain query it can
    // only return 0, because no listing carries the token "NG".
    expect(PLATFORMS.neogeo_pocket_color.label).toBe("NG Pocket Color");
    expect(PLATFORMS.neogeo_pocket_color.sellerSpellings).not.toContain("NG Pocket Color");
    expect(PLATFORMS.neogeo_pocket_color.sellerSpellings[0]).toBe("Neo Geo Pocket Color");
  });

  it("D1: gbc asks eBay for the spelling sellers actually type", () => {
    expect(PLATFORMS.gbc.sellerSpellings).toContain("Gameboy Color");
    // EBAY_GB: the British spelling is the local one
    expect(PLATFORMS.gbc.sellerSpellings).toContain("Game Boy Colour");
  });
});

/**
 * CeX category hints, once CeX is three countries.
 *
 * The hints live here; the detector and its most-specific-first
 * DETECTION_ORDER live in `apps/api/src/adapters/familyReading.ts`, so the
 * golden table that runs every country's live facet string through the real
 * detector lives beside it, in
 * `retrowatchdog-cex-plugin/test/` (its category lists). Re-implementing the
 * word-boundary match here to build a table would only test the copy. What
 * this block pins is the DATA: the strings that exist solely because Spain
 * and Ireland do not name their categories the way the UK does.
 *
 * Every string quoted below is a live `categoryFriendlyName` from
 * `retrowatchdog-cex-plugin/fixtures/country-categories-2026-09-03.md`.
 */
describe("CeX category hints", () => {
  it("keeps every hint lowercase, or it can never match", () => {
    // The detector lowercases the CATEGORY and matches the hint verbatim, so
    // a hint carrying a capital letter is silently dead — the same class of
    // failure as a hint that is a plausible guess rather than real facet text.
    for (const [id, info] of Object.entries(PLATFORMS)) {
      for (const hint of info.cexCategoryHints) {
        expect(hint, `${id}: ${hint}`).toBe(hint.toLowerCase());
        expect(hint.trim(), id).toBe(hint);
        expect(hint.length, id).toBeGreaterThan(0);
      }
    }
  });

  it("carries the country facet strings no UK name covers", () => {
    // Spain appends "Juegos" and writes "GBA"/"PS1" where the UK writes
    // "Gameboy Advance"/"Playstation1", so these four hints are the only
    // reason a Spanish box resolves to a console at all.
    expect(PLATFORMS.gb.cexCategoryHints).toContain("game boy juegos"); // "Game Boy Juegos"
    expect(PLATFORMS.gba.cexCategoryHints).toContain("gba"); // "GBA Juegos"
    expect(PLATFORMS.ps1.cexCategoryHints).toContain("ps1"); // "PS1 Juegos"
    expect(PLATFORMS.ds.cexCategoryHints).toContain("ds juegos"); // "DS Juegos"
  });

  it("keeps the Game Boy hints clear of the generic colour words", () => {
    // gbc's hints are the bare words "color"/"colour" and gbc is checked
    // BEFORE gb, so any Game Boy hint containing one would hand every plain
    // Game Boy category to gbc. That is why the gb hints name whole
    // categories ("game boy juegos") instead of the console.
    expect(PLATFORMS.gbc.cexCategoryHints).toEqual(["color", "colour"]);
    for (const hint of PLATFORMS.gb.cexCategoryHints) {
      expect(hint).not.toContain("color");
      expect(hint).not.toContain("colour");
    }
  });

  it("keeps the UK-only consoles' hints, which no country suffix touches", () => {
    // Virtual Boy and Neo Geo Pocket Color have NO Spanish or Irish category
    // at all (fixture point 3), so their hints stay single UK strings and the
    // ES/IE sync lists are simply shorter.
    expect(PLATFORMS.virtual_boy.cexCategoryHints).toEqual(["virtual boy"]);
    expect(PLATFORMS.neogeo_pocket_color.cexCategoryHints).toEqual(["neo geo pocket color"]);
  });
});
