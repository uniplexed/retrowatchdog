import { describe, it, expect } from "vitest";
import { isNonGameListing } from "../../src/adapters/nonGameListing.js";
import { detectConditionFromTitle } from "../../src/adapters/classifyListing.js";
import { cleanTitle } from "../../src/matching/cleanTitle.js";

/**
 * Per-locale non-game vocabulary (German, Spanish, French).
 *
 * Live evidence: retrowatchdog-ebay-plugin/fixtures/marketplace-probes-2026-09-03.md
 * It probed the five marketplaces the eBay plugin serves and found the
 * CHEAPEST listing in three of them was not a game — a magazine (GB), a
 * "Miniatur Spielmodul Schlüsselanhänger" keyring (DE) and a "Notice" manual
 * (FR). The GB and ES ones were already caught by the English vocabulary; the
 * German and French ones were not, so a DE/FR/ES market fed manuals and
 * merchandise straight into the medians and the bargain barks.
 *
 * COVERED here: English (as before), German, Spanish, French.
 * NOT COVERED: Italian, Dutch, Portuguese, Polish — asserted at the bottom so
 * nobody reads this file as full coverage.
 */

/**
 * No structured condition field: these are all title readings, and the point
 * of the whole file is that the words in the title are understood.
 */
const condition = (title: string) => detectConditionFromTitle(title);

describe("per-locale non-game vocabulary: the five probed marketplaces", () => {
  it("excludes the two fixture listings the English-only filter let through", () => {
    // marketplace-probes-2026-09-03.md, EBAY_DE row. The fixture table truncates
    // the compound at column width ("Schlüsselanhäng…"); completed here.
    expect(isNonGameListing("Zelda Ocarina Of Time N64 Miniatur Spielmodul Schlüsselanhänger")).toBe(true);
    // EBAY_FR row, quoted as far as the fixture table records it
    expect(isNonGameListing("Notice Nintendo 64 N64 The Legend Of Zelda Ocarina Of Time")).toBe(true);
  });

  it("keeps reading the three fixture listings the English vocabulary already handled", () => {
    // EBAY_GB: a magazine — "magazine" and a bare "manual" both fire
    expect(isNonGameListing("Nintendo 64 Magazine N64 Manual Tips Book No8- Zelda Ocarina of Time")).toBe(true);
    // EBAY_ES: the Spanish listing spells "GUIDE BOOK" in English, so the
    // English guide-book term already excluded it
    expect(isNonGameListing("GUIA GUIDE BOOK THE LEGEND OF ZELDA OCARINA OF TIME guidebook")).toBe(true);
    // EBAY_US: a real (batch) game listing — must stay in the market
    expect(isNonGameListing("[REGION LOCK] Authentic Japanese Nintendo 64 Games - New battery")).toBe(false);
  });
});

describe("German listing vocabulary", () => {
  it("excludes manual-only listings: Anleitung / Bedienungsanleitung / Spielanleitung", () => {
    expect(isNonGameListing("The Legend of Zelda Ocarina of Time N64 Anleitung")).toBe(true);
    expect(isNonGameListing("Super Mario World SNES Bedienungsanleitung")).toBe(true);
    expect(isNonGameListing("Sonic 2 Mega Drive Spielanleitung")).toBe(true);
  });

  it("keeps a copy whose manual is merely declared: 'mit Anleitung' / 'ohne Anleitung'", () => {
    // the German twin of the English "boxed with manual" / "no manual" rule
    expect(isNonGameListing("Zelda Ocarina of Time N64 OVP mit Anleitung")).toBe(false);
    expect(isNonGameListing("Super Mario World SNES Modul ohne Anleitung")).toBe(false);
  });

  it("excludes the box alone: 'nur OVP' / 'nur die Originalverpackung' / 'leere OVP'", () => {
    expect(isNonGameListing("Super Mario World SNES nur OVP")).toBe(true);
    expect(isNonGameListing("Zelda Ocarina of Time N64 nur die Originalverpackung")).toBe(true);
    expect(isNonGameListing("Sonic 2 Mega Drive leere OVP")).toBe(true);
  });

  it("TRAP: a bare 'OVP' means the original box IS included — a complete copy, never box-only", () => {
    // "OVP" = Originalverpackung. German sellers write it ON the game to say
    // the box is there; reading it as "box only" would drop every German CIB
    // listing out of the market.
    expect(isNonGameListing("Zelda Ocarina of Time N64 OVP")).toBe(false);
    expect(condition("Zelda Ocarina of Time N64 OVP")).toBe("cib");
    expect(condition("Zelda Ocarina of Time N64 OVP mit Anleitung")).toBe("cib");
  });

  it("reads the cartridge alone as loose: 'nur Modul' / 'nur Spielmodul' / 'ohne OVP'", () => {
    expect(condition("Zelda Ocarina of Time N64 nur Modul")).toBe("loose");
    expect(condition("Super Mario World SNES nur Spielmodul")).toBe("loose");
    expect(condition("Sonic 2 Mega Drive ohne OVP")).toBe("loose");
  });

  it("TRAP: a bare 'Spielmodul' is the cartridge itself — the game, not merchandise", () => {
    // the DE fixture's keyring carries the same word; it is the
    // "Schlüsselanhänger" that makes that one merchandise, never "Spielmodul"
    expect(isNonGameListing("Zelda Ocarina of Time N64 Spielmodul")).toBe(false);
    expect(condition("Zelda Ocarina of Time N64 Spielmodul")).toBe("unknown");
  });

  it("excludes German merchandise: Schlüsselanhänger, Tasse, Aufkleber, Zeitschrift/Magazin, Lösungsbuch", () => {
    expect(isNonGameListing("Zelda Triforce Schlüsselanhänger")).toBe(true);
    // sellers routinely type the umlaut-less spelling
    expect(isNonGameListing("Zelda Triforce Schlusselanhanger")).toBe(true);
    expect(isNonGameListing("Zelda Schluesselanhaenger Metall")).toBe(true);
    expect(isNonGameListing("Super Mario Tasse Keramik")).toBe(true);
    expect(isNonGameListing("Sonic Aufkleber Set")).toBe(true);
    expect(isNonGameListing("Club Nintendo Zeitschrift Ausgabe 3")).toBe(true);
    expect(isNonGameListing("N64 Magazin Ausgabe 12")).toBe(true);
    expect(isNonGameListing("Zelda Ocarina of Time Lösungsbuch")).toBe(true);
  });
});

