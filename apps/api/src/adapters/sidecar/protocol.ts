import { PLUGIN_PROTOCOL_VERSION, PRICE_KINDS, echo, type PriceKind } from "@retrowatchdog/shared";
import type { CatalogItemUpsert, RawListing, RawPrice } from "../types.js";

/**
 * The wire contract a plugin implements; docs/sidecar-protocol.md is its
 * human-readable half and the two change together.
 *
 * VALIDATION, never transformation: a plugin is untrusted, so a row is rebuilt
 * field by field from what survives the check, never spread. That is also what
 * enforces "a plugin must not classify": a `platform`, `region`, `condition` or
 * `grade` key has no way through.
 */

/**
 * Additive changes (a new optional field or query parameter) keep this number;
 * anything that could break a working plugin increments it. It IS shared's
 * `PLUGIN_PROTOCOL_VERSION`, so manifest and rows cannot disagree.
 */
export const SIDECAR_PROTOCOL_VERSION = PLUGIN_PROTOCOL_VERSION;

/** The sidecar answered, but not with something this protocol allows. */
export class SidecarProtocolError extends Error {
  constructor(source: string, detail: string) {
    super(`${source} sidecar broke the protocol: ${detail}`);
    this.name = "SidecarProtocolError";
  }
}

/** The sidecar answered with a status the protocol treats as a failure. */
export class SidecarHttpError extends Error {
  constructor(source: string, readonly status: number) {
    super(`${source} sidecar HTTP ${status}`);
    this.name = "SidecarHttpError";
  }
}

export type ParsedListing =
  /**
   * `droppedKinds` names the kinds THIS ROW lost (unapproved or unrecognised),
   * absent when none, so the caller can report them once per batch. Entries are
   * raw plugin strings: every caller clips and quotes before logging.
   */
  | { ok: true; listing: RawListing; droppedKinds?: string[] }
  | { ok: false; reason: string };

/** ISO 4217 alpha: exactly three uppercase letters, no exceptions made. */
const ISO_4217 = /^[A-Z]{3}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** An absolute http(s) URL — the only kind of link the app will render. */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Any kind the protocol defines: the ceiling, narrowed per source below. */
const EVERY_KNOWN_KIND: ReadonlySet<string> = new Set(PRICE_KINDS);

/**
 * Does this text carry a C0 control character other than tab, newline or CR?
 * Postgres refuses U+0000 (`22021 ... 0x00`, measured) and one such row kills
 * its whole 500-row chunk and the unit; the rest of C0 is damage, not data.
 * Messages name the FIELD and never quote the value, so the byte stays out of logs.
 */
export function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return false;
}

// Re-exported: callers have always imported it from here.
export { echo, MAX_ECHO_LENGTH } from "@retrowatchdog/shared";

/** No declared currency for this source: the ISO shape is then the only rule. */
const NO_CURRENCY_LIMIT: ReadonlySet<string> = new Set();

/**
 * ISO-8601 with an EXPLICIT zone. `new Date` alone accepts "2026" or
 * "12/31/2026" (engine- and locale-dependent), and a zoneless timestamp would
 * be read in the API container's timezone.
 */
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Allowed clock skew: seconds are a clock; hours are a timezone bug, and the row is dropped. */
const OBSERVED_AT_SKEW_MS = 60_000;

/**
 * The realistic bad value is a missing date coerced to 1970, and the block
 * timestamp takes the MINIMUM, so one such row makes a fresh block read decades old.
 */
const OBSERVED_AT_FLOOR_MS = Date.UTC(2000, 0, 1);

const MAX_CONDITION_TEXT = 256;
/** A sample this large is a typo or an attack, not a count of listings. */
export const MAX_SAMPLE_SIZE = 1_000_000;

