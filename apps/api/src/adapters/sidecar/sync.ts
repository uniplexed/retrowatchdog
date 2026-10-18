import pino from "pino";
import type { PriceKind, SourceId, SourceSchedule } from "@retrowatchdog/shared";
import { config } from "../../config.js";
import type { RateLimiter } from "../../lib/rateLimiter.js";
import type { CircuitBreaker } from "../../lib/circuitBreaker.js";
import {
  getJsonBounded,
  postJsonBounded,
  PluginHttpError,
  PluginProtocolError,
} from "../../plugins/http.js";
import type {
  CatalogItemUpsert,
  CatalogSink,
  CatalogSyncCapability,
  SyncUnitReport,
} from "../types.js";
import { SidecarHttpError, SidecarProtocolError, echo, hasControlChar, isRecord, parseSyncRow } from "./protocol.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "warn" });

/** Ids per `POST /catalog/refresh`: the tracked list grows with the collection, so it is chunked. */
const REFRESH_IDS_PER_CALL = 200;

/** A cursor is opaque, but it still goes in a URL this app builds. */
const MAX_CURSOR_LENGTH = 512;

/** A plugin's note reaches our log lines, so a plugin does not choose its length. */
const MAX_NOTES_LENGTH = 500;

/**
 * Share of a page that must be readable for that page to end a unit COMPLETE
 * (a deletion). A judgement, not a measurement; tripping it costs only staleness.
 */
const MIN_USABLE_SHARE = 0.5;

interface CatalogPage {
  rows: unknown[];
  next: string | null;
  complete: boolean;
  notes?: string;
}

/**
 * A unit name the URL parser would remove: `.`/`..` survive
 * `encodeURIComponent` and even `%2E%2E` is resolved as a dot segment (measured
 * with node's WHATWG URL), so the only honest answer is to refuse it.
 */
function isDotSegment(unit: string): boolean {
  return unit === "." || unit === "..";
}

/** What one page's rows turned into, and whether enough of them did. */
interface CollectedRows {
  items: CatalogItemUpsert[];
  /** false when fewer than MIN_USABLE_SHARE of the page's rows parsed */
  mostlyUsable: boolean;
}

export interface SidecarSyncOptions {
  source: SourceId;
  /** where the plugin listens, e.g. http://shop:8000; no trailing slash */
  baseUrl: string;
  /** the cadence the manifest declared; this app never invents one */
  schedule: SourceSchedule;
  /** the kinds the user approved for THIS source; a price of any other kind is dropped */
  approvedKinds: readonly PriceKind[];
  expectedCurrencies: readonly string[];
  /** the PLUGIN's limiter and breaker — the same pair its live traffic uses */
  limiter: RateLimiter;
  breaker: CircuitBreaker;
  timeoutMs?: number;
  maxBytes?: number;
  maxRowsPerPage?: number;
  maxPages?: number;
}

/**
 * A catalog-sync source, read over protocol A.3 and fed into the APP's sink.
 * The plugin walks its catalogue; the app owns pacing, breaker, bounds,
 * validation and the database.
 *
 * The worker DELETES every row of a unit not seen in a run that reported
 * `complete`, so that flag is the most dangerous value on the wire:
 * - it is read from the LAST page only (`next` null);
 * - a page failing mid-unit, the page cap, or a stuck cursor end it INCOMPLETE,
 *   keeping the rows that arrived;
 * - a unit whose FIRST page failed throws: no evidence is not an empty catalogue;
 * - a sweep that stored no row, or had a mostly unreadable page, is never complete.
 */
export class SidecarSyncCapability implements CatalogSyncCapability {
  readonly source: SourceId;
  readonly schedule: SourceSchedule;
  private readonly baseUrl: string;
  private readonly kinds: ReadonlySet<string>;
  private readonly currencies: ReadonlySet<string>;
  private readonly limiter: RateLimiter;
  private readonly breaker: CircuitBreaker;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRowsPerPage: number;
  private readonly maxPages: number;

