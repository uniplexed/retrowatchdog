import { describe, it, expect } from "vitest";
import { classifyListing } from "../../src/adapters/classifyListing.js";
import type { RawListing } from "../../src/adapters/types.js";

/**
 * The classification every adapter's normalize() runs — cleanTitle plus the
 * platform / region / condition / grade detectors — used to live inside
 * adapters/ebay/normalize.ts as private functions. It is shared now because a
 * second adapter needs it, and it was EXTRACTED rather than copied: two
 * copies of these detectors is exactly the failure the whole cross-source
 * comparison rests on not having, since "PAL, boxed" has to mean one thing
 * whichever source said it.
 *
 * Most of what follows was measured against eBay listing titles and used to
 * live in that adapter's test file, expressed through `normalizeEbayListing`.
 * None of it is eBay's: every case is a reading of free-text seller prose,
 * which is what this module does for every source that sends any. What
 * genuinely belonged to the eBay adapter — the Browse item mapping, the
 * `available: true` stamp, the per-market currency check — moved with it: to
 * the eBay plugin's own test file (retrowatchdog-ebay-plugin/test/mapping.test.ts),
 * and the grade tiers have their own (gradeDetection.test.ts).
 *
 * `conditionText: "Pre-owned"` is kept on the cases that carried it. It is a
 * source's structured condition field, and keeping it is what shows the TITLE
 * decides the completeness tier whenever that field does not say "New".
 */
const raw = (title: string, conditionText?: string): RawListing => ({
  sourceProductId: "id-1",
  title,
  ...(conditionText === undefined ? {} : { conditionText }),
  url: null,
  prices: [],
});

const read = (title: string, conditionText?: string) => classifyListing(raw(title, conditionText));
/** the same reading with a source's "this is second-hand" field attached */
const preOwned = (title: string) => read(title, "Pre-owned");

describe("the shared listing classifier", () => {
  /**
   * Six titles whose reading is load-bearing somewhere in the app, asserted
   * field by field.
   *
   * They used to be asserted by COMPARING classifyListing's answer with
   * normalizeEbayListing's, which was already circular — normalizeEbayListing
   * is `{...classifyListing(raw), available: true}` — and would have become
   * literally `classifyListing(x) === classifyListing(x)` once eBay is read
   * through the same shared classifier as everything else. A test that cannot
   * fail is worse than no test, because its doc comment claims cover.
   */
  const readings: Array<[string, string, ReturnType<typeof classifyListing>["platformGuess"], string, string, string | null]> = [
    ["a PAL boxed N64 cart", "Legend of Zelda Ocarina of Time N64 Boxed Complete PAL", "n64", "PAL", "cib", null],
    ["a loose cart with a negated box", "Super Mario World SNES cart only no box NTSC", "snes", "NTSC_U", "loose", null],
    ["the boxed-without-manual tier", "Pokemon Red Game Boy boxed no manual", "gb", "unknown", "boxed_no_manual", null],
    ["a graded listing", "Sonic the Hedgehog Mega Drive MINT condition boxed", "megadrive", "unknown", "cib", "mint"],
    // "famicom" is an NTSC_J marker as well as half of snes's "super famicom"
    // keyword, and the bare word "cartridge" is not the BARE_CART signal
    ["a Japanese import", "Super Famicom Chrono Trigger NTSC-J cartridge", "snes", "NTSC_J", "unknown", null],
    // the seller is listing what the cart PLAYS ON, not a Game Boy Color game
    ["a family-compatibility list on a plain Game Boy cart", "Tetris Game Boy Color Advance PAL", "gb", "PAL", "unknown", null],
  ];

  for (const [what, title, platform, region, condition, grade] of readings) {
    it(`reads ${what}`, () => {
      const listing = preOwned(title);
      expect(listing.platformGuess).toBe(platform);
      expect(listing.regionGuess).toBe(region);
      expect(listing.conditionGuess).toBe(condition);
      expect(listing.gradeGuess).toBe(grade);
    });
  }

  it("hands the matcher a title with the platform, region and condition words taken out", () => {
    expect(preOwned("Legend of Zelda Ocarina of Time N64 Boxed Complete PAL").cleanTitle)
      .toBe("legend of zelda ocarina of time");
  });

  it("reads a source's structured condition field, which a title alone cannot say", () => {
    // The one input that is not the title. A sealed copy whose title carries no
    // newness vocabulary reads as new only because the source said so, and it
    // reads as unknown when nothing says it.
    expect(read("Metroid Prime GameCube", "New").conditionGuess).toBe("new");
    expect(read("Metroid Prime GameCube", "Pre-owned").conditionGuess).toBe("unknown");
    expect(read("Metroid Prime GameCube").conditionGuess).toBe("unknown");
  });

  /**
   * The one thing the shared classifier deliberately does NOT do. Whether a
   * listing is buyable is something the SOURCE says — eBay's adapter stamps
   * `available: true` because a Browse item summary is a live listing by
   * definition, and a sidecar plugin has to say so on the row — so the
   * classifier passes whatever the source said (or did not say) through
   * untouched rather than inventing an answer.
   */
  it("leaves availability to the adapter instead of asserting it", () => {
    expect(classifyListing(raw("Pilotwings 64")).available).toBeUndefined();
    expect(classifyListing({ ...raw("Pilotwings 64"), available: false }).available).toBe(false);
    expect(classifyListing({ ...raw("Pilotwings 64"), available: true }).available).toBe(true);
  });
});

