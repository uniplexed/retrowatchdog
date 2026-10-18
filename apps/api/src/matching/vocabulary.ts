/**
 * Shared title vocabulary: words that describe a LISTING rather than name the
 * GAME. The classifiers (adapters/classifyListing.ts, nonGameListing.ts,
 * familyReading.ts) read it; cleanTitle strips it so trigram similarity
 * compares game names, not marketplace prose.
 *
 * Entries are regex FRAGMENTS; wordsPattern() word-bounds the alternation.
 * Inside one list a phrase must precede any word it starts with ("cart only"
 * before "cart").
 *
 * Covered languages: English, German, Spanish, French (the eBay plugin's five
 * markets and the CeX shops). Italian/Dutch/Portuguese/Polish are a known gap.
 * Non-English fragments are written without diacritics; consumers fold the
 * title through foldDiacritics() first.
 */
import type { ItemGrade } from "@retrowatchdog/shared";

/** `\b(?:a|b|c)\b` over regex fragments; alternatives are tried in list order. */
export function wordsPattern(fragments: readonly string[], flags = ""): RegExp {
  return new RegExp(`\\b(?:${fragments.join("|")})\\b`, flags);
}

/**
 * "Schlüsselanhänger" -> "schlusselanhanger". A fold, not a transliteration:
 * entries that must also match "ae"/"ue" spell it out ("anh(?:a|ae)nger").
 */
export function foldDiacritics(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "");
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

/**
 * Region markers as written in free-text titles. Callers MUST test NTSC_J
 * before NTSC_U: the negative lookahead keeps the bare "NTSC" marker off
 * "NTSC-J"/"NTSC J", but it is the order that makes "Japan NTSC" Japanese.
 */
export const REGION_WORDS = {
  NTSC_J: ["jap", "jpn", "japan", "japanese", "famicom", "ntsc[ -]?j"],
  NTSC_U: ["ntsc(?![ -]?j)", "usa", "us (?:version|import)"],
  PAL: ["pal"],
  /** non-domestic but unspecified (CeX "Import"): never the domestic default */
  IMPORT: ["import"],
} as const;

export const REGION_NTSC_J = wordsPattern(REGION_WORDS.NTSC_J);
export const REGION_NTSC_U = wordsPattern(REGION_WORDS.NTSC_U);
export const REGION_PAL = wordsPattern(REGION_WORDS.PAL);
export const REGION_IMPORT = wordsPattern(REGION_WORDS.IMPORT);

// ---------------------------------------------------------------------------
// Condition (completeness)
// ---------------------------------------------------------------------------

/**
 * Completeness markers; each reader keeps its own check ORDER. The de/es/fr
 * entries are PHRASES on purpose: a bare "modul"/"cartucho"/"cartouche" also
 * appears on complete copies ("Spielmodul mit OVP").
 */
export const CONDITION_WORDS = {
  new: ["sealed", "brand new", "bnib"],
  loose: [
    "cart only", "cartridge only", "disc only", "game only", "loose", "unboxed", "no (?:3d )?case",
    // de
    "nur (?:das )?(?:spiel)?modul", "ohne ovp",
    // es
    "solo (?:el )?cartucho", "cartucho suelto", "sin caja",
    // fr
    "cartouche (?:seule|uniquement)", "sans (?:sa )?bo[iî]te",
  ],
  cib: [
    "boxed", "cib", "complete", "w/ manual", "w/o manual",
    // de — "OVP" means the original box IS included, so it is a cib marker;
    // "nur OVP" (the box alone) is an ACCESSORY_TERM.
    "ovp", "mit anleitung",
  ],
} as const;

export const CONDITION_NEW = wordsPattern(CONDITION_WORDS.new);
export const CONDITION_LOOSE = wordsPattern(CONDITION_WORDS.loose);
export const CONDITION_CIB = wordsPattern(CONDITION_WORDS.cib);
/** Free-text only: CeX's "(Gold Cart)" is a colour variant, so CeX never consults this. */
export const BARE_CART = /\bcart\b/;

