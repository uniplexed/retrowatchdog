import { eq } from "drizzle-orm";
import { type SourceId } from "@retrowatchdog/shared";
import type { Db } from "../db/index.js";
import { appSettings } from "../db/schema.js";
import { config } from "../config.js";

/**
 * Reads and writes a list of ids and does NOT decide which ids exist: it has
 * no registry in reach, so filtering here would drop enabled plugin sources.
 * Every consumer intersects this list with what can actually answer.
 */

/** app_settings key holding the enabled-market list (a SourceId[] JSON array). */
export const ENABLED_SOURCES_KEY = "enabled_sources";

/**
 * ENABLED_SOURCES is the SEED, not the runtime answer: the stored
 * `enabled_sources` row wins whenever it exists. Reading never writes the row,
 * so the seed applies until the user saves a list.
 */
export function seedEnabledSources(): SourceId[] {
  return config.ENABLED_SOURCES.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * An empty array is a real answer ("every market off"), so only a missing
 * row or a non-array falls back to the seed.
 */
function parseStored(value: unknown): SourceId[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is SourceId => typeof v === "string");
}

/**
 * The markets this deployment queries right now. One query — callers cache it
 * per request or per worker tick and pass it down, never one read per adapter.
 */
export async function loadEnabledSources(db: Db): Promise<Set<SourceId>> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, ENABLED_SOURCES_KEY));
  return new Set(parseStored(row?.value) ?? seedEnabledSources());
}

/**
 * The registry's enabled subset, as source ids. "Disabled" means this
 * deployment does not read that market's stored points either, not just that
 * it does not fetch it.
 */
export async function enabledSourceIds(
  db: Db,
  registry: ReadonlyArray<{ source: SourceId }>,
): Promise<SourceId[]> {
  const enabled = await loadEnabledSources(db);
  return registry.map((a) => a.source).filter((source) => enabled.has(source));
}

/** Writes the user's choice; from here on the env seed is ignored. */
export async function saveEnabledSources(db: Db, enabled: SourceId[]): Promise<void> {
  const updatedAt = new Date();
  await db
    .insert(appSettings)
    .values({ key: ENABLED_SOURCES_KEY, value: enabled, updatedAt })
    .onConflictDoUpdate({
      target: [appSettings.key],
      set: { value: enabled, updatedAt },
    });
}
