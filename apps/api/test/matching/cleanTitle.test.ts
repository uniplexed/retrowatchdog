import { describe, it, expect } from "vitest";
import { cleanTitle } from "../../src/matching/cleanTitle.js";

describe("cleanTitle", () => {
  it("strips a fully loaded eBay title down to the game name", () => {
    expect(
      cleanTitle("Legend of Zelda Ocarina of Time N64 PAL Boxed Complete CIB Tested Working"),
    ).toBe("legend of zelda ocarina of time");
  });

  it("strips CeX variant suffixes and parenthesised noise", () => {
    expect(cleanTitle("Legend Of Zelda Ocarina Of Time (Gold Cartridge), Boxed")).toBe(
      "legend of zelda ocarina of time",
    );
    expect(cleanTitle("Legend of Zelda: Ocarina of Time (Gold Cart) (AUS), Mint")).toBe(
      "legend of zelda ocarina of time",
    );
    expect(cleanTitle("Shenmue 2 (4Discs), w/o Manual, Boxed")).toBe("shenmue 2");
    expect(cleanTitle("Legend of Legacy, The (12)")).toBe("legend of legacy");
  });

  it("strips platform words including compound ones", () => {
    expect(cleanTitle("Jurassic Park Sega Mega Drive Genesis JAP Import")).toBe("jurassic park");
    expect(cleanTitle("Pokemon Red Game Boy Color")).toBe("pokemon red");
    expect(cleanTitle("Super Nintendo SNES - Super Famicom Console Game - Street Fighter II - NTSC USA")).toBe("street fighter ii");
  });

  it("strips ps1/ps2/gamecube-era platform words", () => {
    expect(cleanTitle("Gran Turismo PS2 PAL")).toBe("gran turismo");
    expect(cleanTitle("Mario Sunshine GameCube")).toBe("mario sunshine");
    expect(cleanTitle("Final Fantasy VII PSX")).toBe("final fantasy vii");
  });

  it("keeps regular words intact", () => {
    expect(cleanTitle("Super Mario World")).toBe("super mario world");
    expect(cleanTitle("Sonic the Hedgehog 2")).toBe("sonic the hedgehog 2");
  });

  // The eBay recall defect: 451 of 1,291 eBay mappings sat in needs_review
  // because grade/condition/region/marketplace prose diluted similarity to
  // 0.35-0.6. Every word stripped here is one the adapters already read.
  it("strips the grade vocabulary the shared classifier grades every source's titles with", () => {
    expect(cleanTitle("Mario Kart 64 N64 PAL VGC")).toBe("mario kart 64");
    expect(cleanTitle("Zelda Ocarina of Time N64 Near Mint boxed")).toBe("zelda ocarina of time");
    expect(cleanTitle("Street Fighter II Super Nintendo SNES Game Cartridge In Good Condition")).toBe("street fighter ii");
    expect(cleanTitle("Supa Monaco GP For Sega Game Gear. Cartridge Only, Great Condition.")).toBe("supa monaco gp");
    expect(cleanTitle("Super Mario 64 cart, not damaged, fully tested")).toBe("super mario 64");
  });

  it("strips completeness qualifiers and accessory chains as units", () => {
    expect(cleanTitle("The Legend of Zelda: Ocarina Of Time Nintendo 64 - Cartridge, Manual And Case")).toBe(
      "the legend of zelda ocarina of time",
    );
    expect(cleanTitle("Nintendo NES Mega Man 4 Boxed without Manual")).toBe("mega man 4");
    expect(cleanTitle("F-1 Race (Gameboy) *NO BOX * NO MANUAL*")).toBe("f 1 race");
    expect(cleanTitle("Nintendo Game Boy Game - Mega Man - Dr. Wily's Revenge - With Box and Manual")).toBe(
      "mega man dr wily s revenge",
    );
  });

  it("strips region tokens, '<region> version' phrases and product codes", () => {
    expect(cleanTitle("WARIO LAND SUPER MARIOLAND 3 Nintendo Game Boy JAPANESE Version Game Gameboy")).toBe(
      "wario land super marioland 3",
    );
    expect(cleanTitle("Final Fantasy Tactics Advance Nintendo Game Boy Advance Cartridge AGB-AFXP-EUR")).toBe(
      "final fantasy tactics advance",
    );
    expect(cleanTitle("Nintendo Gameboy genuine Double Dragon game tested GC cart only UKV")).toBe("double dragon");
    expect(cleanTitle("SEGA Sonic the Hedgehog 2 Cartridge for Sega Mega Drive (MPN 670-2479-50)")).toBe(
      "sonic the hedgehog 2",
    );
    expect(cleanTitle("Buffy the Vampire Slayer (Nintendo Game Boy Color, 2000) - European Version")).toBe(
      "buffy the vampire slayer",
    );
    // CeX's barcode cross-reference note: a 12-digit run is never a sequel numeral
    expect(cleanTitle("Brain Age 2: More Training In Minutes A Day *USE 045496739010*")).toBe(
      "brain age 2 more training in minutes a day",
    );
  });

  it("strips marketplace filler and dangling connectors, and folds diacritics", () => {
    expect(cleanTitle("Sonic the hedgehog - Sega Game Gear Cartridge PAL - Tested and working")).toBe("sonic the hedgehog");
    expect(cleanTitle("Buffy The Vampire Slayer Game Boy Color Gameboy GBC Retro Vintage Nostalgia")).toBe(
      "buffy the vampire slayer",
    );
    expect(cleanTitle("japanese version of mario kart, boxed no manual, n64 Vgc.")).toBe("mario kart");
    expect(cleanTitle("Pokémon Red Version 1999 Nintendo Game Boy Genuine New Battery Retro PAL")).toBe(
      "pokemon red version 1999",
    );
    expect(cleanTitle("Wario Land Super Mario Land 3 Nintendo Game Boy Japanese Version 🇬🇧 UK Seller")).toBe(
      "wario land super mario land 3",
    );
  });

  it("keeps 'game' where it names the game: Game & Watch and N-games-in-1 titles", () => {
    expect(cleanTitle("Game & Watch Gallery 2 Game Boy Color")).toBe("game watch gallery 2");
    expect(cleanTitle("2 Games in 1: Finding Nemo + The Incredibles GBA")).toBe("2 games in 1 finding nemo the incredibles");
    expect(cleanTitle("Sega Game Gear Game Outrun")).toBe("outrun");
  });

  it("never strips 'version' on its own nor 'super': they name games", () => {
    expect(cleanTitle("Pokémon Red Version")).toBe("pokemon red version");
    expect(cleanTitle("Super Mario Kart, Mint")).toBe("super mario kart");
  });
});
