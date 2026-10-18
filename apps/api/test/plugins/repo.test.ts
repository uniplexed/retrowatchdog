import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb } from "../helpers/testDb.js";
import {
  approvePlugin,
  deletePlugin,
  findPluginByBaseUrl,
  getPlugin,
  insertPlugin,
  listPlugins,
  normalizeBaseUrl,
  recordPluginHealth,
  setPluginStatus,
} from "../../src/plugins/repo.js";
import type { PluginManifest } from "@retrowatchdog/shared";

const manifest = (id: string): PluginManifest => ({
  // Deliberately stays 2: this fixture is written straight into the table
  // through `insertPlugin`/`approvePlugin` below and never passes through
  // `validateManifest`, so it is live proof that a stored row on an older
  // protocol survives the bump (`readStoredManifest`).
  protocol: 2,
  plugin: { name: "vinted", version: "1.0.0" },
  requiredSecrets: [],
  sources: [
    {
      id,
      kind: "live",
      label: "Vinted UK",
      family: "vinted",
      familyLabel: "Vinted",
      country: "GB",
      reach: "global",
      defaultRegion: null,
      expectedCurrencies: ["GBP"],
      kindRoles: { active_listing: "buy_listing" },
      kindLabels: { active_listing: "Vinted UK asking price" },
    },
  ],
});

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

