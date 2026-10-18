import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import {
  PRICE_KINDS,
  readStoredManifest,
  type PluginManifest,
  type PriceKind,
} from "@retrowatchdog/shared";
import type { Db } from "../db/index.js";
import { plugins } from "../db/schema.js";

/** `plugins.status` values; the column has no CHECK constraint, see `asStatus()`. */
export const PLUGIN_STATUSES = ["pending", "approved", "disabled"] as const;
export type PluginStatus = (typeof PLUGIN_STATUSES)[number];

/** What GET /health says: about the PROCESS, never about the source behind it. */
export interface PluginHealth {
  status: string;
  protocol: number;
  /** "I hold what I need to answer" — for eBay, both OAuth values present */
  configured: boolean;
}

export interface PluginRow {
  id: number;
  baseUrl: string;
  name: string;
  version: string;
  /**
   * The manifest the user APPROVED, which the app serves. Nothing ties it to
   * `status`: test `status` for "approved". Null also when it no longer validates.
   */
  manifest: PluginManifest | null;
  /** what the plugin last said, as far as this app can read it; a difference from `manifest` is drift */
  manifestSeen: PluginManifest | null;
  approvedKinds: Record<string, PriceKind[]>;
  status: PluginStatus;
  lastHealth: PluginHealth | null;
  lastHealthAt: Date | null;
  lastError: string | null;
  addedAt: Date;
  approvedAt: Date | null;
  /** When the app approved this row itself rather than a person; null for every ordinary approval. */
  adoptedAt: Date | null;
  /**
   * Operator-set ms between calls, or null to use the deployment default.
   * `asRateLimitMs` reads <= 0 as null: `RateLimiter` would treat it as "never wait".
   */
  rateLimitMs: number | null;
}

/** Why a base URL was refused, or the one spelling the app will store. */
export type BaseUrlCheck = { ok: true; baseUrl: string } | { ok: false; reason: string };

/**
 * The hosts a plugin URL may never name: the stack's own containers, the
 * loopback and link-local ranges (cloud metadata lives there). A LAN or
 * public host stays allowed: whoever reaches Settings → Plugins is the
 * operator, and plugins run anywhere they choose.
 */
const INTERNAL_HOSTS = new Set(["postgres", "redis", "api", "web", "worker", "localhost", "host.docker.internal", "metadata.google.internal"]);
export function isInternalTarget(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (INTERNAL_HOSTS.has(h) || h.endsWith(".localhost")) return true;
  if (/^127\./.test(h) || h === "0.0.0.0" || /^169\.254\./.test(h)) return true;
  if (h === "::1" || h === "::" || h.startsWith("fe80:") || h.startsWith("::ffff:127.")) return true;
  return false;
}

/**
 * The app will FETCH this URL from inside its own network, so a URL it will
 * not honour is REFUSED rather than repaired. Only trailing slashes are
 * collapsed. Userinfo is refused (it would be silently dropped, and plugin
 * secrets live in the plugin's environment); so are a query or fragment,
 * since every request path is appended to this string. `trim()` catches
 * paste artefacts (NBSP etc.) that the WHATWG parser does not strip.
 */
