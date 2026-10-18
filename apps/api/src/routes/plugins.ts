import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import {
  DRIFT_FIELDS,
  PRICE_KINDS,
  paceBudget,
  pacedSourceCount,
  type PluginDto,
  type PluginManifest,
  type PluginManifestSource,
  type PluginSourceDto,
  type PluginsResponse,
  type PriceKind,
} from "@retrowatchdog/shared";
import { config } from "../config.js";
import type { Db } from "../db/index.js";
import { isUniqueViolation } from "../db/errors.js";
import { paceFor, type SourceRegistry } from "../sources/registry.js";
import { fetchPluginHealth, fetchPluginManifest } from "../plugins/client.js";
import { PluginHttpError, PluginProtocolError } from "../plugins/http.js";
import {
  approvePlugin,
  deletePlugin,
  findPluginByBaseUrl,
  getPlugin,
  insertPlugin,
  listPlugins,
  manifestFingerprint,
  normalizeBaseUrl,
  recordPluginHealth,
  setPluginBaseUrl,
  setPluginPace,
  setPluginStatus,
  type PluginRow,
} from "../plugins/repo.js";
import { loadEnabledSources, saveEnabledSources } from "../settings/markets.js";

const addSchema = z.object({ baseUrl: z.string() }).strict();
/**
 * The kinds the user checked, keyed by source id. Keys are client-chosen, so
 * prototype names matter: Fastify refuses a `__proto__` body outright, and a
 * `constructor` key is refused by the approve handler because
 * `validateManifest` never lets a manifest declare such an id.
 */
const approveSchema = z
  .object({
    approvedKinds: z.record(z.string(), z.array(z.enum(PRICE_KINDS))),
    // Non-empty so an omitted field cannot arrive as "" and match a digest.
    reviewedFingerprint: z.string().min(1),
  })
  .strict();

/**
 * Where the APPROVED and the last SEEN manifest disagree: `+shop_fr` appeared,
 * `-shop_fr` went, `shop_gb.kindRoles` changed. Evidence for a review only; the
 * approved manifest keeps serving until the user approves the new one.
 */
export function driftFields(approved: PluginManifest | null, seen: PluginManifest | null): string[] {
  if (approved === null || seen === null) return [];
  const drift: string[] = [];
  const approvedIds = new Set(approved.sources.map((s) => s.id));
  const seenIds = new Set(seen.sources.map((s) => s.id));
  for (const id of seenIds) if (!approvedIds.has(id)) drift.push(`+${id}`);
  for (const id of approvedIds) if (!seenIds.has(id)) drift.push(`-${id}`);
  for (const source of approved.sources) {
    const now = seen.sources.find((s) => s.id === source.id);
    if (!now) continue;
    for (const field of DRIFT_FIELDS) {
      if (JSON.stringify(source[field]) !== JSON.stringify(now[field])) {
        drift.push(`${source.id}.${field}`);
      }
    }
  }
  if (JSON.stringify(approved.requiredSecrets) !== JSON.stringify(seen.requiredSecrets)) {
    drift.push("requiredSecrets");
  }
  return drift;
}

/**
 * Refuses a manifest id another plugin already serves, naming the owner by
 * name and row id.
 *
 * `ownIds` must come from the REGISTRY, not the row's `manifest`: the registry
 * drops sources approved with no kinds (and disabled rows keep their manifest),
 * so carving out a column id could admit two rows for one id, and the
 * approved_at tie-break would then silently move the id between them.
 *
 * Not race-proof: two concurrent approvals in one process both pass, since
 * `app.deps` is read before the awaits. Closing that needs the check inside
 * `approvePlugin`'s transaction.
 *
 * `only` limits the check to the ids being approved; a source approved for no
 * kind never enters the registry, so it can collide with nothing.
 */