describe("Spanish listing vocabulary", () => {
  it("excludes manual-only listings: instrucciones / manual / manuales", () => {
    expect(isNonGameListing("The Legend of Zelda Ocarina of Time N64 instrucciones")).toBe(true);
    expect(isNonGameListing("Super Mario World SNES libro de instrucciones")).toBe(true);
    expect(isNonGameListing("Sonic 2 Mega Drive manuales")).toBe(true);
  });

  it("keeps a copy whose manual is merely declared: 'con manual' / 'sin instrucciones'", () => {
    expect(isNonGameListing("Zelda Ocarina of Time N64 completo con manual")).toBe(false);
    expect(isNonGameListing("Super Mario World SNES cartucho sin instrucciones")).toBe(false);
  });

  it("excludes the box alone: 'solo caja' / 'caja vacía'", () => {
    expect(isNonGameListing("Super Mario World SNES solo caja")).toBe(true);
    expect(isNonGameListing("Zelda Ocarina of Time N64 solo la caja")).toBe(true);
    expect(isNonGameListing("Sonic 2 Mega Drive caja vacía")).toBe(true);
  });

  it("reads the cartridge alone as loose: 'solo cartucho' / 'cartucho suelto' / 'sin caja'", () => {
    expect(condition("Zelda Ocarina of Time N64 solo cartucho")).toBe("loose");
    expect(condition("Super Mario World SNES solo el cartucho")).toBe("loose");
    expect(condition("Sonic 2 Mega Drive cartucho suelto")).toBe("loose");
    expect(condition("Sonic 2 Mega Drive cartucho sin caja")).toBe("loose");
  });

  it("TRAP: 'Sin and Punishment' is a real N64 game — the Spanish 'sin' must never eat it", () => {
    // measured 2026-09-03 on the dev catalog: "Sin and Punishment" (games),
    // "Batman - Rise Of Sin Tzu" and "Diabolik : The Original Sin"
    // (catalog_items) are the only titles carrying any of the words this
    // stage adds
    expect(isNonGameListing("Sin and Punishment N64 PAL Boxed Complete")).toBe(false);
    expect(isNonGameListing("Batman - Rise Of Sin Tzu PS2")).toBe(false);
    expect(cleanTitle("Sin and Punishment N64 PAL Boxed")).toBe("sin and punishment");
    // "original" is dropped by the pre-existing filler list, not by this
    // stage; what matters here is that the trailing "sin" survives
    expect(cleanTitle("Diabolik : The Original Sin, w/o Manual, Boxed")).toBe("diabolik the sin");
    // and the game's own manual is still not the game
    expect(isNonGameListing("Sin and Punishment N64 Manual Only")).toBe(true);
  });

  it("TRAP: a title ending in the word 'Con' keeps it — a real catalog title does", () => {
    // dev catalog: "Midnight Mysteries Edgar Allen Poe Con"
    expect(isNonGameListing("Midnight Mysteries Edgar Allen Poe Con")).toBe(false);
    expect(cleanTitle("Midnight Mysteries Edgar Allen Poe Con")).toBe("midnight mysteries edgar allen poe con");
  });

  it("excludes Spanish merchandise: llavero, taza, camiseta, pegatina, revista, guía oficial", () => {
    expect(isNonGameListing("Zelda Trifuerza llavero")).toBe(true);
    expect(isNonGameListing("Super Mario taza de cerámica")).toBe(true);
    expect(isNonGameListing("Sonic camiseta talla L")).toBe(true);
    expect(isNonGameListing("Zelda pegatinas pack")).toBe(true);
    expect(isNonGameListing("Nintendo Accion revista numero 50")).toBe(true);
    expect(isNonGameListing("Zelda Ocarina of Time guía oficial")).toBe(true);
  });
});

