import { eq } from "drizzle-orm";
import pino from "pino";
import type { Db } from "../db/index.js";
import { appSettings } from "../db/schema.js";
import { findPluginByBaseUrl, insertPlugin, normalizeBaseUrl } from "./repo.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "warn" });

/**
 * app_settings key recording that this one-shot seed has run. Only the row's
 * existence matters; the value (the URL acted on) is a note nobody reads.
 */
export const PLUGIN_SEED_KEY = "plugin_seed_done";

/** Vinted keeps the original key, so a deployment that already had its offer is not offered it twice. */
const seedKey = (name: string): string => (name === "vinted" ? PLUGIN_SEED_KEY : `${PLUGIN_SEED_KEY}:${name}`);

/**
 * Offer a shipped plugin's URL as a PENDING plugin row, never approved here: the
 * roles are the user's to approve. Nothing is fetched (a boot must not wait on
 * another container); the worker's health tick fills in manifest and health.
 *
 * Once per deployment, ever: a deleted row must not come back on the next
 * boot. An already-present URL (imported by hand) also counts as done. An
 * unparseable URL writes no marker, so fixing a typo still gets the offer.
 */
export async function seedPluginsFromEnv(db: Db, baseUrl: string | undefined, name = "vinted"): Promise<void> {
  if (baseUrl === undefined) return;
  if (await seedHasRun(db, name)) return;
  const url = normalizeBaseUrl(baseUrl);
  if (!url.ok) {
    log.warn({ plugin: name, reason: url.reason }, "plugin URL is not one this app can fetch; nothing seeded");
    return;
  }
  if ((await findPluginByBaseUrl(db, url.baseUrl)) === null) {
    await insertPlugin(db, {
      baseUrl: url.baseUrl,
      name,
      version: "unknown",
      manifestSeen: null,
      lastError: "not contacted yet",
    });
  }
  // After the insert: if it throws (two processes racing the unique base_url),
  // no marker is written and the next boot finishes the job.
  await markSeedRun(db, name, url.baseUrl);
}

async function seedHasRun(db: Db, name: string): Promise<boolean> {
  const [row] = await db
    .select({ key: appSettings.key })
    .from(appSettings)
    .where(eq(appSettings.key, seedKey(name)));
  return row !== undefined;
}

async function markSeedRun(db: Db, name: string, baseUrl: string): Promise<void> {
  // The first writer's row is the true record; a late second process has nothing to correct.
  await db
    .insert(appSettings)
    .values({ key: seedKey(name), value: { baseUrl }, updatedAt: new Date() })
    .onConflictDoNothing({ target: [appSettings.key] });
}
