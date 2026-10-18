import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { CheapestListingDto, GamePriceOverride, GameSummary, Platform, PriceMode, PricesResponse } from "@retrowatchdog/shared";
import { CONDITIONS } from "@retrowatchdog/shared";
import { games, watchlist } from "../db/schema.js";
import { getPricesForGame } from "../pricing/service.js";
import { buildSignalInputs, computeSignals, type WatchTarget } from "../signals/computeSignals.js";
import { loadSignalConfig } from "../settings/signals.js";
import { loadSignalHistory } from "../signals/history.js";
import { watchTarget } from "../signals/target.js";
import { config } from "../config.js";

const paramsSchema = z.object({ id: z.coerce.number().int().positive() });
const querySchema = z.object({
  region: z.enum(["PAL", "NTSC_U", "NTSC_J", "unknown"]).optional(),
  // the shared runtime list plus the "no filter" sentinel, never a re-typed copy
  condition: z.enum([...CONDITIONS, "all"] as const).default("all"),
  // the state the signals are judged for (a watch's or a copy's); absent = any.
  // Signals only: the display keeps region/condition above.
  signalRegion: z.enum(["PAL", "NTSC_U", "NTSC_J"]).optional(),
  signalCondition: z.enum(CONDITIONS).optional(),
  // NOT z.coerce.boolean(): that coerces the string "false" to true
  refresh: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

/** the buy targets of the game's watches that admit `region` (any-region watches admit all) */
function targetsFor(watches: Array<typeof watchlist.$inferSelect>, region: string): WatchTarget[] {
  return watches
    .filter((w) => w.region === null || w.region === region)
    .map(watchTarget)
    .filter((t): t is WatchTarget => t !== undefined);
}

export async function pricesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/games/:id/prices", async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    const query = querySchema.safeParse(req.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: "invalid params" });
    }
    // Read per request: `sources` is replaced when a plugin is approved or removed.
    const { db, registry, sources: registeredSources } = app.deps;
    const [row] = await db.select().from(games).where(eq(games.id, params.data.id));
    if (!row) return reply.code(404).send({ error: "game not found" });
    const game: GameSummary = {
      id: row.id,
      title: row.title,
      platform: row.platform as Platform,
      year: row.year,
      coverUrl: row.coverUrl,
    };

    const override = (row.priceMode ?? null) as GamePriceOverride | null;
    const effectiveMode: PriceMode = query.data.refresh ? "live" : override ?? config.PRICE_MODE;
    const blocks = await getPricesForGame(
      db,
      registry,
      { id: game.id, title: game.title, platform: game.platform },
      // a stored row of a kind the registry declares no role for is not rendered
      { mode: effectiveMode, sources: registeredSources },
    );

    // Signals: filtered by region and the signal scope's condition; "unknown"
    // points must survive, they feed the undeclared-region/condition fallback.
    const signalPoints = blocks
      .flatMap((b) => b.points)
      .filter((p) => {
        const region = query.data.signalRegion ?? query.data.region;
        return !region || p.region === region || p.region === "unknown";
      })
      // the same for condition: "unknown"-condition listings feed the ladder's labelled fallback
      .filter((p) => !query.data.signalCondition || p.condition === query.data.signalCondition || p.condition === "unknown");
    const cfg = await loadSignalConfig(app.deps.db);
    const history = await loadSignalHistory(db, game.id, blocks.map((b) => b.source), registeredSources.byId, cfg);
    const watches = await db.select().from(watchlist).where(eq(watchlist.gameId, game.id));
    // Pass the registry: without it plugin points carry no role and stay silent.
    const signals = buildSignalInputs(signalPoints, registeredSources.byId, history).flatMap((input) =>
      computeSignals({ ...input, targets: targetsFor(watches, input.region) }, cfg, registeredSources.byId),
    );

    // Display: filter points by region and condition
    const sources = blocks.map((b) => {
      const points = b.points.filter(
        (p) =>
          (!query.data.region || p.region === query.data.region) &&
          (query.data.condition === "all" || p.condition === query.data.condition),
      );
      const cheapestListings: CheapestListingDto[] = points
        // Damaged is not an offer: the strip shows a bare amount with no condition.
        // The row still appears in `points` with its grade.
        .filter(
          (p) =>
            registeredSources.byId[p.source]?.kindRoles[p.kind] === "buy_listing" &&
            p.grade !== "fair" &&
            p.grade !== "poor",
        )
        .map((p) => ({
          title: p.listingTitle ?? "listing",
          priceUsd: p.priceUsd,
          // the seller's own asking price travels with the USD twin, so the UI
          // can show what was actually asked when the currencies match
          priceOriginal: p.priceOriginal,
          currencyOriginal: p.currencyOriginal,
          condition: p.condition,
          grade: p.grade ?? null,
          url: p.url ?? null,
        }));
      return {
        ...b,
        points,
        // keyed on the declared role, not the kind's name
        ...(cheapestListings.length > 0 ? { cheapestListings } : {}),
      };
    });

    const body: PricesResponse = { game, sources, signals, gamePriceMode: override };
    return body;
  });
}