// ---------------------------------------------------------------------------
// Grade (physical/cosmetic state)
// ---------------------------------------------------------------------------

/** "not damaged" is an INTACT item; "not working" deliberately skips this guard. */
const NOT_NEGATED = "(?<!\\b(?:no|not|never)\\s+)";

/**
 * Grade tiers for free-text titles; first tier with a hit wins, and the order
 * is load-bearing: faults before the mint family ("FAULTY but box is mint"),
 * near_mint before mint, very_good before good. Bare "good" is too noisy to
 * be a keyword. Accepted collateral: "Mint green console", "Broken Sword".
 */
export const GRADE_TIERS: ReadonlyArray<{ grade: ItemGrade; patterns: readonly RegExp[] }> = [
  {
    grade: "poor",
    patterns: [
      /\bfor parts\b/,
      /\bspares\s*(?:or|and|&|\/)\s*repairs?\b/,
      /\bnot working\b/,
      new RegExp(`${NOT_NEGATED}\\b(?:faulty|damaged|broken)\\b`),
    ],
  },
  {
    grade: "fair",
    patterns: [/\btatty\b/, /\bplay[\s-]?worn\b/, /\bwell[\s-]used\b/, /\bheavy wear\b/, /\bpoor\b/],
  },
  {
    grade: "near_mint",
    patterns: [/\bnear[\s-]?mint\b/, /\bnr[\s-]?mint\b/, /\bnmint\b/],
  },
  {
    grade: "mint",
    patterns: [/\bmint\b/, /\bpristine\b/, /\bimmaculate\b/],
  },
  {
    grade: "very_good",
    patterns: [/\bvgc\b/, /\bvery good condition\b/],
  },
  {
    grade: "good",
    patterns: [/\bgood condition\b/],
  },
];

// ---------------------------------------------------------------------------
// Accessories (manual / box / poster ...) and completeness qualifiers
// ---------------------------------------------------------------------------

/**
 * Accessory-only listings ("Box Only", a manual) are not the game and must stay
 * out of pricing. Qualified words ("Cart Only, No Manual") are stripped first
 * by COMPLETENESS_QUALIFIER.
 */
