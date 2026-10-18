import type { PcImportRow } from "@retrowatchdog/shared";
import type { Db } from "../../db/index.js";
import type { IgdbClient } from "../../catalog/igdb.js";
import { createTitleMatcher } from "../matching.js";
import { defaultFetchPage, type PageFetcher, PcFetchError } from "./fetch.js";
import { parseCollectionPage, type PcRawItem } from "./parse.js";
import { mapConsoleName, mapIncludes } from "./map.js";

export { PcFetchError, defaultFetchPage, createPageFetcher, type PageFetcher } from "./fetch.js";
export type { PcRawItem } from "./parse.js";

// bounds a cursor loop or a hostile page
const MAX_PAGES = 20;

export const pcOfferUrl = (offerId: string): string =>
  `https://www.pricecharting.com/offer/${offerId}`;

export interface PcCollection {
  items: PcRawItem[];
  /** collection size from the first page's summary table; null if absent */
  totalCount: number | null;
}

// Lets confirm reuse the preview's fetch instead of walking every page again
// (the double-fetch burst likely triggers PriceCharting's throttling).
const COLLECTION_CACHE_TTL_MS = 10 * 60_000;

interface CachedCollection {
  result: PcCollection;
  at: number;
}

const collectionCache = new Map<string, CachedCollection>();

/** Clears the in-memory fetchCollection cache; call between tests. */
export function resetPcFetchCacheForTests(): void {
  collectionCache.clear();
}

/** Normalizes a collection URL to a stable cache key; falls back to the raw string if unparseable. */
function normalizeCollectionUrl(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

/** Walks all pages of a public collection via the next_page cursor chain (fetch only is cached). */
export async function fetchCollection(
  url: string,
  fetcher: PageFetcher = defaultFetchPage,
): Promise<PcCollection> {
  const key = normalizeCollectionUrl(url);
  const cached = collectionCache.get(key);
  if (cached && Date.now() - cached.at < COLLECTION_CACHE_TTL_MS) {
    return { items: [...cached.result.items], totalCount: cached.result.totalCount };
  }

  const byOfferId = new Map<string, PcRawItem>();
  let totalCount: number | null = null;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const html = await fetcher(url, cursor);
    const parsed = parseCollectionPage(html);
    // lets callers report rows lost to the page cap or parse misses
    if (page === 0) totalCount = parsed.totalCount;
    // keyed by offerId: a cursor that ever re-serves a page must not duplicate rows
    for (const item of parsed.items) {
      if (!byOfferId.has(item.offerId)) byOfferId.set(item.offerId, item);
    }
    cursor = parsed.nextCursor;
    if (cursor === null) break;
  }
  const result: PcCollection = { items: [...byOfferId.values()], totalCount };
  collectionCache.set(key, { result, at: Date.now() });
  return result;
}

export interface ResolveDeps {
  db: Db;
  igdb: IgdbClient;
}

export interface ResolveOpts {
  /** existing owned_copies.acquired_url values, for duplicate flagging */
  existingUrls: ReadonlySet<string>;
}

/** Maps + matches raw collection items into preview rows. */
export async function resolveImportRows(
  deps: ResolveDeps,
  raw: PcRawItem[],
  opts: ResolveOpts,
): Promise<PcImportRow[]> {
  const matcher = createTitleMatcher(deps);

  const rows: PcImportRow[] = [];
  for (const item of raw) {
    const duplicate = opts.existingUrls.has(pcOfferUrl(item.offerId));
    const base = {
      offerId: item.offerId,
      title: item.title,
      consoleName: item.consoleName,
      includes: item.includes,
      // PriceCharting is natively USD: the parsed number verbatim, no FX call
      valueUsd: item.valueUsd,
      duplicate,
    };

    const mapping = mapConsoleName(item.consoleName);
    if (!mapping) {
      rows.push({
        ...base,
        platform: null,
        region: null,
        condition: null,
        matchStatus: "unsupported_platform",
        matchScore: null,
        game: null,
        candidates: [],
      });
      continue;
    }

    const match = await matcher.match(item.title, mapping.platform);
    rows.push({
      ...base,
      platform: mapping.platform,
      region: mapping.region,
      condition: mapIncludes(item.includes),
      ...match,
    });
  }
  return rows;
}
