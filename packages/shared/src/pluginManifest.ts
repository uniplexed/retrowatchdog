/**
 * IMPORT CYCLE: index.ts re-exports this file and this file imports values
 * from index.ts. A module-level read of an imported value throws a TDZ
 * ReferenceError under Node ESM and silently reads `undefined` under Vitest
 * (every manifest then fails validation). Both were observed. Invariant: read
 * imported values only inside function bodies, and pass vocabularies to
 * `declares()` as parameters instead of freezing them into module-level Sets.
 */
import { COUNTRY_CODES, CONVERTIBLE_CURRENCIES, PRICE_KINDS, REGIONS } from "./index.js";
import type { PriceKind, SourceId, SourceInfo, SourceSchedule } from "./index.js";
// Read only inside parseSource() too, for consistency (platforms.ts is not in the cycle).
import { PLATFORMS } from "./platforms.js";
import type { Platform } from "./platforms.js";

/**
 * Protocol version this app speaks. `validateManifest` refuses any other
 * number from a plugin; `readStoredManifest` never compares it, so raising
 * this does not empty the registry (an old plugin fails its health poll and
 * keeps its approved manifest until re-approved). Same constant as
 * `SIDECAR_PROTOCOL_VERSION`; docs/sidecar-protocol.md must change with it.
 */
export const PLUGIN_PROTOCOL_VERSION = 3;

/**
 * Every role this app understands; a manifest may claim no other. `guide` is
 * deliberately inert to the signal engine. Declared here so `PriceRole`
 * derives from it.
 */
export const PRICE_ROLES = ["buy_listing", "buy_store", "bid", "reference", "guide"] as const;

/** A source as a plugin proposes it: `SourceInfo` plus the id it claims. */
export interface PluginManifestSource extends SourceInfo {
  id: SourceId;
}

/**
 * The manifest fields whose change alters WHAT THE APP DOES with a source, so
 * a change makes a person review again (a version bump does not). Each one
 * decides transport, sweeping (a sync sweep deletes unseen rows), which prices
 * exist, classification, PROFIT, market placement, or what the app prints or
 * links in its own voice.
 *
 * Deliberately excluded: `id` (a changed id already shows as an added and a
 * removed source) and `label`/`familyLabel` (prose a person can check on
 * the card in front of them).
 */
export const DRIFT_FIELDS = [
  "kind",
  "kindRoles",
  "kindLabels",
  "kindLabelsShort",
  "reach",
  "country",
  "defaultRegion",
  "expectedCurrencies",
  "sellFeeRate",
  "schedule",
  "productUrl",
  "categoryPlatforms",
  "caveat",
  "family",
] as const;

export interface PluginManifest {
  protocol: number;
  plugin: { name: string; version: string };
  /** NAMES of the environment variables the plugin needs; never values */
  requiredSecrets: string[];
  sources: PluginManifestSource[];
}

export type ManifestValidation =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; reason: string };

const PLUGIN_NAME = /^[a-z][a-z0-9_-]{1,31}$/;
/**
 * Does NOT keep Object.prototype names out (`constructor` matches);
 * `namesAPrototypeProperty()` does.
 */
const SOURCE_ID = /^[a-z][a-z0-9_]{1,31}$/;
const FAMILY = /^[a-z][a-z0-9_]{1,31}$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;
const ISO_4217 = /^[A-Z]{3}$/;
/** Caps the one otherwise-unbounded string; checked before the regex. */
const MAX_CRON_LENGTH = 120;
/** How much of an offending value a rejection quotes back. */
export const MAX_ECHO_LENGTH = 80;
/** At least one letter or digit — see `rendered()`. */
const HAS_VISIBLE_CHARACTER = /[\p{L}\p{N}]/u;
/**
 * Five cron-ish fields: the SHAPE only. This package cannot import
 * cron-parser, so a cron that passes here is plausible, not accepted; the API
 * parses it when it builds the sync capability.
 */
const CRON_5 = /^[\d*/,\-A-Za-z?]+(\s+[\d*/,\-A-Za-z?]+){4}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Does this string name a property `Object.prototype` already carries?
 * Ids and families become object keys, and a lookup of `constructor` would
 * answer a function instead of `undefined`. `value in {}` is exact for
 * whatever language version runs this; a denylist would go stale.
 */
function namesAPrototypeProperty(value: string): boolean {
  return value in {};
}

/** Quote a value back to the author, cut with a visible ellipsis. */
export function echo(value: unknown): string {
  const quoted = JSON.stringify(value) ?? String(value);
  return quoted.length <= MAX_ECHO_LENGTH ? quoted : `${quoted.slice(0, MAX_ECHO_LENGTH)}…`;
}

