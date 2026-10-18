import type { FastifyInstance } from "fastify";
import { and, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Condition, HistoryResponse, PriceKind, Region, SourceId } from "@retrowatchdog/shared";
import { CONDITIONS, REGIONS } from "@retrowatchdog/shared";
import { games, pricePoints } from "../db/schema.js";
import { buildHistorySeries, dayOf, type HistoryRow } from "../pricing/history.js";
import { loadEnabledSources } from "../settings/markets.js";

const paramsSchema = z.object({ id: z.coerce.number().int().positive() });

/**
 * `region` and `condition` are required and concrete: a history line mixing PAL
 * with NTSC-J is the dimension confusion this app exists to avoid. `days` out of
 * range is refused, not clamped.
 */
const querySchema = z.object({
  region: z.enum(REGIONS),
  condition: z.enum(CONDITIONS),
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export async function historyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/games/:id/history", async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    const query = querySchema.safeParse(req.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: "invalid params" });
    }
    // Read per request: `sources` is replaced when a plugin is approved or removed.
    const { db, sources: registeredSources } = app.deps;
    const [game] = await db.select({ id: games.id }).from(games).where(eq(games.id, params.data.id));
    if (!game) return reply.code(404).send({ error: "game not found" });

    const { region, condition, days } = query.data;
    // The window is whole UTC days, inclusive of today: days=1 is today only.
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86_400_000);
    const fromMidnight = new Date(`${dayOf(from)}T00:00:00.000Z`);

    // A market turned off in Settings must not surface here either.
    const enabledSources = [...(await loadEnabledSources(db))];
    if (enabledSources.length === 0) {
      // an empty `inArray` would build an invalid `IN ()`
      const body: HistoryResponse = {
        region,
        condition,
        days,
        from: dayOf(from),
        to: dayOf(to),
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
      from: dayOf(from),
      to: dayOf(to),
      series: buildHistorySeries(history, registeredSources.byId),
    };
    return body;
  });
}
