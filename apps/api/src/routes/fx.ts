import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FxMode, FxRateResponse, FxSettingDto, FxSettingsResponse, SupportedCurrency } from "@retrowatchdog/shared";
import { SUPPORTED_CURRENCIES, type CurrencySettingsResponse } from "@retrowatchdog/shared";
import { loadEnabledCurrencies, saveEnabledCurrencies } from "../settings/currencies.js";
import type { Db } from "../db/index.js";
import { fxOverrides } from "../db/schema.js";
import { autoRateFromUsd, rateFromUsd } from "../pricing/fx.js";

/** One currency's settings row; renders even with Frankfurter down, when a manual override may be needed most. */
async function settingDto(
  currency: SupportedCurrency,
  override: { mode: string; manualRate: string | null } | undefined,
): Promise<FxSettingDto> {
  let autoRate: number | null = null;
  let fetchedAt: string | null = null;
  try {
    const auto = await autoRateFromUsd(currency);
    autoRate = auto.rate;
    fetchedAt = auto.fetchedAt.toISOString();
  } catch {
    // FX down: row still renders, just without the reference rate
  }
  return {
    currency,
    mode: (override?.mode ?? "auto") as FxMode,
    manualRate: override?.manualRate == null ? null : Number(override.manualRate),
    autoRate,
    fetchedAt,
  };
}

async function loadOverrides(db: Db): Promise<Map<string, { mode: string; manualRate: string | null }>> {
  const rows = await db.select().from(fxOverrides);
  return new Map(rows.map((r) => [r.currency, { mode: r.mode, manualRate: r.manualRate }]));
}

export async function fxRoutes(app: FastifyInstance): Promise<void> {
  // USD->X display rate. Manual overrides win; FX down is an honest 503.
  app.get("/api/fx", async (req, reply) => {
    const parsed = z.object({ to: z.enum(SUPPORTED_CURRENCIES) }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "unsupported currency" });
    const { db } = app.deps;
    try {
      const rate = await rateFromUsd(db, parsed.data.to);
      const body: FxRateResponse = {
        base: "USD",
        to: parsed.data.to,
        rate: rate.rate,
        fetchedAt: rate.fetchedAt?.toISOString() ?? null,
        mode: rate.mode,
      };
      return body;
    } catch {
      return reply.code(503).send({ error: `FX rate for ${parsed.data.to} is unavailable` });
    }
  });

  // The currencies the menus offer; USD always.
  app.get("/api/settings/currencies", async (): Promise<CurrencySettingsResponse> => ({ enabled: await loadEnabledCurrencies(app.deps.db) }));

  app.put("/api/settings/currencies", async (req, reply) => {
    const body = z
      .object({ enabled: z.array(z.enum(SUPPORTED_CURRENCIES)).max(SUPPORTED_CURRENCIES.length) })
      .strict()
      .refine((b) => new Set(b.enabled).size === b.enabled.length, { message: "a currency is listed twice" })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const out: CurrencySettingsResponse = { enabled: await saveEnabledCurrencies(app.deps.db, body.data.enabled) };
    return out;
  });

  // Per-currency FX control, one row per enabled currency except USD.
  app.get("/api/settings/fx", async (): Promise<FxSettingsResponse> => {
    const { db } = app.deps;
    const overrides = await loadOverrides(db);
    const currencies: FxSettingDto[] = [];
    for (const currency of await loadEnabledCurrencies(db)) {
      if (currency === "USD") continue;
      currencies.push(await settingDto(currency, overrides.get(currency)));
    }
    return { currencies };
  });

  app.put("/api/settings/fx/:currency", async (req, reply) => {
    const params = z
      .object({ currency: z.enum(SUPPORTED_CURRENCIES).refine((c) => c !== "USD", { message: "USD is the base" }) })
      .safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "unsupported currency" });
    const body = z
      .object({
        mode: z.enum(["auto", "manual"]),
        manualRate: z.number().positive().optional(),
      })
      .strict()
      .refine((b) => b.mode !== "manual" || b.manualRate !== undefined, {
        message: "mode 'manual' requires manualRate > 0",
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.success === false ? body.error.message : "invalid body" });

    const { db } = app.deps;
    const currency = params.data.currency;
    // manualRate survives a switch back to 'auto' so re-toggling remembers it.
    const manualRate = body.data.manualRate !== undefined ? String(body.data.manualRate) : undefined;
    await db
      .insert(fxOverrides)
      .values({ currency, mode: body.data.mode, manualRate })
      .onConflictDoUpdate({
        target: [fxOverrides.currency],
        set: { mode: body.data.mode, ...(manualRate !== undefined ? { manualRate } : {}) },
      });
    const overrides = await loadOverrides(db);
    return settingDto(currency, overrides.get(currency));
  });
}