// The pool is ended once, in the LAST describe that uses it — see the note there.
describe.skipIf(ctx === null)("the plugins table", () => {
  beforeEach(async () => ctx!.truncateAll());

  it("stores an imported plugin as pending, with nothing approved", async () => {
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://vinted-sidecar-plugin:8000",
      name: "vinted",
      version: "1.0.0",
      manifestSeen: manifest("vinted_uk"),
      lastHealth: { status: "ok", protocol: 2, configured: true },
    });
    expect(row.status).toBe("pending");
    expect(row.approvedKinds).toEqual({});
    expect(row.approvedAt).toBeNull();
    expect(row.manifestSeen?.sources[0].id).toBe("vinted_uk");
    // `manifest` means "what the user approved", and an import approves
    // nothing. insertPlugin takes no value for that column at all, so this is
    // structural rather than a promise the function has to keep.
    expect(row.manifest).toBeNull();
    expect(row.lastHealth).toEqual({ status: "ok", protocol: 2, configured: true });
    expect(row.lastHealthAt).toBeInstanceOf(Date);
    expect(row.addedAt).toBeInstanceOf(Date);
    expect(row.lastError).toBeNull();
  });

  it("returns a manifest out of jsonb exactly as it went in, pound signs and accents included", async () => {
    // Every price this app shows is quoted in someone's currency and a label
    // says so, so a jsonb round trip that mangled "£" would corrupt the copy
    // the registry will serve. The caveat carries a non-ASCII character for the
    // same reason: these are the two manifest fields written to be READ.
    const written = manifest("vinted_uk");
    written.sources[0].kindLabels = { active_listing: "Vinted UK asking price (£)" };
    written.sources[0].caveat = "Precios de un scraper comunitario — no oficial";
    written.sources[0].sellFeeRate = 0.05;
    written.requiredSecrets = ["VINTED_TOKEN"];

    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://plug:8000",
      name: "vinted",
      version: "1.0.0",
      manifestSeen: written,
    });
    // Both columns, so the round trip is proven for the one the app SERVES
    // from as well: approval is what writes it.
    expect(await approvePlugin(ctx!.db, row.id, {}, written)).toEqual({ ok: true });
    const read = await getPlugin(ctx!.db, row.id);
    expect(read?.manifest).toEqual(written);
    expect(read?.manifestSeen).toEqual(written);
    // Field for field, so a deep-equal that somehow passed on a mangled
    // string could not hide it.
    const source = read!.manifest!.sources[0];
    expect(source.kindLabels?.active_listing).toBe("Vinted UK asking price (£)");
    expect(source.caveat).toBe("Precios de un scraper comunitario — no oficial");
    expect(source.sellFeeRate).toBe(0.05);
    expect(source.defaultRegion).toBeNull();
    expect(source.expectedCurrencies).toEqual(["GBP"]);
    expect(read!.manifest!.requiredSecrets).toEqual(["VINTED_TOKEN"]);
  });

  it("refuses a second row for the same base URL, with an error a route can read", async () => {
    // The duplicate must surface as a unique-violation a route can turn into
    // a 400, not as an opaque crash — and the pool must still be usable after
    // it, or one clumsy import would take the API's database access with it.
    const input = {
      baseUrl: "http://plug:8000",
      name: "p",
      version: "1",
      manifestSeen: null,
    };
    await insertPlugin(ctx!.db, input);
    const error = await insertPlugin(ctx!.db, input).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect(uniqueViolationCode(error)).toBe("23505");
    expect(await findPluginByBaseUrl(ctx!.db, "http://plug:8000")).not.toBeNull();
    expect(await listPlugins(ctx!.db)).toHaveLength(1);
  });

  it("approving promotes the seen manifest and records what the user checked", async () => {
    // The user approves KINDS, not a plugin: this row is the record of that
    // consent. Nothing reads it yet — restricting a source to its approved
    // kinds is the registry's job, later in this batch.
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://plug:8000",
      name: "p",
      version: "1",
      manifestSeen: manifest("vinted_uk"),
    });
    const reviewed = (await getPlugin(ctx!.db, row.id))!.manifestSeen!;
    const result = await approvePlugin(ctx!.db, row.id, { vinted_uk: ["active_listing"] }, reviewed);
    expect(result).toEqual({ ok: true });
    const approved = await getPlugin(ctx!.db, row.id);
    expect(approved?.status).toBe("approved");
    expect(approved?.approvedKinds).toEqual({ vinted_uk: ["active_listing"] });
    expect(approved?.manifest).toEqual(manifest("vinted_uk"));
    expect(approved?.approvedAt).toBeInstanceOf(Date);
  });

  it("refuses to approve a manifest the user never saw, when the plugin republished mid-review", async () => {
    // Later in this milestone a worker tick will write manifest_seen on its
    // own schedule, so between a review screen rendering a manifest and the
    // user clicking Approve the plugin can have published a different one.
    // Promoting whatever is in the column
    // at approval time would approve THAT — with the kinds the user checked
    // against a document they never read.
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://plug:8000",
      name: "p",
      version: "1",
      manifestSeen: manifest("vinted_uk"),
    });
    const reviewed = (await getPlugin(ctx!.db, row.id))!.manifestSeen!;
    const republished = manifest("vinted_uk");
    republished.sources[0].kindRoles = { active_listing: "reference" };
    await recordPluginHealth(ctx!.db, row.id, null, republished, null);

    const result = await approvePlugin(
      ctx!.db,
      row.id,
      { vinted_uk: ["active_listing"] },
      reviewed,
    );
    expect(result).toEqual({ ok: false, reason: "manifest-changed" });
    // and nothing moved: no approval, no promotion, no recorded consent
    const after = (await getPlugin(ctx!.db, row.id))!;
    expect(after.status).toBe("pending");
    expect(after.manifest).toBeNull();
    expect(after.approvedKinds).toEqual({});
    expect(after.approvedAt).toBeNull();
  });

  it("approves a manifest that only looks different, since jsonb does not keep key order", async () => {
    // The comparison must not be a plain compare of two serializations: the
    // reviewed document came back through jsonb, which does not preserve key
    // order, so a caller holding an equal manifest whose keys sit in another
    // order is approving the same thing and must not be told otherwise.
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://plug:8000",
      name: "p",
      version: "1",
      manifestSeen: manifest("vinted_uk"),
    });
    const reordered: PluginManifest = {
      sources: manifest("vinted_uk").sources,
      requiredSecrets: [],
      plugin: { version: "1.0.0", name: "vinted" },
      // Stays 2, like `manifest()` above: `approvePlugin` writes this
      // straight into the table and never runs it through `validateManifest`.
      protocol: 2,
    };
    expect(await approvePlugin(ctx!.db, row.id, {}, reordered)).toEqual({ ok: true });
    expect((await getPlugin(ctx!.db, row.id))?.status).toBe("approved");
  });

  it("refuses to approve a plugin that has never answered /manifest", async () => {
    // A row can exist before anything was fetched — the VINTED_SIDECAR_PLUGIN_URL
    // seed inserts one at boot — and approving it would produce an approved
    // plugin serving no sources, under a consent given to no document. That is
    // the state a fresh deployment is in for one health interval: the seed
    // contacts nothing, so its row waits for the worker's first poll to fetch
    // the manifest there is then something to approve.
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://plug:8000",
      name: "p",
      version: "1",
      manifestSeen: null,
    });
    const result = await approvePlugin(ctx!.db, row.id, {}, manifest("vinted_uk"));
    expect(result).toEqual({ ok: false, reason: "no-manifest" });
    const after = (await getPlugin(ctx!.db, row.id))!;
    expect(after.status).toBe("pending");
    expect(after.manifest).toBeNull();
    expect(after.approvedAt).toBeNull();
  });

  it("keeps the last poll's error when a plugin is approved", async () => {
    // last_error is the result of the last POLL, and it sits beside a
    // last_health/last_health_at pair that a failed poll leaves standing at
    // the last good reading. Clearing it here would erase the only evidence
    // that the reading is stale — and approval learns nothing about whether
    // the plugin is reachable. Only the next successful poll may clear it.
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://plug:8000",
      name: "p",
      version: "1",
      manifestSeen: manifest("vinted_uk"),
      lastHealth: { status: "ok", protocol: 2, configured: true },
      lastError: "connect ECONNREFUSED",
    });
    const reviewed = (await getPlugin(ctx!.db, row.id))!.manifestSeen!;
    expect(await approvePlugin(ctx!.db, row.id, {}, reviewed)).toEqual({ ok: true });
    const approved = (await getPlugin(ctx!.db, row.id))!;
    expect(approved.status).toBe("approved");
    expect(approved.lastError).toBe("connect ECONNREFUSED");
    await recordPluginHealth(
      ctx!.db,
      row.id,
      { status: "ok", protocol: 2, configured: true },
      null,
      null,
    );
    expect((await getPlugin(ctx!.db, row.id))?.lastError).toBeNull();
  });

  it("records health and drift without touching the approved manifest", async () => {
    // The two columns are what will let the app keep serving the APPROVED
    // manifest while the plugin publishes another, so a community plugin
    // cannot promote its own roles through an update. Nothing serves either
    // column yet; this pins that a poll writes one and never the other.
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://plug:8000",
      name: "p",
      version: "1",
      manifestSeen: manifest("vinted_uk"),
    });
    const reviewed = (await getPlugin(ctx!.db, row.id))!.manifestSeen!;
    expect(
      await approvePlugin(ctx!.db, row.id, { vinted_uk: ["active_listing"] }, reviewed),
    ).toEqual({ ok: true });
    const drifted = manifest("vinted_uk");
    drifted.sources[0].kindRoles = { active_listing: "reference" };
    await recordPluginHealth(
      ctx!.db,
      row.id,
      { status: "ok", protocol: 2, configured: true },
      drifted,
      null,
    );
    const after = await getPlugin(ctx!.db, row.id);
    expect(after?.manifest?.sources[0].kindRoles).toEqual({ active_listing: "buy_listing" });
    expect(after?.manifestSeen?.sources[0].kindRoles).toEqual({ active_listing: "reference" });
    expect(after?.lastHealthAt).toBeInstanceOf(Date);
  });

  it("keeps the last known health when a poll fails, and says why", async () => {
    // The app never flips every plugin to unconfigured because its own worker
    // stopped: a failed poll records the error, not a false negative.
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://plug:8000",
      name: "p",
      version: "1",
      manifestSeen: manifest("vinted_uk"),
      lastHealth: { status: "ok", protocol: 2, configured: true },
    });
    const seenAt = (await getPlugin(ctx!.db, row.id))!.lastHealthAt;
    await recordPluginHealth(ctx!.db, row.id, null, null, "connect ECONNREFUSED");
    const after = await getPlugin(ctx!.db, row.id);
    expect(after?.lastHealth).toEqual({ status: "ok", protocol: 2, configured: true });
    expect(after?.lastError).toBe("connect ECONNREFUSED");
    // last_health_at is the age of the KEPT reading, so a failed poll must not
    // refresh it — a screen listing plugins would otherwise show a stale
    // value as fresh.
    expect(after?.lastHealthAt?.getTime()).toBe(seenAt?.getTime());
    // A failed poll says nothing about the manifest either.
    expect(after?.manifestSeen).toEqual(manifest("vinted_uk"));
  });

  it("leaves health null when the FIRST poll fails: never-answered is not the same as unhealthy", async () => {
    // There is no last known health to keep here. Writing a synthetic
    // unhealthy reading would be inventing an answer the plugin never gave;
    // null is what "it has not answered yet" looks like, and it is what the
    // configured rule will read once the registry exists (spec B.4).
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://plug:8000",
      name: "p",
      version: "1",
      manifestSeen: null,
    });
    expect(row.lastHealth).toBeNull();
    expect(row.lastHealthAt).toBeNull();
    await recordPluginHealth(ctx!.db, row.id, null, null, "getaddrinfo ENOTFOUND plug");
    const after = await getPlugin(ctx!.db, row.id);
    expect(after?.lastHealth).toBeNull();
    expect(after?.lastHealthAt).toBeNull();
    expect(after?.lastError).toBe("getaddrinfo ENOTFOUND plug");
  });

  it("clears the last error once a poll succeeds again", async () => {
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://plug:8000",
      name: "p",
      version: "1",
      manifestSeen: null,
      lastError: "connect ECONNREFUSED",
    });
    expect(row.lastError).toBe("connect ECONNREFUSED");
    await recordPluginHealth(
      ctx!.db,
      row.id,
      { status: "ok", protocol: 2, configured: true },
      null,
      null,
    );
    expect((await getPlugin(ctx!.db, row.id))?.lastError).toBeNull();
  });

  it("reports no approved kind for a source id that is only an Object.prototype member", async () => {
    // approved_kinds is keyed by SOURCE ID and read as approvedKinds[sourceId]
    // once the registry applies it. A plain-object read would answer that
    // lookup out of Object.prototype: `constructor` is a legal-looking id, and
    // a source called that would come back APPROVED for kinds nobody checked.
    // The manifest validator refuses such an id, but a row is not a validated
    // manifest — it can be hand-edited or restored from a backup.
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://plug:8000",
      name: "p",
      version: "1",
      manifestSeen: manifest("vinted_uk"),
    });
    const reviewed = (await getPlugin(ctx!.db, row.id))!.manifestSeen!;
    await approvePlugin(ctx!.db, row.id, { vinted_uk: ["active_listing"] }, reviewed);
    const approved = (await getPlugin(ctx!.db, row.id))!;
    expect(approved.approvedKinds.constructor).toBeUndefined();
    expect(approved.approvedKinds["__proto__"]).toBeUndefined();
    expect(approved.approvedKinds["toString"]).toBeUndefined();
    expect(approved.approvedKinds.vinted_uk).toEqual(["active_listing"]);
  });

  it("returns a hand-edited prototype-named key as the data it is", async () => {
    // The guard above is about a key the row does NOT have. A row that really
    // does carry one is answered from the row, not swallowed: the registry
    // will find no source by that id and the entry stays inert.
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://plug:8000",
      name: "p",
      version: "1",
      manifestSeen: null,
    });
    await ctx!.pool.query("UPDATE plugins SET approved_kinds = $1::jsonb WHERE id = $2", [
      JSON.stringify({ constructor: ["sell"], vinted_uk: ["active_listing"] }),
      row.id,
    ]);
    const read = (await getPlugin(ctx!.db, row.id))!;
    expect(read.approvedKinds.constructor).toEqual(["sell"]);
    expect(read.approvedKinds.vinted_uk).toEqual(["active_listing"]);
  });

  it("reads a malformed approved_kinds as nothing approved rather than crashing the route", async () => {
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://plug:8000",
      name: "p",
      version: "1",
      manifestSeen: null,
    });
    for (const malformed of ['"everything"', "42", "null", '["vinted_uk"]']) {
      await ctx!.pool.query(`UPDATE plugins SET approved_kinds = '${malformed}'::jsonb WHERE id = $1`, [
        row.id,
      ]);
      expect((await getPlugin(ctx!.db, row.id))?.approvedKinds).toEqual({});
    }
  });

  it("drops an approved entry that is not a list of this app's price kinds", async () => {
    // The column is typed Record<string, PriceKind[]> everywhere it is read.
    // A row saying otherwise makes that type a lie, and the honest reading of
    // "sold_median was approved" is that this app has no such kind to approve.
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://plug:8000",
      name: "p",
      version: "1",
      manifestSeen: null,
    });
    await ctx!.pool.query("UPDATE plugins SET approved_kinds = $1::jsonb WHERE id = $2", [
      JSON.stringify({
        vinted_uk: ["active_listing", "sold_median"],
        cex_pt: "sell",
        ebay_pt: [7, null],
      }),
      row.id,
    ]);
    const read = (await getPlugin(ctx!.db, row.id))!;
    expect(read.approvedKinds).toEqual({ vinted_uk: ["active_listing"], ebay_pt: [] });
    expect(read.approvedKinds.cex_pt).toBeUndefined();
  });

  it("lists newest first, and breaks a tie on id the same way round", async () => {
    // Two plugins imported in the same instant share added_at — the seed and a
    // hand import on the same boot do exactly that. The tiebreak is what
    // decides their order then, and an ascending one would put the OLDER of
    // the two first inside a newest-first list. Both rows are forced onto one
    // timestamp so the tiebreak is the only thing under test.
    const first = await insertPlugin(ctx!.db, {
      baseUrl: "http://a:8000",
      name: "a",
      version: "1",
      manifestSeen: null,
    });
    const second = await insertPlugin(ctx!.db, {
      baseUrl: "http://b:8000",
      name: "b",
      version: "1",
      manifestSeen: null,
    });
    await ctx!.pool.query("UPDATE plugins SET added_at = '2026-01-01T00:00:00Z'");
    expect((await listPlugins(ctx!.db)).map((p) => p.id)).toEqual([second.id, first.id]);
  });

  it("orders on added_at before id, so the newer timestamp leads whatever the ids say", async () => {
    const first = await insertPlugin(ctx!.db, {
      baseUrl: "http://a:8000",
      name: "a",
      version: "1",
      manifestSeen: null,
    });
    const second = await insertPlugin(ctx!.db, {
      baseUrl: "http://b:8000",
      name: "b",
      version: "1",
      manifestSeen: null,
    });
    // The lower id now carries the newer timestamp, so id order and added_at
    // order disagree and only one of them can win. added_at does.
    await ctx!.pool.query("UPDATE plugins SET added_at = '2026-12-01T00:00:00Z' WHERE id = $1", [
      first.id,
    ]);
    expect((await listPlugins(ctx!.db)).map((p) => p.id)).toEqual([first.id, second.id]);
  });

  it("finds by base URL", async () => {
    await insertPlugin(ctx!.db, {
      baseUrl: "http://a:8000",
      name: "a",
      version: "1",
      manifestSeen: null,
    });
    expect((await findPluginByBaseUrl(ctx!.db, "http://a:8000"))?.name).toBe("a");
    expect(await findPluginByBaseUrl(ctx!.db, "http://nothing:8000")).toBeNull();
  });

  it("disables and deletes", async () => {
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://plug:8000",
      name: "p",
      version: "1",
      manifestSeen: null,
    });
    await setPluginStatus(ctx!.db, row.id, "disabled");
    expect((await getPlugin(ctx!.db, row.id))?.status).toBe("disabled");
    await deletePlugin(ctx!.db, row.id);
    expect(await getPlugin(ctx!.db, row.id)).toBeNull();
    expect(await listPlugins(ctx!.db)).toEqual([]);
  });

  it("refuses to approve a plugin row that is not there", async () => {
    expect(await approvePlugin(ctx!.db, 999_999, {}, manifest("vinted_uk"))).toEqual({
      ok: false,
      reason: "not-found",
    });
  });
});

