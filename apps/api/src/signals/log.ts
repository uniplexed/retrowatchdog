import { and, desc, eq, gt, isNull, lt, lte, sql, gte } from "drizzle-orm";
import type { PriceKind, PriceRole, ReliabilityRow, Signal, SignalType, SourceInfo } from "@retrowatchdog/shared";
import type { Db } from "../db/index.js";
import { pricePoints, signalLog } from "../db/schema.js";
import type { SignalConfig } from "./computeSignals.js";

const DAY_MS = 86_400_000;

/**
 * "The same signal" across refreshes: the alert key's fields (worker/alerts.ts
 * alertKey), prefixed by what it belongs to so a watch and a copy of one game
 * never share a row.
 */
export function logKey(owner: "w" | "c", id: number, signal: Signal): string {
  return [
    owner,
    id,
    signal.type,
    signal.source ?? "",
    signal.buySource ?? "",
    signal.sellSource ?? "",
    signal.sellKind ?? "",
    signal.url ?? "",
  ].join("|");
}

export interface LoggedSignal {
  key: string;
  gameId: number;
  watchId?: number;
  copyId?: number;
  /** the slice it was computed for; "any" where a watch leaves a dimension open */
  region: string;
  condition: string;
  signal: Signal;
}

/**
 * One row per distinct signal per appearance: a key seen again within
 * evalDays of its first sighting refreshes last_seen_at; seen later, it is a
 * new appearance and a new row.
 */
