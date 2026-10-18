import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { setupTestDb } from "../helpers/testDb.js";
import { games, gameNames } from "../../src/db/schema.js";
import { buildApp } from "../../src/app.js";
import { resetSearchEnrichCacheForTests } from "../../src/routes/search.js";
import { config } from "../../src/config.js";
import type { IgdbClient, IgdbGame } from "../../src/catalog/igdb.js";
import type { Platform, SearchResponse } from "@retrowatchdog/shared";

const igdbFixture = JSON.parse(
  readFileSync(new URL("../fixtures/igdb-panzer.json", import.meta.url), "utf8"),
) as IgdbGame[];

function fakeIgdb(results: IgdbGame[]): { client: IgdbClient; searchSpy: ReturnType<typeof vi.fn> } {
  const searchSpy = vi.fn(async () => results);
  return {
    client: { isConfigured: () => true, searchGames: searchSpy } as unknown as IgdbClient,
    searchSpy,
  };
}

/** Minimal IGDB row for a game the local catalog is missing. */
function igdbGame(id: number, name: string, platformIgdbId: number): IgdbGame {
  return { id, name, platforms: [platformIgdbId], first_release_date: 883612800 };
}

const NEOGEO_AES_IGDB_ID = 80;
const MEGADRIVE_IGDB_ID = 29;

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

