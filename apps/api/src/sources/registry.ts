import {
  type PluginManifest,
  type PriceKind,
  type PriceRole,
  type SourceId,
  type SourceInfo,
  type SourceInfoDto,
} from "@retrowatchdog/shared";
import pino from "pino";
import type { Db } from "../db/index.js";
import type { PriceSourceAdapter, SnapshotStrategy } from "../adapters/types.js";
import { SidecarAdapter } from "../adapters/sidecar/index.js";
import { PluginCatalogAdapter } from "../adapters/sidecar/catalogAdapter.js";
import { SidecarSyncCapability } from "../adapters/sidecar/sync.js";
import { RateLimiter } from "../lib/rateLimiter.js";
import { CircuitBreaker } from "../lib/circuitBreaker.js";
import { config } from "../config.js";
import { listPlugins, type PluginRow } from "../plugins/repo.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "warn" });

/**
 * The sources this deployment has right now: every approved plugin's approved
 * manifest. Rebuilt from the `plugins` table (which the worker also writes),
 * and replaced through `deps.reloadSources()` — so readers go through
 * `app.deps` per request, after any await, never a reference captured once.
 */
export interface SourceRegistry {
  /** every source this deployment has, in approval order */
  readonly sources: SourceInfoDto[];
  /**
   * The same set keyed by id, as the shared signal helpers take it.
   *
   * A NULL-PROTOTYPE object, deliberately: the keys are strings a plugin chose,
   * and on a plain object `constructor` or `toString` would answer a lookup
   * with a function. The manifest validator also refuses such ids, but this map
   * is built from a column that can be hand-edited or restored from a backup.
   */
  readonly byId: Record<SourceId, SourceInfo>;
  get(id: string): SourceInfoDto | undefined;
  has(id: string): boolean;
}

export interface SourceRuntime {
  registry: SourceRegistry;
  adapters: PriceSourceAdapter[];
}

/**
 * The roles this source may actually claim: what its manifest DECLARED,
 * restricted to the kinds the user CHECKED at approval. Narrowed here because
 * the price table renders every stored row, so an unapproved role would still
 * reach the screen. No record of an approval reads as nothing approved.
 */
export function effectiveKindRoles(
  declared: Partial<Record<PriceKind, PriceRole>>,
  approved: PriceKind[] | undefined,
): Partial<Record<PriceKind, PriceRole>> {
  const allowed = new Set(approved ?? []);
  const roles: Partial<Record<PriceKind, PriceRole>> = {};
  for (const [kind, role] of Object.entries(declared)) {
    if (allowed.has(kind as PriceKind) && role !== undefined) roles[kind as PriceKind] = role;
  }
  return roles;
}

/**
 * The kind labels (long or short) this source may print, restricted to the
 * kinds that survived `effectiveKindRoles` — otherwise a label for an unticked
 * kind still puts a claim on screen. Absent or empty returns `undefined`, and
 * the game view falls back to its own wording.
 */
export function effectiveKindLabels(
  declared: Partial<Record<PriceKind, string>> | undefined,
  kindRoles: Partial<Record<PriceKind, PriceRole>>,
): Partial<Record<PriceKind, string>> | undefined {
  if (declared === undefined) return undefined;
  const labels: Partial<Record<PriceKind, string>> = {};
  for (const [kind, label] of Object.entries(declared)) {
    if (Object.hasOwn(kindRoles, kind) && label !== undefined) labels[kind as PriceKind] = label;
  }
  return Object.keys(labels).length === 0 ? undefined : labels;
}

/**
 * Derived from the EFFECTIVE roles — never declared by a manifest, never from
 * a kind's name — so a plugin cannot turn a handful of asking prices into a
 * market baseline.
 *
 * BOTH `buy_listing` and `reference` are required: with only `reference`, the
 * median strategy would take a median of references and count it as listings.
 * Everything else, including the common buy_listing-only marketplace, stores
 * each row as it arrived with no sample size, so it can never pass the
 * engine's sample floor.
 */
export function snapshotStrategyFor(
  kindRoles: Partial<Record<PriceKind, PriceRole>>,
): SnapshotStrategy {
  const roles = new Set(Object.values(kindRoles));
  return roles.has("buy_listing") && roles.has("reference") ? "median_of_listings" : "per_listing";
}

