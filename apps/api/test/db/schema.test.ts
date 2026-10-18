import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import { setupTestDb } from "../helpers/testDb.js";

describe("database schema", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    ({ pool } = await setupTestDb());
  });
  afterAll(async () => {
    await pool.end();
  });

  it("has all four tables and the pg_trgm extension", async () => {
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = tables.rows.map((r) => r.table_name);
    for (const t of [
      "games", "game_names", "price_points", "source_mappings", "owned_copies",
    ]) {
      expect(names).toContain(t);
    }
    const ext = await pool.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'",
    );
    expect(ext.rowCount).toBe(1);
  });

  it("similarity() works via the trgm index path", async () => {
    const res = await pool.query(
      "SELECT similarity('ocarina of time', 'ocarina of time 3d') AS s",
    );
    expect(Number(res.rows[0].s)).toBeGreaterThan(0.5);
  });

  it("catalog_items carries the S3b row-contract columns and no source_metadata", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'catalog_items'",
    );
    const names = rows.map((r) => r.column_name);
    expect(names).toEqual(expect.arrayContaining(["observed_at", "condition_text", "sample_sizes"]));
    expect(names).not.toContain("source_metadata");
  });
});
