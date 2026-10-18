import type { Condition, Platform, Region } from "@retrowatchdog/shared";

/**
 * PriceCharting console-name → platform/region. The region is a prefix
 * ("PAL GameBoy", "JP Nintendo 64"); no prefix means NTSC_U.
 */

export interface PcConsoleMapping {
  platform: Platform;
  region: Region;
}

interface BaseConsoleEntry {
  platform: Platform;
  /** overrides the prefix-derived region (Famicom lines are always NTSC_J) */
  forcedRegion?: Region;
}

const BASE_CONSOLES: Record<string, BaseConsoleEntry> = {
  gameboy: { platform: "gb" },
  "gameboy color": { platform: "gbc" },
  "gameboy advance": { platform: "gba" },
  "nintendo 64": { platform: "n64" },
  nes: { platform: "nes" },
  "super nintendo": { platform: "snes" },
  gamecube: { platform: "gamecube" },
  famicom: { platform: "nes", forcedRegion: "NTSC_J" },
  "super famicom": { platform: "snes", forcedRegion: "NTSC_J" },
  "neo geo aes": { platform: "neogeo_aes" },
  "neo geo pocket color": { platform: "neogeo_pocket_color" },
  "sega game gear": { platform: "game_gear" },
  "sega master system": { platform: "master_system" },
  "sega genesis": { platform: "megadrive" },
  "sega mega drive": { platform: "megadrive" }, // PAL naming of the same catalog
  playstation: { platform: "ps1" },
  "playstation 2": { platform: "ps2" },
  "sega saturn": { platform: "saturn" },
  "sega dreamcast": { platform: "dreamcast" },
  "nintendo ds": { platform: "ds" },
  "nintendo 3ds": { platform: "3ds" },
  "virtual boy": { platform: "virtual_boy" },
  // parse.ts decodes &amp; before mapping, so the key is the literal ampersand
  "game & watch": { platform: "game_and_watch" },
};

/** Returns null for consoles RetroWatchdog does not support (yet). */
export function mapConsoleName(consoleName: string): PcConsoleMapping | null {
  let name = consoleName.trim();
  let region: Region = "NTSC_U"; // no prefix = US market
  if (name.startsWith("PAL ")) {
    region = "PAL";
    name = name.slice(4).trim();
  } else if (name.startsWith("JP ")) {
    region = "NTSC_J";
    name = name.slice(3).trim();
  }
  const entry = BASE_CONSOLES[name.toLowerCase()];
  if (!entry) return null;
  return { platform: entry.platform, region: entry.forcedRegion ?? region };
}

/**
 * PriceCharting includes-text → condition. Only shapes naming a priced tier
 * get one; "Item and Manual" stays unknown (no source prices that set).
 */
export function mapIncludes(includes: string): Condition {
  const normalized = includes.trim().toLowerCase();
  if (normalized === "item, box, and manual") return "cib";
  if (normalized === "item" || normalized === "item only") return "loose";
  if (/^item and box(?: only)?$/.test(normalized)) return "boxed_no_manual";
  if (/\b(sealed|new)\b/.test(normalized)) return "new";
  return "unknown";
}