export function normalizeBaseUrl(value: string): BaseUrlCheck {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "not an absolute URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `${parsed.protocol}// is not a scheme this app can fetch; use http or https` };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return {
      ok: false,
      reason:
        "a plugin URL must not carry a username or password: the app would drop them and every call would go out unauthenticated. A plugin holds its own secrets, in its own environment.",
    };
  }
  if (parsed.search !== "") {
    return { ok: false, reason: "a plugin URL must not carry a query string: the app appends its own" };
  }
  if (parsed.hash !== "") {
    return { ok: false, reason: "a plugin URL must not carry a fragment: it is never sent to the server" };
  }
  if (isInternalTarget(parsed.hostname)) {
    return { ok: false, reason: `${parsed.hostname} is this deployment's own service or loopback, not a plugin address` };
  }
  return { ok: true, baseUrl: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}` };
}

/**
 * A column this app cannot read, said out loud rather than swallowed.
 * `console.warn` because the callers have three different loggers.
 */
function unreadable(column: string, pluginId: number, reason: string): void {
  console.warn(`plugins.${column} of plugin ${pluginId} cannot be read and is ignored: ${reason}`);
}

// A stored row can be hand-edited, restored or written by an older build, so
// it is CHECKED, not cast. `readStoredManifest` skips only the protocol check:
// moving the constant must not empty the registry of approved plugins.
const asManifest = (value: unknown, column: string, pluginId: number): PluginManifest | null => {
  // The normal empty state, not a defect: nothing has been fetched or approved.
  if (value === null || value === undefined) return null;
  const checked = readStoredManifest(value);
  if (checked.ok) return checked.manifest;
  unreadable(column, pluginId, checked.reason);
  return null;
};

/**
 * Rebuilt rather than cast or spread, so an unnamed key cannot ride along
 * into the plugin DTO.
 */
function asHealth(value: unknown, pluginId: number): PluginHealth | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    unreadable("last_health", pluginId, "it is not a JSON object");
    return null;
  }
  const { status, protocol, configured } = value;
  if (typeof status !== "string") {
    unreadable("last_health", pluginId, "status is not a string");
    return null;
  }
  if (typeof protocol !== "number" || !Number.isFinite(protocol)) {
    unreadable("last_health", pluginId, "protocol is not a number");
    return null;
  }
  if (typeof configured !== "boolean") {
    unreadable("last_health", pluginId, "configured is not a boolean");
    return null;
  }
  return { status, protocol, configured };
}

/**
 * `status` decides whether the app queries a plugin at all, so an unknown
 * value must never read as `approved`. It reads as `disabled` ("the app will
 * not query it"), not `pending`, which would claim nobody has reviewed it.
 */
function asStatus(value: unknown, pluginId: number): PluginStatus {
  if (typeof value === "string" && (PLUGIN_STATUSES as readonly string[]).includes(value)) {
    return value as PluginStatus;
  }
  unreadable("status", pluginId, `${JSON.stringify(value)} is not one of ${PLUGIN_STATUSES.join(", ")}`);
  return "disabled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KNOWN_KINDS: ReadonlySet<string> = new Set(PRICE_KINDS);

/**
 * Keyed by source id and read as `approvedKinds[sourceId]`, so rebuilt on a
 * null-prototype object: a key like `constructor` must not read as approved
 * via Object.prototype. Unknown kinds are dropped.
 */
function asApprovedKinds(value: unknown): Record<string, PriceKind[]> {
  const approved = Object.create(null) as Record<string, PriceKind[]>;
  if (!isRecord(value)) return approved;
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(value, key)) continue;
    const kinds = value[key];
    if (!Array.isArray(kinds)) continue;
    approved[key] = kinds.filter((kind): kind is PriceKind => typeof kind === "string" && KNOWN_KINDS.has(kind));
  }
  return approved;
}

function asRateLimitMs(value: unknown, pluginId: number): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  unreadable("rate_limit_ms", pluginId, `${JSON.stringify(value)} is not a positive whole number of milliseconds`);
  return null;
}

function toRow(row: typeof plugins.$inferSelect): PluginRow {
  return {
    id: row.id,
    baseUrl: row.baseUrl,
    name: row.name,
    version: row.version,
    manifest: asManifest(row.manifest, "manifest", row.id),
    manifestSeen: asManifest(row.manifestSeen, "manifest_seen", row.id),
    approvedKinds: asApprovedKinds(row.approvedKinds),
    status: asStatus(row.status, row.id),
    lastHealth: asHealth(row.lastHealth, row.id),
    lastHealthAt: row.lastHealthAt,
    lastError: row.lastError,
    addedAt: row.addedAt,
    approvedAt: row.approvedAt,
    adoptedAt: row.adoptedAt,
    rateLimitMs: asRateLimitMs(row.rateLimitMs, row.id),
  };
}

/** Newest first, so the Plugins panel leads with what the user just imported. */
export async function listPlugins(db: Db): Promise<PluginRow[]> {
  // desc id tiebreak: rows imported in the same instant share `added_at`.
  const rows = await db.select().from(plugins).orderBy(desc(plugins.addedAt), desc(plugins.id));
  return rows.map(toRow);
}

export async function getPlugin(db: Db, id: number): Promise<PluginRow | null> {
  const [row] = await db.select().from(plugins).where(eq(plugins.id, id));
  return row ? toRow(row) : null;
}

export async function findPluginByBaseUrl(db: Db, baseUrl: string): Promise<PluginRow | null> {
  const [row] = await db.select().from(plugins).where(eq(plugins.baseUrl, baseUrl));
  return row ? toRow(row) : null;
}

/**
 * A newly imported plugin, always `pending` with nothing approved. `base_url`
 * is unique (SQLSTATE 23505 on duplicate). No `manifest` input on purpose:
 * that column means "what the user approved".
 */
export async function insertPlugin(
  db: Db,
  input: {
    baseUrl: string;
    name: string;
    version: string;
    manifestSeen: PluginManifest | null;
    lastHealth?: PluginHealth | null;
    lastError?: string | null;
  },
): Promise<PluginRow> {
  const lastHealth = input.lastHealth ?? null;
  const [row] = await db
    .insert(plugins)
    .values({
      baseUrl: input.baseUrl,
      name: input.name,
      version: input.version,
      manifestSeen: input.manifestSeen,
      lastHealth,
      lastHealthAt: lastHealth ? new Date() : null,
      lastError: input.lastError ?? null,
    })
    .returning();
  return toRow(row);
}

/**
 * Why an approval did not happen. `manifest-changed`: the plugin published
 * something else while a person was reading the old one.
 */
export type ApprovalResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "no-manifest" | "manifest-changed" };

/**
 * JSON with every object's keys in sorted order, so two documents that say the
 * same thing compare equal. Needed because these manifests have been through
 * jsonb, which does not preserve key order.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, raw: unknown) => {
    if (!isRecord(raw)) return raw;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(raw).sort()) sorted[key] = raw[key];
    return sorted;
  });
}

/**
 * A manifest reduced to one stable string, so the approve route can refuse an
 * approval whose fingerprint is not what the row hashes to NOW: the browser
 * only holds a flattened DTO, not the document. Uses the same `canonicalJson`
 * as `approvePlugin` so the two can never disagree. sha256 for being
 * ordinary, not for attack resistance.
 */
export function manifestFingerprint(manifest: PluginManifest | null): string | null {
  if (manifest === null) return null;
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

/**
 * Promote `manifest_seen` to `manifest` and record the checked kinds, but only
 * if `reviewed` (the manifest the user read) still matches it canonically: the
 * health tick can rewrite `manifest_seen` at any time. Row is locked FOR UPDATE.
 *
 * `last_error` is NOT cleared: it belongs to the last poll, and clearing it
 * would hide that the standing health reading is stale.
 */
export async function approvePlugin(
  db: Db,
  id: number,
  approvedKinds: Record<string, PriceKind[]>,
  reviewed: PluginManifest,
): Promise<ApprovalResult> {
  return db.transaction(async (tx): Promise<ApprovalResult> => {
    const [row] = await tx
      .select({ id: plugins.id, manifestSeen: plugins.manifestSeen })
      .from(plugins)
      .where(eq(plugins.id, id))
      .for("update");
    if (!row) return { ok: false, reason: "not-found" };
    const seen = asManifest(row.manifestSeen, "manifest_seen", row.id);
    // Never fetched, or unreadable: approval would consent to no document.
    if (seen === null) return { ok: false, reason: "no-manifest" };
    if (canonicalJson(seen) !== canonicalJson(reviewed)) {
      return { ok: false, reason: "manifest-changed" };
    }
    await tx
      .update(plugins)
      .set({
        status: "approved",
        // the validated rebuild, so the served column is fully checked
        manifest: seen,
        approvedKinds,
        approvedAt: new Date(),
      })
      .where(eq(plugins.id, id));
    return { ok: true };
  });
}

export async function setPluginStatus(db: Db, id: number, status: PluginStatus): Promise<void> {
  await db.update(plugins).set({ status }).where(eq(plugins.id, id));
}

/**
 * A poll's result. A failed poll (health null) keeps the last health and its
 * timestamp, so a dead worker never makes every plugin read unconfigured and
 * a stale reading never looks fresh; the error goes in `last_error`. A first
 * failed poll leaves `last_health` null ("never answered"), which the registry
 * treats as unconfigured. A null `manifestSeen` means nothing new was learned.
 */
export async function recordPluginHealth(
  db: Db,
  id: number,
  health: PluginHealth | null,
  manifestSeen: PluginManifest | null,
  lastError: string | null,
): Promise<void> {
  const set: Partial<typeof plugins.$inferInsert> = { lastError };
  if (health !== null) {
    set.lastHealth = health;
    set.lastHealthAt = new Date();
  }
  if (manifestSeen !== null) set.manifestSeen = manifestSeen;
  await db.update(plugins).set(set).where(eq(plugins.id, id));
}

/**
 * Set (or clear) this plugin's pace. Null means "auto" and follows
 * SIDECAR_RATE_LIMIT_MS; storing today's default would freeze it.
 */
export async function setPluginPace(db: Db, id: number, rateLimitMs: number | null): Promise<void> {
  await db.update(plugins).set({ rateLimitMs }).where(eq(plugins.id, id));
}

/**
 * Move a plugin to a new address, keeping its grants. `manifest` is untouched:
 * the caller probes the new address into `manifest_seen`, so any difference
 * surfaces as drift and sends the user back to review.
 */
export async function setPluginBaseUrl(db: Db, id: number, baseUrl: string): Promise<void> {
  await db.update(plugins).set({ baseUrl }).where(eq(plugins.id, id));
}

export async function deletePlugin(db: Db, id: number): Promise<void> {
  await db.delete(plugins).where(eq(plugins.id, id));
}
