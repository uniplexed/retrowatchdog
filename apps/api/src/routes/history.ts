import type { FastifyInstance } from "fastify";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import type { Condition, HistoryResponse, PriceKind, Region, SourceId } from "@retrowatchdog/shared";
import { CONDITIONS, REGIONS } from "@retrowatchdog/shared";
import { games, pricePoints } from "../db/schema.js";
import { buildHistorySeries, type HistoryRow } from "../pricing/history.js";
import { loadEnabledSources } from "../settings/markets.js";
import { parseWindow } from "../lib/window.js";

const paramsSchema = z.object({ id: z.coerce.number().int().positive() });

/**
 * `region` and `condition` are required and concrete: a history line mixing PAL
 * with NTSC-J is the dimension confusion this app exists to avoid. The window
 * is `days`, or `from` and `to` (lib/window.ts); out of range is refused.
 */
const querySchema = z.object({
  region: z.enum(REGIONS),
  condition: z.enum(CONDITIONS),
});

export async function historyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/games/:id/history", async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    const query = querySchema.safeParse(req.query);
    const window = parseWindow(req.query as Record<string, unknown>, 30);
    if (!params.success || !query.success || !window.ok) {
      return reply.code(400).send({ error: window.ok ? "invalid params" : window.reason });
    }
    // Read per request: `sources` is replaced when a plugin is approved or removed.
    const { db, sources: registeredSources } = app.deps;
    const [game] = await db.select({ id: games.id }).from(games).where(eq(games.id, params.data.id));
    if (!game) return reply.code(404).send({ error: "game not found" });

    const { region, condition } = query.data;
    const { days } = window;
    // whole UTC days, both edges inclusive
    const fromMidnight = new Date(`${window.from}T00:00:00.000Z`);
    const toEnd = new Date(`${window.to}T23:59:59.999Z`);

    // A market turned off in Settings must not surface here either.
    const enabledSources = [...(await loadEnabledSources(db))];
    if (enabledSources.length === 0) {
      // an empty `inArray` would build an invalid `IN ()`
      const body: HistoryResponse = {
        region,
        condition,
        days,
        from: window.from,
        to: window.to,
        series: [],
      };
      return body;
    }

    const rows = await db
      .select({
        source: pricePoints.source,
        kind: pricePoints.kind,
        region: pricePoints.region,
        condition: pricePoints.condition,
        grade: pricePoints.grade,
        priceUsd: pricePoints.priceUsd,
        priceOriginal: pricePoints.priceOriginal,
        currencyOriginal: pricePoints.currencyOriginal,
        available: pricePoints.available,
        sampleSize: pricePoints.sampleSize,
        fetchedAt: pricePoints.fetchedAt,
      })
      .from(pricePoints)
      .where(
        and(
          eq(pricePoints.gameId, game.id),
          eq(pricePoints.region, region),
          eq(pricePoints.condition, condition),
          gte(pricePoints.fetchedAt, fromMidnight),
          lte(pricePoints.fetchedAt, toEnd),
          inArray(pricePoints.source, enabledSources),
        ),
      );

    const history: HistoryRow[] = rows.map((r) => ({
      source: r.source as SourceId,
      kind: r.kind as PriceKind,
      region: r.region as Region,
      condition: r.condition as Condition,
      grade: r.grade as HistoryRow["grade"],
      // numeric comes back as a string from pg; every other reader does the same
      priceUsd: Number(r.priceUsd),
      original: { amount: Number(r.priceOriginal), currency: r.currencyOriginal },
      available: r.available,
      sampleSize: r.sampleSize,
      fetchedAt: r.fetchedAt,
    }));

    const body: HistoryResponse = {
      region,
      condition,
      days,
      from: window.from,
      to: window.to,
      series: buildHistorySeries(history, registeredSources.byId),
    };
    return body;
  });
}
