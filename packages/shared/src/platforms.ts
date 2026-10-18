/**
 * HOW TO ADD A CONSOLE
 *
 * 1. Add a Platform union member and its PLATFORMS entry (the Record makes a
 *    missing entry a compile error).
 *      - igdbId: from IGDB's /platforms endpoint.
 *      - cexCategoryHints: lowercase substrings of CeX's live
 *        categoryFriendlyName, verified against the live facet text PER
 *        COUNTRY (ES/IE do not rename the UK string by rule, e.g. "GBA Juegos");
 *        a guessed hint silently never matches. [] if CeX does not sell it.
 *      - titleKeywords: words that DETECT the platform in free-text titles
 *        (matched on word boundaries).
 *      - sellerSpellings: what the eBay query ASKS for; include the closed-up
 *        twin of every spaced spelling ("Game Boy" AND "Gameboy"), since eBay
 *        matches a group member as a phrase.
 * 2. If CeX sells it, add the exact per-country category name to
 *    DEFAULT_CEX_CATEGORIES / DEFAULT_CEX_ES_CATEGORIES / DEFAULT_CEX_IE_CATEGORIES
 *    in apps/api/src/config.ts. A country without the category stays short,
 *    with a comment saying the absence was measured.
 * 3. Append to DETECTION_ORDER (apps/api/src/adapters/familyReading.ts) and
 *    TITLE_DETECTION_ORDER (apps/api/src/adapters/classifyListing.ts); a
 *    platform whose hints could collide with another's must come first
 *    (neogeo_pocket_color before gbc, 3ds before ds).
 * 4. Tests: packages/shared/test/platforms.test.ts (count, igdbId,
 *    CLOSED_UP_CONSOLE_NAMES), apps/api/test/adapters/familyReading.test.ts
 *    (golden rows, FIXTURE_CATEGORIES), classifyListing.test.ts (keyword and
 *    disambiguation cases), and the matching entry in
 *    retrowatchdog-ebay-plugin/src/spellings.ts, which
 *    apps/api/test/deploy/pluginPackage.test.ts keeps identical to this table.
 */

export type Platform =
  | "nes" | "snes" | "n64" | "gb" | "gbc" | "gba"
  | "megadrive" | "master_system" | "game_gear" | "saturn" | "dreamcast"
  | "ps1" | "ps2" | "gamecube"
  | "neogeo_aes" | "neogeo_pocket_color"
  | "ds" | "3ds" | "virtual_boy" | "game_and_watch"
  | "pc";

export interface PlatformInfo {
  igdbId: number;
  /** further IGDB platforms read as this one (PC: DOS beside Windows) */
  extraIgdbIds?: number[];
  label: string;
  /** substrings expected in CeX categoryFriendlyName, lowercase */
  cexCategoryHints: string[];
  /** keywords used to detect the platform in free-text titles, lowercase */
  titleKeywords: string[];
  /**
   * How sellers write this console in a listing title; the eBay query is built
   * from it (first entry appended to a plain query, the whole list as the
   * platform group). Separate from titleKeywords because asking for a spelling
   * is always safe (the matcher verifies every result) while detecting on it
   * is not: a gb cart titled "... Nintendo GameBoy Color PAL Cartridge Only"
   * (probe 7) would be hidden by the platform filter. Not the UI label either:
   * eBay word-ANDs it and returns 0.
   */
  sellerSpellings: string[];
}