/**
 * A row is not a validated document. It can be hand-edited, restored from a
 * backup or written by an older build — the three cases the readers in
 * repo.ts name — and every one of these columns is read back on every
 * registry rebuild once the runtime registry exists. So the question these
 * tests ask of each column is the same: what does this app do with a value it
 * cannot read? The answer must be "nothing, and say so", never "carry it on
 * as if it were the real thing".
 */
describe.skipIf(ctx === null)("a row this app cannot read", () => {
  let warnings: string[] = [];

  beforeEach(async () => {
    await ctx!.truncateAll();
    warnings = [];
    vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args.map(String).join(" "));
    });
  });
  afterEach(() => vi.restoreAllMocks());
  // Last describe to touch the database: pg refuses a second end() on a pool,
  // so exactly one of them may close it and it has to be this one.
  afterAll(async () => ctx?.pool.end());

  const seed = async () =>
    insertPlugin(ctx!.db, {
      baseUrl: "http://plug:8000",
      name: "p",
      version: "1",
      manifestSeen: null,
    });

  const write = async (id: number, column: string, json: string) => {
    await ctx!.pool.query(`UPDATE plugins SET ${column} = $1::jsonb WHERE id = $2`, [json, id]);
  };

  // The same document `manifest("vinted_uk")` (:16-34) builds, as a plain
  // object a test can spread and re-stamp — reusing that fixture rather than
  // writing a second one.
  const validManifestJson = (): PluginManifest => manifest("vinted_uk");

  it("reads a manifest column that is not a manifest as no manifest at all", async () => {
    // The scalar and the array are what a bare "is it an object" guard would
    // hand back as a PluginManifest. The third is the one that guard cannot
    // see at all: an object, with the right protocol, whose `sources` is a
    // string — the `manifest.sources.map(...)` the Plugins panel does
    // would throw on it, from a row nobody could have explained.
    const row = await seed();
    // The third string keeps protocol 2 on purpose: it is a hand-written
    // jsonb payload written directly by `write()` below, never through
    // `validateManifest`, so what condemns it is `sources` being a string —
    // not the protocol number, which this test is not about.
    for (const malformed of ['"everything"', '["vinted_uk"]', '{"protocol":2,"sources":"all"}']) {
      await write(row.id, "manifest", malformed);
      await write(row.id, "manifest_seen", malformed);
      const read = (await getPlugin(ctx!.db, row.id))!;
      expect(read.manifest).toBeNull();
      expect(read.manifestSeen).toBeNull();
    }
  });

  it("says which column it could not read, and why", async () => {
    // A row silently read as empty is a support call nobody can answer. The
    // validator already writes its reasons for a person, so they travel.
    const row = await seed();
    await write(
      row.id,
      "manifest_seen",
      // plugin.name is "vv" and not "v": a single-character name is refused by
      // PLUGIN_NAME (packages/shared/src/pluginManifest.ts) before the reader
      // ever reaches `sources`, which would test the wrong field.
      '{"protocol":1,"plugin":{"name":"vv","version":"1"},"sources":[]}',
    );
    expect((await getPlugin(ctx!.db, row.id))?.manifestSeen).toBeNull();
    // The reason changed with the gate, and the CASE did not: this document is
    // refused for having no sources, not for its protocol number. A stored
    // document's version is no longer compared (readStoredManifest), so a row
    // written by an older build stays readable while a row that is not a
    // manifest does not.
    expect(warnings.join("\n")).toMatch(/plugins\.manifest_seen of plugin \d+/);
    expect(warnings.join("\n")).toMatch(/sources must be an array/);
  });

  it("reads a manifest a previous build wrote, protocol number and all", async () => {
    const row = await seed();
    await write(
      row.id,
      "manifest_seen",
      JSON.stringify({ ...validManifestJson(), protocol: 1 }),
    );
    const read = await getPlugin(ctx!.db, row.id);
    expect(read?.manifestSeen?.protocol).toBe(1);
    expect(read?.manifestSeen?.sources[0]?.id).toBe("vinted_uk");
    expect(warnings).toEqual([]);
  });

  it("reads a health column that is not a health reading as never-answered", async () => {
    // Not "unhealthy": the app has no reading. Spec B.4 reads a null health as
    // not configured, which is the same conclusion by the honest route.
    const row = await seed();
    for (const malformed of [
      '"ok"',
      "[]",
      '{"status":2,"protocol":2,"configured":true}',
      '{"status":"ok","protocol":"2","configured":true}',
      '{"status":"ok","protocol":2,"configured":"yes"}',
    ]) {
      await write(row.id, "last_health", malformed);
      expect((await getPlugin(ctx!.db, row.id))?.lastHealth).toBeNull();
    }
    expect(warnings.join("\n")).toMatch(/plugins\.last_health of plugin \d+/);
  });

  it("keeps only the three fields a health reading has", async () => {
    const row = await seed();
    await write(
      row.id,
      "last_health",
      '{"status":"ok","protocol":2,"configured":true,"sources":["ebay_uk"]}',
    );
    // Rebuilt, not spread: a key nobody named cannot ride along into the
    // plugin DTO Settings → Plugins is served.
    expect((await getPlugin(ctx!.db, row.id))?.lastHealth).toEqual({
      status: "ok",
      protocol: 2,
      configured: true,
    });
  });

  it("never reads an unknown status as approved", async () => {
    // `status` decides whether the app queries a plugin at all, and the column
    // is plain text with no CHECK behind it. An unreadable one reads as
    // `disabled`: inert, and a claim about the present rather than `pending`'s
    // claim about a review that may well have happened.
    const row = await seed();
    for (const bogus of ["APPROVED", "approved ", "enabled", ""]) {
      await ctx!.pool.query("UPDATE plugins SET status = $1 WHERE id = $2", [bogus, row.id]);
      expect((await getPlugin(ctx!.db, row.id))?.status).toBe("disabled");
    }
    expect(warnings.join("\n")).toMatch(/plugins\.status of plugin \d+/);
  });

  it("says nothing about the columns that are simply empty", async () => {
    // Null is the normal state of all three: nothing fetched, nothing
    // approved, never polled. A warning there would train the reader to
    // ignore the ones that matter.
    const row = await seed();
    expect((await getPlugin(ctx!.db, row.id))?.manifest).toBeNull();
    expect(warnings).toEqual([]);
  });
});