async function idCollision(
  db: Db,
  registry: SourceRegistry,
  manifest: PluginManifest,
  opts: { ownIds: Set<string>; only?: Set<string> },
): Promise<string | null> {
  for (const source of manifest.sources) {
    if (opts.ownIds.has(source.id)) continue;
    if (opts.only && !opts.only.has(source.id)) continue;
    const existing = registry.get(source.id);
    if (!existing) continue;
    const row = await getPlugin(db, existing.pluginId);
    const owner = row ? `another plugin (${row.name}, id ${row.id})` : `another plugin (id ${existing.pluginId})`;
    return `${source.id} is already served by ${owner}`;
  }
  return null;
}

/**
 * `validateManifest` (packages/shared) only checks the cron's shape; the app's
 * own parser must read it, or the catalog job is silently never scheduled.
 */
function badCron(manifest: PluginManifest): string | null {
  for (const source of manifest.sources) {
    if (!source.schedule) continue;
    try {
      CronExpressionParser.parse(source.schedule.catalogCron);
    } catch {
      return `sources[${source.id}].schedule.catalogCron is not a cron expression this app can read`;
    }
  }
  return null;
}

/**
 * One sentence naming the URL and the call. Plugin errors already do; undici
 * transport errors don't, and hide the real reason on `cause`.
 */
function callFailure(baseUrl: string, step: string, error: unknown): string {
  if (error instanceof PluginHttpError || error instanceof PluginProtocolError) return error.message;
  const err = error as Error & { cause?: unknown };
  const cause = err.cause instanceof Error ? `: ${err.cause.message}` : "";
  return `${baseUrl} ${step} failed: ${err.message}${cause}`;
}

/**
 * How a refused approval reaches the client. `manifest-changed` is a 409 raised
 * both by the handler's `reviewedFingerprint` check and by `approvePlugin`'s
 * in-transaction check; the worker's health tick rewrites `manifest_seen`, so
 * a running deployment really does hit it.
 */
export function approvalRefusal(
  reason: "not-found" | "no-manifest" | "manifest-changed",
  id: number,
): { code: number; error: string } {
  if (reason === "not-found") return { code: 404, error: `no plugin ${id}` };
  if (reason === "no-manifest") {
    return { code: 400, error: "this plugin has not answered /manifest yet" };
  }
  return {
    code: 409,
    error: "this plugin changed its manifest while you were reviewing it; review it again",
  };
}

/**
 * One source as the panel reviews it. Every field the app acts on is served
 * (see `DRIFT_FIELDS`): a consent screen may not hide what it asks consent to.
 * `approvedKinds` is the last decision for this id, used to pre-tick a
 * re-review, not a grant under the seen document.
 */
function sourceDto(
  source: PluginManifestSource,
  approvedKinds: Record<string, PriceKind[]>,
  // Always the APPROVED manifest, never the seen/proposed one.
  approvedManifest: PluginManifest | null,
): PluginSourceDto {
  return {
    id: source.id,
    label: source.label,
    family: source.family,
    familyLabel: source.familyLabel,
    country: source.country,
    reach: source.reach,
    kind: source.kind,
    // Declared roles; the registry narrows them to what was approved.
    kindRoles: source.kindRoles,
    kindLabels: source.kindLabels,
    kindLabelsShort: source.kindLabelsShort,
    caveat: source.caveat,
    productUrl: source.productUrl,
    categoryPlatforms: source.categoryPlatforms,
    defaultRegion: source.defaultRegion,
    expectedCurrencies: source.expectedCurrencies,
    // Absent means "declared none"; never invent a 0 or a schedule here.
    sellFeeRate: source.sellFeeRate,
    schedule: source.schedule,
    approvedKinds: approvedKinds[source.id] ?? [],
    approvedKindRoles: approvedManifest?.sources.find((s) => s.id === source.id)?.kindRoles ?? {},
  };
}

/** Sources this row's pace must serve; sync ones are excluded, no document counts as one. */
function sourceCount(row: PluginRow): number {
  const sources = row.manifest?.sources ?? row.manifestSeen?.sources;
  return sources === undefined ? 1 : pacedSourceCount(sources);
}