/** One rule for both transports: ISO-8601 with an explicit zone, a real date, not future, not before 2000. */
function checkObservedAt(value: unknown): { ok: true; observedAt: Date } | { ok: false; reason: string } {
  if (typeof value !== "string") return { ok: false, reason: "observedAt must be an ISO-8601 string" };
  if (!ISO_8601_UTC.test(value)) {
    return { ok: false, reason: "observedAt is not an ISO-8601 timestamp with an explicit zone" };
  }
  const observedAt = new Date(value);
  const ms = observedAt.getTime();
  if (Number.isNaN(ms)) return { ok: false, reason: "observedAt is not a real date" };
  if (ms > Date.now() + OBSERVED_AT_SKEW_MS) return { ok: false, reason: "observedAt is in the future" };
  if (ms < OBSERVED_AT_FLOOR_MS) {
    return { ok: false, reason: "observedAt predates anything this app could have been told about" };
  }
  return { ok: true, observedAt };
}

/** One rule for both transports: the classifier reads this string, so it is bounded like every other one it reads. */
function checkConditionText(value: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  if (typeof value !== "string") return { ok: false, reason: "conditionText must be a string" };
  if (value.length > MAX_CONDITION_TEXT) {
    return { ok: false, reason: `conditionText must be a string of at most ${MAX_CONDITION_TEXT} characters` };
  }
  if (hasControlChar(value)) return { ok: false, reason: "conditionText carries a control character" };
  return { ok: true, text: value };
}

/** Exported so a stored value can be re-checked against the same bound it was admitted under (catalogAdapter.ts). */
export function isSampleSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_SAMPLE_SIZE;
}

/**
 * Why a price was refused. `unapproved-kind` (a known kind this source has no
 * consent for) and `unrecognised-kind` (a kind this build has never heard of,
 * likely a newer protocol) cost only the PRICE; `malformed` condemns the row.
 * A discriminant, not a message match, so rewording a reason never changes behaviour.
 */
type PriceRefusal =
  | { ok: false; refusal: "unapproved-kind"; kind: string; reason: string }
  | { ok: false; refusal: "unrecognised-kind"; kind: string; reason: string }
  | { ok: false; refusal: "malformed"; reason: string };

/**
 * A price the app is willing to store:
 * - `kind` must be one THIS SOURCE declares a role for: the price table renders
 *   every stored row, so a `cash` row from a marketplace would print "pays cash"
 *   in the app's own voice on a plugin's say-so.
 * - `currency` must be a real ISO code and, where declared, one the site quotes:
 *   an unservable code makes the FX lookup throw (whole block lost), and a wrong
 *   but quotable one freezes a USD twin at another country's rate, forever.
 * The unknown-kind check runs before the permission check.
 */
function parsePrice(
  value: unknown,
  index: number,
  allowedKinds: ReadonlySet<string>,
  allowedCurrencies: ReadonlySet<string>,
): { ok: true; price: RawPrice } | PriceRefusal {
  const bad = (reason: string): PriceRefusal => ({ ok: false, refusal: "malformed", reason });
  if (!isRecord(value)) return bad(`prices[${index}] is not an object`);
  const { kind, amount, currency, sampleSize } = value;
  if (typeof kind !== "string") {
    // `echo`: `kind` is not a string here and can be any size up to the byte cap.
    return bad(`prices[${index}].kind ${echo(kind)} is not a price kind the app knows`);
  }
  if (!EVERY_KNOWN_KIND.has(kind)) {
    // Clipped and quoted: a plugin-invented string that can still reach a log line.
    return {
      ok: false,
      refusal: "unrecognised-kind",
      kind,
      reason: `prices[${index}].kind ${JSON.stringify(kind.slice(0, 32))} is not a price kind this app knows`,
    };
  }
  if (!allowedKinds.has(kind)) {
    return {
      ok: false,
      refusal: "unapproved-kind",
      kind,
      reason: `prices[${index}].kind ${JSON.stringify(kind)} is a kind this source declares no role for`,
    };
  }
    // Same ceiling as the sync path: above it the price_points INSERT fails and
    // takes the game's whole batch for this source with it, on every fetch.
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > MAX_STORABLE_AMOUNT) {
    return bad(`prices[${index}].amount must be a finite number between 0 and ${MAX_STORABLE_AMOUNT}`);
  }
  if (typeof currency !== "string" || !ISO_4217.test(currency)) {
    // `echo`: `currency` can still be a non-string here.
    return bad(`prices[${index}].currency ${echo(currency)} is not a 3-letter ISO 4217 code`);
  }
  if (allowedCurrencies.size > 0 && !allowedCurrencies.has(currency)) {
    return bad(`prices[${index}].currency ${JSON.stringify(currency)} is not one this source's site quotes`);
  }
  // `null` is refused: "no sample" is said by leaving the key out.
  if (sampleSize !== undefined && !isSampleSize(sampleSize)) {
    return bad(`prices[${index}].sampleSize must be a whole number from 1 to ${MAX_SAMPLE_SIZE}`);
  }
  const price: RawPrice = { kind: kind as PriceKind, amount, currency };
  if (sampleSize !== undefined) price.sampleSize = sampleSize;
  return { ok: true, price };
}

