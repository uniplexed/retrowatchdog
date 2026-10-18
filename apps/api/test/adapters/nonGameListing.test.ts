import { describe, it, expect } from "vitest";
import { isNonGameListing } from "../../src/adapters/nonGameListing.js";
import { detectConditionFromTitle } from "../../src/adapters/classifyListing.js";

/**
 * The app's "is this listing the game at all?" reading — adapters/nonGameListing.ts.
 *
 * Every assertion below is a measured trap: a real polluter that reached a
 * median or a mapping, or a real game title a wider vocabulary would have
 * eaten. The comments ARE the evidence, so they travel with the cases.
 *
 * The coverage lived in test/adapters/ebay/normalize.test.ts because the
 * vocabulary grew up inside adapters/ebay/normalize.ts and was extracted — not
 * copied — the moment a second adapter reading free-text marketplace titles
 * needed it (see that module's header). The module is shared now and every
 * adapter that reads seller prose calls it, including the sidecar one, so its
 * tests belong beside it rather than beside one of its callers.
 */

describe("non-game listing exclusion", () => {
  it("excludes manual/booklet/instruction-only listings", () => {
    // real polluter: a £10 manual flagged UNDERPRICED vs the £24 game median
    expect(isNonGameListing("The Legend of Zelda Ocarina of Time N64 Instruction Booklet / Manual")).toBe(true);
    expect(isNonGameListing("Super Mario World SNES Manual Only")).toBe(true);
    expect(isNonGameListing("Zelda Ocarina of Time instruction booklet")).toBe(true);
  });

  it("keeps 'cart only, no manual' listings — they ARE the game", () => {
    expect(isNonGameListing("Legend of Zelda Ocarina of Time N64 Cart Only, No Manual")).toBe(false);
    expect(isNonGameListing("Super Mario World SNES cart without manual")).toBe(false);
  });

  it("excludes box-only / case-only / empty-box listings", () => {
    expect(isNonGameListing("Super Mario World SNES Box Only")).toBe(true);
    expect(isNonGameListing("The Legend of Zelda Ocarina of Time N64 Empty Box")).toBe(true);
    expect(isNonGameListing("Final Fantasy IX PS1 Case Only")).toBe(true);
  });

  it("keeps 'no box' / 'box damaged' listings — the game with a bad or missing box", () => {
    expect(isNonGameListing("Super Mario World SNES cart, no box")).toBe(false);
    expect(isNonGameListing("Super Mario World SNES boxed PAL, box damaged")).toBe(false);
  });

  it("excludes inserts, posters, maps and cover art", () => {
    expect(isNonGameListing("Ocarina of Time N64 poster")).toBe(true);
    expect(isNonGameListing("Super Mario World SNES box insert")).toBe(true);
    expect(isNonGameListing("The Legend of Zelda Ocarina of Time map only")).toBe(true);
    expect(isNonGameListing("Super Mario World SNES cover art")).toBe(true);
  });

  it("keeps normal titles, including CIB listings that say the manual IS included", () => {
    expect(isNonGameListing("Super Mario World SNES PAL Boxed Complete")).toBe(false);
    expect(isNonGameListing("Zelda Ocarina of Time N64 PAL boxed with manual")).toBe(false);
    expect(isNonGameListing("Super Mario World SNES complete with instruction manual")).toBe(false);
  });

  it("reads the bare `w/` as a completeness qualifier, the way sellers and shops write it", () => {
    // "w/" is how a marketplace seller and a high-street shop both abbreviate
    // WITH, and the qualifier list knew "w/o" but not it — so the accessory
    // word survived the strip and a complete copy was thrown away as if it
    // were a loose manual. Measured on the live Vinted path before this fix.
    // The app already reads the phrase correctly one layer down:
    // CONDITION_WORDS.cib lists "w/ manual" as a complete-in-box marker, so
    // it understood the title and discarded the listing anyway.
    expect(isNonGameListing("Zelda Ocarina of Time w/ manual")).toBe(false);
    expect(isNonGameListing("Some Game, w/ Manual, Boxed")).toBe(false);
    expect(isNonGameListing("Super Mario World SNES w/ box and manual")).toBe(false);
    // a cart sold WITH a bonus poster is the game, exactly as "with poster" is
    expect(isNonGameListing("Zelda Ocarina of Time N64 cart w/ poster")).toBe(false);
  });

  it("keeps `w/o` meaning WITHOUT, which differs from `w/` by one character", () => {
    // Both are stripped, so both keep the listing — but they are separate
    // alternatives and the longer one has to win, or "w/o manual" would be
    // read as "w/" followed by a stray "o".
    expect(isNonGameListing("Zelda Ocarina of Time w/o manual")).toBe(false);
    expect(isNonGameListing("Super Mario World SNES cart w/o box")).toBe(false);
    // and the tier the condition reader assigns is still the negated one
    expect(detectConditionFromTitle("Zelda Ocarina of Time N64 boxed w/o manual")).toBe("boxed_no_manual");
    expect(detectConditionFromTitle("Zelda Ocarina of Time N64 boxed w/ manual")).toBe("cib");
  });

  it("still drops an accessory-only listing that happens to say `w/`", () => {
    // The qualifier consumes what FOLLOWS it. An unqualified accessory word
    // before it is untouched, which is what keeps a manual being sold with a
    // box out of the prices.
    expect(isNonGameListing("Zelda Ocarina of Time manual w/ box")).toBe(true);
    expect(isNonGameListing("Super Mario World SNES Manual Only w/ Sleeve")).toBe(true);
    expect(isNonGameListing("N64 Instruction Booklet w/ Map")).toBe(true);
  });
});

