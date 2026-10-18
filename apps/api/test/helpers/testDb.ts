import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Db } from "../../src/db/index.js";

// Overridable so tests can target a non-default host/port (e.g. a throwaway
// postgres container while the published 5432 is held by another stack).
const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ??
  "postgres://retrowatchdog:retrowatchdog@localhost:5432/retrowatchdog";
const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://retrowatchdog:retrowatchdog@localhost:5432/retrowatchdog_test";
// db name derived from TEST_URL so an override stays consistent everywhere
const TEST_DB_NAME = new URL(TEST_URL).pathname.slice(1);

export async function setupTestDb(): Promise<{
  db: Db;
  pool: pg.Pool;
  truncateAll: () => Promise<void>;
}> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
    TEST_DB_NAME,
  ]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
  await admin.end();

  const { db, pool } = createDb(TEST_URL);
  await migrate(db, {
    // fileURLToPath, never .pathname (Windows: "/D:/..." breaks fs)
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  });
  const truncateAll = async () => {
    await pool.query(
      "TRUNCATE app_settings, fx_overrides, sync_state, catalog_items, watchlist, source_fetches, owned_copies, acquisitions, price_points, source_mappings, game_names, games, plugins, collection_value_daily, signal_log RESTART IDENTITY CASCADE",
    );
  };
  return { db, pool, truncateAll };
}
