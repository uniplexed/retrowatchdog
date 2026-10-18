import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SourceInfoDto } from "@retrowatchdog/shared";
import {
  getSourcesSnapshot,
  kindLabel,
  loadSources,
  resetSourcesForTests,
  setSourcesForTests,
  sourceLabel,
  subscribeSources,
} from "../src/lib/sources.js";

/**
 * The source registry store.
 *
 * The setup file seeds every test with SOURCES_FIXTURE, so this file starts
 * each case from the boot state (nothing known) to test the store itself
 * rather than the seed.
 */
beforeEach(() => {
  resetSourcesForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const shopGb: SourceInfoDto = {
  id: "shop_gb",
  label: "Shop GB",
  family: "shop",
  familyLabel: "Shop",
  kind: "live",
  country: "GB",
  reach: "local",
  defaultRegion: "PAL",
  expectedCurrencies: ["GBP"],
  kindRoles: { sell: "buy_store" },
  kindLabels: { sell: "Shop GB sells for" },
  configured: true,
  origin: "plugin",
  pluginId: 3,
};

describe("the sources store", () => {
  it("loads the registry from the API once", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ sources: [shopGb] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await loadSources();

    expect(seen).toEqual(["/api/sources"]);
    expect(getSourcesSnapshot().byId.shop_gb?.label).toBe("Shop GB");
    expect(getSourcesSnapshot().status).toBe("ready");
    expect(sourceLabel("shop_gb")).toBe("Shop GB");
    expect(kindLabel("shop_gb", "sell")).toBe("Shop GB sells for");
  });

  it("names a source the bundle has never heard of by its id, never by throwing", () => {
    // The whole point of the runtime registry: this build knows nothing about
    // an imported plugin's ids, and every call site has to survive that.
    expect(sourceLabel("some_plugin_source")).toBe("some_plugin_source");
    expect(kindLabel("some_plugin_source", "sell")).toBe("sells for"); // KIND_LABEL_FALLBACK
  });

  it("answers undefined for an id that only Object.prototype has", async () => {
    // Source ids are DATA — a plugin author names them. On a plain object
    // literal, byId["constructor"] answers with an inherited function instead
    // of undefined, and every reader's `?.` sails straight past it: the next
    // step is `(<function>).kindRoles[kind]`, a TypeError that blanks the
    // React tree. A null-prototype map answers undefined, which is the truth.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ sources: [shopGb] }))));
    await loadSources();

    for (const inherited of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
      expect(getSourcesSnapshot().byId[inherited], inherited).toBeUndefined();
      expect(sourceLabel(inherited), inherited).toBe(inherited);
    }
    expect(Object.getPrototypeOf(getSourcesSnapshot().byId)).toBeNull();
    // the empty boot state has to hold the same kind of map, not just the
    // one built from a served list
    resetSourcesForTests();
    expect(Object.getPrototypeOf(getSourcesSnapshot().byId)).toBeNull();
    expect(getSourcesSnapshot().byId.constructor).toBeUndefined();
  });

  it("falls back to the shared kind wording for a known source that declares none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ sources: [shopGb] }))));
    await loadSources();
    // shop_gb labels `sell` and nothing else
    expect(kindLabel("shop_gb", "cash")).toBe("pays cash");
  });

  it("records a failed load as `failed` rather than as an empty registry", async () => {
    // The distinction the screens need: "this deployment has no such source"
    // and "this app could not find out" are different facts, and only the
    // second one is worth interrupting the user about.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    await expect(loadSources()).resolves.toBeUndefined();

    expect(getSourcesSnapshot().list).toEqual([]);
    expect(getSourcesSnapshot().status).toBe("failed");
    expect(sourceLabel("cex")).toBe("cex");
  });

  it("recovers on a retry: the same call that failed puts the registry back", async () => {
    // Nothing else retries. The boot load fires once, so without this the
    // first failure would last for the life of the page.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await loadSources();
    expect(getSourcesSnapshot().status).toBe("failed");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ sources: [shopGb] }))));
    await loadSources();

    expect(getSourcesSnapshot().status).toBe("ready");
    expect(sourceLabel("shop_gb")).toBe("Shop GB");
  });

  it("drops a load that lands after the registry has moved on", async () => {
    // money.ts guards /api/fx the same way (its fetchSeq): a boot fetch still
    // in flight must not overwrite the registry a test deliberately set, or
    // the test is racing its own setup.
    let release: ((response: Response) => void) | null = null;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(() => pending));

    const inFlight = loadSources();
    setSourcesForTests([shopGb]);
    (release as unknown as (response: Response) => void)(
      new Response(JSON.stringify({ sources: [] })),
    );
    await inFlight;

    expect(getSourcesSnapshot().status).toBe("ready");
    expect(sourceLabel("shop_gb")).toBe("Shop GB");
  });

  it("notifies subscribers so a mounted screen re-renders when the registry lands", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSources(listener);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ sources: [shopGb] }))));

    await loadSources();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setSourcesForTests([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
