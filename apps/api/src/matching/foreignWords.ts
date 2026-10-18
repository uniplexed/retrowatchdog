import { numeralTokens } from "./numerals.js";

/**
 * Words a title can drop or add without naming a different game. Numerals are
 * not here: numerals.ts owns them, and a sequel number is its rule's business.
 */
const FILLER = new Set([
  "the", "of", "a", "an", "and", "to", "in", "on", "for", "with", "vs", "s",
  "de", "la", "le", "el", "der", "die", "das", "du", "des", "et", "und", "y",
]);

/** Two-letter words ("gb", "hq", "tm") and anything with a digit are codes or numerals, never a title's own word. */
const isFiller = (word: string): boolean => FILLER.has(word) || word.length <= 2 || /\d/.test(word) || numeralTokens(word).size > 0;

/** Same stem: "gold"/"golden", "simulation"/"simulator", "generations"/"generationgeneration". */
function sameStem(a: string, b: string): boolean {
  if (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i >= 6;
}

/** One edit apart, transpositions included, for words of 4+ letters: "wily"/"willy", "ulitmate"/"ultimate". */
function oneTypoApart(a: string, b: string): boolean {
  if (a === b || sameStem(a, b)) return true;
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** Dice overlap of letter pairs: "ichishou"/"isshou" 0.67 (a romanisation), "lego"/"land" 0 (another word). */
function lettersAlike(a: string, b: string): boolean {
  const pairs = (w: string) => Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2));
  const pa = pairs(a);
  const pb = pairs(b);
  const shared = pa.filter((p) => pb.includes(p)).length;
  return (2 * shared) / (pa.length + pb.length) >= 0.5;
}

/** `word` is accounted for by `other`: same word, a typo of one, or part of it with spaces dropped ("out run" / "outrun"). */
function explainedBy(word: string, otherWords: string[], otherJoined: string): boolean {
  return otherJoined.includes(word) || otherWords.some((o) => oneTypoApart(word, o));
}

/**
 * Whether a cleaned listing title names a DIFFERENT game than a cleaned game
 * name that trigram similarity scored well. Two shapes, both measured against
 * every confirmed mapping on 2026-09-19:
 * - a foreign word INSIDE the name's span: "mario party 64" against "mario 64".
 *   Seller junk sits at the edges ("spiel", "capcom", "modul"); a word between
 *   the name's own words is another title.
 * - both sides disagree: the name has a word the listing lacks AND the listing
 *   has one the name lacks ("super mario lego" / "super mario land").
 * Either one caps the candidate under the confirm threshold, like a numeral
 * mismatch: it can still be reviewed, never confirmed on its own.
 */
export function foreignTitleWord(cleanedListing: string, cleanedName: string): string | null {
  const listing = cleanedListing.split(" ").filter(Boolean);
  const name = cleanedName.split(" ").filter(Boolean);
  const listingJoined = listing.join("");
  const nameJoined = name.join("");
  const nameCore = name.filter((w) => !isFiller(w));

  // Align the name's words to the listing in order, each used once. Numerals
  // anchor the span ("mario 64") though they are never foreign themselves.
  const anchors = name.filter((w) => !FILLER.has(w));
  const matched: Array<{ at: number; nameIndex: number }> = [];
  let from = 0;
  anchors.forEach((word, nameIndex) => {
    const at = listing.findIndex((w, i) => i >= from && oneTypoApart(w, word));
    if (at >= 0) {
      matched.push({ at, nameIndex });
      from = at + 1;
    }
  });
  // An INSERTION between two consecutive name words is another title; a word
  // standing where a name word went missing is a spelling of it.
  for (let k = 0; k + 1 < matched.length; k++) {
    if (matched[k + 1].nameIndex !== matched[k].nameIndex + 1) continue;
    for (let i = matched[k].at + 1; i < matched[k + 1].at; i++) {
      const word = listing[i];
      if (!isFiller(word) && !explainedBy(word, name, nameJoined)) return word;
    }
  }

  const missing = nameCore.filter((w) => !explainedBy(w, listing, listingJoined));
  const extra = listing.filter((w) => !isFiller(w) && !explainedBy(w, name, nameJoined));
  const unpaired = (words: string[], others: string[]) => words.filter((w) => !others.some((o) => lettersAlike(w, o)));
  const foreign = unpaired(extra, missing);
  return unpaired(missing, extra).length > 0 && foreign.length > 0 ? foreign[0] : null;
}
