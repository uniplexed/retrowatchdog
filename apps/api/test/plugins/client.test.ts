import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { fetchPluginHealth, fetchPluginManifest } from "../../src/plugins/client.js";

/**
 * The two questions the app asks a plugin about ITSELF. Both answers are a
 * proposal from an untrusted process, so what is tested is what the app
 * refuses to assume from one: that silence means yes, that a 200 means well,
 * or that a manifest means what it says before `validateManifest` has read it.
 */
const BASE = "http://plug:8000";

const manifestBody = {
  protocol: 3,
  plugin: { name: "vinted", version: "1.0.0" },
  sources: [
    {
      id: "vinted_uk",
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
};

describe("fetchPluginHealth and fetchPluginManifest", () => {
  let agent: MockAgent;
  let previous: Dispatcher;

  beforeEach(() => {
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    setGlobalDispatcher(previous);
    await agent.close();
  });

  const health = () => agent.get(BASE).intercept({ path: "/health", method: "GET" });
  const manifest = () => agent.get(BASE).intercept({ path: "/manifest", method: "GET" });

  it("reads status, protocol and configured, ignoring whatever else the plugin adds", async () => {
    // Rebuilt, not passed through: the row this becomes is the app's reading
    // of the answer, so a plugin's extra keys have no way into the database.
    health().reply(200, {
      status: "ok",
      protocol: 2,
      configured: true,
      package: { name: "vinted_scraper", version: "4.0.0" },
    });
    await expect(fetchPluginHealth(BASE)).resolves.toEqual({ status: "ok", protocol: 2, configured: true });
  });

  it("treats a missing `configured` as not configured rather than assuming yes", async () => {
    // The safe reading of silence is "it did not say it can answer". Nothing
    // reads the flag yet; it is recorded so that whatever decides a source is
    // worth offering decides it from evidence rather than from silence.
    health().reply(200, { status: "ok", protocol: 2 });
    await expect(fetchPluginHealth(BASE)).resolves.toEqual({ status: "ok", protocol: 2, configured: false });
  });

  it("fails on a non-2xx, on a non-JSON body, on a JSON array and on a status that is not ok", async () => {
    health().reply(503, "");
    await expect(fetchPluginHealth(BASE)).rejects.toThrow(/503/);

    health().reply(200, "<html>");
    await expect(fetchPluginHealth(BASE)).rejects.toThrow(/did not answer JSON/);

    health().reply(200, [{ status: "ok", protocol: 2 }]);
    await expect(fetchPluginHealth(BASE)).rejects.toThrow(/did not answer a JSON object/);

    // "degraded" is a plugin saying so itself; the app takes it at its word

    health().reply(200, { status: "degraded", protocol: 2, configured: true });
    await expect(fetchPluginHealth(BASE)).rejects.toThrow(/status "degraded" is not "ok"/);

    health().reply(200, { status: "ok", configured: true });
    await expect(fetchPluginHealth(BASE)).rejects.toThrow(/protocol is missing/);
  });

  it("cuts the plugin's own status to a length a person can read", async () => {
    // The status is a string the PLUGIN chose, quoted back in the app's own
    // error. The only other cap on it is the 1 MB declaration limit, so
    // without one here a plugin answering a megabyte of "x" makes a
    // megabyte-long error, which has stopped being a message. Today that
    // error is only replied to the caller of an import; once the health poll
    // exists it becomes a stored column served over HTTP, which is why the
    // bound belongs here rather than at whichever screen renders it.
    health().reply(200, { status: "x".repeat(5000), protocol: 2 });
    const error = await fetchPluginHealth(BASE).then(
      () => null,
      (caught: Error) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    // 80 characters of value, the ellipsis that says it was cut, and the
    // app's own words around it — nowhere near what the plugin sent
    expect(error!.message).toMatch(/status "x{79}…/);
    expect(error!.message.length).toBeLessThan(200);
  });

  /**
   * The other things valid JSON can be. An array is the one above; these three
   * parse just as happily and would each reach the field reads below the
   * guard, where `null.status` throws a TypeError the caller cannot read and a
   * string's `.status` is quietly `undefined` — a plugin answering `"ok"`
   * would be refused for the wrong reason, in words about a status it never
   * sent. The guard is three checks and needs all three tested.
   */
  it("refuses a health body that is JSON but not an object: null, a string, a number", async () => {
    // written as raw bodies, because these are literals a plugin can send and
    // not values a JSON-serialising fixture would produce on its own
    for (const body of ["null", '"ok"', "42"]) {
      health().reply(200, body, { headers: { "content-type": "application/json" } });
      await expect(fetchPluginHealth(BASE)).rejects.toThrow(/did not answer a JSON object/);
    }
  });

  it("names the plugin and the endpoint when a call fails on its status", async () => {
    // The message is the whole diagnosis a stored `last_error` can carry: it
    // has to say WHICH plugin and WHICH endpoint, since one deployment can
    // hold several and a bare "HTTP 503" would point at none of them.
    health().reply(503, "");
    await expect(fetchPluginHealth(BASE)).rejects.toThrow("http://plug:8000 GET /health answered HTTP 503");
  });

  it("returns the validated manifest", async () => {
    manifest().reply(200, manifestBody);
    const parsed = await fetchPluginManifest(BASE);
    expect(parsed.plugin.name).toBe("vinted");
    expect(parsed.sources[0].id).toBe("vinted_uk");
    // requiredSecrets is the validator's, not the plugin's: it was absent
    expect(parsed.requiredSecrets).toEqual([]);
  });

  it("rejects an invalid manifest with the validator's own reason", async () => {
    // Passed through word for word rather than replaced by a sentence of this
    // module's own, because it is the whole of what the app ever learns about
    // WHY a manifest was refused — and it is written to `plugins.last_error`,
    // the one column that survives the poll. "this plugin speaks protocol 1,
    // and this app requires 3" is something a person can act on; "invalid
    // manifest" is not. The health poller (worker/pluginHealth.ts) is the
    // caller that writes it there, on every tick that fails.
    manifest().reply(200, { ...manifestBody, protocol: 1 });
    await expect(fetchPluginManifest(BASE)).rejects.toThrow(/protocol 1.*requires 3/i);
  });

  it("refuses a manifest past the byte cap", async () => {
    // A plugin that needs a megabyte to say what it serves is broken, and the
    // app finds that out without holding the megabyte.
    manifest().reply(200, { ...manifestBody, filler: "x".repeat(2 * 1024 * 1024) });
    await expect(fetchPluginManifest(BASE)).rejects.toThrow(/answered more than 1048576 bytes/);
  });
});