export const PLATFORMS: Record<Platform, PlatformInfo> = {
  nes: { igdbId: 18, label: "NES", cexCategoryHints: ["nes"], titleKeywords: ["nes", "nintendo entertainment system", "famicom"], sellerSpellings: ["NES", "Nintendo Entertainment System", "Famicom"] },
  // "super nes": CeX's live category is "Super NES Software", and without the
  // keyword "Super Mario World Super NES Cart Only" resolved to nes.
  snes: { igdbId: 19, label: "SNES", cexCategoryHints: ["super nintendo", "snes", "super nes"], titleKeywords: ["snes", "super nintendo", "super famicom", "super nes"], sellerSpellings: ["SNES", "Super Nintendo", "Super Famicom"] },
  // "nintendo 64": the live category is "Nintendo 64 Software".
  n64: { igdbId: 4, label: "N64", cexCategoryHints: ["n64", "nintendo 64"], titleKeywords: ["n64", "nintendo 64"], sellerSpellings: ["N64", "Nintendo 64"] },
  // Live category is "Game Boy Software"; "game boy juegos" is Spain's, and
  // cannot match "Game Boy Color Juegos".
  gb: { igdbId: 33, label: "Game Boy", cexCategoryHints: ["gameboy games", "game boy games", "game boy software", "game boy juegos"], titleKeywords: ["game boy", "gameboy"], sellerSpellings: ["Game Boy", "Gameboy"] },
  // gbc does NOT detect on "gameboy color"/"colour": sellers put those on plain
  // Game Boy carts (14 of 451 needs_review eBay rows; probe 7), and the platform
  // filter would hide the gb entry. It still ASKS eBay for them.
  gbc: { igdbId: 22, label: "Game Boy Color", cexCategoryHints: ["color", "colour"], titleKeywords: ["game boy color", "gbc"], sellerSpellings: ["Game Boy Color", "Gameboy Color", "Game Boy Colour", "Gameboy Colour", "GBC"] },
  // "gba" is Spain's category ("GBA Juegos").
  gba: { igdbId: 24, label: "GBA", cexCategoryHints: ["advance", "gba"], titleKeywords: ["gba", "game boy advance", "gameboy advance"], sellerSpellings: ["GBA", "Game Boy Advance", "Gameboy Advance"] },
  megadrive: { igdbId: 29, label: "Mega Drive", cexCategoryHints: ["mega drive"], titleKeywords: ["mega drive", "megadrive", "genesis"], sellerSpellings: ["Mega Drive", "Megadrive", "Genesis"] },
  master_system: { igdbId: 64, label: "Master System", cexCategoryHints: ["master system"], titleKeywords: ["master system"], sellerSpellings: ["Master System"] },
  game_gear: { igdbId: 35, label: "Game Gear", cexCategoryHints: ["game gear"], titleKeywords: ["game gear", "gamegear"], sellerSpellings: ["Game Gear", "GameGear"] },
  saturn: { igdbId: 32, label: "Saturn", cexCategoryHints: ["saturn"], titleKeywords: ["saturn"], sellerSpellings: ["Saturn"] },
  dreamcast: { igdbId: 23, label: "Dreamcast", cexCategoryHints: ["dreamcast"], titleKeywords: ["dreamcast"], sellerSpellings: ["Dreamcast"] },
  // "ps1" is Spain's category ("PS1 Juegos").
  ps1: { igdbId: 7, label: "PS1", cexCategoryHints: ["playstation1", "ps1"], titleKeywords: ["ps1", "playstation 1", "psx"], sellerSpellings: ["PS1", "PlayStation 1", "PSX"] },
  ps2: { igdbId: 8, label: "PS2", cexCategoryHints: ["playstation2"], titleKeywords: ["ps2", "playstation 2"], sellerSpellings: ["PS2", "PlayStation 2"] },
  gamecube: { igdbId: 21, label: "GameCube", cexCategoryHints: ["gamecube"], titleKeywords: ["gamecube", "game cube"], sellerSpellings: ["GameCube", "Game Cube"] },
  // CeX has no AES category: no CeX pricing for this platform.
  neogeo_aes: { igdbId: 80, label: "Neo Geo AES", cexCategoryHints: ["neo geo aes"], titleKeywords: ["neo geo aes", "neogeo aes"], sellerSpellings: ["Neo Geo AES", "NeoGeo AES"] },
  neogeo_pocket_color: { igdbId: 120, label: "NG Pocket Color", cexCategoryHints: ["neo geo pocket color"], titleKeywords: ["neo geo pocket color", "neo geo pocket colour", "neogeo pocket color", "neogeo pocket colour", "ngpc"], sellerSpellings: ["Neo Geo Pocket Color", "Neo Geo Pocket Colour", "NeoGeo Pocket Color", "NeoGeo Pocket Colour", "NGPC"] },
  // CeX's "DS Ware" category is deliberately NOT synced: digital titles, not
  // carts. The bare "ds" keyword is safe only because matching is word-boundary
  // based (not inside "kids"/"3ds").
  ds: { igdbId: 20, label: "Nintendo DS", cexCategoryHints: ["nintendo ds", "ds juegos"], titleKeywords: ["nintendo ds", "ds"], sellerSpellings: ["Nintendo DS", "DS"] },
  // MUST precede ds in both detection-order lists.
  "3ds": { igdbId: 37, label: "3DS", cexCategoryHints: ["3ds"], titleKeywords: ["3ds", "nintendo 3ds"], sellerSpellings: ["3DS", "Nintendo 3DS"] },
  virtual_boy: { igdbId: 87, label: "Virtual Boy", cexCategoryHints: ["virtual boy"], titleKeywords: ["virtual boy", "virtualboy"], sellerSpellings: ["Virtual Boy", "VirtualBoy"] },
  // CeX has no software/console split for Game & Watch. The "&" spellings reach
  // eBay unprobed; kept because dropping them drops the console's own name.
  game_and_watch: { igdbId: 307, label: "Game & Watch", cexCategoryHints: ["game & watch"], titleKeywords: ["game & watch", "game and watch", "game&watch"], sellerSpellings: ["Game & Watch", "Game and Watch", "Game&Watch"] },
  // IGDB 6 is "PC (Microsoft Windows)", 13 is DOS: a 90s game is often on only
  // one of them. CeX's live categories (2026-10-18): UK "PC Games" and
  // "PC CD-ROM", Spain "PC Juegos", Ireland "PC Games". No bare "pc" title
  // keyword: it would read every "PC Engine" listing as a PC game.
  pc: { igdbId: 6, extraIgdbIds: [13], label: "PC", cexCategoryHints: ["pc games", "pc cd-rom", "pc juegos"], titleKeywords: ["pc cd-rom", "pc cd rom", "pc cdrom", "pc dvd", "pc dvd-rom", "pc big box", "big box pc", "pc game", "ms-dos", "msdos"], sellerSpellings: ["PC"] },
};

/** Every IGDB platform id the catalogue imports, extras included. */
export const ALL_IGDB_PLATFORM_IDS: number[] = Object.values(PLATFORMS).flatMap((p) => [p.igdbId, ...(p.extraIgdbIds ?? [])]);

export const PLATFORM_IGDB_IDS: Record<Platform, number> = Object.fromEntries(
  Object.entries(PLATFORMS).map(([k, v]) => [k, v.igdbId]),
) as Record<Platform, number>;