  constructor(opts: SidecarSyncOptions) {
    this.source = opts.source;
    this.schedule = opts.schedule;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.kinds = new Set(opts.approvedKinds);
    this.currencies = new Set(opts.expectedCurrencies);
    this.limiter = opts.limiter;
    this.breaker = opts.breaker;
    this.timeoutMs = opts.timeoutMs ?? config.ADAPTER_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? config.SIDECAR_SYNC_MAX_BYTES;
    this.maxRowsPerPage = opts.maxRowsPerPage ?? config.SIDECAR_SYNC_MAX_ROWS_PER_PAGE;
    this.maxPages = opts.maxPages ?? config.SIDECAR_SYNC_MAX_PAGES_PER_UNIT;
  }

  /**
   * The units this source's catalogue is swept in. Bounded at 200: the worker
   * runs them one after another, and thousands would be a job that never ends.
   */
  async listSyncUnits(): Promise<string[]> {
    const body = await this.get(`/catalog/units?source=${encodeURIComponent(this.source)}`);
    if (!Array.isArray(body) || body.length < 1 || body.length > 200) {
      throw new SidecarProtocolError(
        this.source,
        `GET /catalog/units did not answer an array of 1 to 200 units`,
      );
    }
    const units: string[] = [];
    const seen = new Set<string>();
    for (const unit of body) {
      if (typeof unit !== "string" || unit.trim().length === 0 || unit.length > 128) {
        // `echo`: `unit` is still `unknown` and can be any size up to the byte cap.
        throw new SidecarProtocolError(
          this.source,
          `unit ${echo(unit)} is not a non-empty string of at most 128 characters`,
        );
      }
      if (isDotSegment(unit)) {
        throw new SidecarProtocolError(
          this.source,
          `unit ${echo(unit)} cannot be asked for: it names a path segment the URL parser removes`,
        );
      }
      // Postgres refuses U+0000 in the `sync_unit` text column, and `sink.upsert`
      // runs outside the page's try, so one bad unit name would end the whole unit.
      if (hasControlChar(unit)) {
        throw new SidecarProtocolError(this.source, "a unit name carries a control character");
      }
      // Each unit gets its own `runStartedAt`, so a unit listed twice is swept
      // twice and the second sweep's delete-unseen removes the first one's rows.
      if (seen.has(unit)) throw new SidecarProtocolError(this.source, `unit ${unit} is listed twice`);
      seen.add(unit);
      units.push(unit);
    }
    return units;
  }

  /**
   * Walk one unit's pages, feeding the sink page by page so a partial sweep
   * still stores what arrived (and, reported incomplete, deletes nothing).
   */
  async syncUnit(unit: string, sink: CatalogSink): Promise<SyncUnitReport> {
    let cursor: string | null = null;
    const requested = new Set<string>();
    let pages = 0;
    let itemsUpserted = 0;
    let complete = false;
    let degraded = false;
    let notes: string | undefined;

    for (;;) {
      let page: CatalogPage;
      let items: CatalogItemUpsert[];
      try {
        page = this.parsePage(await this.get(this.pagePath(unit, cursor)));
        // A page whose every row broke the protocol is a failed page and must
        // not end the unit as complete.
        const collected = this.collect(page.rows, unit);
        items = collected.items;
        if (!collected.mostlyUsable) degraded = true;
      } catch (error) {
        // Nothing arrived at all: that is a failed job, not an empty catalogue.
        if (pages === 0) throw error;
        // Something did: keep it, and leave the unit incomplete so the
        // worker's delete-unseen does not wipe what it never saw.
        notes = `page ${pages + 1} failed: ${(error as Error).message}`;
        log.warn({ source: this.source, unit, notes }, "catalog page failed mid-unit");
        return { itemsUpserted, complete: false, notes };
      }
      // A sink failure is the APP's database; reporting it as an incomplete unit
      // would claim rows were stored that were not.
      if (items.length > 0) await sink.upsert(items);
      itemsUpserted += items.length;
      pages += 1;

      // `complete` is the LAST page's claim.
      if (page.next === null) {
        complete = page.complete;
        notes = page.notes;
        break;
      }
      // A repeated cursor never ends; stop now rather than at the page cap.
      if (requested.has(page.next)) {
        notes = `page ${pages} repeated a cursor already served; the unit does not advance`;
        log.warn({ source: this.source, unit, pages }, "catalog cursor stopped advancing");
        break;
      }
      if (pages >= this.maxPages) {
        notes = `stopped at the ${pages}-page cap`;
        log.warn({ source: this.source, unit, pages }, "catalog unit hit the page cap");
        break;
      }
      requested.add(page.next);
      cursor = page.next;
    }

    // The last gate before deletion: `complete` must mean "this sweep saw the
    // unit". An empty sweep, or one surviving row among an unreadable page,
    // must not authorise deleting a category. Cost: a genuinely emptied
    // category keeps stale rows until `sweepStale` removes them after 30 days.
    if (complete && itemsUpserted === 0) {
      complete = false;
      notes = "the sweep stored no row at all, so it is not reported complete";
      log.warn({ source: this.source, unit, pages }, "catalog unit swept nothing; not reported complete");
    } else if (complete && degraded) {
      complete = false;
      notes = `a page was under the ${MIN_USABLE_SHARE * 100}% readable share, so the unit is not reported complete`;
      log.warn({ source: this.source, unit, pages }, "catalog unit mostly unreadable; not reported complete");
    }

    return notes === undefined ? { itemsUpserted, complete } : { itemsUpserted, complete, notes };
  }