describe("region detection from a listing title", () => {
  it("detects region per listing: PAL, NTSC_J import, NTSC_U, unknown", () => {
    expect(preOwned("Super Mario World SNES PAL Boxed Complete").regionGuess).toBe("PAL");
    expect(preOwned("Super Mario World Super Famicom JAP Japan import").regionGuess).toBe("NTSC_J");
    expect(preOwned("Super Mario World SNES NTSC USA version boxed").regionGuess).toBe("NTSC_U");
    expect(preOwned("Super Mario World SNES").regionGuess).toBe("unknown"); // no signal: never guessed
  });

  it("classifies the literal 'NTSC-J' marker as NTSC_J, not NTSC_U (finding 2)", () => {
    expect(preOwned("Sega Saturn NTSC-J import").regionGuess).toBe("NTSC_J");
  });
});

describe("completeness detection from a listing title", () => {
  const conditionTable: Array<[string, string]> = [
    // boxed_no_manual tier: a box claim plus a missing-manual phrase. The
    // seller's own words say the set is not complete, so it never reads as cib.
    ["Super Mario World SNES PAL boxed no manual", "boxed_no_manual"],
    ["Super Mario World SNES PAL Boxed, No Manual", "boxed_no_manual"],
    ["Super Mario World SNES box no manual", "boxed_no_manual"],
    ["Super Mario World SNES no manual boxed", "boxed_no_manual"],
    ["Super Mario World SNES boxed without manual", "boxed_no_manual"],
    ["Super Mario World SNES boxed w/o instructions", "boxed_no_manual"],
    // a completeness claim contradicted by "no manual" is not complete
    ["Super Mario World SNES CIB no manual", "boxed_no_manual"],
    // the bare "cart" word yields to the boxed tier
    ["Super Mario World SNES boxed cart no manual", "boxed_no_manual"],
    // manual present: complete
    ["Super Mario World SNES boxed with manual", "cib"],
    ["Super Mario World SNES PAL Boxed Complete", "cib"],
    // no box at all: loose, even though the word "box" appears
    ["Super Mario World SNES no box no manual", "loose"],
    ["Super Mario World SNES cart only no manual", "loose"],
    ["Super Mario World SNES cartridge only", "loose"],
    // "no manual" alone claims no box: nothing to tier it by
    ["Super Mario World SNES no manual", "unknown"],
  ];
  it.each(conditionTable)("condition: '%s' -> %s", (title, condition) => {
    expect(preOwned(title).conditionGuess).toBe(condition);
  });

  it("reads condition and region from the shared matching vocabulary", () => {
    // "no case" (CeX wording) and "us import" (CeX wording) read on a
    // marketplace title too: one vocabulary, so a word one source teaches the
    // app is a word every source's titles are read with
    expect(preOwned("Zelda Ocarina of Time N64 cart, no case").conditionGuess).toBe("loose");
    expect(preOwned("Sonic 2 Mega Drive US import").regionGuess).toBe("NTSC_U");
    expect(preOwned("Sonic 2 Mega Drive NTSC J").regionGuess).toBe("NTSC_J");
    // word-bounded: "unboxed" is loose, never cib through its "boxed" suffix
    expect(preOwned("Sonic 2 Mega Drive unboxed").conditionGuess).toBe("loose");
  });
});