/** What a given source may say, beyond what the protocol allows anyone to say. */
export interface SourceLimits {
  /** kinds this source's manifest declares a role for; default: any known kind */
  kinds?: ReadonlySet<string>;
  /** currencies this source's site quotes; empty or absent: any ISO-shaped code */
  currencies?: ReadonlySet<string>;
}

/**
 * One row of a plugin's `GET /search` array, checked against the protocol and
 * the source's `SourceLimits`. Absent optional fields stay absent; a PRESENT
 * invalid one makes the row malformed: a broken claim beside real evidence is
 * worse than a dropped row with a reason.
 */
export function parseSidecarListing(value: unknown, limits: SourceLimits = {}): ParsedListing {
  const allowedKinds = limits.kinds ?? EVERY_KNOWN_KIND;
  const allowedCurrencies = limits.currencies ?? NO_CURRENCY_LIMIT;
  if (!isRecord(value)) return { ok: false, reason: "listing is not an object" };

  // Bounded like parseSyncRow: an unchecked value here would instead fail the
  // price_points INSERT and cost the whole block on every fetch.
  const id = value.sourceProductId;
  if (!nonEmptyString(id) || id.length > 128) {
    return { ok: false, reason: "sourceProductId must be a non-empty string of at most 128 characters" };
  }
  // Checked before `at` is built: `at` puts the id INTO a logged reason.
  if (hasControlChar(id)) {
    return { ok: false, reason: "sourceProductId carries a control character" };
  }
  // every reason from here on names the row, for the plugin's maintainer
  const at = (detail: string): { ok: false; reason: string } => ({ ok: false, reason: `${detail} (listing ${id})` });

  if (!nonEmptyString(value.title) || value.title.length > 512) {
    return at("title must be a non-empty string of at most 512 characters");
  }
  if (hasControlChar(value.title)) return at("title carries a control character");
  if (!Array.isArray(value.prices)) return at("prices is missing or not an array");

  const prices: RawPrice[] = [];
  const droppedKinds: string[] = [];
  for (const [index, entry] of value.prices.entries()) {
    const parsed = parsePrice(entry, index, allowedKinds, allowedCurrencies);
    // One bad price condemns the row: no half-read listing that looks complete.
    // Exceptions, both costing only the price and checked before the amount is
    // read: `unapproved-kind` (missing permission; a source approved for one of
    // two kinds must still sync) and `unrecognised-kind` (a newer protocol).
    if (!parsed.ok) {
      if (parsed.refusal === "unapproved-kind" || parsed.refusal === "unrecognised-kind") {
        droppedKinds.push(parsed.kind);
        continue;
      }
      return at(parsed.reason);
    }
    prices.push(parsed.price);
  }
  // A row that ARRIVED with prices and lost every one has nothing to store.
  // `prices: []` on arrival is LEGAL (the eBay plugin emits it for an unpriced
  // item, and `cheapestWindow` sorts it last), so gating on emptiness alone
  // would change its meaning. Kinds are deduped (an array can repeat one fifty
  // times) and clipped (plugin strings). Known limit: a row condemned later for
  // another reason loses its dropped-kind report.
  if (prices.length === 0 && droppedKinds.length > 0) {
    const named = [...new Set(droppedKinds)].map((kind) => JSON.stringify(kind.slice(0, 32))).join(", ");
    return at(`every price named a kind this source may not store or this app does not recognise (${named})`);
  }

  let url: string | null = null;
  if (value.url !== undefined && value.url !== null) {
    if (typeof value.url !== "string") return at("url must be a string or null");
    // Length before `new URL()`: a pathological string never reaches the costlier check.
    if (value.url.length > 2048) {
      return at("url must be an absolute http(s) URL of at most 2048 characters or null");
    }
    // The one field meant to be clicked, rendered as "the listing" beside the
    // price, so the app vouches for it: it must be an http(s) URL.
    if (!isHttpUrl(value.url)) return at("url must be an absolute http(s) URL or null");
    url = value.url;
  }

  const listing: RawListing = { sourceProductId: id, title: value.title, prices, url };

  // Same bounds and `null` = "not sent" as parseSyncRow.
  for (const field of ["categoryText", "conditionText"] as const) {
    const text = value[field];
    if (text === undefined || text === null) continue;
    if (field === "categoryText") {
      // Bounded: the classifier reads it.
      if (typeof text !== "string") return at("categoryText must be a string");
      if (text.length > 256) return at("categoryText must be a string of at most 256 characters");
      if (hasControlChar(text)) return at("categoryText carries a control character");
      listing.categoryText = text;
    } else {
      const checked = checkConditionText(text);
      if (!checked.ok) return at(checked.reason);
      listing.conditionText = checked.text;
    }
  }

  if (value.observedAt !== undefined && value.observedAt !== null) {
    const checked = checkObservedAt(value.observedAt);
    if (!checked.ok) return at(checked.reason);
    listing.observedAt = checked.observedAt;
  }

  if (value.available !== undefined) {
    if (typeof value.available !== "boolean" && value.available !== null) {
      return at("available must be a boolean or null");
    }
    listing.available = value.available;
  }

  if (droppedKinds.length === 0) return { ok: true, listing };
  return { ok: true, listing, droppedKinds };
}

