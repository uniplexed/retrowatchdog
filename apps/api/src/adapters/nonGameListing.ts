import {
  ACCESSORY_TERMS,
  COMPLETENESS_QUALIFIER,
  LOCALE_MERCHANDISE_TERMS,
  foldDiacritics,
} from "../matching/vocabulary.js";

/**
 * "Is this listing the game at all?" Keeps manuals, empty boxes, merch and
 * repro carts out of matching and out of every stored price. Called at search
 * time to drop the row, not in normalize(), so nothing non-game reaches the
 * matcher, where "Pokemon Red Poster A3" vs "Pokémon Red" would earn a
 * confirmed mapping kept forever. A plugin never does this; the app decides.
 */

/**
 * Merchandise sharing the "Video Games" category. Every trap is a real title:
 * - no bare "art" ("Art of Fighting") or bare "cup" ("Nintendo World Cup").
 * - "pin"/"print" are \b-protected ("Pokemon Pinball", "Sprint").
 * - "sticker" not before "star" ("Paper Mario: Sticker Star"); "coaster" not
 *   after "roller" ("Roller Coaster Tycoon").
 * - "guide" never bare, only strategy/guide book/"<word>'s guide"
 *   (precautionary: no fixture title contains "guide").
 * - "dvd"/"blu-ray" not next to "case": PS2/GameCube CIB listings say "DVD case".
 * - repros are excluded outright: not a genuine market comparable.
 */
const MERCHANDISE_TERMS = [
  // drinkware
  /\bmugs?\b/,
  /\bcoffee\s+cups?\b/,
  /\btea\s+cups?\b/,
  /(?<!roller\s?)\bcoasters?\b/,
  // wall/print decor
  /\bprints?\b/,
  /\bcanvas(?:es)?\b/,
  /\bwall\s+art\b/,
  // apparel
  /\bt-?shirts?\b/,
  /\bshirts?\b/,
  /\btees?\b/,
  /\bhoodies?\b/,
  // wearables / desk tat
  /\bkeyrings?\b/,
  /\bkey\s*chains?\b/,
  /\blanyards?\b/,
  /\bbadges?\b/,
  /\bpins?\b/,
  /\bstickers?\b(?!\s*star)/,
  /\bdecals?\b/,
  /\bmouse\s*mats?\b/,
  /\bmouse\s*pads?\b/,
  // collectibles
  /\bplush(?:es|ies)?\b/,
  /\bfigures?\b/,
  /\bfigurines?\b/,
  /\bstatues?\b/,
  /\bamiibos?\b/,
  // print/AV media
  /\bstrategy\s+guides?\b/,
  /\bguide\s*books?\b/,
  /\b\w+['’]?s\s+guides?\b/,
  /\bmagazines?\b/,
  /\bsoundtracks?\b/,
  /\bost\b/,
  /\bvinyls?\b/,
  /\bblu[\s-]?rays?\b(?![\s-]*cases?)/,
  /\bdvds?\b(?![\s-]*cases?)/,
  // spare/aftermarket packaging — not the item itself
  /\breplacement\s+cases?\b/,
  /\bempty\s+cases?\b/,
  // unofficial aftermarket carts/boxes: not genuine market comparables
  /\breproductions?\b/,
  /\brepros?\b/,
  /\bcustom\s+labels?\b/,
];

/**
 * The English merchandise list above plus LOCALE_MERCHANDISE_TERMS, the
 * de/es/fr half kept in the shared vocabulary. The title is folded first
 * ("Schlüsselanhänger" -> "schlusselanhanger") because the locale vocabulary
 * is written unaccented and sellers type both spellings.
 */
export function isNonGameListing(title: string): boolean {
  const stripped = foldDiacritics(title.toLowerCase()).replace(COMPLETENESS_QUALIFIER, " ");
  return (
    ACCESSORY_TERMS.some((re) => re.test(stripped)) ||
    MERCHANDISE_TERMS.some((re) => re.test(stripped)) ||
    LOCALE_MERCHANDISE_TERMS.some((re) => re.test(stripped))
  );
}