describe("French listing vocabulary", () => {
  it("excludes manual-only listings: notice / mode d'emploi", () => {
    expect(isNonGameListing("Notice Zelda Ocarina of Time Nintendo 64")).toBe(true);
    expect(isNonGameListing("Super Mario World SNES mode d'emploi")).toBe(true);
    expect(isNonGameListing("Sonic 2 Mega Drive mode d’emploi")).toBe(true);
  });

  it("TRAP: 'avec notice' / 'sans notice' describe the copy — the listing IS the game", () => {
    // the French twin of "boxed with manual" / "cart only, no manual"; without
    // the qualifier words a complete French copy would be dropped as a manual
    expect(isNonGameListing("Zelda Ocarina of Time N64 complet avec notice")).toBe(false);
    expect(isNonGameListing("Super Mario World SNES cartouche sans notice")).toBe(false);
  });

  it("excludes the box alone: 'boîte seule' / 'boîte vide' / 'boîtier seul'", () => {
    expect(isNonGameListing("Super Mario World SNES boîte seule")).toBe(true);
    expect(isNonGameListing("Zelda Ocarina of Time N64 boite vide")).toBe(true);
    expect(isNonGameListing("Final Fantasy IX PS1 boîtier seul")).toBe(true);
  });

  it("reads the cartridge alone as loose: 'cartouche seule' / 'sans boîte'", () => {
    expect(condition("Zelda Ocarina of Time N64 cartouche seule")).toBe("loose");
    expect(condition("Super Mario World SNES cartouche uniquement")).toBe("loose");
    expect(condition("Sonic 2 Mega Drive cartouche sans boîte")).toBe("loose");
  });

  it("TRAP: 'Mode Ontwerpster in Parijs' keeps its 'Mode' — only 'mode d'emploi' is a manual", () => {
    // dev catalog title (a real DS game), measured 2026-09-03
    expect(isNonGameListing("Mode Ontwerpster in Parijs Nintendo DS")).toBe(false);
    expect(cleanTitle("Mode Ontwerpster in Parijs")).toBe("mode ontwerpster in parijs");
  });

  it("excludes French merchandise: porte-clés, autocollant, affiche, peluche, guide officiel", () => {
    expect(isNonGameListing("Zelda porte-clés Triforce")).toBe(true);
    expect(isNonGameListing("Mario porte clefs metal")).toBe(true);
    expect(isNonGameListing("Sonic autocollants lot de 10")).toBe(true);
    expect(isNonGameListing("Zelda Ocarina of Time affiche A3")).toBe(true);
    expect(isNonGameListing("Pokemon Pikachu peluche")).toBe(true);
    expect(isNonGameListing("Zelda Ocarina of Time guide officiel")).toBe(true);
  });
});

describe("locale coverage is partial and says so", () => {
  it("does NOT cover Italian or Dutch: those manuals still read as games (known gap)", () => {
    // Not a desired outcome — a documented gap. eBay IT/NL are not markets
    // the eBay plugin serves today (see MARKETS in
    // retrowatchdog-ebay-plugin/src/manifest.ts), so no
    // live evidence exists for their wording and guessing it would be exactly
    // the "plausible word that silently never matches" trap.
    expect(isNonGameListing("Zelda Ocarina of Time N64 istruzioni")).toBe(false);
    expect(isNonGameListing("Zelda Ocarina of Time N64 handleiding")).toBe(false);
  });

  it("does NOT catch 'OVP ohne Spiel': the qualifier strip eats the 'ohne' (known gap)", () => {
    // Also not a desired outcome. COMPLETENESS_QUALIFIER blanks a qualifier
    // word plus the separators after it before ACCESSORY_TERMS run, so a
    // box-only phrase built AROUND a qualifier cannot be expressed as a term.
    // "nur OVP" and "leere OVP" are the common phrasings and are caught; see
    // the ACCESSORY_TERMS comment for why the qualifier is not tightened.
    expect(isNonGameListing("Zelda Ocarina of Time N64 OVP ohne Spiel")).toBe(false);
  });

  it("strips the new locale words out of the title the matcher compares", () => {
    expect(cleanTitle("Super Mario World SNES OVP mit Anleitung")).toBe("super mario world");
    expect(cleanTitle("Super Mario World SNES solo cartucho")).toBe("super mario world");
    expect(cleanTitle("Super Mario World SNES cartouche seule")).toBe("super mario world");
    expect(cleanTitle("Super Mario World SNES sin caja")).toBe("super mario world");
  });
});