/** Vocabulary membership; the list is a PARAMETER because of the import cycle (top of file). */
function declares<T extends string>(vocabulary: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (vocabulary as readonly string[]).includes(value);
}

/**
 * Does this string carry a C0 control character or DEL?
 *
 * Refused rather than left to 500: `plugins.manifest_seen` is jsonb, and
 * Postgres refuses a NUL in it (`null character not permitted`, measured).
 * Stricter than `hasControlChar` in apps/api/src/adapters/sidecar/protocol.ts,
 * which allows tab/newline/CR in shop-written titles; everything gated here is
 * one-line text the app prints in its own voice.
 *
 * A loop, not a regex: a character class containing control bytes is where
 * tooling-induced byte damage in this repo would hide.
 */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * A non-blank string, at most `max` long, with no control character. The
 * minimum is measured trimmed (meaning), the maximum raw (stored size). Never
 * transforms the value. Use `rendered()` for strings the app displays.
 */
function text(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length >= min &&
    value.length <= max &&
    !hasControlCharacter(value)
  );
}

/**
 * A string the app will PUT ON A SCREEN: `text()` plus at least one letter
 * or digit, because `trim()` misses invisible characters (U+200B, U+2060,
 * U+00AD) and a nameless heading hides where prices came from. `\p{L}\p{N}`
 * so any script is a good label.
 */
function rendered(value: unknown, min: number, max: number): value is string {
  return text(value, min, max) && HAS_VISIBLE_CHARACTER.test(value);
}

const fail = (reason: string): ManifestValidation => ({ ok: false, reason });

/**
 * A manifest is a PROPOSAL from an untrusted process. Every field is checked
 * and the result REBUILT, never spread, so an unnamed key has no way through.
 * Validation only, never repair; every rejection names the field.
 */
function parseManifestBody(value: Record<string, unknown>, protocol: number): ManifestValidation {
  const plugin = value.plugin;
  if (!isRecord(plugin)) return fail("plugin must be an object with a name and a version");
  const name = plugin.name;
  const version = plugin.version;
  if (typeof name !== "string" || !PLUGIN_NAME.test(name)) {
    return fail(`plugin.name ${echo(name)} must match ${PLUGIN_NAME.source}`);
  }
  // Deviation from the spec (which allows ""): a person identifies the approved
  // build by this, so it must not be blank.
  if (!text(version, 1, 32)) {
    return fail("plugin.version must be a string of 1 to 32 characters and no control character");
  }

  // Optional; absent means the plugin needs no secrets.
  const requiredSecrets: string[] = [];
  if (value.requiredSecrets !== undefined) {
    if (!Array.isArray(value.requiredSecrets) || value.requiredSecrets.length > 10) {
      return fail("requiredSecrets must be an array of at most 10 names");
    }
    for (const secret of value.requiredSecrets) {
      // Catches the common paste of a value, not every one (an upper-cased token
      // matches). The real protection: the app never asks for or stores a secret.
      if (typeof secret !== "string" || !SECRET_NAME.test(secret)) {
        return fail(
          `requiredSecrets entry ${echo(secret)} is not an environment variable NAME (${SECRET_NAME.source})`,
        );
      }
      if (requiredSecrets.includes(secret)) return fail(`requiredSecrets lists ${echo(secret)} twice`);
      requiredSecrets.push(secret);
    }
  }

  if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 20) {
    return fail("sources must be an array of 1 to 20 entries");
  }

  const sources: PluginManifestSource[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.sources.entries()) {
    const parsed = parseSource(entry, index);
    if (!parsed.ok) return fail(parsed.reason);
    if (seen.has(parsed.source.id)) return fail(`sources declares ${parsed.source.id} twice`);
    seen.add(parsed.source.id);
    sources.push(parsed.source);
  }

  return {
    ok: true,
    manifest: { protocol, plugin: { name, version }, requiredSecrets, sources },
  };
}

/**
 * The gate for a manifest a plugin PUBLISHED, run on every fetch from a plugin
 * (`fetchPluginManifest`, apps/api/src/plugins/client.ts). Approval reads
 * `manifest_seen` back through `readStoredManifest`, which is safe because
 * nothing reaches that column except through this gate.
 */
export function validateManifest(value: unknown): ManifestValidation {
  if (!isRecord(value)) return fail("the manifest is not a JSON object");
  if (value.protocol !== PLUGIN_PROTOCOL_VERSION) {
    return fail(
      `this plugin speaks protocol ${echo(value.protocol)}; this app requires ${PLUGIN_PROTOCOL_VERSION}`,
    );
  }
  return parseManifestBody(value, PLUGIN_PROTOCOL_VERSION);
}

