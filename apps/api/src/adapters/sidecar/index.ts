import pino from "pino";
import { PLATFORMS, PRICE_KINDS, type Platform, type PriceKind, type PriceRole, type Region, type SourceId } from "@retrowatchdog/shared";
import { config } from "../../config.js";
import { RateLimiter } from "../../lib/rateLimiter.js";
import { CircuitBreaker } from "../../lib/circuitBreaker.js";
import {
  kindForRole,
  NotConfiguredError,
  type NormalizedListing,
  type PriceSourceAdapter,
  type RawListing,
  type SearchOptions,
  type SnapshotStrategy,
} from "../types.js";
import { classifyListing } from "../classifyListing.js";
import { detectPlatformFromCategory } from "../familyReading.js";
import { applyDefaultRegion } from "../defaultRegion.js";
import { isNonGameListing } from "../nonGameListing.js";
import { getTextBounded, PluginHttpError, PluginProtocolError } from "../../plugins/http.js";
import { SidecarHttpError, SidecarProtocolError, parseSidecarListing } from "./protocol.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "warn" });

/** Known kinds: a dropped kind in here is a consent gap, anything else a vocabulary gap. */
const KNOWN_PRICE_KINDS: ReadonlySet<string> = new Set(PRICE_KINDS);

export interface SidecarAdapterOptions {
  /** the source id this sidecar serves */
  source: SourceId;
  /** where the sidecar listens; absent or blank = not deployed (see isConfigured) */
  baseUrl?: string;
  /** how the pricing service turns this source's listings into price_points rows */
  snapshotStrategy: SnapshotStrategy;
  /**
   * The price kinds this source may send: declared and approved. Absent means
   * "any kind the protocol defines", which only a test ever uses.
   */
  declaredKinds?: readonly PriceKind[];
  /**
   * The roles behind `declaredKinds`. Required for a `median_of_listings`
   * source (`cheapestWindow` ranks on the `buy_listing` role); unused otherwise.
   */
  kindRoles?: Partial<Record<PriceKind, PriceRole>>;
  /** the currencies this source's site quotes; absent/empty = any ISO-shaped code */
  expectedCurrencies?: readonly string[];
  /** region for a listing whose title declares none; null = do not guess */
  defaultRegion?: Region | null;
  /** gap between consecutive calls; defaults to SIDECAR_RATE_LIMIT_MS */
  rateLimitMs?: number;
  /** per-request budget; defaults to ADAPTER_TIMEOUT_MS, the whole fetch's budget */
  timeoutMs?: number;
  /** largest response body to read; defaults to SIDECAR_MAX_BYTES */
  maxBytes?: number;
  /** most rows to read out of one answer; defaults to SIDECAR_MAX_LISTINGS */
  maxListings?: number;
  /**
   * Most listings counted into a median source's sample, after the non-game
   * filter; inert unless `median_of_listings` with exactly one currency.
   */
  maxWindow?: number;
  /**
   * The plugin's rate limiter, ONE per plugin shared by all its sources: a
   * plugin is one process, so pacing per source would multiply its request
   * rate. Optional only for tests.
   */
  limiter?: RateLimiter;
  /** the plugin's circuit breaker; shared per plugin for the same reason as `limiter` */
  breaker?: CircuitBreaker;
}

/**
 * The app's half of docs/sidecar-protocol.md: one adapter for any plugin. The
 * plugin FETCHES; the app INTERPRETS and owns what must hold for every source,
 * so a plugin author cannot get it wrong: pacing, a circuit breaker, bounded
 * time and bytes with no redirects (plugins/http.ts), validation before any
 * stored row, and the shared classification. A plugin holds no credentials,
 * no database and no host port; that isolation is why untrusted community code
 * is allowed near the app at all.
 */
export class SidecarAdapter implements PriceSourceAdapter {
  readonly source: SourceId;
  readonly snapshotStrategy: SnapshotStrategy;
  /** The kinds this source may send. */
  readonly declaredKinds: ReadonlySet<PriceKind>;
  /** The roles behind `declaredKinds`, read through `kindForRole`. */
  readonly kindRoles: Partial<Record<PriceKind, PriceRole>>;
  /** the currencies this source's site quotes; empty means "no expectation" */
  readonly expectedCurrencies: ReadonlySet<string>;
  /** the manifest's `defaultRegion`; null is "do not guess" */
  private readonly defaultRegion: Region | null;
  /** null when no sidecar is deployed for this source */
  private readonly baseUrl: string | null;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxListings: number;
  private readonly maxWindow: number;
  /**
   * Public: every source a plugin serves holds the SAME two instances, pacing
   * and breaking the plugin as one process, and a test asserts that identity.
   */
  readonly limiter: RateLimiter;
  readonly breaker: CircuitBreaker;

