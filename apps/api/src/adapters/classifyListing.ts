import { PLATFORMS, type Condition, type ItemGrade, type Platform, type Region } from "@retrowatchdog/shared";
import type { NormalizedListing, RawListing } from "./types.js";
import { cleanTitle } from "../matching/cleanTitle.js";
import { applyDefaultRegion } from "./defaultRegion.js";
import { detectPlatformFromCategory } from "./familyReading.js";
import {
  BARE_CART,
  CONDITION_CIB,
  CONDITION_LOOSE,
  CONDITION_NEW,
  GRADE_TIERS,
  REGION_NTSC_J,
  REGION_NTSC_U,
  REGION_PAL,
  foldDiacritics,
} from "../matching/vocabulary.js";

/**
 * Reading a free-text listing title: platform, region, completeness tier,
 * cosmetic grade, and the cleaned title the matcher searches with. ONE
 * implementation for every source, because comparing two sources' prices for
 * the same game, region and condition only holds while one piece of code makes
 * those judgements; a drifted copy fails silently. Plugins never classify.
 */

/**
 * Most specific first. snes precedes nes so "super famicom" beats the bare
 * "famicom" it contains. neogeo_* can sit last only while none of their
 * keywords is a phrase inside another platform's keywords; re-check that
 * invariant when adding spellings. 3ds precedes ds ("Nintendo 3DS 2DS DS
 * compatible"); bare "ds" is safe only because matching is word-boundary.
 * game_and_watch stays after the gb family: "Game & Watch Gallery" titles are
 * Game Boy carts.
 */
