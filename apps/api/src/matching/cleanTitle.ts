import {
  COMPLETENESS_PHRASE,
  CONDITION_WORDS,
  GRADE_TIERS,
  NOISE_WORDS,
  REGION_WORDS,
  foldDiacritics,
  wordsPattern,
} from "./vocabulary.js";

const REGION_FRAGMENTS = [
  ...NOISE_WORDS.region,
  ...REGION_WORDS.NTSC_J,
  ...REGION_WORDS.NTSC_U,
  ...REGION_WORDS.PAL,
  ...REGION_WORDS.IMPORT,
];
const CONDITION_FRAGMENTS = [
  ...CONDITION_WORDS.new,
  ...CONDITION_WORDS.loose,
  ...CONDITION_WORDS.cib,
  ...NOISE_WORDS.condition,
];

/**
 * A parenthetical mentioning ANY noise word goes as a whole ("(Nintendo Game
 * Boy, 1990)"), or its leftover year would read as a sequel numeral.
 */
const PAREN_FRAGMENTS = [
  ...REGION_FRAGMENTS,
  ...CONDITION_FRAGMENTS,
  ...NOISE_WORDS.grade,
  ...NOISE_WORDS.accessory,
  ...NOISE_WORDS.filler,
  ...NOISE_WORDS.platform,
  ...NOISE_WORDS.codes,
  ...NOISE_WORDS.parenthesisedVariant,
];
const PAREN_NOISE = new RegExp(`\\([^)]*\\b(?:${PAREN_FRAGMENTS.join("|")})\\b[^)]*\\)`, "g");

/** Order is load-bearing: longer phrases before the words they contain. */
const STRIP_PATTERNS: readonly RegExp[] = [
  COMPLETENESS_PHRASE,
  wordsPattern(NOISE_WORDS.platform, "g"),
  wordsPattern(NOISE_WORDS.codes, "g"),
  wordsPattern(REGION_FRAGMENTS, "g"),
  wordsPattern(CONDITION_FRAGMENTS, "g"),
  wordsPattern(NOISE_WORDS.grade, "g"),
  ...GRADE_TIERS.flatMap((tier) => tier.patterns.map((re) => new RegExp(re.source, "g"))),
  wordsPattern(NOISE_WORDS.accessory, "g"),
  wordsPattern(NOISE_WORDS.filler, "g"),
];

/** a parenthetical left with only digits/punctuation: PEGI "(12)", a stock code "(1726)", CeX's "(6)" after "VI" */
const EMPTY_PAREN = /\(\s*[\d\s,.\-/'"&+]*\)/g;

/** Connectors the strips leave dangling, only at the edges ("Beavis and Butt-Head" keeps its). */
const LEADING_CONNECTOR = /^(?:(?:for|and|with|of|in|on|&)\s+)+/;
const TRAILING_CONNECTOR = /(?:\s+(?:for|and|with|of|in|on|only|the|&))+$/;

/**
 * Lowercase, fold diacritics, strip listing noise (./vocabulary.ts), collapse
 * punctuation: what trigram similarity and the numeral rule see.
 */
export function cleanTitle(rawTitle: string): string {
  let s = foldDiacritics(rawTitle.toLowerCase());
  s = s.replace(PAREN_NOISE, " ");
  // global regexes: String.replace always scans from 0 and resets lastIndex
  for (const pattern of STRIP_PATTERNS) s = s.replace(pattern, " ");
  s = s.replace(EMPTY_PAREN, " ");
  s =s.replace(/[^\p{L}\p{N}\s]+/gu, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(LEADING_CONNECTOR, "").replace(TRAILING_CONNECTOR, "");
  return s;
}
