import type { FastifyInstance, FastifyReply } from "fastify";
import { asc, eq } from "drizzle-orm";
import { COLLECTION_CSV_COLUMNS, WATCHLIST_CSV_COLUMNS } from "@retrowatchdog/shared";
import { games, ownedCopies, watchlist } from "../db/schema.js";
import { serializeCsv } from "../lib/csv.js";

/** server-clock date stamp for the download filename (YYYYMMDD) */
function dateStamp(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/**
 * CSV exports in the canonical formats (round-trip via game_id). Numerics are
 * emitted verbatim from their stored strings.
 */
export async function csvExportRoutes(app: FastifyInstance): Promise<void> {
  const sendCsv = (reply: FastifyReply, kind: string, csv: string) =>
    reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="retrowatchdog-${kind}-${dateStamp()}.csv"`)
      .send(csv);

  app.get("/api/collection/export", async (_req, reply) => {
    const { db } = app.deps;
    const rows = await db
      .select({ copy: ownedCopies, game: games })
      .from(ownedCopies)
      .innerJoin(games, eq(games.id, ownedCopies.gameId))
      .orderBy(asc(ownedCopies.id));
    const csv = serializeCsv(
      COLLECTION_CSV_COLUMNS,
      rows.map(({ copy, game }) => [
        copy.gameId,
        game.title,
        game.platform,
        copy.region,
        copy.condition,
        copy.itemGrade,
        copy.status,
        copy.acquiredPriceOriginal,
        copy.acquiredCurrency,
        copy.acquiredPriceUsd,
        copy.notes,
        copy.acquiredAt,
        copy.acquiredSource,
        copy.acquiredUrl,
        copy.matchBasis,
        copy.soldAt,
        copy.soldVenue,
        copy.soldCurrency,
        copy.soldPriceOriginal,
        copy.soldFeesOriginal,
        copy.soldPriceUsd,
        copy.soldFeesUsd,
        copy.returnedAt,
        copy.refundOriginal,
        copy.returnCostsOriginal,
        copy.refundUsd,
        copy.returnCostsUsd,
      ]),
    );
    return sendCsv(reply, "collection", csv);
  });

  app.get("/api/watchlist/export", async (_req, reply) => {
    const { db } = app.deps;
    const rows = await db
      .select({ watch: watchlist, game: games })
      .from(watchlist)
      .innerJoin(games, eq(games.id, watchlist.gameId))
      .orderBy(asc(watchlist.id));
    const csv = serializeCsv(
      WATCHLIST_CSV_COLUMNS,
      rows.map(({ watch, game }) => [
        watch.gameId,
        game.title,
        game.platform,
        watch.region,
        watch.condition,
        watch.targetPriceOriginal,
        watch.targetCurrency,
        watch.targetPriceUsd,
      ]),
    );
    return sendCsv(reply, "watchlist", csv);
  });
}