describe("platform detection from a listing title", () => {
  it("detects the platform from title keywords", () => {
    expect(preOwned("Super Mario World SNES PAL Boxed Complete").platformGuess).toBe("snes");
    expect(preOwned("Super Mario World Super Nintendo PAL cartridge only tested").platformGuess).toBe("snes");
  });

  it("does not match platform keywords as substrings of unrelated words (finding 1)", () => {
    // "genesis" contains "nes" as a substring; a naive .includes() scan would
    // misdetect this Mega Drive listing as NES.
    expect(preOwned("Jurassic Park Sega Genesis Mega Drive").platformGuess).toBe("megadrive");
    expect(preOwned("Sonic 2 Sega Genesis").platformGuess).toBe("megadrive");
  });

  it("detects PC games from the spellings sellers use, and never a PC Engine listing", () => {
    expect(preOwned("Doom II PC CD-ROM Big Box 1994").platformGuess).toBe("pc");
    expect(preOwned("Monkey Island 2 PC big box complete").platformGuess).toBe("pc");
    expect(preOwned("Commander Keen MS-DOS 3.5 floppy").platformGuess).toBe("pc");
    expect(preOwned("Bonk's Adventure PC Engine HuCard").platformGuess).toBeNull();
    expect(preOwned("Castlevania Rondo of Blood PC Engine CD-ROM").platformGuess).toBeNull();
  });

  it("detects Super Famicom as snes, not nes (famicom keyword collision, snes must win)", () => {
    expect(preOwned("Super Famicom Street Fighter II").platformGuess).toBe("snes");
  });

  it("detects ps1/ps2/gamecube from title keywords", () => {
    expect(preOwned("Final Fantasy IX PS1 PAL").platformGuess).toBe("ps1");
    expect(preOwned("GameCube Mario Sunshine").platformGuess).toBe("gamecube");
  });

  it("detects the new Neo Geo platforms from title keywords, without regressing gbc", () => {
    expect(preOwned("Neo Geo Pocket Color Sonic Pocket Adventure").platformGuess).toBe("neogeo_pocket_color");
    expect(preOwned("Samurai Shodown Neo Geo AES").platformGuess).toBe("neogeo_aes");
    expect(preOwned("Game Boy Color Tetris DX").platformGuess).toBe("gbc");
  });

  it("detects ds and 3ds from title keywords", () => {
    expect(preOwned("Mario Kart DS Nintendo DS Boxed").platformGuess).toBe("ds");
    expect(preOwned("New Super Mario Bros DS").platformGuess).toBe("ds");
    expect(preOwned("Animal Crossing New Leaf Nintendo 3DS").platformGuess).toBe("3ds");
    expect(preOwned("Zelda Ocarina of Time 3D 3DS Complete").platformGuess).toBe("3ds");
  });

  it("never lets ds steal a 3DS title, nor 3ds a DS title (detection-order trap)", () => {
    // "3ds" is a single word: no boundary between "3" and "d", so ds's bare
    // "ds" keyword can't fire inside it — and 3ds precedes ds in
    // TITLE_DETECTION_ORDER so a title carrying both signals resolves to 3ds.
    expect(preOwned("Nintendo 3DS Pokemon X").platformGuess).toBe("3ds");
    expect(preOwned("Nintendo 3DS Pokemon X").platformGuess).not.toBe("ds");
    expect(preOwned("Nintendo DS Pokemon Diamond").platformGuess).toBe("ds");
    expect(preOwned("Nintendo DS Pokemon Diamond").platformGuess).not.toBe("3ds");
    expect(preOwned("Nintendo 3DS 2DS DS compatible game").platformGuess).toBe("3ds");
  });

  it("does not match the bare 'ds' keyword inside unrelated words (kids, cards)", () => {
    expect(preOwned("Trading Cards Bundle For Kids").platformGuess).toBeNull();
    expect(preOwned("Yu-Gi-Oh cards job lot").platformGuess).toBeNull();
  });

  it("detects virtual_boy and game_and_watch from title keywords", () => {
    expect(preOwned("Mario's Tennis Virtual Boy Cart Only").platformGuess).toBe("virtual_boy");
    expect(preOwned("Wario Land VirtualBoy Boxed").platformGuess).toBe("virtual_boy");
    expect(preOwned("Nintendo Game & Watch Ball 1980").platformGuess).toBe("game_and_watch");
    expect(preOwned("Nintendo Game and Watch Octopus").platformGuess).toBe("game_and_watch");
    expect(preOwned("Vintage Game&Watch Donkey Kong").platformGuess).toBe("game_and_watch");
  });

  it("detects the one-word 'gameboy advance' spelling as gba, not gb", () => {
    // the measured mis-mapping: Pokémon FireRed listed as "Gameboy Advance" fell to gb and mapped onto Pokémon Red
    expect(preOwned("Pokémon Fire Red Version Nintendo Gameboy Advance - Boxed").platformGuess).toBe("gba");
    expect(preOwned("Pokemon Fire Red Version (GameBoy Advance, 2004)").platformGuess).toBe("gba");
    // but a compatibility list on a plain Game Boy cart stays gb: "Gameboy
    // Color Advance" means "plays on all three", and gbc/gba must not steal
    // it (the hard platform filter would hide the gb catalog entry)
    expect(preOwned("Double Dragon Nintendo Gameboy Color Advance Game, GENUINE!").platformGuess).toBe("gb");
    expect(preOwned("Authentic Pokémon Red Version Game Boy Colour Original Cartridge Only").platformGuess).toBe("gb");
  });

  it("D1: reads the same Game Boy compatibility list the same way however the seller spells it", () => {
    // The rule above was only ever enforced for the closed-up spelling: with
    // a space, "Game Boy Color Advance" matched gbc's "game boy color" and
    // resolved to gbc (executed 2026-09-02, before this fix) while the very
    // same claim written "Gameboy Color Advance" resolved to gb. One decision,
    // two answers, decided by the seller's spacing.
    expect(preOwned("Double Dragon Nintendo Game Boy Color Advance Game, GENUINE!").platformGuess).toBe("gb");
    expect(preOwned("Double Dragon Nintendo Gameboy Color Advance Game, GENUINE!").platformGuess).toBe("gb");
    expect(preOwned("Tetris Game Boy Colour Advance compatible").platformGuess).toBe("gb");
    expect(preOwned("Tetris Gameboy Colour Advance compatible").platformGuess).toBe("gb");
    // a genuine GBA cart still reads as gba: no "color"/"colour" between the
    // console name and "advance", so this is not a compatibility list
    expect(preOwned("Pokémon Fire Red Version Nintendo Game Boy Advance - Boxed").platformGuess).toBe("gba");
  });

  it("D1: does NOT read the closed-up 'Gameboy Color' as evidence of gbc (deliberate, measured)", () => {
    // Not an oversight and not fixed: the probe fixture holds a Game Boy
    // cartridge titled "Nintendo Pokémon Red - Nintendo GameBoy Color PAL
    // Cartridge Only" (query-probes-2026-09-02.md, probe 7), and 14 of 451
    // needs_review eBay rows were the same pattern. Teaching gbc this
    // spelling would hand the hard platform filter a wrong answer for those.
    // The SEARCH QUERY does ask for it — see PLATFORMS.gbc.sellerSpellings,
    // where a wide guess costs nothing because the matcher re-checks titles.
    expect(preOwned("Nintendo Pokémon Red - Nintendo GameBoy Color PAL Cartridge Only").platformGuess).toBe("gb");
    expect(preOwned("Tetris DX Gameboy Color cart only").platformGuess).toBe("gb");
    // the spaced spelling remains gbc's, as it has always been
    expect(preOwned("Tetris DX Game Boy Color cart only").platformGuess).toBe("gbc");
  });

  it("D1: detects the console spellings that matched nothing at all", () => {
    // each of these resolved to the wrong platform or to null before the fix
    // (executed 2026-09-02): a spelling missing from titleKeywords is silent
    expect(preOwned("Super Mario World Super NES Cart Only").platformGuess).toBe("snes");
    expect(preOwned("Sonic Chaos GameGear cart only").platformGuess).toBe("game_gear");
    expect(preOwned("SNK vs Capcom Neo Geo Pocket Colour boxed").platformGuess).toBe("neogeo_pocket_color");
    expect(preOwned("SNK vs Capcom Neogeo Pocket Color boxed").platformGuess).toBe("neogeo_pocket_color");
    // and the spellings they must not steal
    expect(preOwned("Super Mario Bros NES Cart Only").platformGuess).toBe("nes");
    expect(preOwned("Sonic Chaos Game Gear cart only").platformGuess).toBe("game_gear");
  });

  it("keeps Game & Watch Gallery cartridges on the gb family, not game_and_watch", () => {
    // These are Game Boy (Color/Advance) games whose names contain the
    // "game & watch" phrase — the gb family precedes game_and_watch in
    // TITLE_DETECTION_ORDER, so the cartridge platform must win.
    expect(preOwned("Game & Watch Gallery Game Boy").platformGuess).toBe("gb");
    expect(preOwned("Game & Watch Gallery 2 Game Boy Color").platformGuess).toBe("gbc");
    expect(preOwned("Game & Watch Gallery 4 GBA").platformGuess).toBe("gba");
  });
});

describe("a console this app does not track, named in the title", () => {
  // Measured 2026-10-19: Vinted answered three Xbox copies of Shenmue II to a
  // search for the Dreamcast game. "Xbox" matched no tracked platform, the
  // platform filter fell open, and they were priced as Dreamcast copies.
  it.each([
    "Shenmue II - Xbox",
    "Shenmue II – Original Xbox – PAL – Complete with Manual",
    "Xbox Shenmue II sega game boxed",
    "Zelda Breath of the Wild Nintendo Switch",
    "GTA San Andreas PS4",
    "Mario Kart Wii",
    "Sonic CD Mega CD PAL",
    "Bonk's Adventure PC Engine HuCard",
  ])("%s is marked foreign", (title) => {
    expect(preOwned(title).foreignPlatform).toBe(true);
  });

  it.each([
    "Shenmue II Dreamcast PAL",
    "Super Mario World SNES",
    "Shenmue II",
    // a tracked console named beside it wins: the listing is that console's
    "Sonic Adventure 2 Dreamcast not the GameCube or Xbox port",
  ])("%s is not", (title) => {
    expect(preOwned(title).foreignPlatform).toBe(false);
  });
});
