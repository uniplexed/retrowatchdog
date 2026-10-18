import { afterAll, describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";
import { setupTestDb } from "./helpers/testDb.js";

/**
 * CHANGED: this test used to call `buildApp()` with no database at all, and
 * passed because building the app made no query — it reached `getDb()` and
 * never used it. Building the app now reads the `plugins` table, so an app
 * built with no `db` override reaches whatever `DATABASE_URL` names, which on
 * a developer's machine is the running deployment's database and may be on an
 * older schema. It is given the test database like every other integration
 * test.
 *
 * The container is unaffected: its CMD runs the migrations and only then
 * starts the server (apps/api/Dockerfile), so the table is there before
 * anything asks for it.
 */
let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

describe.skipIf(ctx === null)("GET /health", () => {
  afterAll(async () => ctx?.pool.end());

  it("returns 200 with status ok", async () => {
    const app = await buildApp({ db: ctx!.db });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
