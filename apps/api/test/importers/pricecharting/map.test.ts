import { describe, it, expect } from "vitest";
import { mapConsoleName, mapIncludes } from "../../../src/importers/pricecharting/map.js";

describe("mapConsoleName", () => {
  // golden table: [PriceCharting console name, platform, region]
  const supported: Array<[string, string, string]> = [
    ["GameBoy", "gb", "NTSC_U"],
    ["PAL GameBoy", "gb", "PAL"],
    ["JP GameBoy", "gb", "NTSC_J"],
    ["GameBoy Color", "gbc", "NTSC_U"],
    ["GameBoy Advance", "gba", "NTSC_U"],
    ["PAL GameBoy Advance", "gba", "PAL"],
    ["JP GameBoy Advance", "gba", "NTSC_J"],
    ["Nintendo 64", "n64", "NTSC_U"],
    ["NES", "nes", "NTSC_U"],
    ["Super Nintendo", "snes", "NTSC_U"],
    ["PAL Super Nintendo", "snes", "PAL"],
    ["Gamecube", "gamecube", "NTSC_U"],
    ["Famicom", "nes", "NTSC_J"],
    ["Super Famicom", "snes", "NTSC_J"],
    ["Neo Geo AES", "neogeo_aes", "NTSC_U"],
    ["JP Neo Geo AES", "neogeo_aes", "NTSC_J"],
    ["Neo Geo Pocket Color", "neogeo_pocket_color", "NTSC_U"],
    ["Sega Game Gear", "game_gear", "NTSC_U"],
    ["PAL Sega Game Gear", "game_gear", "PAL"],
    ["Sega Master System", "master_system", "NTSC_U"],
    ["Sega Genesis", "megadrive", "NTSC_U"],
    ["PAL Sega Mega Drive", "megadrive", "PAL"],
    ["Playstation", "ps1", "NTSC_U"],
    ["Playstation 2", "ps2", "NTSC_U"],
    ["Sega Saturn", "saturn", "NTSC_U"],
    ["JP Sega Saturn", "saturn", "NTSC_J"],
    ["Sega Dreamcast", "dreamcast", "NTSC_U"],
    ["JP Sega Dreamcast", "dreamcast", "NTSC_J"],
    ["Nintendo DS", "ds", "NTSC_U"],
    ["JP Nintendo DS", "ds", "NTSC_J"],
    ["Nintendo 3DS", "3ds", "NTSC_U"],
    ["JP Nintendo 3DS", "3ds", "NTSC_J"],
    ["PAL Nintendo 3DS", "3ds", "PAL"],
    ["Virtual Boy", "virtual_boy", "NTSC_U"],
    ["JP Virtual Boy", "virtual_boy", "NTSC_J"],
    ["Game & Watch", "game_and_watch", "NTSC_U"],
  ];
  it.each(supported)("%s -> %s / %s", (name, platform, region) => {
    expect(mapConsoleName(name)).toEqual({ platform, region });
  });

  it("forces NTSC_J for Famicom lines regardless of prefix", () => {
    expect(mapConsoleName("JP Famicom")).toEqual({ platform: "nes", region: "NTSC_J" });
    expect(mapConsoleName("PAL Super Famicom")).toEqual({ platform: "snes", region: "NTSC_J" });
  });

  // genuinely unsupported: consoles absent from the Platform union
  const unsupported = [
    "Famicom Disk System",
    "Wii",
    "JP Wii",
    "Playstation 3",
    "",
  ];
  it.each(unsupported)("'%s' is unsupported", (name) => {
    expect(mapConsoleName(name)).toBeNull();
  });

  it("compares base names case-insensitively", () => {
    expect(mapConsoleName("gameboy advance")).toEqual({ platform: "gba", region: "NTSC_U" });
    expect(mapConsoleName("PAL sega game gear")).toEqual({ platform: "game_gear", region: "PAL" });
  });
});

describe("mapIncludes", () => {
  const table: Array<[string, string]> = [
    ["Item, Box, and Manual", "cib"],
    ["Item", "loose"],
    ["Item Only", "loose"],
    ["Item only", "loose"], // the live page's actual casing
    ["Sealed", "new"],
    ["Brand New", "new"],
    ["Item (Sealed)", "new"],
    // game + box, manual missing: the boxed_no_manual tier
    ["Item and Box", "boxed_no_manual"],
    ["Item and Box only", "boxed_no_manual"],
    ["item and box", "boxed_no_manual"],
    // game + manual, no box: there is no such priced tier, stays unknown
    ["Item and Manual", "unknown"],
    ["Item and Manual only", "unknown"],
    ["Box Only", "unknown"],
    ["Manual Only", "unknown"],
    ["", "unknown"],
    // word boundary: "new" inside another word must not read as sealed/new
    ["Manual for Newton", "unknown"],
  ];
  it.each(table)("'%s' -> %s", (includes, condition) => {
    expect(mapIncludes(includes)).toBe(condition);
  });
});