function toDto(row: PluginRow): PluginDto {
  const pace = paceFor(row);
  // Approved: what the registry serves. Pending/disabled: the last seen one.
  const served = row.status === "approved" ? row.manifest : row.manifestSeen;
  const seenFingerprint = manifestFingerprint(row.manifestSeen);
  const servedFingerprint = manifestFingerprint(served);
  // The seen document when it differs by any byte, so a drifted plugin can be
  // reviewed and approved from its card. Not gated on `drift`: `protocol` is
  // fingerprinted but never compared by `driftFields`, and `proposed` is the
  // only fingerprint the approve guard accepts.
  const proposed =
    row.manifestSeen !== null && seenFingerprint !== null && seenFingerprint !== servedFingerprint
      ? {
          name: row.manifestSeen.plugin.name,
          version: row.manifestSeen.plugin.version,
          requiredSecrets: row.manifestSeen.requiredSecrets,
          sources: row.manifestSeen.sources.map((source) =>
            sourceDto(source, row.approvedKinds, row.manifest),
          ),
          manifestFingerprint: seenFingerprint,
        }
      : null;
  return {
    id: row.id,
    baseUrl: row.baseUrl,
    // The row's columns are only written at import, so prefer the served manifest.
    name: served?.plugin.name ?? row.name,
    version: served?.plugin.version ?? row.version,
    status: row.status,
    // Never answered health = not configured; no evidence is not a yes.
    configured: row.lastHealth?.configured === true,
    requiredSecrets: served?.requiredSecrets ?? [],
    sources: (served?.sources ?? []).map((source) => sourceDto(source, row.approvedKinds, row.manifest)),
    drift: driftFields(row.manifest, row.manifestSeen),
    proposed,
    adoptedAt: row.adoptedAt?.toISOString() ?? null,
    lastError: row.lastError,
    lastHealthAt: row.lastHealthAt?.toISOString() ?? null,
    manifestFingerprint: servedFingerprint,
    // Null means any approval of this row will be refused, even an approved row.
    seenFingerprint,
    rateLimitMs: row.rateLimitMs,
    effectiveRateLimitMs: pace.ms,
    rateLimitSource: pace.source,
  };
}

/**
 * `plugins.id` is a serial int4; without the bound 2147483648 reaches postgres
 * and comes back as a 500 quoting the SQL instead of a 404.
 */
const MAX_INT4 = 2147483647;

function parseId(params: unknown): number | null {
  const raw = (params as { id?: string }).id ?? "";
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 && id <= MAX_INT4 ? id : null;
}

