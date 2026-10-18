/**
 * Numeral tokens and the ONE numeral-compatibility predicate. Trigram
 * similarity is nearly blind to sequel numerals ("Sonic the Hedgehog" scores
 * 0.90 against "Sonic the Hedgehog 2"), so every matcher caps on them. The
 * matcher and the review sweep MUST both call numeralCompatible(), or a row
 * oscillates between them.
 */
import type { Platform } from "@retrowatchdog/shared";

// conservative range (I..XVI plus XX) so ordinary words never collide
const ROMAN_TO_ARABIC: Record<string, string> = {
  i: "1",
  ii: "2",
  iii: "3",
  iv: "4",
  v: "5",
  vi: "6",
  vii: "7",
  viii: "8",
  ix: "9",
  x: "10",
  xi: "11",
  xii: "12",
  xiii: "13",
  xiv: "14",
  xv: "15",
  xvi: "16",
  xx: "20",
};

/**
 * Returns the set of numeral tokens in a title, normalized to arabic digit
 * strings: "Street Fighter II" and "Street Fighter 2" both yield {"2"},
 * "Monster Hunter X" yields {"10"}, "Sonic the Hedgehog" yields {}.
 */
export function numeralTokens(title: string): Set<string> {
  const tokens = title
    .toLowerCase()
    // strip punctuation to spaces BEFORE splitting: "F-1" tokenizes as "f","1"
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 0)
    // split one letter off a digit run ("F1" -> "f","1"; "4G" -> "4"); a
    // trailing i/v/x is NOT split ("32x") or it would read as a roman numeral
    .flatMap((t) => {
      const leading = /^([a-z])(\d+)$/.exec(t);
      if (leading) return [leading[1], leading[2]];
      const trailing = /^(\d+)([a-hj-uwy-z])$/.exec(t);
      if (trailing) return [trailing[1], trailing[2]];
      return [t];
    });

  const numerals = new Set<string>();
  for (const token of tokens) {
    const arabic = ROMAN_TO_ARABIC[token];
    if (arabic !== undefined) numerals.add(arabic);
    else if (/^\d+$/.test(token)) numerals.add(token);
  }
  return numerals;
}

/** Set equality; two titles "numeral-agree" when their sets are equal. */
export function numeralSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

/** The catalog side of a numeral comparison. */
export interface NumeralGame {
  /** games.title */
  primaryTitle: string;
  /** game_names rows the listing may have been scored against (regional retitles live here) */
  names: readonly string[];
  /** games.year: lets a release year written in the listing pass as a year, not a sequel numeral */
  year?: number | null;
  /** games.platform: the N64 brand suffix ("Mario Kart 64") is forgiven when the listing omits it */
  platform?: Platform | string | null;
}

/** a 4-digit token in this range is a plausible release year (same window findGameCandidates uses for its year bonus) */
const YEAR_LIKE = /^(?:19[89]\d|200\d)$/;
/** IGDB carries the first (often JP) release year; UK sellers write the EU one, 1-3 years later */
const YEAR_TOLERANCE = 3;

function relaxedEqual(listing: Set<string>, title: Set<string>, game: NumeralGame): boolean {
  if (numeralSetsEqual(listing, title)) return true;
  const year = game.year ?? null;
  const listingRelaxed = new Set(listing);
  // a year-like token near the release year is the year ("SimCity 2000" is not)
  if (year !== null) {
    for (const token of listing) {
      if (YEAR_LIKE.test(token) && !title.has(token) && Math.abs(Number(token) - year) <= YEAR_TOLERANCE) {
        listingRelaxed.delete(token);
      }
    }
  }
  const titleRelaxed = new Set(title);
  // on N64 the "64" of "Mario Kart 64" is the console brand, not a sequel
  if (game.platform === "n64" && !listing.has("64")) titleRelaxed.delete("64");
  return numeralSetsEqual(listingRelaxed, titleRelaxed);
}

/**
 * THE numeral rule: the listing's numerals equal those of the primary title or
 * of any given name. The listing title must already be cleaned (platform words
 * like "N64" would read as numerals). No numerals vs some IS a mismatch.
 */
export function numeralCompatible(cleanedListingTitle: string, game: NumeralGame): boolean {
  const listing = numeralTokens(cleanedListingTitle);
  const titles = [game.primaryTitle, ...game.names];
  return titles.some((title) => relaxedEqual(listing, numeralTokens(title), game));
}