/**
 * The largest amount this app can store: `price_points` amounts are
 * `numeric(10, 2)`, measured: Postgres accepts '99999999.99' and refuses
 * '100000000.00' with a numeric field overflow.
 *
 * Above it a row syncs fine (jsonb) and then, on every view of a game whose
 * confirmed mappings include it, fails that game's one-statement insert: the
 * block serves stale points under `status: "error"`, and every other price in
 * the batch is lost with it. Dropping the row here is cheaper.
 *
 * The USD twin (`amount * rate`) is not checked: the rate is unknown at parse
 * time, so an amount just under the ceiling can still overflow when converted.
 */
export const MAX_STORABLE_AMOUNT = 99_999_999.99;

/**
 * Two decimals, the precision the price columns keep. A sync amount is a NUMBER
 * on the wire and a STRING in `catalog_items.prices`; this is the one place that
 * converts. `String()` would write `0.30000000000000004` or `"1e+21"`; the
 * latter is also why MAX_STORABLE_AMOUNT must be checked first.
 */
function money(amount: number): string {
  return amount.toFixed(2);
}

/**
 * One row of a catalog page (protocol A.3), rebuilt field by field, never
 * spread, and dropped with a reason rather than half-trusted.
 *
 * `prices` is keyed by the APP's kind names (translating the source's labels
 * is the plugin's job) and NARROWED to the approved ones, not condemned: a
 * shop sending sell/cash/voucher to a user who approved only sell must still
 * sync. Dropped kinds are returned so the caller reports them once per page.
 *
 * No `url` field: a synced row is a catalogue entry, and its link comes from
 * the manifest's `productUrl` template.
 */