export async function recordSignals(
  db: Db,
  items: LoggedSignal[],
  cfg: SignalConfig,
  now: Date = new Date(),
): Promise<{ inserted: number; refreshed: number }> {
  let inserted = 0;
  let refreshed = 0;
  const since = new Date(now.getTime() - cfg.evalDays * DAY_MS);
  for (const item of items) {
    const [open] = await db
      .select({ id: signalLog.id })
      .from(signalLog)
      .where(and(eq(signalLog.key, item.key), gt(signalLog.firstSeenAt, since)))
      .orderBy(desc(signalLog.firstSeenAt))
      .limit(1);
    if (open !== undefined) {
      await db.update(signalLog).set({ lastSeenAt: now }).where(eq(signalLog.id, open.id));
      refreshed += 1;
      continue;
    }
    const s = item.signal;
    await db.insert(signalLog).values({
      key: item.key,
      gameId: item.gameId,
      watchId: item.watchId ?? null,
      copyId: item.copyId ?? null,
      type: s.type,
      source: s.source ?? s.sellSource ?? s.buySource ?? null,
      kind: s.sellKind ?? null,
      region: item.region,
      condition: item.condition,
      confidence: s.confidence ?? "high",
      priceUsd: s.price === undefined ? null : s.price.usd.toFixed(2),
      priceOriginal: s.price === undefined ? null : s.price.original.toFixed(2),
      currency: s.price?.currency ?? null,
      edgePct: s.edgePct ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    inserted += 1;
  }
  return { inserted, refreshed };
}

/** what a signal's advice was: buy something, sell something, or keep off a store */
const BUY_TYPES = new Set(["UNDERPRICED", "TARGET_HIT", "NEW_LOW", "PRICE_DROP", "BACK_IN_STOCK"]);
const SELL_TYPES = new Set(["PROFIT", "RISING"]);

interface NowPoint {
  source: string;
  kind: string;
  role: PriceRole | undefined;
  usd: number;
}

/** each source's latest batch for a game, already narrowed to the row's slice and to real prices */
async function latestPoints(db: Db, gameId: number): Promise<Array<typeof pricePoints.$inferSelect>> {
  const latest = db
    .select({ source: pricePoints.source, at: sql<Date>`max(${pricePoints.fetchedAt})`.as("at") })
    .from(pricePoints)
    .where(eq(pricePoints.gameId, gameId))
    .groupBy(pricePoints.source)
    .as("latest");
  return db
    .select({ p: pricePoints })
    .from(pricePoints)
    .innerJoin(latest, and(eq(latest.source, pricePoints.source), eq(latest.at, pricePoints.fetchedAt)))
    .where(and(eq(pricePoints.gameId, gameId), sql`${pricePoints.priceUsd} > 0`, sql`${pricePoints.available} IS DISTINCT FROM false`))
    .then((rows) => rows.map((r) => r.p));
}

const pick = (points: NowPoint[], source: string | null, roles: PriceRole[], best: "min" | "max", kind: string | null = null): number | null => {
  const usd = points
    .filter((p) => (source === null || p.source === source) && (kind === null || p.kind === kind) && p.role !== undefined && roles.includes(p.role))
    .map((p) => p.usd);
  if (usd.length === 0) return null;
  return best === "min" ? Math.min(...usd) : Math.max(...usd);
};

/**
 * Judges every signal first seen at least evalDays ago against today's
 * prices of its slice: held (the advice stood), beaten (something better came
 * along) or unknown (no price to judge by). gain_usd is signed in the
 * advice's favour.
 */
export async function evaluateSignals(
  db: Db,
  registry: Record<string, SourceInfo>,
  cfg: SignalConfig,
  now: Date = new Date(),
): Promise<{ evaluated: number }> {
  const due = await db
    .select()
    .from(signalLog)
    .where(and(isNull(signalLog.evaluatedAt), lte(signalLog.firstSeenAt, new Date(now.getTime() - cfg.evalDays * DAY_MS))));
  const byGame = new Map<number, Array<typeof pricePoints.$inferSelect>>();
  const beaten = cfg.beatenPct / 100;
  for (const row of due) {
    if (!byGame.has(row.gameId)) byGame.set(row.gameId, await latestPoints(db, row.gameId));
    const points: NowPoint[] = byGame
      .get(row.gameId)!
      // a batch from before the signal is the price that raised it, not news about it
      .filter((p) => p.fetchedAt > row.firstSeenAt)
      .filter((p) => (row.region === "any" || p.region === row.region) && (row.condition === "any" || p.condition === row.condition))
      .map((p) => ({ source: p.source, kind: p.kind, role: registry[p.source]?.kindRoles[p.kind as PriceKind], usd: Number(p.priceUsd) }));
    const price = row.priceUsd === null ? null : Number(row.priceUsd);
    let outcome: "held" | "beaten" | "unknown" = "unknown";
    let nowUsd: number | null = null;
    let gain: number | null = null;
    if (price !== null) {
      if (BUY_TYPES.has(row.type)) {
        // what that source asks today; a median when the signal was about one (PRICE_DROP)
        nowUsd = pick(points, row.source, ["buy_listing", "buy_store"], "min") ?? pick(points, row.source, ["reference"], "min");
        if (nowUsd !== null) {
          outcome = nowUsd <= price * (1 - beaten) ? "beaten" : "held";
          gain = nowUsd - price;
        }
      } else if (SELL_TYPES.has(row.type)) {
        // PROFIT: the same instrument it was read from; a reference is netted by the source's fee as the rule does
        const fee = row.source === null ? 0 : (registry[row.source]?.sellFeeRate ?? 0);
        const ref = pick(points, row.source, ["reference"], "max", row.type === "PROFIT" ? row.kind : null);
        nowUsd =
          row.type === "PROFIT"
            ? (pick(points, row.source, ["bid"], "max", row.kind) ?? (ref === null ? null : Math.round(ref * (1 - fee) * 100) / 100))
            : ref;
        if (nowUsd !== null) {
          outcome = nowUsd >= price * (1 + beaten) ? "beaten" : "held";
          gain = price - nowUsd;
        }
      } else if (row.type === "FLIP") {
        nowUsd = pick(points, row.source, ["bid"], "max", row.kind);
        if (nowUsd !== null) {
          outcome = nowUsd >= price * cfg.flipFactor ? "held" : "beaten";
          gain = nowUsd - price;
        }
      } else if (row.type === "OVERPRICED_STORE") {
        nowUsd = pick(points, row.source, ["buy_store"], "min");
        const reference = pick(points, null, ["reference"], "min");
        if (nowUsd !== null && reference !== null) {
          outcome = nowUsd >= reference * cfg.overpricedFactor ? "held" : "beaten";
          gain = nowUsd - reference;
        }
      }
    }
    await db
      .update(signalLog)
      .set({
        evaluatedAt: now,
        outcome,
        outcomePriceUsd: nowUsd === null ? null : nowUsd.toFixed(2),
        gainUsd: gain === null ? null : gain.toFixed(2),
      })
      .where(eq(signalLog.id, row.id));
  }
  return { evaluated: due.length };
}

/** deletes rows first seen more than logRetentionDays ago */
export async function purgeSignalLog(db: Db, cfg: SignalConfig, now: Date = new Date()): Promise<number> {
  const gone = await db
    .delete(signalLog)
    .where(lt(signalLog.firstSeenAt, new Date(now.getTime() - cfg.logRetentionDays * DAY_MS)))
    .returning({ id: signalLog.id });
  return gone.length;
}

/** under this many judged (held or beaten) signals a held rate is not stated */
const MIN_EVALUATED = 10;

/** how often each signal type (and source) held, plus one aggregate row per type */
/** Per type and per source; `window` counts only the signals first seen inside it. */
export async function reliabilityRows(db: Db, window?: { from: string; to: string }): Promise<ReliabilityRow[]> {
  const grouped = await db
    .select({
      type: signalLog.type,
      source: signalLog.source,
      logged: sql<number>`count(*)::int`,
      evaluated: sql<number>`count(${signalLog.evaluatedAt})::int`,
      held: sql<number>`count(*) filter (where ${signalLog.outcome} = 'held')::int`,
      beaten: sql<number>`count(*) filter (where ${signalLog.outcome} = 'beaten')::int`,
      unknown: sql<number>`count(*) filter (where ${signalLog.outcome} = 'unknown')::int`,
      gainSum: sql<string | null>`sum(${signalLog.gainUsd}) filter (where ${signalLog.outcome} in ('held', 'beaten'))`,
    })
    .from(signalLog)
    .where(
      window === undefined
        ? undefined
        : and(
            gte(signalLog.firstSeenAt, new Date(`${window.from}T00:00:00.000Z`)),
            lte(signalLog.firstSeenAt, new Date(`${window.to}T23:59:59.999Z`)),
          ),
    )
    .groupBy(signalLog.type, signalLog.source);
  const row = (type: string, source: string | null, g: Array<(typeof grouped)[number]>): ReliabilityRow => {
    const sum = (k: "logged" | "evaluated" | "held" | "beaten" | "unknown") => g.reduce((n, r) => n + r[k], 0);
    const held = sum("held");
    const beatenN = sum("beaten");
    const judged = held + beatenN;
    const gain = g.reduce((n, r) => n + (r.gainSum === null ? 0 : Number(r.gainSum)), 0);
    return {
      type: type as SignalType,
      source,
      logged: sum("logged"),
      evaluated: sum("evaluated"),
      held,
      beaten: beatenN,
      unknown: sum("unknown"),
      heldPct: judged >= MIN_EVALUATED ? Math.round((held / judged) * 1000) / 10 : null,
      meanGainUsd: judged > 0 ? Math.round((gain / judged) * 100) / 100 : null,
    };
  };
  const out: ReliabilityRow[] = [];
  for (const type of [...new Set(grouped.map((g) => g.type))].sort()) {
    const ofType = grouped.filter((g) => g.type === type);
    out.push(row(type, null, ofType));
    for (const g of ofType) out.push(row(type, g.source, [g]));
  }
  return out;
}
