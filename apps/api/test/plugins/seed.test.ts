import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDb } from "../helpers/testDb.js";
import { deletePlugin, insertPlugin, listPlugins } from "../../src/plugins/repo.js";
import { seedPluginsFromEnv } from "../../src/plugins/seed.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

describe.skipIf(ctx === null)("the VINTED_SIDECAR_PLUGIN_URL seed", () => {
  beforeEach(async () => ctx!.truncateAll());
  afterAll(async () => ctx?.pool.end());

  it("inserts ONE pending row for the configured sidecar URL", async () => {
    await seedPluginsFromEnv(ctx!.db, "http://vinted-sidecar-plugin:8000");
    const rows = await listPlugins(ctx!.db);
    expect(rows).toHaveLength(1);
    expect(rows[0].baseUrl).toBe("http://vinted-sidecar-plugin:8000");
    // Never approved automatically, ours or not: the roles are the user's to
    // approve, and that first approval is the proof the import flow works.
    expect(rows[0].status).toBe("pending");
    expect(rows[0].approvedKinds).toEqual({});
    expect(rows[0].approvedAt).toBeNull();
  });

  it("contacts nothing, so the row carries no manifest and no health reading", async () => {
    // A boot must not wait on another container. The worker's health tick is
    // what fills these in; until then the panel has an error to show and
    // nothing to review. That is a state, not a fault, and it lasts one health
    // interval: the sidecar serves a protocol-3 /manifest, so the first poll
    // gives the user something to approve.
    await seedPluginsFromEnv(ctx!.db, "http://vinted-sidecar-plugin:8000");
    const [row] = await listPlugins(ctx!.db);
    expect(row.manifest).toBeNull();
    expect(row.manifestSeen).toBeNull();
    expect(row.lastHealth).toBeNull();
    expect(row.lastHealthAt).toBeNull();
    expect(row.lastError).toBe("not contacted yet");
  });

  it("stores the normalised spelling of the URL, not the one it was given", async () => {
    // The seed goes through the same check `POST /api/plugins` does, so a
    // trailing slash cannot make the seeded row and a hand-imported one two
    // rows for one process (`base_url` is unique).
    await seedPluginsFromEnv(ctx!.db, "http://vinted-sidecar-plugin:8000/");
    expect((await listPlugins(ctx!.db))[0].baseUrl).toBe("http://vinted-sidecar-plugin:8000");
  });

  it("seeds nothing at all when the URL is one the app could not fetch, and stays armed", async () => {
    // Refused rather than repaired, for the reasons normalizeBaseUrl states.
    // A row nobody can call is worse than no row: it would sit in Settings
    // reporting an error forever.
    await seedPluginsFromEnv(ctx!.db, "vinted-sidecar-plugin:8000");
    await seedPluginsFromEnv(ctx!.db, "http://user:pw@vinted-sidecar-plugin:8000");
    expect(await listPlugins(ctx!.db)).toEqual([]);
    // And no "already ran" marker either: nothing was offered, so correcting
    // the spelling and rebooting still offers it. A marker written on the way
    // past an unusable URL would spend the deployment's one offer on a typo.
    await seedPluginsFromEnv(ctx!.db, "http://vinted-sidecar-plugin:8000");
    expect(await listPlugins(ctx!.db)).toHaveLength(1);
  });

  it("does nothing when no sidecar URL is configured", async () => {
    await seedPluginsFromEnv(ctx!.db, undefined);
    expect(await listPlugins(ctx!.db)).toEqual([]);
  });

  it("leaves one row and only one, however many boots run the seed", async () => {
    // Deliberately NOT named after the marker, because it does not isolate it:
    // with the marker guard deleted this case still passes, rejected one line
    // later by the base_url check. Two guards, one outcome, and the outcome is
    // what a user sees — so it is pinned here, and the marker itself is pinned
    // where it is the ONLY thing that can stop the insert: "never resurrects
    // the row after the user deleted it" below, where the row is gone and the
    // URL check therefore has nothing to find.
    await seedPluginsFromEnv(ctx!.db, "http://vinted-sidecar-plugin:8000");
    await seedPluginsFromEnv(ctx!.db, "http://vinted-sidecar-plugin:8000");
    expect(await listPlugins(ctx!.db)).toHaveLength(1);
  });

  it("offers every shipped plugin once, each on its own marker", async () => {
    // A fresh install lists CeX, eBay and Vinted without the user pasting a URL.
    await seedPluginsFromEnv(ctx!.db, "http://vinted-sidecar-plugin:8000", "vinted");
    await seedPluginsFromEnv(ctx!.db, "http://cex-plugin:8000", "cex");
    await seedPluginsFromEnv(ctx!.db, "http://ebay-plugin:8000", "ebay");
    const rows = await listPlugins(ctx!.db);
    expect(rows.map((r) => r.name).sort()).toEqual(["cex", "ebay", "vinted"]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);

    // Deleting one is final for that one and costs the others nothing.
    await deletePlugin(ctx!.db, rows.find((r) => r.name === "cex")!.id);
    await seedPluginsFromEnv(ctx!.db, "http://cex-plugin:8000", "cex");
    expect((await listPlugins(ctx!.db)).map((r) => r.name).sort()).toEqual(["ebay", "vinted"]);
  });

  it("never resurrects the row after the user deleted it", async () => {
    // THE BUG THIS SEED SHIPPED WITH, pinned so it cannot come back. The rule
    // used to be "the plugins table is EMPTY", and on the deployment this seed
    // exists for the seeded row is the ONLY row — so deleting it emptied the
    // table and the next container recreate inserted a brand new one. The
    // docblock claimed a deletion was final while the code did the opposite.
    await seedPluginsFromEnv(ctx!.db, "http://vinted-sidecar-plugin:8000");
    const [seeded] = await listPlugins(ctx!.db);
    await deletePlugin(ctx!.db, seeded.id);
    expect(await listPlugins(ctx!.db)).toEqual([]);

    await seedPluginsFromEnv(ctx!.db, "http://vinted-sidecar-plugin:8000");
    expect(await listPlugins(ctx!.db)).toEqual([]);
  });

  it("still offers the sidecar to a deployment that imported some other plugin first", async () => {
    // THE RULE CHANGED, and this test changed with it: it used to assert the
    // opposite. "Only while the plugins table is empty" was never a decision
    // about other plugins — it was scaffolding for a record the app did not
    // keep, and its own docblock apologised for the refusal. Now that a real
    // marker records whether the seed ran, a user who imported something else
    // first has still never been offered the sidecar their own compose file
    // is running, so they are offered it.
    await insertPlugin(ctx!.db, {
      baseUrl: "http://some-other-plugin:9000",
      name: "other",
      version: "1.0.0",
      manifestSeen: null,
    });
    await seedPluginsFromEnv(ctx!.db, "http://vinted-sidecar-plugin:8000");
    const urls = (await listPlugins(ctx!.db)).map((r) => r.baseUrl).sort();
    expect(urls).toEqual(["http://some-other-plugin:9000", "http://vinted-sidecar-plugin:8000"]);
  });

  it("inserts nothing when the user has already imported this very URL by hand", async () => {
    // The one case dropping the emptiness rule opens. `base_url` is unique, so
    // a blind insert would throw SQLSTATE 23505 and the boot log would carry a
    // scary line about a duplicate key for a seed that had nothing to do.
    // A URL already present means the offer has already been taken.
    const byHand = await insertPlugin(ctx!.db, {
      baseUrl: "http://vinted-sidecar-plugin:8000",
      name: "vinted-by-hand",
      version: "2.0.0",
      manifestSeen: null,
    });
    await seedPluginsFromEnv(ctx!.db, "http://vinted-sidecar-plugin:8000/");
    const rows = await listPlugins(ctx!.db);
    expect(rows).toHaveLength(1);
    // untouched: the seed did not overwrite what the user imported
    expect(rows[0].id).toBe(byHand.id);
    expect(rows[0].name).toBe("vinted-by-hand");

    // And the offer counts as spent, which is the whole reason this branch
    // writes the marker rather than just returning: deleting the row the user
    // imported must not re-arm the seed either.
    await deletePlugin(ctx!.db, byHand.id);
    await seedPluginsFromEnv(ctx!.db, "http://vinted-sidecar-plugin:8000");
    expect(await listPlugins(ctx!.db)).toEqual([]);
  });
});