  constructor(opts: SidecarAdapterOptions) {
    this.source = opts.source;
    this.snapshotStrategy = opts.snapshotStrategy;
    this.declaredKinds = new Set(opts.declaredKinds ?? PRICE_KINDS);
    this.kindRoles = opts.kindRoles ?? {};
    this.expectedCurrencies = new Set(opts.expectedCurrencies ?? []);
    this.defaultRegion = opts.defaultRegion ?? null;
    const baseUrl = (opts.baseUrl ?? "").trim().replace(/\/+$/, "");
    this.baseUrl = baseUrl.length > 0 ? baseUrl : null;
    this.timeoutMs = opts.timeoutMs ?? config.ADAPTER_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? config.SIDECAR_MAX_BYTES;
    this.maxListings = opts.maxListings ?? config.SIDECAR_MAX_LISTINGS;
    this.maxWindow = opts.maxWindow ?? config.SIDECAR_MEDIAN_WINDOW;
    this.limiter = opts.limiter ?? new RateLimiter(opts.rateLimitMs ?? config.SIDECAR_RATE_LIMIT_MS);
    this.breaker =
      opts.breaker ??
      new CircuitBreaker({
        failureThreshold: config.SIDECAR_BREAKER_THRESHOLD,
        holdMs: config.SIDECAR_BREAKER_HOLD_MS,
      });
  }

  /**
   * A sidecar nobody deployed is not an outage: no base URL reports
   * `not_configured` (block hidden), not `error` (a permanent red block).
   */
  isConfigured(): boolean {
    return this.baseUrl !== null;
  }

  /**
   * One GET per search. `source` is required: one plugin may serve several.
   * `alt` carries the catalog's other names; building the query is the
   * plugin's (fetching) decision. `spelling` carries the platform's
   * `sellerSpellings`, since a plugin cannot turn an opaque platform id into
   * seller prose; sent only with a platform hint.
   *
   * `budgetMs` is what is LEFT of `timeoutMs` when the request goes out: the
   * limiter's wait runs inside the pricing service's race, so the raw timeout
   * would overstate it. Floored at zero.
   *
   * The URL is not bounded, measured: the longest this builds over the whole
   * catalog is 773 chars (2026-09-04), plus 133 for the most spellings and 13
   * for `budgetMs`, far under Python's 65536 and nginx's 8 KB. Re-measure if
   * alternative names or seller spellings grow a lot.
   */
  async search(
    query: string,
    platformHint?: Platform,
    opts?: SearchOptions,
  ): Promise<RawListing[]> {
    const baseUrl = this.baseUrl;
    if (baseUrl === null) throw new NotConfiguredError(this.source);
    const startedAt = Date.now();
    const params = new URLSearchParams({ source: this.source, q: query });
    if (platformHint) params.set("platform", platformHint);
    for (const name of opts?.alternativeNames ?? []) params.append("alt", name);
    if (platformHint) {
      for (const spelling of PLATFORMS[platformHint].sellerSpellings) params.append("spelling", spelling);
    }

    // Parsing runs INSIDE the breaker on purpose: a sidecar answering 200 with
    // a body this protocol does not allow is as broken as one answering 500,
    // and a breaker that only counted status codes would keep calling it.
    return this.breaker.exec(() =>
      this.limiter.schedule(async () => {
        // Read right before the request goes out, so it counts the limiter's wait.
        const budgetMs = Math.max(0, this.timeoutMs - (Date.now() - startedAt));
        if (budgetMs === 0) throw new SidecarHttpError(this.source, 504);
        params.set("budgetMs", String(budgetMs));
        // JSON.parse stays here so a non-JSON body reads as a plain syntax error.
        const body: unknown = JSON.parse(await this.get(`${baseUrl}/search?${params}`, budgetMs));
        if (!Array.isArray(body)) {
          throw new SidecarProtocolError(this.source, "GET /search did not answer a JSON array");
        }
        return this.collect(body);
      }),
    );
  }

  /**
   * The shared bounded read, with failures re-formed to name the SOURCE (what
   * the pricing service stores and a user reads). Timeouts, refused
   * connections and redirects pass through for the breaker.
   */
  private async get(url: string, timeoutMs = this.timeoutMs): Promise<string> {
    try {
      return await getTextBounded(url, {
        label: "GET /search",
        timeoutMs,
        maxBytes: this.maxBytes,
      });
    } catch (err) {
      if (err instanceof PluginHttpError) throw new SidecarHttpError(this.source, err.status);
      if (err instanceof PluginProtocolError) {
        throw new SidecarProtocolError(this.source, `${err.label} ${err.detail}`);
      }
      throw err;
    }
  }