  /**
   * Re-read the products the app tracks, without sweeping anything. An id the
   * plugin omits keeps its stored row: only a complete sweep may delete.
   */
  async refreshItems(sourceProductIds: string[], sink: CatalogSink): Promise<void> {
    for (let i = 0; i < sourceProductIds.length; i += REFRESH_IDS_PER_CALL) {
      const asked = sourceProductIds.slice(i, i + REFRESH_IDS_PER_CALL);
      const body = await this.post("/catalog/refresh", { source: this.source, ids: asked });
      if (!isRecord(body) || !Array.isArray(body.rows)) {
        throw new SidecarProtocolError(this.source, "POST /catalog/refresh did not answer { rows }");
      }
      if (body.rows.length > this.maxRowsPerPage) {
        throw new SidecarProtocolError(
          this.source,
          `POST /catalog/refresh answered ${body.rows.length} rows, over the ${this.maxRowsPerPage}-row cap`,
        );
      }
      const wanted = new Set(asked);
      // A row the app did not ask about would land with no `sync_unit`, so only
      // the 30-day stale sweep would ever remove it. `mostlyUsable` is ignored:
      // a refresh reports nothing and deletes nothing.
      const items = this.collect(body.rows, "refresh").items.filter((item) => {
        if (wanted.has(item.sourceProductId)) return true;
        log.warn(
          { source: this.source, sourceProductId: item.sourceProductId },
          "catalog refresh answered about a product the app did not ask for",
        );
        return false;
      });
      if (items.length > 0) await sink.upsert(items);
    }
  }

  /**
   * The unit goes in the URL PATH, percent-encoded, so "Toys/Games" or
   * "50% off" reach the plugin as the string it named.
   */
  private pagePath(unit: string, cursor: string | null): string {
    // Checked again here: a unit arrives from a queue payload that may predate
    // the latest unit list.
    if (isDotSegment(unit)) {
      throw new SidecarProtocolError(
        this.source,
        `unit ${JSON.stringify(unit)} cannot be asked for: it names a path segment the URL parser removes`,
      );
    }
    const params = new URLSearchParams({ source: this.source });
    if (cursor !== null) params.set("cursor", cursor);
    return `/catalog/units/${encodeURIComponent(unit)}?${params}`;
  }

  /**
   * Every call goes through the PLUGIN's breaker and limiter, shared with its
   * live traffic, so sweeps and game views together keep the promised pace.
   * Errors are re-formed to name the SOURCE.
   */
  private async call(fn: () => Promise<unknown>): Promise<unknown> {
    return this.breaker.exec(() =>
      this.limiter.schedule(async () => {
        try {
          return await fn();
        } catch (err) {
          if (err instanceof PluginHttpError) throw new SidecarHttpError(this.source, err.status);
          if (err instanceof PluginProtocolError) {
            throw new SidecarProtocolError(this.source, `${err.label} ${err.detail}`);
          }
          throw err;
        }
      }),
    );
  }

