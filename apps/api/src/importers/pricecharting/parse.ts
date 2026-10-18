/**
 * Parser for the public PriceCharting collection page (shapes in fixtures/).
 * The header tr.offer has no data-offer-id, so splitting on it skips it.
 */

export interface PcRawItem {
  offerId: string;
  title: string;
  /** console name as printed, region prefix included (e.g. "PAL GameBoy") */
  consoleName: string;
  includes: string;
  /** market value; null when the page shows "N/A" or no price cell */
  valueUsd: number | null;
  /** PriceCharting's own /game/<id> the value links to */
  pcGameId: string | null;
}

export interface PcParsedPage {
  items: PcRawItem[];
  /** opaque POST cursor for the next page; null on the last page */
  nextCursor: string | null;
  /** item count from the <table id="summary"> header, when present */
  totalCount: number | null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes the entity subset PriceCharting emits (&amp;, &#39;, &#x27;, ...). */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-zA-Z]+);/g, (all, name: string) => NAMED_ENTITIES[name] ?? all);
}

const collapse = (text: string): string => decodeEntities(text.replace(/\s+/g, " ").trim());

const TITLE_RE = /<p class="title">\s*<a href="[^"]*">([\s\S]*?)<\/a><br>\s*([\s\S]*?)<\/p>/;
const INCLUDES_RE = /<td class="includes">([\s\S]*?)<\/td>/;
const PRICE_RE = /<td class="price">[\s\S]*?<a href="\/game\/(\d+)"[^>]*>\s*<span class="js-price">([^<]*)<\/span>/;
// scoped to next_page: the first_page form also carries an (empty) cursor
const NEXT_CURSOR_RE = /<form method="POST" class="next_page">[\s\S]*?<input type="hidden" name="cursor" value="([^"]*)"/;
const SUMMARY_RE = /<table id="summary">[\s\S]*?<\/table>/;
// the value cell is class="number js-value js-price"; the count is bare "number"
const SUMMARY_COUNT_RE = /<td class="number">\s*([\d,]+)\s*<\/td>/;

function parseValue(text: string): number | null {
  const cleaned = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null; // "N/A" and friends
  return Number(cleaned);
}

export function parseCollectionPage(html: string): PcParsedPage {
  const items: PcRawItem[] = [];
  const chunks = html.split(/<tr class="offer" data-offer-id="/).slice(1);
  for (const chunk of chunks) {
    const offerId = chunk.slice(0, chunk.indexOf('"'));
    // bound at the row's own </tr> so a missing cell never bleeds into the next row
    const trEnd = chunk.indexOf("</tr>");
    const row = trEnd === -1 ? chunk : chunk.slice(0, trEnd);
    const title = TITLE_RE.exec(row);
    if (!offerId || !title) continue; // malformed row: skip, never abort the page
    const includes = INCLUDES_RE.exec(row);
    const price = PRICE_RE.exec(row);
    items.push({
      offerId,
      title: collapse(title[1]),
      consoleName: collapse(title[2]),
      includes: includes ? collapse(includes[1]) : "",
      valueUsd: price ? parseValue(price[2]) : null,
      pcGameId: price ? price[1] : null,
    });
  }

  const cursor = NEXT_CURSOR_RE.exec(html);
  const summary = SUMMARY_RE.exec(html);
  const count = summary ? SUMMARY_COUNT_RE.exec(summary[0]) : null;
  return {
    items,
    nextCursor: cursor && cursor[1].length > 0 ? cursor[1] : null,
    totalCount: count ? Number(count[1].replace(/,/g, "")) : null,
  };
}