export const ACCESSORY_TERMS: readonly RegExp[] = [
  /\bmanual(?:es|s)?\b/,
  /\bbooklets?\b/,
  /\binstructions?\b/,
  /\binserts?\b/,
  /\bposters?\b/,
  /\bbox\s+only\b/,
  /\bcase\s+only\b/,
  /\bmap\s+only\b/,
  /\bcover\s+art\b/,
  /\bempty\s+box(?:es)?\b/,
  // --- de -------------------------------------------------------------
  /\b(?:bedienungs|spiel|spiele)?anleitung(?:en)?\b/,
  // Bare "OVP" is cib (see CONDITION_WORDS). Known gap: "OVP ohne Spiel".
  /\bnur\s+(?:die\s+)?(?:ovp|originalverpackung)\b/,
  /\bleere?\s+(?:ovp|originalverpackung)\b/,
  // --- es -------------------------------------------------------------
  /\binstrucciones\b/,
  /\bsolo\s+(?:la\s+)?caja\b/,
  /\bcaja\s+(?:vacia|sola)\b/,
  // --- fr -------------------------------------------------------------
  // "Notice" (the French leaflet) is also English; measured: no catalog
  // title or source mapping in the dev corpus contains it.
  /\bnotices?\b/,
  /\bmode\s+d['’]?\s*emploi\b/,
  /\bboite\s+(?:seule|vide)\b/,
  /\bboitier\s+(?:seul|vide)\b/,
];

export const ACCESSORY_WORD =
  "(?:manual(?:es|s)?|booklets?|instructions?|inserts?|posters?|maps?|box(?:es)?|cases?" +
  "|anleitung(?:en)?|ovp|originalverpackung|instrucciones|cajas?|notices?|boites?|boitiers?)";

/**
 * Words that turn a following accessory word into a completeness statement.
 * Short ones ("sin", "con") are safe only because they must precede an
 * accessory word ("Sin and Punishment" is a real title).
 */
export const COMPLETENESS_QUALIFIER_WORD =
  "(?:no|without|w\\/o|missing|with|inc|incl|includes|including|ohne|mit|inkl|sin|con|sans|avec)";

/**
 * "w/" (with) cannot take a trailing `\b` after its slash, so it gets its own
 * opener. Without it a "w/ manual" complete copy was dropped as a loose booklet.
 */
const SLASH_QUALIFIER_WORD = "w\\/";

/** Ordered: the `\b`-closed list first, so "w/o" is not read as "w/" + "o". */
const COMPLETENESS_QUALIFIER_OPENER =
  `(?:\\b${COMPLETENESS_QUALIFIER_WORD}\\b|\\b${SLASH_QUALIFIER_WORD})`;

const ACCESSORY_CHAIN_SEPARATOR = "(?:[\\s.,:;/&+-]|\\bor\\b|\\band\\b)";

/**
 * A qualifier plus a chain of accessory words ("inc. manual & poster") means
 * the listing IS the game. Stripped before ACCESSORY_TERMS run.
 */
export const COMPLETENESS_QUALIFIER = new RegExp(
  `${COMPLETENESS_QUALIFIER_OPENER}(?:${ACCESSORY_CHAIN_SEPARATOR}|${ACCESSORY_WORD})+`,
  "g",
);

/** cleanTitle's stricter shape: needs at least one accessory word after the qualifier. */
export const COMPLETENESS_PHRASE = new RegExp(
  `${COMPLETENESS_QUALIFIER_OPENER}${ACCESSORY_CHAIN_SEPARATOR}*${ACCESSORY_WORD}\\b` +
    `(?:${ACCESSORY_CHAIN_SEPARATOR}*${ACCESSORY_WORD}\\b)*`,
  "g",
);

// ---------------------------------------------------------------------------
// Merchandise in the markets' own languages
// ---------------------------------------------------------------------------

/**
 * The de/es/fr half of the merchandise vocabulary, appended to the English
 * MERCHANDISE_TERMS in adapters/nonGameListing.ts. Words identical to the
 * English ones are not repeated.
 */
export const LOCALE_MERCHANDISE_TERMS: readonly RegExp[] = [
  // keyrings
  /\bschl(?:u|ue)ssel[\s-]?anh(?:a|ae)nger\b/,
  /\bllaveros?\b/,
  /\bporte[\s-]?cl(?:efs?|es?)\b/,
  /\btassen?\b/,
  /\btazas?\b/,
  /\bcamisetas?\b/,
  /\bpegatinas?\b/,
  /\bautocollants?\b/,
  /\baufklebern?\b/,
  /\brevistas?\b/,
  /\bzeitschrift(?:en)?\b/,
  /\bmagazins?\b/,
  /\baffiches?\b/,
  /\bpeluches?\b/,
  // strategy guides: bare "guía"/"guide" is unsafe, only qualified phrasings
  /\bl(?:o|oe)sungsb(?:u|ue)ch(?:er)?\b/,
  /\bguia\s+(?:oficial|completa|del?\s+juego)\b/,
  /\bguide\s+officiel\b/,
];

// ---------------------------------------------------------------------------
// Strip-only vocabulary (classifies nothing, dilutes similarity)
// ---------------------------------------------------------------------------

/**
 * Marketplace prose cleanTitle removes. Words that also name games ("super",
 * "edition", "collection", "classic") are kept out deliberately.
 */
export const NOISE_WORDS = {
  region: [
    "region free",
    "(?:japanese|japan|jap|european|euro|uk|us|usa|pal|ntsc) (?:version|release|edition)",
    "ntsc[ -]?[uc]", "ukv", "uk", "eu", "eur", "european", "europe", "euro", "aus", "australian", "us",
  ],
  condition: [
    "complete in box", "new", "used", "pre-?owned", "second hand",
    "(?:w/o?|with|without) ?(?:rom|ram) cart(?:ridge)?", "outer box",
    "cartridges?", "catridge", "cartdridge", "cartrige", "cart", "\\d+ ?discs?",
  ],
  grade: [
    "(?:no|not|never) (?:damaged?|faulty|broken|scratche?s|scratched|issues|problems)",
    "(?:in )?(?:very good|great|good|excellent|superb|lovely|nice|fantastic|perfect|immaculate|mint|pristine|used|played|fair|poor|average|reasonable|decent|okay|ok|clean|tidy|worn|exc|ex|a1|top) (?:condition|cond)",
    "condition", "cond", "vgc", "gc", "nm",
  ],
  accessory: [
    "manual(?:es|s)?", "booklets?", "instructions?", "inserts?", "posters?", "box(?:es)?", "cases?",
    "(?:box )?protectors?", "inlays?", "sleeves?", "packaging",
    "(?:bedienungs|spiel|spiele)?anleitung(?:en)?", "originalverpackung",
    "instrucciones", "cajas?",
    "notices?", "mode d['’]? ?emploi", "boites?", "boitiers?",
  ],
  filler: [
    "video ?games?", "games?(?! ?(?:&|and) ?watch| in \\d)",
    "authentic", "genuine", "official", "vintage", "retro", "rare",
    "(?:fully )?tested", "untested", "(?:fully )?working", "works(?: perfectly| fine| great)?",
    "uk seller", "seller", "fast (?:dispatch|post|postage|shipping|delivery)", "dispatch",
    "free (?:p ?\\+ ?p|p ?& ?p|postage|delivery|shipping)", "p ?\\+ ?p", "job lot",
    "gaming", "nostalgia", "nostalgic", "keyring", "promo", "original", "consoles?",
    "battery", "(?:working|battery) saves?", "saves? (?:works?|working|fine|ok)",
    "(?:console )?not included", "offers? combine", "please read", "see (?:description|pictures|photos|pics)",
    "(?:\\d ?- ?)?\\d players?", "mpn",
    // de/es/fr merchandise words; measured: no catalog title carries any.
    "schl(?:u|ue)ssel ?anh(?:a|ae)nger", "llaveros?", "porte[ -]?cl(?:efs?|es?)",
    "tassen?", "tazas?", "camisetas?", "pegatinas?", "autocollants?", "aufklebern?",
    "revistas?", "zeitschrift(?:en)?", "magazins?", "affiches?", "peluches?",
  ],
  // Detected on the raw title, then stripped. "game & watch" is a title word.
  platform: [
    "nintendo entertainment system", "super nintendo(?: entertainment system)?", "super famicom", "super nes",
    "nintendo 64", "nintendo 3ds", "nintendo ds", "nintendo",
    "game ?boy(?: colou?r)?(?: advance)?(?: sp| pocket| light)?", "gba(?: sp)?", "gbc", "snes", "nes", "n64",
    "3ds", "2ds", "nds", "ds",
    "mega ?drive", "genesis", "master system", "game gear", "mega ?cd", "sega cd", "32x", "saturn", "dreamcast", "sega",
    "playstation ?[12]?", "ps ?[12]", "psx", "psone", "sony",
    "game ?cube", "ngc",
    "neo ?geo(?: pocket(?: colou?r)?| aes| cd)?", "ngpc", "aes",
    "virtual ?boy",
  ],
  /**
   * Model codes, part numbers and barcodes. A code needs 3+ digits so "F-1
   * Race" keeps its numeral; a bare digit run needs 8+ to never eat a year.
   */
  codes: [
    "(?:dmg|agb|cgb|nus|shvc|snsp|dol|ntr|ctr|mk)-[a-z0-9]{2,5}(?:-[a-z]{2,3})?",
    "[a-z]{1,4}-\\d{3,6}", "\\d{2,}-\\d{2,}(?:-\\d+)?", "use \\d{8,}", "\\d{8,}",
    "dmg", "sfc", "snsp", "shvc",
  ],
  /** publisher re-release variants, only ever stripped as a whole parenthetical */
  parenthesisedVariant: ["gold cart(?:ridge)?", "players'? choice", "player's choice", "platinum", "classics", "greatest hits", "essentials", "exp\\.? pak"],
} as const;