export function parseSyncRow(
  value: unknown,
  limits: SourceLimits = {},
): { ok: true; item: CatalogItemUpsert; droppedKinds: string[] } | { ok: false; reason: string } {
  const allowedKinds = limits.kinds ?? EVERY_KNOWN_KIND;
  const allowedCurrencies = limits.currencies ?? NO_CURRENCY_LIMIT;
  if (!isRecord(value)) return { ok: false, reason: "row is not an object" };

  const id = value.sourceProductId;
  if (typeof id !== "string" || id.trim().length === 0 || id.length > 128) {
    return { ok: false, reason: "sourceProductId must be a non-empty string of at most 128 characters" };
  }
  // Checked before `at` is built: `at` puts the id INTO a logged reason.
  if (hasControlChar(id)) {
    return { ok: false, reason: "sourceProductId carries a control character" };
  }
  // every reason from here on names the row, exactly as parseSidecarListing's do
  const at = (detail: string): { ok: false; reason: string } => ({ ok: false, reason: `${detail} (row ${id})` });

  if (typeof value.title !== "string" || value.title.trim().length === 0 || value.title.length > 512) {
    return at("title must be a non-empty string of at most 512 characters");
  }
  if (hasControlChar(value.title)) return at("title carries a control character");

  let categoryText: string | null = null;
  if (value.categoryText !== undefined && value.categoryText !== null) {
    if (typeof value.categoryText !== "string" || value.categoryText.length > 256) {
      return at("categoryText must be a string of at most 256 characters or null");
    }
    if (hasControlChar(value.categoryText)) return at("categoryText carries a control character");
    categoryText = value.categoryText;
  }

  if (typeof value.currency !== "string" || !ISO_4217.test(value.currency)) {
    // `echo`: `value.currency` can still be a non-string, and this is logged once per row.
    return at(`currency ${echo(value.currency)} is not a 3-letter ISO 4217 code`);
  }
  if (allowedCurrencies.size > 0 && !allowedCurrencies.has(value.currency)) {
    return at(`currency ${value.currency} is not one this source's site quotes`);
  }

  if (!isRecord(value.prices)) return at("prices must be an object");
  const priceEntries = Object.entries(value.prices);
  if (priceEntries.length === 0) return at("prices must name at least one kind");
  const prices: Record<string, string> = {};
  const droppedKinds: string[] = [];
  for (const [kind, amount] of priceEntries) {
    // Unknown or unapproved kinds are dropped, not fatal.
    if (!EVERY_KNOWN_KIND.has(kind) || !allowedKinds.has(kind)) {
      droppedKinds.push(kind);
      continue;
    }
    // A broken amount for a kind the app WOULD store is a broken claim: condemn the row.
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > MAX_STORABLE_AMOUNT) {
      return at(`prices.${kind} must be a finite number between 0 and ${MAX_STORABLE_AMOUNT}`);
    }
    prices[kind] = money(amount);
  }
  if (Object.keys(prices).length === 0) {
    // Nothing left to store. Kinds are plugin strings: clipped and quoted for the log.
    const named = droppedKinds.map((kind) => JSON.stringify(kind.slice(0, 32))).join(", ");
    return at(`prices names no kind this source has an approved role for (${named})`);
  }

  let available: boolean | null = null;
  if (value.available !== undefined && value.available !== null) {
    if (typeof value.available !== "boolean") return at("available must be a boolean or null");
    available = value.available;
  }

  // Keys not named here (e.g. `sourceMetadata`) are ignored, not refused.

  let observedAt: Date | null = null;
  if (value.observedAt !== undefined && value.observedAt !== null) {
    const checked = checkObservedAt(value.observedAt);
    if (!checked.ok) return at(checked.reason);
    observedAt = checked.observedAt;
  }

  let conditionText: string | null = null;
  if (value.conditionText !== undefined && value.conditionText !== null) {
    const checked = checkConditionText(value.conditionText);
    if (!checked.ok) return at(checked.reason);
    conditionText = checked.text;
  }

  // A sample only counts beside a price that survived; a non-count sample for
  // a stored kind is a broken claim and condemns the row.
  let sampleSizes: Record<string, number> | null = null;
  if (value.sampleSizes !== undefined && value.sampleSizes !== null) {
    if (!isRecord(value.sampleSizes)) return at("sampleSizes must be an object or null");
    for (const [kind, sample] of Object.entries(value.sampleSizes)) {
      if (!Object.hasOwn(prices, kind)) continue;
      if (!isSampleSize(sample)) {
        return at(`sampleSizes.${kind} must be a whole number from 1 to ${MAX_SAMPLE_SIZE}`);
      }
      (sampleSizes ??= {})[kind] = sample;
    }
  }

  return {
    ok: true,
    item: {
      sourceProductId: id,
      title: value.title,
      categoryText,
      prices,
      currency: value.currency,
      available,
      observedAt,
      conditionText,
      sampleSizes,
    },
    droppedKinds,
  };
}