/**
 * WHERE the seed is called from, read as text.
 *
 * The rule cannot be tested any other way from here: `config` is read once at
 * module level, so a test that imports buildApp cannot vary
 * VINTED_SIDECAR_PLUGIN_URL, and the damage is done in processes that never import
 * this file. A grep over the source tree suits this kind of rule: one a type
 * checker cannot state and no ordinary test would notice.
 *
 * WHAT IT COSTS TO GET WRONG, measured rather than imagined: while this ran
 * inside buildApp, `npx vitest run test/routes/plugins.test.ts` with
 * VINTED_SIDECAR_PLUGIN_URL set failed NINE assertions — every one of them a route
 * test seeing a plugin row the test never created, and not one of them naming
 * the reason. That variable is set for the api container in
 * docker-compose.yml, and .env.example tells a host-side developer to set it,
 * so this was the ordinary developer's suite and not an exotic setup.
 */
describe("seeding belongs to the process entrypoint, not to buildApp", () => {
  const read = (name: string): string =>
    // fileURLToPath, never .pathname (Windows: "/D:/..." breaks fs)
    readFileSync(fileURLToPath(new URL(`../../src/${name}`, import.meta.url)), "utf8");

  it("calls seedPluginsFromEnv from server.ts", () => {
    const server = read("server.ts");
    // Guards the guard: a renamed or moved file would otherwise make the
    // assertion below fail for the wrong reason, or pass while reading
    // something else entirely.
    expect(server).toContain("buildApp");
    expect(server).toMatch(/await seedPluginsFromEnv\(/);
  });

  it("does not name it in app.ts at all", () => {
    expect(read("app.ts")).not.toContain("seedPluginsFromEnv");
  });
});
