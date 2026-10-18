import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { readFileSync } from "node:fs";
import { IgdbClient } from "../../src/catalog/igdb.js";

const fixture = readFileSync(new URL("../fixtures/igdb-panzer.json", import.meta.url), "utf8");

describe("IgdbClient", () => {
  let mockAgent: MockAgent;
  let original: Dispatcher;

  beforeEach(() => {
    original = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });
  afterEach(async () => {
    setGlobalDispatcher(original);
    await mockAgent.close();
  });

  it("is not configured without credentials", () => {
    const client = new IgdbClient({ clientId: undefined, secret: undefined });
    expect(client.isConfigured()).toBe(false);
  });

  it("fetches a token once and reuses it across searches", async () => {
    let tokenCalls = 0;
    mockAgent
      .get("https://id.twitch.tv")
      .intercept({ path: /\/oauth2\/token.*/, method: "POST" })
      .reply(200, () => {
        tokenCalls += 1;
        return { access_token: "tok123", expires_in: 5000, token_type: "bearer" };
      })
      .times(2);
    mockAgent
      .get("https://api.igdb.com")
      .intercept({ path: "/v4/games", method: "POST" })
      .reply(200, fixture, { headers: { "content-type": "application/json" } })
      .times(2);

    const client = new IgdbClient({ clientId: "cid", secret: "sec" });
    const first = await client.searchGames("panzer dragoon saga");
    const second = await client.searchGames("panzer dragoon saga");
    expect(first[0].name).toBe("Panzer Dragoon Saga");
    expect(second).toHaveLength(2);
    expect(tokenCalls).toBe(1);
  });

  it("strips double quotes from the query to keep apicalypse valid", async () => {
    mockAgent
      .get("https://id.twitch.tv")
      .intercept({ path: /\/oauth2\/token.*/, method: "POST" })
      .reply(200, { access_token: "tok", expires_in: 5000 });
    let sentBody = "";
    mockAgent
      .get("https://api.igdb.com")
      .intercept({ path: "/v4/games", method: "POST" })
      .reply(200, (opts) => {
        sentBody = String(opts.body);
        return [];
      });
    const client = new IgdbClient({ clientId: "cid", secret: "sec" });
    await client.searchGames('zelda "majora\'s" mask');
    expect(sentBody).not.toContain('""');
    expect(sentBody).toContain('search "zelda');
  });

  it("excludes mods and forks via a game_type filter (game_type 5 = mod, 12 = fork)", async () => {
    // NOT `category`: verified live against the real IGDB API that `category`
    // is null on virtually every row (mainline games and mods alike) — the
    // classification IGDB actually populates today is `game_type`, which
    // shares the same enum. See the comment in igdb.ts.
    mockAgent
      .get("https://id.twitch.tv")
      .intercept({ path: /\/oauth2\/token.*/, method: "POST" })
      .reply(200, { access_token: "tok", expires_in: 5000 });
    let sentBody = "";
    mockAgent
      .get("https://api.igdb.com")
      .intercept({ path: "/v4/games", method: "POST" })
      .reply(200, (opts) => {
        sentBody = String(opts.body);
        return [];
      });
    const client = new IgdbClient({ clientId: "cid", secret: "sec" });
    await client.searchGames("ocarina of time");
    expect(sentBody).toContain("game_type = (0,3,4,8,9,10,11)");
    expect(sentBody).toContain("game_type = null");
  });
});

import { config } from "../../src/config.js";

describe.skipIf(!config.IGDB_CLIENT_ID || !config.IGDB_SECRET)("IgdbClient live", () => {
  it("finds Panzer Dragoon Saga on the real API", async () => {
    const client = new IgdbClient({
      clientId: config.IGDB_CLIENT_ID,
      secret: config.IGDB_SECRET,
    });
    const results = await client.searchGames("panzer dragoon saga");
    expect(results.map((r) => r.name)).toContain("Panzer Dragoon Saga");
  });
});