  /**
   * A malformed row costs that row only; the drop is logged with the reason
   * for the plugin's maintainer.
   *
   * Non-game rows are dropped here, at search time, with the app's shared
   * reading: "Pokemon Red Poster A3" is a near-perfect trigram hit on the game
   * and would earn a confirmed mapping kept forever.
   */
  private collect(rows: unknown[]): RawListing[] {
    // Capped BEFORE parsing: the pricing service does two queries and a write
    // per returned row, outside the fetch's timeout.
    if (rows.length > this.maxListings) {
      log.warn(
        { source: this.source, sent: rows.length, kept: this.maxListings },
        "sidecar answer truncated to the row cap",
      );
      rows = rows.slice(0, this.maxListings);
    }
    const listings: RawListing[] = [];
    // Separate sets: a known kind was dropped for CONSENT, an unknown one
    // because this build has never heard of it (likely a newer protocol).
    const unapprovedKinds = new Set<string>();
    const unrecognisedKinds = new Set<string>();
    let malformed = 0;
    for (const row of rows) {
      const parsed = parseSidecarListing(row, {
        kinds: this.declaredKinds,
        currencies: this.expectedCurrencies,
      });
      if (!parsed.ok) {
        malformed += 1;
        log.warn({ source: this.source, reason: parsed.reason }, "sidecar listing dropped");
        continue;
      }
      // Collected before the non-game check: the kind report is still true
      // of the plugin even when the row is then dropped as merchandise.
      for (const kind of parsed.droppedKinds ?? []) {
        if (KNOWN_PRICE_KINDS.has(kind)) unapprovedKinds.add(kind);
        else unrecognisedKinds.add(kind);
      }
      // merchandise is normal marketplace traffic, not a plugin fault: debug
      if (isNonGameListing(parsed.listing.title)) {
        log.debug({ source: this.source, title: parsed.listing.title }, "non-game listing dropped");
        continue;
      }
      listings.push(parsed.listing);
    }
    // Once per batch: a dropped kind arrives on every row. Known kinds are
    // fixed app strings and need no clipping.
    if (unapprovedKinds.size > 0) {
      log.warn(
        { source: this.source, kinds: [...unapprovedKinds] },
        "sidecar sent kinds this source is not approved for; those prices were dropped",
      );
    }
    // Clipped and quoted: an unrecognised kind is any string a plugin invented.
    if (unrecognisedKinds.size > 0) {
      log.warn(
        {
          source: this.source,
          kinds: [...unrecognisedKinds].map((kind) => JSON.stringify(kind.slice(0, 32))),
        },
        "sidecar sent price kinds this app does not recognise; those prices were dropped -- " +
          "check whether the plugin speaks a newer protocol",
      );
    }
    // A batch where EVERY row broke the protocol is a source redesign, not an
    // empty answer; as a success it would reset the breaker and report `ok`
    // forever. An all-merchandise batch is different: a real answer.
    if (malformed > 0 && malformed === rows.length) {
      throw new SidecarProtocolError(this.source, `all ${malformed} rows of GET /search were malformed`);
    }
    return this.cheapestWindow(listings);
  }

  /**
   * The cheapest `maxWindow` of the listings this app is willing to COUNT, for
   * a `median_of_listings` source with exactly one expected currency (raw
   * amounts rank only within one currency). A priceless row sorts last.
   *
   * ORDER IS A RULE: filter non-games first, window second. Windowing first
   * lets merchandise in the cheap tail eat slots that nothing refills
   * (measured: 47 rows instead of 50). A test fails if this is inverted.
   *
   * Ranks on the `buy_listing`-role price via `kindForRole`, never `prices[0]`,
   * so it agrees with what `medianPointsFrom` aggregates.
   *
   * Duplicate `sourceProductId`s are NOT de-duplicated here; a plugin that
   * answers one id twice counts it twice in the median.
   */
  private cheapestWindow(listings: RawListing[]): RawListing[] {
    if (this.snapshotStrategy !== "median_of_listings") return listings;
    if (this.expectedCurrencies.size !== 1) return listings;
    if (listings.length <= this.maxWindow) return listings;
    const buyListingKind = kindForRole(this.kindRoles, "buy_listing");
    const price = (l: RawListing): number =>
      l.prices.find((p) => p.kind === buyListingKind)?.amount ?? Number.POSITIVE_INFINITY;
    return [...listings].sort((a, b) => price(a) - price(b)).slice(0, this.maxWindow);
  }

  /**
   * The shared classifier plus the same category override and `defaultRegion`
   * rule the sync transport applies: the two transports must read a row the
   * same way. The category reading is CeX's hint list and not family-keyed,
   * deliberately: it only adds a guess where the title gave none.
   */
  normalize(raw: RawListing): NormalizedListing {
    const classified = classifyListing(raw);
    const fromCategory = raw.categoryText ? detectPlatformFromCategory(raw.categoryText) : null;
    return {
      ...classified,
      platformGuess: fromCategory ?? classified.platformGuess,
      regionGuess: applyDefaultRegion(classified.regionGuess, raw.title, this.defaultRegion),
    };
  }
}