describe.skipIf(ctx === null)("GET /api/search", () => {
  beforeEach(async () => {
    // The enrich cache is module-level and outlives a single test: without
    // this, the second test to use a given query would never call IGDB.
    resetSearchEnrichCacheForTests();
    await ctx!.truncateAll();
  });
  afterAll(async () => await ctx?.pool.end());

  /** Seeds one catalog row per title, each searchable under its own name. */
  const seed = async (titles: string[], platform: Platform = "neogeo_aes"): Promise<void> => {
    for (const title of titles) {
      const [g] = await ctx!.db
        .insert(games)
        .values({ title, platform })
        .returning({ id: games.id });
      await ctx!.db.insert(gameNames).values({ gameId: g.id, name: title });
    }
  };

  const search = async (client: IgdbClient, q: string): Promise<SearchResponse> => {
    const app = await buildApp({ db: ctx!.db, igdb: client });
    const res = await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent(q)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SearchResponse;
    await app.close();
    return body;
  };

  it("falls back to IGDB import when local results are thin, then returns them", async () => {
    const { client, searchSpy } = fakeIgdb(igdbFixture);
    const body = await search(client, "panzer dragoon");
    expect(searchSpy).toHaveBeenCalledOnce();
    expect(body.games.map((g) => g.title)).toContain("Panzer Dragoon Saga");
  });

  it("does not call IGDB when the catalog already holds the exact game", async () => {
    const [game] = await ctx!.db
      .insert(games)
      .values({ igdbId: 1671, title: "Panzer Dragoon Saga", platform: "saturn", year: 1998 })
      .returning({ id: games.id });
    await ctx!.db.insert(gameNames).values([
      { gameId: game.id, name: "Panzer Dragoon Saga" },
      { gameId: game.id, name: "Azel Panzer Dragoon RPG" },
    ]);
    // Siblings so the thin-results clauses are satisfied too — they are
    // evaluated first and would otherwise enrich regardless of the exact hit.
    await seed(["Panzer Dragoon", "Panzer Dragoon II Zwei", "Panzer Dragoon Orta"], "saturn");

    const { client, searchSpy } = fakeIgdb([]);
    const body = await search(client, "panzer dragoon saga");
    expect(searchSpy).not.toHaveBeenCalled();
    expect(body.games.map((g) => g.title)).toContain("Panzer Dragoon Saga");
  });

  it("calls IGDB for a high-scoring local hit that is not the queried title", async () => {
    // The defect this whole predicate exists for: "The King of Fighters '97"
    // scores ~0.69 for "king of fighters 98" — good enough for the old thin
    // check, so KOF '98 could never enter the catalog.
    await seed([
      "The King of Fighters '95",
      "The King of Fighters '96",
      "The King of Fighters '97",
    ]);
    const kof98 = igdbGame(1234, "The King of Fighters '98", NEOGEO_AES_IGDB_ID);
    const { client, searchSpy } = fakeIgdb([kof98]);

    const body = await search(client, "king of fighters 98");
    expect(searchSpy).toHaveBeenCalledOnce();
    expect(body.games.map((g) => g.title)).toContain("The King of Fighters '98");
  });

  it("calls IGDB when the catalog holds only unrelated near-matches", async () => {
    await seed(["Run! Run! Run!", "Rex Run", "Run and Gun"], "megadrive");
    const outrun = igdbGame(4321, "OutRun", MEGADRIVE_IGDB_ID);
    const { client, searchSpy } = fakeIgdb([outrun]);

    const body = await search(client, "out run");
    expect(searchSpy).toHaveBeenCalledOnce();
    expect(body.games.map((g) => g.title)).toContain("OutRun");
  });

  it("does not call IGDB when a spaced query matches a run-together title", async () => {
    // "OutRun" scores 0.5 for "out run" (measured), the siblings 0.29-0.33:
    // enough rows above the trigram threshold to clear the thin clauses, so
    // the compact-title match is the only thing suppressing the round trip.
    await seed(["OutRun", "OutRun Europa", "Turbo OutRun", "OutRun 2019"], "megadrive");
    const { client, searchSpy } = fakeIgdb([]);
    const body = await search(client, "out run");
    expect(searchSpy).not.toHaveBeenCalled();
    expect(body.games.map((g) => g.title)).toContain("OutRun");
  });

  it("calls IGDB for a query whose catalogued hits are all sequels", async () => {
    // REVERSED from the original spec, which asserted no IGDB call here on
    // the grounds that an unnumbered query cannot mismatch a numbered hit.
    // Wrong: three catalogued sequels are no evidence that the original is
    // catalogued, and the original is precisely what the user is missing.
    await seed(
      ["Sonic the Hedgehog 2", "Sonic the Hedgehog 3", "Sonic the Hedgehog Spinball"],
      "megadrive",
    );
    const sonic1 = igdbGame(5678, "Sonic the Hedgehog", MEGADRIVE_IGDB_ID);
    const { client, searchSpy } = fakeIgdb([sonic1]);
    const body = await search(client, "sonic the hedgehog");
    expect(searchSpy).toHaveBeenCalledOnce();
    expect(body.games.map((g) => g.title)).toContain("Sonic the Hedgehog");
  });

  it("does not call IGDB for a query shorter than MIN_ENRICH_QUERY_LENGTH", async () => {
    // Keystroke prefixes are answered from the catalog only: the route takes
    // anything >= 2 chars, but importing IGDB's idea of "kin" is noise.
    const short = "k".repeat(config.MIN_ENRICH_QUERY_LENGTH - 1);
    const { client, searchSpy } = fakeIgdb([]);
    await search(client, short);
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("calls IGDB at exactly MIN_ENRICH_QUERY_LENGTH", async () => {
    const atBar = "k".repeat(config.MIN_ENRICH_QUERY_LENGTH);
    const { client, searchSpy } = fakeIgdb([]);
    await search(client, atBar);
    expect(searchSpy).toHaveBeenCalledOnce();
  });

  it("serves local results when IGDB import fails (finding 5)", async () => {
    await seed(["Panzer Dragoon Saga"], "saturn");
    // Only one local match for "panzer dragoon", and not the exact title, so
    // the route does reach out to IGDB — and must survive it failing.
    const searchSpy = vi.fn(async () => {
      throw new Error("IGDB is down");
    });
    const igdb = { isConfigured: () => true, searchGames: searchSpy } as unknown as IgdbClient;
    const body = await search(igdb, "panzer dragoon");
    expect(searchSpy).toHaveBeenCalledOnce();
    expect(body.games.map((g) => g.title)).toContain("Panzer Dragoon Saga");
  });

  it("imports a query from IGDB at most once per TTL window", async () => {
    await seed(["The King of Fighters '95", "The King of Fighters '97"]);
    // IGDB knows nothing: the query stays enrichment-worthy on the second
    // pass, so only the cache can keep the second call from happening.
    const { client, searchSpy } = fakeIgdb([]);
    await search(client, "king of fighters 98");
    await search(client, "king of fighters 98");
    expect(searchSpy).toHaveBeenCalledOnce();

    resetSearchEnrichCacheForTests();
    await search(client, "king of fighters 98");
    expect(searchSpy).toHaveBeenCalledTimes(2);
  });

  it("caches a failed IGDB attempt only briefly, so an outage self-heals", async () => {
    await seed(["Panzer Dragoon Saga"], "saturn");
    const searchSpy = vi.fn(async () => {
      throw new Error("IGDB is down");
    });
    const igdb = { isConfigured: () => true, searchGames: searchSpy } as unknown as IgdbClient;

    // Only Date is faked: pg's own setTimeout-driven timers must keep running.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await search(igdb, "panzer dragoon");
      await search(igdb, "panzer dragoon");
      // The keystrokes right after the failure are still absorbed...
      expect(searchSpy).toHaveBeenCalledOnce();

      vi.setSystemTime(Date.now() + 61_000);
      await search(igdb, "panzer dragoon");
      // ...but a minute later it is retried, not blanked out for ten.
      expect(searchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a successful but empty IGDB answer cached for the full window", async () => {
    await seed(["Panzer Dragoon Saga"], "saturn");
    const { client, searchSpy } = fakeIgdb([]);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await search(client, "panzer dragoon");
      vi.setSystemTime(Date.now() + 61_000);
      await search(client, "panzer dragoon");
      // A minute in, only the failure TTL has lapsed — this one has not.
      expect(searchSpy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects queries shorter than 2 chars", async () => {
    const app = await buildApp({ db: ctx!.db, igdb: fakeIgdb([]).client });
    const res = await app.inject({ method: "GET", url: "/api/search?q=a" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