describe("merchandise listing exclusion", () => {
  it("excludes the real polluter: a mug matched to the game it depicts", () => {
    // live evidence: this was a needs_review source mapping to Art of Fighting 2 (score 0.39)
    expect(isNonGameListing("Art of Fighting 2, Retro Gaming Mug with Neo Geo AES Artwork")).toBe(true);
  });

  it("excludes drinkware, but never bare 'cup' — real games are titled '... Cup'", () => {
    expect(isNonGameListing("Zelda Ocarina of Time N64 Ceramic Mug")).toBe(true);
    expect(isNonGameListing("Sonic the Hedgehog Coffee Cup, Boxed Set")).toBe(true);
    expect(isNonGameListing("Pokemon Tea Cup and Saucer")).toBe(true);
    // "Nintendo World Cup" (NES) is a real game — bare "cup" must never exclude
    expect(isNonGameListing("Nintendo World Cup NES Boxed")).toBe(false);
    expect(isNonGameListing("Davis Cup Tennis NES Cart Only")).toBe(false);
  });

  it("excludes decor merch, but never bare 'art'/'artwork' — 'Art of Fighting' is a real game", () => {
    expect(isNonGameListing("Zelda Hyrule Castle Canvas Print")).toBe(true);
    expect(isNonGameListing("Super Mario Wall Art Poster")).toBe(true);
    expect(isNonGameListing("Art of Fighting 2 Neo Geo AES Boxed")).toBe(false);
    expect(isNonGameListing("Art of Fighting SNES Cart Only")).toBe(false);
  });

  it("excludes 'print' as a standalone word, without matching it as a substring", () => {
    expect(isNonGameListing("Sonic the Hedgehog Fan Art Print, Signed")).toBe(true);
    // word-boundary safety: "print" appears as a substring of "Sprint"/"Fingerprint"
    // but must never fire without a preceding word boundary
    expect(isNonGameListing("Street Sprint Racer Game Boy Cart Only")).toBe(false);
    expect(isNonGameListing("Cyber Fingerprint Scanner Toy Boxed")).toBe(false);
  });

  it("excludes apparel", () => {
    expect(isNonGameListing("Sonic the Hedgehog T-Shirt Size L")).toBe(true);
    expect(isNonGameListing("Zelda Tshirt Large")).toBe(true);
    expect(isNonGameListing("Pokemon Tee Small")).toBe(true);
    expect(isNonGameListing("Mario Hoodie Medium")).toBe(true);
  });

  it("excludes wearables and desk tat: keyring, keychain, lanyard, badge, sticker, decal, mouse mat/pad", () => {
    expect(isNonGameListing("Zelda Triforce Keyring")).toBe(true);
    expect(isNonGameListing("Pokemon Pikachu Key Chain")).toBe(true);
    expect(isNonGameListing("Sonic the Hedgehog Lanyard")).toBe(true);
    expect(isNonGameListing("Mario Enamel Pin Badge")).toBe(true);
    expect(isNonGameListing("Zelda Master Sword Sticker Sheet")).toBe(true);
    expect(isNonGameListing("Metroid Samus Vinyl Decal")).toBe(true);
    expect(isNonGameListing("Sonic the Hedgehog Mouse Mat")).toBe(true);
    expect(isNonGameListing("Zelda Mousepad XL")).toBe(true);
  });

  it("excludes a standalone 'pin', but never inside 'pinball' — a game genre", () => {
    expect(isNonGameListing("Mario Enamel Pin")).toBe(true);
    expect(isNonGameListing("Pokemon Pinball Game Boy Color")).toBe(false);
    expect(isNonGameListing("Sonic Spinball Mega Drive Boxed")).toBe(false);
  });

  it("excludes a standalone 'sticker', but never 'Sticker Star' — a real 3DS game", () => {
    expect(isNonGameListing("Zelda Sticker Pack, 10 Stickers")).toBe(true);
    expect(isNonGameListing("Paper Mario Sticker Star Nintendo 3DS Boxed")).toBe(false);
  });

  it("excludes a standalone 'coaster', but never 'RollerCoaster Tycoon' — real GBA/3DS releases", () => {
    expect(isNonGameListing("Zelda Hyrule Crest Coaster Set")).toBe(true);
    expect(isNonGameListing("RollerCoaster Tycoon 3D Nintendo 3DS Boxed")).toBe(false);
    // sellers commonly space the franchise name as two words
    expect(isNonGameListing("Roller Coaster Tycoon Game Boy Advance Cart Only")).toBe(false);
  });

  it("excludes collectibles: plush, figure, figurine, statue, amiibo", () => {
    expect(isNonGameListing("Sonic the Hedgehog Plush Toy")).toBe(true);
    expect(isNonGameListing("Mega Man Action Figure")).toBe(true);
    expect(isNonGameListing("Chun-Li Figurine, Boxed")).toBe(true);
    expect(isNonGameListing("Samus Aran Statue, Limited Edition")).toBe(true);
    expect(isNonGameListing("Mario Amiibo")).toBe(true);
  });

  it("excludes strategy guides and guide books, but never bare 'guide'", () => {
    expect(isNonGameListing("Pokemon Blue Official Strategy Guide")).toBe(true);
    expect(isNonGameListing("Mario Party 64 Guide Book")).toBe(true);
    expect(isNonGameListing("Zelda Ocarina of Time N64 Player's Guide")).toBe(true);
    // real product: an official Nintendo Power / Prima guide book, not the cartridge
    expect(isNonGameListing("Pokemon Trainer's Guide")).toBe(true);
    // no game in the current fixture corpus is titled "... Guide"; documented
    // as precautionary in the MERCHANDISE_TERMS comment, not a measured fix
  });

  it("excludes print/AV media: magazine, soundtrack, ost, vinyl", () => {
    expect(isNonGameListing("Nintendo Power Magazine Issue 50")).toBe(true);
    expect(isNonGameListing("Streets of Rage Soundtrack CD")).toBe(true);
    expect(isNonGameListing("Sonic 2 OST")).toBe(true);
    expect(isNonGameListing("Chrono Trigger Vinyl Soundtrack")).toBe(true);
  });

  it("excludes dvd/blu-ray media, but never 'DVD case' — how PS2/GameCube CIB listings describe the box", () => {
    expect(isNonGameListing("Pokemon The Movie 2000 DVD")).toBe(true);
    expect(isNonGameListing("Final Fantasy VII Advent Children Blu-ray")).toBe(true);
    expect(isNonGameListing("Final Fantasy Advent Children Blu Ray Disc")).toBe(true);
    expect(isNonGameListing("Metal Gear Solid 2 PS2 DVD Case, Complete")).toBe(false);
    expect(isNonGameListing("Resident Evil GameCube Blu-ray Case Boxed")).toBe(false);
  });

  it("excludes replacement/empty cases and custom-label carts — packaging that isn't the item itself", () => {
    expect(isNonGameListing("PS1 Replacement Case, Clear")).toBe(true);
    expect(isNonGameListing("N64 Empty Case, No Cart")).toBe(true);
    expect(isNonGameListing("Metal Slug X Custom Label Cart")).toBe(true);
  });

  it("excludes reproductions and repros outright: not genuine market comparables", () => {
    expect(isNonGameListing("Contra NES Reproduction Cart")).toBe(true);
    expect(isNonGameListing("Metal Slug X Neo Geo AES Repro")).toBe(true);
    expect(isNonGameListing("Chrono Trigger SNES Reproduction, Custom Label")).toBe(true);
  });

  it("keeps ordinary game listings untouched by the merchandise vocabulary", () => {
    expect(isNonGameListing("Super Mario World SNES PAL Boxed Complete")).toBe(false);
    expect(isNonGameListing("The Legend of Zelda Ocarina of Time N64 Cart Only")).toBe(false);
    expect(isNonGameListing("Sonic the Hedgehog Mega Drive, Very Good Condition")).toBe(false);
  });
});