export async function pluginRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/plugins", async (): Promise<PluginsResponse> => {
    // Read per request in every handler: `reloadSources()` replaces deps.
    const { db } = app.deps;
    return {
      plugins: (await listPlugins(db)).map(toDto),
      // The panel checks a pace against this before saving.
      adapterTimeoutMs: config.ADAPTER_TIMEOUT_MS,
    };
  });

  /**
   * Import a plugin by URL.
   *
   * SECURITY: this makes the app fetch a URL a person typed from inside the
   * compose network, so it can probe internal ports (it tells open from closed
   * and echoes a little of what answered, size-capped). No address blocklist,
   * on purpose: plugins live at private addresses by design, DNS resolves at
   * fetch time anyway, and with no auth in v1 every other write endpoint is
   * equally reachable (the web container's LAN-exposed Caddy proxies /api/).
   * Calls are GETs with no caller-chosen headers, no redirects, byte and time
   * caps (plugins/http.ts). If this API ever leaves a network the user controls
   * or gains accounts, add an ALLOWLIST of plugin hosts, never a blocklist.
   */
  app.post("/api/plugins", async (req, reply) => {
    const body = addSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid body" });
    const { db, sources } = app.deps;

    // Refused, never repaired: credentials, a query or a fragment would store
    // something the user did not type.
    const checked = normalizeBaseUrl(body.data.baseUrl);
    if (!checked.ok) return reply.code(400).send({ error: checked.reason });
    const baseUrl = checked.baseUrl;
    if (await findPluginByBaseUrl(db, baseUrl)) {
      return reply.code(400).send({ error: `${baseUrl} is already added` });
    }

    // Both calls happen here so a broken plugin leaves no row behind. Worst
    // case is two ADAPTER_TIMEOUT_MS budgets; `AbortSignal.timeout` is an
    // absolute deadline, so a dripping plugin cannot hold the request open.
    let health;
    let manifest: PluginManifest;
    try {
      health = await fetchPluginHealth(baseUrl);
    } catch (error) {
      return reply.code(400).send({ error: callFailure(baseUrl, "GET /health", error) });
    }
    try {
      manifest = await fetchPluginManifest(baseUrl);
    } catch (error) {
      return reply.code(400).send({ error: callFailure(baseUrl, "GET /manifest", error) });
    }

    const cron = badCron(manifest);
    if (cron) return reply.code(400).send({ error: cron });
    const collision = await idCollision(db, sources, manifest, { ownIds: new Set() });
    if (collision) return reply.code(400).send({ error: collision });

    // `insertPlugin` takes no `manifest`, so an import cannot grant anything.
    // Two imports racing through the network gap meet the unique `base_url`
    // index; answer that with the pre-check's 400, not a 500.
    let row: PluginRow;
    try {
      row = await insertPlugin(db, {
        baseUrl,
        name: manifest.plugin.name,
        version: manifest.plugin.version,
        manifestSeen: manifest,
        lastHealth: health,
        lastError: null,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return reply.code(400).send({ error: `${baseUrl} is already added` });
    }
    return reply.code(201).send({ plugin: toDto(row) });
  });

  /**
   * Grant a plugin's sources the kinds a person checked.
   *
   * The guard is `reviewedFingerprint`: a plugin must not promote itself (e.g.
   * `sell` from `buy_store` to `reference`, which the panel leaves unchecked by
   * default) by republishing while the review screen is open. The client sends
   * back the fingerprint it was served and approval only proceeds while the
   * seen manifest still hashes to it. A drifted row is approved via
   * `proposed`'s fingerprint; the top-level one earns a 409.
   */
  app.post("/api/plugins/:id/approve", async (req, reply) => {
    const body = approveSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid body" });
    const { db, sources } = app.deps;
    const id = parseId(req.params);
    if (id === null) return reply.code(404).send({ error: "no such plugin" });
    const row = await getPlugin(db, id);
    if (!row) return reply.code(404).send({ error: `no plugin ${id}` });
    // Also narrows `row.manifestSeen` to non-null below.
    if (!row.manifestSeen) {
      return reply.code(400).send({ error: "this plugin has not answered /manifest yet" });
    }

    // First, so later refusals never name a field of a document the user never saw.
    if (manifestFingerprint(row.manifestSeen) !== body.data.reviewedFingerprint) {
      const refusal = approvalRefusal("manifest-changed", id);
      return reply.code(refusal.code).send({ error: refusal.error });
    }

    // Only kinds the manifest declares a role for; a client cannot widen it.
    for (const [sourceId, kinds] of Object.entries(body.data.approvedKinds)) {
      const declared = row.manifestSeen.sources.find((s) => s.id === sourceId);
      if (!declared) {
        return reply.code(400).send({ error: `${sourceId} is not a source of this plugin` });
      }
      for (const kind of kinds) {
        if (!Object.hasOwn(declared.kindRoles, kind)) {
          return reply.code(400).send({ error: `${sourceId} declares no role for ${kind}` });
        }
      }
    }

    // Import checks run again: the health tick may have replaced
    // `manifest_seen` since import. The protocol gate is not repeated because
    // a document only reaches that column after passing `validateManifest`.
    const cron = badCron(row.manifestSeen);
    if (cron) return reply.code(400).send({ error: cron });

    // Ids this plugin already serves don't count; only sources approved for a
    // kind are checked. Registry, never `row.manifest` (see `idCollision`).
    const ownIds = new Set(
      sources.sources.filter((s) => s.origin === "plugin" && s.pluginId === id).map((s) => s.id),
    );
    const approving = new Set(
      Object.entries(body.data.approvedKinds)
        .filter(([, kinds]) => kinds.length > 0)
        .map(([sourceId]) => sourceId),
    );
    const collision = await idCollision(db, sources, row.manifestSeen, { ownIds, only: approving });
    if (collision) return reply.code(400).send({ error: collision });

    // Pass back the exact document checked above; `approvePlugin` promotes it
    // or nothing, so a concurrent write cannot slip in an unchecked manifest.
    const outcome = await approvePlugin(
      db,
      id,
      body.data.approvedKinds as Record<string, PriceKind[]>,
      row.manifestSeen,
    );
    if (!outcome.ok) {
      const refusal = approvalRefusal(outcome.reason, id);
      return reply.code(refusal.code).send({ error: refusal.error });
    }
    await app.deps.reloadSources();
    const approved = await getPlugin(db, id);
    return reply.code(200).send({ plugin: toDto(approved!) });
  });

  /**
   * Run the worker's health tick for one plugin now, so a user who just fixed
   * a plugin need not wait PLUGIN_HEALTH_INTERVAL_MS. A /health answer is kept
   * even if /manifest then fails. Cannot grant anything: only `manifest_seen`
   * and health columns are written. One call per row at a time, because two
   * probes of a dead plugin cost two timeouts.
   */
  const rechecking = new Set<number>();
  app.post("/api/plugins/:id/recheck", async (req, reply) => {
    const { db } = app.deps;
    const id = parseId(req.params);
    if (id === null) return reply.code(404).send({ error: "no such plugin" });
    const row = await getPlugin(db, id);
    if (!row) return reply.code(404).send({ error: `no plugin ${id}` });
    // "Disabled means not queried" holds on every path.
    if (row.status === "disabled") {
      return reply.code(409).send({ error: "this plugin is off; turn it on first" });
    }
    if (rechecking.has(id)) {
      return reply.code(409).send({ error: "already checking this plugin" });
    }
    rechecking.add(id);
    try {
      let health = null;
      let manifest: PluginManifest | null = null;
      let failure: string | null = null;
      try {
        health = await fetchPluginHealth(row.baseUrl);
        manifest = await fetchPluginManifest(row.baseUrl);
      } catch (error) {
        failure = callFailure(row.baseUrl, health === null ? "GET /health" : "GET /manifest", error);
      }
      await recordPluginHealth(db, id, health, manifest, failure);
      await app.deps.reloadSources();
      return reply.code(200).send({ plugin: toDto((await getPlugin(db, id))!) });
    } finally {
      rechecking.delete(id);
    }
  });

  /**
   * Set how fast this deployment may call one plugin.
   *
   * A plugin's sources share ONE limiter, so a pace decides when the LAST
   * source starts; if that misses the timeout budget it fails silently
   * (`withTimeout` is a bare race). So refuse what `paceBudget` says won't fit,
   * leaving PLUGIN_CALL_ALLOWANCE_MS to finish. `null` (auto) is never refused,
   * so a set pace can always be unset; the panel warns instead.
   */
  const paceSchema = z
    .object({ rateLimitMs: z.number().nullable() })
    .strict();
  app.post("/api/plugins/:id/pace", async (req, reply) => {
    const body = paceSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "rateLimitMs must be a number of milliseconds, or null" });
    }
    const { db } = app.deps;
    const id = parseId(req.params);
    if (id === null) return reply.code(404).send({ error: "no such plugin" });
    const row = await getPlugin(db, id);
    if (!row) return reply.code(404).send({ error: `no plugin ${id}` });

    const ms = body.data.rateLimitMs;
    if (ms !== null) {
      if (!Number.isInteger(ms) || ms <= 0) {
        return reply.code(400).send({ error: "the pace must be a whole number of milliseconds above 0" });
      }
      const n = sourceCount(row);
      const budget = paceBudget(n, ms, config.ADAPTER_TIMEOUT_MS);
      if (!budget.fits) {
        return reply.code(400).send({
          error:
            `${row.name} serves ${n} live markets on one queue, so at ${ms} ms the last one starts ` +
            `${budget.lastStartMs} ms in — too late to answer inside the ${config.ADAPTER_TIMEOUT_MS} ms ` +
            `a game view waits. Use ${budget.largestThatFitsMs} ms or less.`,
        });
      }
    }

    await setPluginPace(db, id, ms);
    // Applies here on the next call; the worker picks it up on its next health
    // tick (within PLUGIN_HEALTH_INTERVAL_MS).
    await app.deps.reloadSources();
    return reply.code(200).send({ plugin: toDto((await getPlugin(db, id))!) });
  });

  /**
   * Move a plugin to a new address, keeping its grant and pace.
   *
   * `manifest` is not written: whoever answers at the new address must not
   * inherit the old one's consent. The address is probed first (and must
   * answer), and what it publishes goes to `manifest_seen`, so anything
   * different drifts and asks for a review.
   */
  const addressSchema = z.object({ baseUrl: z.string() }).strict();
  app.post("/api/plugins/:id/address", async (req, reply) => {
    const body = addressSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid body" });
    const { db } = app.deps;
    const id = parseId(req.params);
    if (id === null) return reply.code(404).send({ error: "no such plugin" });
    const row = await getPlugin(db, id);
    if (!row) return reply.code(404).send({ error: `no plugin ${id}` });

    const checked = normalizeBaseUrl(body.data.baseUrl);
    if (!checked.ok) return reply.code(400).send({ error: checked.reason });
    const baseUrl = checked.baseUrl;
    if (baseUrl === row.baseUrl) {
      return reply.code(200).send({ plugin: toDto(row) });
    }
    const taken = await findPluginByBaseUrl(db, baseUrl);
    if (taken) return reply.code(400).send({ error: `${baseUrl} is already added` });

    let health;
    let manifest: PluginManifest;
    try {
      health = await fetchPluginHealth(baseUrl);
    } catch (error) {
      return reply.code(400).send({ error: callFailure(baseUrl, "GET /health", error) });
    }
    try {
      manifest = await fetchPluginManifest(baseUrl);
    } catch (error) {
      return reply.code(400).send({ error: callFailure(baseUrl, "GET /manifest", error) });
    }
    const cron = badCron(manifest);
    if (cron) return reply.code(400).send({ error: cron });

    try {
      await setPluginBaseUrl(db, id, baseUrl);
    } catch (error) {
      // Same race as the import: the unique `base_url` index catches it.
      if (!isUniqueViolation(error)) throw error;
      return reply.code(400).send({ error: `${baseUrl} is already added` });
    }
    await recordPluginHealth(db, id, health, manifest, null);
    await app.deps.reloadSources();
    return reply.code(200).send({ plugin: toDto((await getPlugin(db, id))!) });
  });

  app.post("/api/plugins/:id/disable", async (req, reply) => {
    const { db } = app.deps;
    const id = parseId(req.params);
    if (id === null) return reply.code(404).send({ error: "no such plugin" });
    const row = await getPlugin(db, id);
    if (!row) return reply.code(404).send({ error: `no plugin ${id}` });
    // Row and prices stay. Unlike DELETE, the enabled list is NOT pruned, so
    // re-approving brings the sources back switched on.
    await setPluginStatus(db, id, "disabled");
    await app.deps.reloadSources();
    return reply.code(200).send({ plugin: toDto((await getPlugin(db, id))!) });
  });

  app.delete("/api/plugins/:id", async (req, reply) => {
    const { db } = app.deps;
    const id = parseId(req.params);
    if (id === null) return reply.code(404).send({ error: "no such plugin" });
    const row = await getPlugin(db, id);
    if (!row) return reply.code(404).send({ error: `no plugin ${id}` });
    // A pending plugin's ids live only in `manifest_seen`.
    const ids = new Set([
      ...(row.manifest?.sources ?? []).map((s) => s.id),
      ...(row.manifestSeen?.sources ?? []).map((s) => s.id),
    ]);
    await deletePlugin(db, id);

    // Prune dead ids from the enabled list (Settings serves it verbatim).
    // Stored prices, catalog items and mappings are kept as history.
    const enabled = [...(await loadEnabledSources(db))];
    const remaining = enabled.filter((source) => !ids.has(source));
    // Only write on change, or the ENABLED_SOURCES seed gets frozen into the DB.
    if (remaining.length !== enabled.length) await saveEnabledSources(db, remaining);
    await app.deps.reloadSources();
    return reply.code(200).send({ ok: true });
  });
}
