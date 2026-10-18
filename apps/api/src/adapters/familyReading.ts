/**
 * The app's reading of a source family's own category vocabulary. Reading a
 * shop's shelf names is the app's job, not the plugin's: a plugin may not send
 * a platform, region, condition or grade, so the reading is selected by the
 * manifest's `family`.
 *
 * Only CeX has a reading: its hints were measured from live facet lists
 * (`retrowatchdog-cex-plugin/fixtures/country-categories-2026-09-03.md`) and mean
 * nothing on another shop. A family with no reading is classified from titles.
 *
 * ponytail: two branches on one family, not a table keyed by family. Make it a
 * table at the second family that needs a reading.
 */

import { PLATFORMS, type Platform } from "@retrowatchdog/shared";

/**
 * Most specific first so "Gameboy Color/Advance" do not fall through to gb
 * (see HOW TO ADD A CONSOLE in packages/shared/src/platforms.ts).
 * neogeo_pocket_color must precede gbc: CeX's "Neo Geo Pocket Color Software"
 * contains gbc's generic hint "color". 3ds stays ahead of ds to mirror the
 * eBay title list, where that order is load-bearing.
 */
const DETECTION_ORDER: Platform[] = [
  "neogeo_pocket_color",
  "gbc", "gba", "gb", "n64", "snes", "nes", "megadrive",
  "master_system", "game_gear", "saturn", "dreamcast",
  "ps1", "ps2", "gamecube",
  "neogeo_aes",
  "3ds", "ds", "virtual_boy", "game_and_watch", "pc",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary match, not substring: the same "genesis" contains "nes" trap as eBay titles. */
function matchesHint(lower: string, hint: string): boolean {
  return new RegExp(`\\b${escapeRegExp(hint)}\\b`).test(lower);
}

/**
 * The platform a shop's own category text names, or null when this build
 * cannot read it. Family-blind on purpose: callers use it as the last fallback
 * after the title, and a miss just returns null. `familyCategoryHints` is
 * family-keyed because it drops rows.
 */
export function detectPlatformFromCategory(category: string): Platform | null {
  const lower = category.toLowerCase();
  for (const platform of DETECTION_ORDER) {
    if (PLATFORMS[platform].cexCategoryHints.some((hint) => matchesHint(lower, hint))) {
      return platform;
    }
  }
  return null;
}

/**
 * The category words that mean "this platform" for this family, or none when
 * the app has no reading for it. Used only to prefer rows (the matcher's hard
 * platform filter decides correctness); family-keyed because applying CeX's
 * words to another shop would drop that shop's rows.
 */
export function familyCategoryHints(family: string, platform: Platform): readonly string[] {
  return family === "cex" ? PLATFORMS[platform].cexCategoryHints : [];
}

/** Whether a row's own category text carries any of those words, whole. */
export function matchesAnyHint(categoryText: string | null, hints: readonly string[]): boolean {
  const text = (categoryText ?? "").toLowerCase();
  return hints.some((hint) => matchesHint(text, hint));
}
