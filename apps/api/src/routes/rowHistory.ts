import type { FastifyInstance } from "fastify";
import { eq, notInArray } from "drizzle-orm";
import { z } from "zod";
import { VALUATION_BASES, type Condition, type Region, type SparklinesResponse, type WatchlistHistoryResponse } from "@retrowatchdog/shared";
import { ownedCopies, watchlist } from "../db/schema.js";
import { enabledSourceIds } from "../settings/markets.js";
import { loadSignalConfig } from "../settings/signals.js";
import { loadSeries, sliceFor, type DayReading } from "../insights/series.js";
import { cachedFor } from "./insights.js";
import { parseWindow } from "../lib/window.js";

const DAY_MS = 86_400_000;
const daysSchema = z.coerce.number().int().min(1).max(365).optional();
type Row = { id: number; gameId: number; region: string | null; condition: string | null };

/** The price history behind the watchlist total and the row sparklines, all from price_points. */
export async function rowHistoryRoutes(app: FastifyInstance): Promise<void> {
  const readings = async (rows: Row[], days: number) => {
    const { db, registry, sources } = app.deps;
    const series = await loadSeries(db, [...new Set(rows.map((r) => r.gameId))], await enabledSourceIds(db, registry), sources.byId, days);
    return new Map(rows.map((r) => [r.id, sliceFor(series.get(r.gameId), r.region as Region | null, r.condition as Condition | null)]));
  };
  const watches = () => app.deps.db.select({ id: watchlist.id, gameId: watchlist.gameId, region: watchlist.region, condition: watchlist.condition }).from(watchlist);
  const parseDays = async (raw: unknown) => {
    const parsed = daysSchema.safeParse(raw);
    return parsed.success ? (parsed.data ?? (await loadSignalConfig(app.deps.db)).historyDays) : null;
  };
  const spark = (byId: Map<number, DayReading[]>, pick: (r: DayReading) => number | null, days: number): SparklinesResponse => ({
    days,
    series: Object.fromEntries(
      [...byId].map(([id, rs]) => [id, rs.flatMap((r) => (pick(r) === null ? [] : [{ day: r.day, usd: pick(r)! }]))]),
    ),
  });

  app.get("/api/watchlist/history", async (req, reply) => {
    const window = parseWindow(req.query as Record<string, unknown>, (await loadSignalConfig(app.deps.db)).historyDays);
    if (!window.ok) return reply.code(400).send({ error: window.reason });
    const { from, to, days } = window;
    // the series loader reads back from today, so it is asked for everything since `from`
    const sinceFrom = Math.round((Date.now() - new Date(`${from}T00:00:00.000Z`).getTime()) / DAY_MS) + 1;
    const rows = await watches();
    const byDay = new Map<string, { totalUsd: number; covered: number }>();
    for (const rs of (await readings(rows, sinceFrom)).values()) {
      for (const r of rs) {
        if (r.cheapestUsd === null || r.day < from || r.day > to) continue;
        const cell = byDay.get(r.day) ?? { totalUsd: 0, covered: 0 };
        cell.totalUsd = Math.round((cell.totalUsd + r.cheapestUsd) * 100) / 100;
        cell.covered += 1;
        byDay.set(r.day, cell);
      }
    }
    const body: WatchlistHistoryResponse = {
      days,
      from,
      to,
      points: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, c]) => ({ day, ...c, of: rows.length })),
    };
    return body;
  });

  app.get("/api/watchlist/sparklines", async (req, reply) => {
    const days = await parseDays((req.query as { days?: unknown }).days);
    if (days === null) return reply.code(400).send({ error: "days must be 1..365" });
    return cachedFor(`w${days}`, async () => spark(await readings(await watches(), days), (r) => r.cheapestUsd, days));
  });

  app.get("/api/collection/sparklines", async (req, reply) => {
    const q = req.query as { days?: unknown; valuation?: unknown };
    const days = await parseDays(q.days);
    const basis = z.enum(VALUATION_BASES).default("market").safeParse(q.valuation);
    if (days === null || !basis.success) return reply.code(400).send({ error: "invalid params" });
    const pick =
      basis.data === "trade_in" ? (r: DayReading) => r.bestBidUsd : basis.data === "replacement" ? (r: DayReading) => r.cheapestStoreUsd : (r: DayReading) => r.cheapestUsd;
    return cachedFor(`c${days}${basis.data}`, async () => {
      const copies = await app.deps.db
        .select({ id: ownedCopies.id, gameId: ownedCopies.gameId, region: ownedCopies.region, condition: ownedCopies.condition })
        .from(ownedCopies)
        .where(notInArray(ownedCopies.status, ["sold", "returned"]));
      return spark(await readings(copies, days), pick, days);
    });
  });
}