/**
 * The gate for a manifest read back out of a `plugins` row (hand-edited,
 * restored, or written by an older build): every field check, but NOT the
 * protocol number. The shape protects the app; the version asserts a live
 * process speaks this wire, which a table row is not, and comparing it would
 * drop every approved plugin the moment the constant moves. The number is
 * preserved: the row is the record of what a person approved.
 */
export function readStoredManifest(value: unknown): ManifestValidation {
  if (!isRecord(value)) return fail("the manifest is not a JSON object");
  const protocol = value.protocol;
  if (typeof protocol !== "number" || !Number.isInteger(protocol) || protocol < 1) {
    return fail(`protocol ${echo(protocol)} is not a protocol number`);
  }
  return parseManifestBody(value, protocol);
}

function parseSource(
  value: unknown,
  index: number,
): { ok: true; source: PluginManifestSource } | { ok: false; reason: string } {
  const at = (detail: string) => ({ ok: false as const, reason: `sources[${index}].${detail}` });
  if (!isRecord(value)) return { ok: false, reason: `sources[${index}] is not an object` };

  const id = value.id;
  if (typeof id !== "string" || !SOURCE_ID.test(id)) {
    return at(`id ${echo(id)} must match ${SOURCE_ID.source}`);
  }
  if (namesAPrototypeProperty(id)) {
    return at(`id ${echo(id)} names a property of Object.prototype and cannot be a key in the registry`);
  }
  const kind = value.kind;
  if (kind !== "live" && kind !== "sync") return at('kind must be "live" or "sync"');
  const label = value.label;
  if (!rendered(label, 1, 60)) {
    return at("label must be 1 to 60 characters, contain a letter or digit, and no control character");
  }
  const familyLabel = value.familyLabel;
  if (!rendered(familyLabel, 1, 40)) {
    return at(
      "familyLabel must be 1 to 40 characters, contain a letter or digit, and no control character",
    );
  }
  const family = value.family;
  if (typeof family !== "string" || !FAMILY.test(family)) {
    return at(`family ${echo(family)} must match ${FAMILY.source}`);
  }
  if (namesAPrototypeProperty(family)) {
    return at(`family ${echo(family)} names a property of Object.prototype and cannot be a grouping key`);
  }
  // COUNTRY_CODES drives the markets picker: an unknown code could never be valued.
  const country = value.country;
  if (!declares(COUNTRY_CODES, country)) {
    return at(`country ${echo(country)} is not a country this app has a market in`);
  }
  const reach = value.reach;
  if (reach !== "local" && reach !== "global") return at('reach must be "local" or "global"');

  // `null` declares "do not guess a region"; a missing field is refused.
  const defaultRegion = value.defaultRegion;
  if (defaultRegion !== null && !declares(REGIONS, defaultRegion)) {
    return at(`defaultRegion must be null or one of ${REGIONS.join(", ")}`);
  }

  if (
    !Array.isArray(value.expectedCurrencies) ||
    value.expectedCurrencies.length < 1 ||
    value.expectedCurrencies.length > 5
  ) {
    return at("expectedCurrencies must be an array of 1 to 5 ISO 4217 codes");
  }
  const expectedCurrencies: string[] = [];
  for (const code of value.expectedCurrencies) {
    if (typeof code !== "string" || !ISO_4217.test(code)) {
      return at(`expectedCurrencies entry ${echo(code)} is not a 3-letter ISO 4217 code`);
    }
    // Shape is not enough: `ZZZ` is nothing this app can price.
    if (!declares(CONVERTIBLE_CURRENCIES, code)) {
      return at(`expectedCurrencies entry ${echo(code)} is not a currency this app's rate provider quotes`);
    }
    if (expectedCurrencies.includes(code)) return at(`expectedCurrencies lists ${echo(code)} twice`);
    expectedCurrencies.push(code);
  }

  // At least one role, or the source is inert; at most one per kind the app has.
  if (!isRecord(value.kindRoles)) return at("kindRoles must be an object");
  const kindRoles: Partial<Record<PriceKind, (typeof PRICE_ROLES)[number]>> = {};
  const roleEntries = Object.entries(value.kindRoles);
  if (roleEntries.length < 1 || roleEntries.length > PRICE_KINDS.length) {
    return at(`kindRoles must declare 1 to ${PRICE_KINDS.length} kinds`);
  }
  for (const [kind, role] of roleEntries) {
    if (!declares(PRICE_KINDS, kind)) {
      return at(`kindRoles key ${echo(kind)} is not a price kind this app knows`);
    }
    if (!declares(PRICE_ROLES, role)) {
      return at(`kindRoles.${kind} ${echo(role)} is not a price role this app understands`);
    }
    kindRoles[kind] = role;
  }

  // Required: a source words its own prices rather than borrow the app's
  // vocabulary. No protocol condition, so stored older manifests are held to it too.
  if (!isRecord(value.kindLabels)) return at("kindLabels must be an object with a label per kind this source gives a role");
  const kindLabels: Partial<Record<PriceKind, string>> = {};
  for (const [kind, kindLabel] of Object.entries(value.kindLabels)) {
    // Kind list first, so prototype names are refused as unknown kinds.
    if (!declares(PRICE_KINDS, kind)) {
      return at(`kindLabels key ${echo(kind)} is not a price kind this app knows`);
    }
    // Own keys, not `in`, so this line does not rely on the check above.
    if (!Object.hasOwn(kindRoles, kind)) {
      return at(`kindLabels.${kind} labels a kind this source declares no role for`);
    }
    // Deviation from the spec (no length there): same bound as `label`.
    if (!rendered(kindLabel, 1, 60)) {
      return at(
        `kindLabels.${kind} must be 1 to 60 characters, contain a letter or digit, and no control character`,
      );
    }
    kindLabels[kind] = kindLabel;
  }
  // The reverse direction: every role gets a word.
  for (const kind of Object.keys(kindRoles)) {
    if (!Object.hasOwn(kindLabels, kind)) {
      return at(`kindLabels has no label for ${kind}, which this source declares a role for`);
    }
  }

  // Optional, per kind: the same wording with the source's name taken out, for
  // places where the app already prints the name. Absent falls back to the app's clause.
  let kindLabelsShort: Partial<Record<PriceKind, string>> | undefined;
  if (value.kindLabelsShort !== undefined) {
    if (!isRecord(value.kindLabelsShort)) return at("kindLabelsShort must be an object");
    kindLabelsShort = {};
    for (const [kind, short] of Object.entries(value.kindLabelsShort)) {
      if (!declares(PRICE_KINDS, kind)) {
        return at(`kindLabelsShort key ${echo(kind)} is not a price kind this app knows`);
      }
      if (!Object.hasOwn(kindRoles, kind)) {
        return at(`kindLabelsShort.${kind} labels a kind this source declares no role for`);
      }
      // A word, not a clause: half the bound.
      if (!rendered(short, 1, 30)) {
        return at(`kindLabelsShort.${kind} must be 1 to 30 characters, contain a letter or digit, and no control character`);
      }
      kindLabelsShort[kind] = short;
    }
  }

  // Deviation from the spec (no minimum there): a blank warning label is refused.
  let caveat: string | undefined;
  if (value.caveat !== undefined) {
    if (!rendered(value.caveat, 1, 300)) {
      return at("caveat must be 1 to 300 characters, contain a letter or digit, and no control character");
    }
    caveat = value.caveat;
  }

  // SECURITY: the origin check is a PROBE. Substituting an id must still resolve
  // to the prefix's own origin, which refuses `https://uk.webuy{id}.com/p` (id
  // `evil.com/x` walks to another host) and `https://uk.webuy.com{id}` (id
  // `@...` turns the host into a username) while accepting safe forms a string
  // prefix check would refuse (uppercase host, default port, query with no
  // path). Percent-encoding at apply time cannot stop a host change.
  let productUrl: string | undefined;
  if (value.productUrl !== undefined) {
    if (!text(value.productUrl, 1, 512)) {
      return at("productUrl must be a string of 1 to 512 characters and no control character");
    }
    const parts = value.productUrl.split("{id}");
    if (parts.length !== 2) return at("productUrl must contain {id} exactly once");
    const prefix = parts[0];
    let base: URL;
    try {
      base = new URL(prefix);
    } catch {
      return at(`productUrl ${echo(value.productUrl)} must be an https URL with {id} after the host`);
    }
    if (base.protocol !== "https:") return at("productUrl must be https");
    if (base.username !== "" || base.password !== "") return at("productUrl must carry no credentials");
    let probed: URL;
    try {
      probed = new URL(prefix + "PROBEID");
    } catch {
      return at("productUrl must put {id} after the host, so no product id can change where the app links");
    }
    if (probed.origin !== base.origin) {
      return at("productUrl must put {id} after the host, so no product id can change where the app links");
    }
    productUrl = value.productUrl;
  }

  // Sync only: a live row's category is never read. Values must be this app's
  // platforms; keys are the shop's own text.
  let categoryPlatforms: Partial<Record<string, Platform>> | undefined;
  if (value.categoryPlatforms !== undefined) {
    if (kind !== "sync") {
      return at('categoryPlatforms is for a sync source, and this source declares kind "live"');
    }
    if (!isRecord(value.categoryPlatforms)) return at("categoryPlatforms must be an object");
    const entries = Object.entries(value.categoryPlatforms);
    if (entries.length < 1 || entries.length > 200) {
      return at("categoryPlatforms must map 1 to 200 categories");
    }
    // No prototype, so `map[categoryText]` for a shelf named "constructor"
    // answers undefined, not a function.
    categoryPlatforms = Object.create(null) as Partial<Record<string, Platform>>;
    // Read inside the function: the ESM-cycle note at the top of this file.
    const platformIds = Object.keys(PLATFORMS) as Platform[];
    for (const [category, platform] of entries) {
      if (!text(category, 1, 256)) {
        return at(`categoryPlatforms key ${echo(category)} must be 1 to 256 characters and no control character`);
      }
      // Kept despite the null prototype, so no future reader depends on it.
      if (namesAPrototypeProperty(category)) {
        return at(`categoryPlatforms key ${echo(category)} names a property every object already has`);
      }
      if (!declares(platformIds, platform)) {
        return at(`categoryPlatforms.${category} ${echo(platform)} is not a platform this app has`);
      }
      categoryPlatforms[category] = platform;
    }
  }

  // An estimate of the seller's fee loss. PROFIT multiplies by (1 - rate), so it
  // is bounded to [0, 1]; isFinite catches NaN, which passes every comparison.
  let sellFeeRate: number | undefined;
  if (value.sellFeeRate !== undefined) {
    if (
      typeof value.sellFeeRate !== "number" ||
      !Number.isFinite(value.sellFeeRate) ||
      value.sellFeeRate < 0 ||
      value.sellFeeRate > 1
    ) {
      return at("sellFeeRate must be a number in [0, 1]");
    }
    sellFeeRate = value.sellFeeRate;
  }

  // Required on sync: the app has no honest cadence to choose for a sweep.
  if (kind === "sync" && value.schedule === undefined) {
    return at('schedule is required on a sync source: a catalog sweep needs a cadence, and this app will not choose one for you');
  }

  let schedule: SourceSchedule | undefined;
  if (value.schedule !== undefined) {
    // Refused on live: a live source has no catalog to sweep.
    if (kind !== "sync") return at('schedule is for a sync source, and this source declares kind "live"');
    if (!isRecord(value.schedule)) return at("schedule must be an object");
    const { catalogCron, trackedRefreshHours } = value.schedule;
    // Matched as sent (never trimmed); length first because CRON_5 bounds shape only.
    if (
      typeof catalogCron !== "string" ||
      catalogCron.length > MAX_CRON_LENGTH ||
      !CRON_5.test(catalogCron)
    ) {
      return at(`schedule.catalogCron ${echo(catalogCron)} is not a 5-field cron expression of at most ${MAX_CRON_LENGTH} characters`);
    }
    // Whole hours: this becomes a repeat interval.
    if (
      typeof trackedRefreshHours !== "number" ||
      !Number.isInteger(trackedRefreshHours) ||
      trackedRefreshHours < 1 ||
      trackedRefreshHours > 168
    ) {
      return at("schedule.trackedRefreshHours must be a whole number of hours in 1..168");
    }
    schedule = { catalogCron, trackedRefreshHours };
  }

  // Rebuilt, never spread. Optional fields attach only when sent.
  const source: PluginManifestSource = {
    id,
    kind,
    label,
    family,
    familyLabel,
    country,
    reach,
    defaultRegion,
    expectedCurrencies,
    kindRoles,
    kindLabels,
  };
  // An empty object must not attach: absent and {} are the same fact and must
  // give the same `manifestFingerprint`, or a drift line appears for nothing.
  if (kindLabelsShort && Object.keys(kindLabelsShort).length > 0) {
    source.kindLabelsShort = kindLabelsShort;
  }
  if (caveat) source.caveat = caveat;
  if (productUrl) source.productUrl = productUrl;
  if (categoryPlatforms) source.categoryPlatforms = categoryPlatforms;
  if (sellFeeRate !== undefined) source.sellFeeRate = sellFeeRate;
  if (schedule) source.schedule = schedule;
  return { ok: true, source };
}