describe("normalizeBaseUrl", () => {
  const accepted = (value: string): string | null => {
    const checked = normalizeBaseUrl(value);
    return checked.ok ? checked.baseUrl : null;
  };
  const refusal = (value: string): string | null => {
    const checked = normalizeBaseUrl(value);
    return checked.ok ? null : checked.reason;
  };

  it("accepts an absolute http(s) URL and collapses only the trailing slash", () => {
    // The trailing slash is the one thing collapsed, because
    // `http://plug:8000/` and `http://plug:8000` address the same process and
    // two rows for one plugin is the mistake that costs.
    expect(accepted("http://vinted-sidecar-plugin:8000/")).toBe("http://vinted-sidecar-plugin:8000");
    expect(accepted("https://plugins.example.com/vinted//")).toBe(
      "https://plugins.example.com/vinted",
    );
    expect(accepted("http://plug:8000")).toBe("http://plug:8000");
  });

  it("accepts a URL pasted with whitespace the URL parser does not strip", () => {
    // This is what trim() is for, and it is the only case that shows it: the
    // WHATWG parser already strips leading and trailing C0 controls and
    // SPACE, so an ordinary "  http://plug:8000  " passes with trim() deleted
    // and proves nothing about this function.
    //
    // A non-breaking space or an ideographic space — what a copy out of a
    // rendered document or a CJK IME leaves behind — is not whitespace to
    // that parser, and without trim() the two values below fail to parse at
    // all. They are built from their code points rather than typed as
    // characters, because a reader must be able to SEE which character a test
    // is about; pasted literally they would be two invisible bytes nobody
    // could check against this comment.
    const nbsp = String.fromCodePoint(0x00a0);
    const ideographicSpace = String.fromCodePoint(0x3000);
    expect(accepted(`${nbsp}http://plug:8000${nbsp}`)).toBe("http://plug:8000");
    expect(accepted(`${ideographicSpace}https://plugins.example.com/vinted/`)).toBe(
      "https://plugins.example.com/vinted",
    );
    // The ordinary case still works, of course.
    expect(accepted("  http://plug:8000  ")).toBe("http://plug:8000");
  });

  it("refuses anything that is not an absolute http(s) URL", () => {
    // The app will fetch this URL from inside its own network, so a
    // file:/ftp:/relative value is not a plugin, it is a mistake or a probe.
    expect(refusal("vinted-sidecar-plugin:8000")).toMatch(/vinted-sidecar-plugin:\/\/ is not a scheme/);
    expect(refusal("file:///etc/passwd")).toMatch(/file:\/\/ is not a scheme/);
    expect(refusal("ftp://plug:21/")).toMatch(/ftp:\/\/ is not a scheme/);
    // Empty and blank need no guard of their own: `new URL("")` throws, which
    // is already the rejection. These two assertions characterise the PARSER
    // and not this function — they are here so that the absence of a length
    // check cannot be read later as an oversight.
    expect(refusal("")).toBe("not an absolute URL");
    expect(refusal("   ")).toBe("not an absolute URL");
  });

  it("refuses a URL carrying credentials instead of quietly dropping them", () => {
    // `http://user:pw@plug:8000` normalized to `http://plug:8000` is the worst
    // available outcome: the credentials vanish, every later fetch goes out
    // unauthenticated, and the URL on screen looks exactly right. The message
    // has to say what was wrong, because the user typed it on purpose.
    expect(accepted("http://user:pw@plug:8000")).toBeNull();
    expect(refusal("http://user:pw@plug:8000")).toMatch(/username or password/);
    expect(accepted("http://user@plug:8000")).toBeNull();
    expect(accepted("https://:pw@plug:8000/vinted")).toBeNull();
  });

  it("refuses a query string or a fragment, which this app would never send", () => {
    // Every path the app builds appends to this string (/health, /manifest,
    // /search?source=...), so a stored ?token=... could not survive into the
    // request it was written for, and a #fragment never leaves the client.
    expect(accepted("http://plug:8000/?token=abc")).toBeNull();
    expect(refusal("http://plug:8000/?token=abc")).toMatch(/query string/);
    expect(accepted("http://plug:8000/#vinted")).toBeNull();
    expect(refusal("http://plug:8000/#vinted")).toMatch(/fragment/);
  });
});

/**
 * Postgres puts the SQLSTATE on the error it throws; drizzle may hand it back
 * wrapped, so the cause chain is walked. Five links is a bound, not a
 * measurement: it is deep enough for every wrapping seen here and shallow
 * enough that a cyclic `cause` cannot spin. A driver that nests deeper would
 * make this return undefined, and the test asserting the code would fail
 * loudly rather than pass for the wrong reason.
 */
function uniqueViolationCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as Error).cause;
  }
  return undefined;
}
