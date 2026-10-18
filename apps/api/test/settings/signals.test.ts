import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGNAL_TYPES } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { appSettings } from "../../src/db/schema.js";
import { config } from "../../src/config.js";
import {
  clearSignalConfigCacheForTests,
  defaultSignalConfig,
  loadSignalConfig,
  resetSignalConfig,
  saveSignalConfig,
  SIGNAL_CONFIG_KEY,
} from "../../src/settings/signals.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

describe.skipIf(ctx === null)("signal configuration store", () => {
  beforeEach(async () => {
    clearSignalConfigCacheForTests();
    await ctx!.truncateAll();
  });
  afterAll(async () => ctx?.pool.end());

  it("a 1.1 config fills the recommendation thresholds with defaults", async () => {
    // a row stored before the recommendation thresholds existed
    const { quietDays: _q, evalDays: _e, ...old } = defaultSignalConfig();
    await ctx!.db.insert(appSettings).values({ key: SIGNAL_CONFIG_KEY, value: { ...old, underpricedFactor: 0.6 } });
    const cfg = await loadSignalConfig(ctx!.db);
    expect(cfg.underpricedFactor).toBe(0.6);
    expect(cfg.quietDays).toBe(120);
    expect(cfg.evalDays).toBe(14);
  });

  it("defaults equal the env-derived config, so an upgraded deployment behaves the same", async () => {
    const cfg = await loadSignalConfig(ctx!.db);
    expect(cfg.flipFactor).toBe(config.SIGNAL_VOUCHER_FACTOR);
    expect(cfg.overpricedFactor).toBe(config.SIGNAL_OVERPRICED_FACTOR);
    expect(cfg.underpricedFactor).toBe(config.SIGNAL_UNDERPRICED_FACTOR);
    expect(cfg.crossStoreFactor).toBe(config.SIGNAL_CROSS_STORE_FACTOR);
    expect(cfg.profitFactor).toBe(config.SIGNAL_PROFIT_FACTOR);
    expect(cfg.minSample).toBe(config.SIGNAL_MIN_SAMPLE);
    expect(cfg).toMatchObject({
      priceDropPct: 15,
      priceDropDays: 7,
      newLowDays: 90,
      risingPct: 20,
      risingDays: 30,
      excludedSources: [],
      minGain: null,
      minGainUsd: null,
      alertLowConfidence: false,
    });
    expect(cfg.enabledTypes).toEqual(SIGNAL_TYPES.filter((t) => t !== "INSUFFICIENT_DATA"));
  });

  it("merges a stored partial object over the defaults and ignores unknown or mistyped keys", async () => {
    await ctx!.db
      .insert(appSettings)
      .values({ key: SIGNAL_CONFIG_KEY, value: { underpricedFactor: 0.6, bogus: 1, minSample: "lots" } });
    const cfg = await loadSignalConfig(ctx!.db);
    expect(cfg.underpricedFactor).toBe(0.6);
    expect(cfg.minSample).toBe(config.SIGNAL_MIN_SAMPLE);
    expect("bogus" in cfg).toBe(false);
  });

  it("saves, loads back, and resets to the defaults", async () => {
    const saved = { ...defaultSignalConfig(), flipFactor: 1.4, enabledTypes: ["UNDERPRICED" as const], alertLowConfidence: true };
    await saveSignalConfig(ctx!.db, saved);
    clearSignalConfigCacheForTests();
    const loaded = await loadSignalConfig(ctx!.db);
    expect(loaded.flipFactor).toBe(1.4);
    expect(loaded.enabledTypes).toEqual(["UNDERPRICED"]);
    expect(loaded.alertLowConfidence).toBe(true);

    const reset = await resetSignalConfig(ctx!.db);
    expect(reset).toEqual(defaultSignalConfig());
    expect(await ctx!.db.select().from(appSettings)).toHaveLength(0);
  });

  it("derives minGainUsd from minGain at the stored FX rate", async () => {
    await saveSignalConfig(ctx!.db, { ...defaultSignalConfig(), minGain: { amount: 5, currency: "USD" } });
    expect((await loadSignalConfig(ctx!.db)).minGainUsd).toBe(5);
  });

  it("serves a second read from the cache, and a save refreshes it", async () => {
    await loadSignalConfig(ctx!.db);
    const spy = vi.spyOn(ctx!.db, "select");
    await loadSignalConfig(ctx!.db);
    expect(spy).not.toHaveBeenCalled();
    await saveSignalConfig(ctx!.db, { ...defaultSignalConfig(), newLowDays: 60 });
    expect((await loadSignalConfig(ctx!.db)).newLowDays).toBe(60);
    spy.mockRestore();
  });
});