const TITLE_DETECTION_ORDER: Platform[] = [
  "gbc", "gba", "gb", "n64", "snes", "nes", "megadrive",
  "master_system", "game_gear", "saturn", "dreamcast",
  "ps1", "ps2", "gamecube",
  "neogeo_aes", "neogeo_pocket_color",
  "3ds", "ds", "virtual_boy", "game_and_watch", "pc",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary match, not substring: "genesis" must not match the "nes" keyword. */
function matchesKeyword(lower: string, keyword: string): boolean {
  return new RegExp(`\\b${escapeRegExp(keyword)}\\b`).test(lower);
}

/**
 * "Game Boy Color Advance", in any spelling: a seller listing the whole
 * handheld family on a plain Game Boy cart. Measured: 14 of 451 needs_review
 * eBay rows, and the hard platform filter hides the gb entry whenever gbc or
 * gba wins. Neutralised to "game boy" so spacing cannot change the answer.
 */
const GB_FAMILY_COMPATIBILITY_LIST = /\bgame\s?boy\s+colou?r\s+advance\b/g;

export function detectPlatformFromTitle(title: string): Platform | null {
  const lower = title.toLowerCase().replace(GB_FAMILY_COMPATIBILITY_LIST, "game boy");
  for (const platform of TITLE_DETECTION_ORDER) {
    if (PLATFORMS[platform].titleKeywords.some((k) => matchesKeyword(lower, k))) return platform;
  }
  return null;
}

/** Region/condition/grade words come from matching/vocabulary.ts, the same lists cleanTitle strips. */
export function detectRegionFromTitle(title: string): Region {
  const lower = title.toLowerCase();
  // NTSC_J first: "NTSC-J" must never fall through to the bare NTSC rule
  if (REGION_NTSC_J.test(lower)) return "NTSC_J";
  if (REGION_NTSC_U.test(lower)) return "NTSC_U";
  if (REGION_PAL.test(lower)) return "PAL";
  // Never guessed from the marketplace's country: a British seller lists Japanese imports too.
  return "unknown";
}

/** "no manual", "without manual", "w/o manual", "missing instructions" */
const NO_MANUAL = /\b(?:no|without|w\/o|missing)\s+(?:the\s+)?(?:manuals?|instructions?|booklet)\b/;
/** a negated box ("no box", "without box") is the cartridge alone, whatever else the title claims */
const NO_BOX = /\b(?:no|without|w\/o|missing)\s+(?:the\s+)?box(?:es)?\b/;
/** a box is claimed: "box"/"boxed", or a completeness claim ("cib", "complete") */
const BOX_CLAIMED = /\bbox(?:ed)?\b|\bcib\b|\bcomplete\b/;

/**
 * Completeness tiers from free-text titles, most explicit first:
 * 1. new — structured condition field or sealed vocabulary;
 * 2. loose — "cart only", "no box", ...: checked BEFORE the boxed tiers because
 *    "no box no manual" carries the word "box";
 * 3. boxed_no_manual — a box claim plus a missing-manual phrase ("boxed, no
 *    manual", "box no manual", "cib no manual"): the seller's own words say
 *    the set is not complete, so it must never read as cib;
 * 4. loose — the bare "cart" word (weak signal, so it yields to a boxed tier:
 *    "boxed cart no manual" is a boxed copy);
 * 5. cib — "boxed"/"cib"/"complete" with no missing-manual phrase.
 *
 * `conditionField` is the source's own STRUCTURED condition value where it has
 * one (eBay's "New"/"Pre-owned"); most second-hand marketplaces have none.
 */
export function detectConditionFromTitle(title: string, conditionField?: string): Condition {
  // folded: the de/es/fr completeness phrases are written unaccented
  const lower = foldDiacritics(title.toLowerCase());
  if (conditionField?.toLowerCase() === "new" || CONDITION_NEW.test(lower)) return "new";
  if (CONDITION_LOOSE.test(lower) || NO_BOX.test(lower)) return "loose";
  // a claimed box plus a "no manual" phrase is the boxed-without-manual tier;
  // checked before the bare-cart rule so "boxed no manual cart" is not loose
  if (BOX_CLAIMED.test(lower) && NO_MANUAL.test(lower)) return "boxed_no_manual";
  // free text: a bare "cart" ("SNES game cart") is the cartridge alone
  if (BARE_CART.test(lower)) return "loose";
  if (CONDITION_CIB.test(lower)) return "cib";
  return "unknown";
}

/** First GRADE_TIERS tier with a hit wins (poor -> fair -> near_mint -> mint -> very_good -> good). */
export function detectGradeFromTitle(title: string): ItemGrade | null {
  const lower = title.toLowerCase();
  for (const tier of GRADE_TIERS) {
    if (tier.patterns.some((re) => re.test(lower))) return tier.grade;
  }
  return null;
}

/**
 * Consoles this app has no platform for, as sellers write them. Word-bounded
 * on the lowercased title. Only consulted when no tracked platform is named:
 * "Sonic Adventure 2 Dreamcast, not the GameCube or Xbox port" is a Dreamcast
 * listing. A bare "switch" or "wii" in a retro title is rare enough that
 * dropping such a listing costs less than pricing a Switch copy as a retro one.
 */
const UNTRACKED_CONSOLE =
  /\b(xbox|ps[345]|playstation [345]|psp|ps ?vita|switch|wii|mega ?cd|sega cd|32x|pc engine|turbografx|neo ?geo cd|3do|atari|jaguar|lynx|wonderswan|n-gage|amiga|commodore 64|c64|msx)\b/i;

export function namesUntrackedConsole(title: string): boolean {
  return UNTRACKED_CONSOLE.test(title);
}

/** The whole reading. Availability passes through: it is what the source says, not the title. */
export function classifyListing(raw: RawListing): NormalizedListing {
  const platformGuess = detectPlatformFromTitle(raw.title);
  return {
    ...raw,
    cleanTitle: cleanTitle(raw.title),
    platformGuess,
    foreignPlatform: platformGuess === null && namesUntrackedConsole(raw.title),
    regionGuess: detectRegionFromTitle(raw.title),
    conditionGuess: detectConditionFromTitle(raw.title, raw.conditionText),
    gradeGuess: detectGradeFromTitle(raw.title),
  };
}

/**
 * The same reading for a shop catalogue row, with two differences:
 * - the shop's category beats the title on platform ("Super Mario Advance" is a
 *   GBA cart named after the SNES original), since a wrong confirmed mapping is kept;
 * - a title naming no region takes the shop's declared default (see applyDefaultRegion).
 */
export function classifyCatalogListing(
  raw: RawListing,
  defaultRegion: Region | null,
): NormalizedListing {
  const classified = classifyListing(raw);
  const fromCategory = raw.categoryText ? detectPlatformFromCategory(raw.categoryText) : null;
  return {
    ...classified,
    platformGuess: fromCategory ?? classified.platformGuess,
    regionGuess: applyDefaultRegion(classified.regionGuess, raw.title, defaultRegion),
  };
}