  private async get(path: string): Promise<unknown> {
    return this.call(() =>
      getJsonBounded(`${this.baseUrl}${path}`, {
        label: `GET ${path}`,
        timeoutMs: this.timeoutMs,
        maxBytes: this.maxBytes,
      }),
    );
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    return this.call(() =>
      postJsonBounded(`${this.baseUrl}${path}`, body, {
        label: `POST ${path}`,
        timeoutMs: this.timeoutMs,
        maxBytes: this.maxBytes,
      }),
    );
  }

  private parsePage(body: unknown): CatalogPage {
    const fail = (detail: string): never => {
      throw new SidecarProtocolError(this.source, detail);
    };
    if (!isRecord(body)) return fail("a catalog page is not a JSON object");
    if (!Array.isArray(body.rows)) return fail("a catalog page has no rows array");
    const rows: unknown[] = body.rows;
    // Capped rather than truncated: keeping the first N rows would write a
    // partial page that could then be reported complete (a deletion).
    if (rows.length > this.maxRowsPerPage) {
      return fail(`a catalog page carried ${rows.length} rows, over the ${this.maxRowsPerPage}-row cap`);
    }
    if (body.next !== null) {
      if (typeof body.next !== "string" || body.next.length === 0 || body.next.length > MAX_CURSOR_LENGTH) {
        return fail(`next must be null or a cursor of 1 to ${MAX_CURSOR_LENGTH} characters`);
      }
    }
    // Not defaulted to false: `complete` decides whether the worker deletes.
    if (typeof body.complete !== "boolean") return fail("complete must be a boolean");
    if (body.notes !== undefined) {
      if (typeof body.notes !== "string" || body.notes.length > MAX_NOTES_LENGTH) {
        return fail(`notes must be a string of at most ${MAX_NOTES_LENGTH} characters`);
      }
    }
    return {
      rows,
      next: body.next as string | null,
      complete: body.complete,
      ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
    };
  }

  /**
   * A malformed row costs that row only. A page where EVERY row is malformed
   * throws (a source redesign, not an empty category), and a MOSTLY malformed
   * page loses the right to end the unit complete (`MIN_USABLE_SHARE`).
   *
   * A duplicate id in one page is dropped: the sink upserts in chunks of 500,
   * and two rows with one id in the same chunk make Postgres refuse the
   * statement ("cannot affect row a second time"), ending the whole unit.
   */
  private collect(rows: unknown[], unit: string): CollectedRows {
    const items: CatalogItemUpsert[] = [];
    const seen = new Set<string>();
    const droppedKinds = new Set<string>();
    let malformed = 0;
    for (const row of rows) {
      const parsed = parseSyncRow(row, { kinds: this.kinds, currencies: this.currencies });
      if (!parsed.ok) {
        malformed += 1;
        log.warn({ source: this.source, unit, reason: parsed.reason }, "catalog row dropped");
        continue;
      }
      // Clipped AND quoted, so an empty or comma-bearing kind stays readable once joined.
      for (const kind of parsed.droppedKinds) droppedKinds.add(JSON.stringify(kind.slice(0, 32)));
      if (seen.has(parsed.item.sourceProductId)) {
        log.warn(
          { source: this.source, unit, sourceProductId: parsed.item.sourceProductId },
          "catalog row repeated in one page",
        );
        continue;
      }
      seen.add(parsed.item.sourceProductId);
      items.push(parsed.item);
    }
    // Once per page: an unapproved kind arrives on every row.
    if (droppedKinds.size > 0) {
      log.warn(
        { source: this.source, unit, kinds: [...droppedKinds] },
        "catalog page carried prices of kinds this source has no approved role for",
      );
    }
    if (malformed > 0 && malformed === rows.length) {
      throw new SidecarProtocolError(this.source, `all ${malformed} rows of a catalog page were malformed`);
    }
    return { items, mostlyUsable: rows.length - malformed >= rows.length * MIN_USABLE_SHARE };
  }
}