/**
 * Approved AND the last health said so; never answered means NOT configured.
 * `last_health` survives a failed poll, so a stopped worker cannot flip every
 * plugin to unconfigured at once. Only as fresh as the runtime it was built
 * for: the API rebuilds before the two endpoints that report it
 * (`GET /api/settings/markets`, `GET /api/sources`).
 */
function pluginConfigured(plugin: PluginRow): boolean {
  return plugin.status === "approved" && plugin.lastHealth?.configured === true;
}

/**
 * The pace and the breaker one plugin is held to, kept ACROSS rebuilds.
 *
 * The worker rebuilds adapters on every health tick (five minutes by default);
 * a breaker rebuilt with them would force an open breaker closed long before
 * SIDECAR_BREAKER_HOLD_MS (half an hour) ran out.
 *
 * Keyed by row id AND base URL: a row repointed elsewhere is a different
 * process. A manifest change keeps the key. The store belongs to the caller
 * (app.ts, worker/index.ts) and is never pruned; it is bounded by the plugins
 * one process ever sees.
 */
export interface PluginPacing {
  limiter: RateLimiter;
  breaker: CircuitBreaker;
}
export type PluginPacingStore = Map<string, PluginPacing>;

/**
 * How fast this deployment may call this plugin: the row's `rateLimitMs`, else
 * the default. NOTHING HERE READS `plugin.manifest` — a plugin may not ask to
 * be called faster than the operator allows.
 */
export function paceFor(plugin: PluginRow): { ms: number; source: "plugin" | "default" } {
  if (plugin.rateLimitMs !== null) return { ms: plugin.rateLimitMs, source: "plugin" };
  return { ms: config.SIDECAR_RATE_LIMIT_MS, source: "default" };
}

function pacingFor(store: PluginPacingStore, plugin: PluginRow): PluginPacing {
  // A stored base URL holds no space (normalizeBaseUrl), so keys cannot collide.
  // The pace is deliberately NOT in the key: a miss would also hand back a
  // fresh breaker, closing an open one. A pace change updates the limiter in place.
  const key = `${plugin.id} ${plugin.baseUrl}`;
  const known = store.get(key);
  if (known !== undefined) {
    known.limiter.setInterval(paceFor(plugin).ms);
    return known;
  }
  // ONE limiter and ONE breaker per plugin, shared by every source it serves:
  // it is one process behind one base URL. The values come from the operator
  // only; no manifest field may set a plugin's pace, breaker or timeout.
  const pacing: PluginPacing = {
    limiter: new RateLimiter(paceFor(plugin).ms),
    breaker: new CircuitBreaker({
      failureThreshold: config.SIDECAR_BREAKER_THRESHOLD,
      holdMs: config.SIDECAR_BREAKER_HOLD_MS,
    }),
  };
  store.set(key, pacing);
  return pacing;
}

/**
 * Build the registry and the adapter list that goes with it. Cheap (one query,
 * no connections), so it runs at boot and after every `plugins` change.
 *
 * `injected` is a test seam; production passes none. `pacing` preserves each
 * plugin's limiter and breaker (see `PluginPacingStore`); omitting it gives
 * fresh breakers.
 */
export async function buildSourceRuntime(
  db: Db,
  injected: PriceSourceAdapter[] = [],
  pacing: PluginPacingStore = new Map(),
): Promise<SourceRuntime> {

  // Null-prototype for the reason `byId` states.
  const byId = Object.create(null) as Record<string, SourceInfoDto>;
  const sources: SourceInfoDto[] = [];
  const add = (dto: SourceInfoDto): void => {
    // First declaration of an id wins. Import and approve refuse collisions
    // (routes/plugins.ts); this holds for a row that got past them anyway.
    if (Object.hasOwn(byId, dto.id)) return;
    byId[dto.id] = dto;
    sources.push(dto);
  };

  const adapters: PriceSourceAdapter[] = [...injected];

  // Only an APPROVED plugin's APPROVED manifest is served. Oldest approval
  // first (listPlugins returns newest first), so a later plugin declaring the
  // same id can never displace one already approved. `addedAt` stands in for a
  // missing `approvedAt`; the id makes the order total.
  const approved = (await listPlugins(db))
    .filter((p): p is PluginRow & { manifest: PluginManifest } => p.status === "approved" && p.manifest !== null)
    .sort(
      (a, b) =>
        (a.approvedAt ?? a.addedAt).getTime() - (b.approvedAt ?? b.addedAt).getTime() || a.id - b.id,
    );

  for (const plugin of approved) {
    // Looked up, not constructed: an open breaker must survive a health-tick rebuild.
    const { limiter, breaker } = pacingFor(pacing, plugin);
    for (const declared of plugin.manifest.sources) {
      if (Object.hasOwn(byId, declared.id)) continue;
      const kindRoles = effectiveKindRoles(declared.kindRoles, plugin.approvedKinds[declared.id]);
      // No approved kind: left OUT rather than added as a source whose every
      // row would be refused while it still reported `configured`.
      if (Object.keys(kindRoles).length === 0) continue;
      // Belt-and-braces: the manifest parser already refuses a sync source with
      // no schedule, but should one reach here it is left out with a log line
      // rather than scheduled never. Not defaulted: no cadence is anyone's choice.
      if (declared.kind === "sync" && declared.schedule === undefined) {
        log.warn(
          { plugin: plugin.id, source: declared.id },
          "sync source declares no schedule; left out of the registry",
        );
        continue;
      }
      // Labels are narrowed like the roles; a plain spread would leak revoked ones.
      const { kindLabels: declaredLabels, kindLabelsShort: declaredShort, ...rest } = declared;
      const kindLabels = effectiveKindLabels(declaredLabels, kindRoles);
      const kindLabelsShort = effectiveKindLabels(declaredShort, kindRoles);
      add({
        ...rest,
        kindRoles,
        ...(kindLabels === undefined ? {} : { kindLabels }),
        ...(kindLabelsShort === undefined ? {} : { kindLabelsShort }),
        configured: pluginConfigured(plugin),
        origin: "plugin",
        pluginId: plugin.id,
      });
      // the kinds this source may SEND are the ones it may claim a role for
      const declaredKinds = Object.keys(kindRoles) as PriceKind[];
      const snapshotStrategy = snapshotStrategyFor(kindRoles);
      if (declared.kind === "sync" && declared.schedule !== undefined) {
        // Carrying `catalogSync` is what makes the worker schedule a sync;
        // search reads this deployment's own `catalog_items`.
        adapters.push(
          new PluginCatalogAdapter({
            db,
            source: declared.id,
            baseUrl: plugin.baseUrl,
            snapshotStrategy,
            declaredKinds,
            // Selects the app's reading of this shop's category vocabulary.
            family: declared.family,
            // A synced row carries no URL, so this template is the only link its
            // points get — and the mapping sweep matches points back by it.
            ...(declared.productUrl === undefined ? {} : { productUrl: declared.productUrl }),
            // The exact map `snapshotStrategy` was derived from, so they cannot disagree.
            kindRoles,
            expectedCurrencies: declared.expectedCurrencies,
            // Without it a SKU naming no region classifies `unknown`.
            defaultRegion: declared.defaultRegion,
            catalogSync: new SidecarSyncCapability({
              source: declared.id,
              baseUrl: plugin.baseUrl,
              schedule: declared.schedule,
              approvedKinds: declaredKinds,
              expectedCurrencies: declared.expectedCurrencies,
              limiter,
              breaker,
            }),
          }),
        );
        continue;
      }
      adapters.push(
        new SidecarAdapter({
          source: declared.id,
          baseUrl: plugin.baseUrl,
          snapshotStrategy,
          declaredKinds,
          // The exact map `snapshotStrategy` was derived from, so they cannot disagree.
          kindRoles,
          expectedCurrencies: declared.expectedCurrencies,
          defaultRegion: declared.defaultRegion,
          limiter,
          breaker,
        }),
      );
    }
  }

  return {
    adapters,
    registry: {
      sources,
      byId,
      get: (id) => (Object.hasOwn(byId, id) ? byId[id] : undefined),
      has: (id) => Object.hasOwn(byId, id),
    },
  };
}
