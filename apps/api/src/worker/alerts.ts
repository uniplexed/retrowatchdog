import { and, inArray, like, notInArray, notLike } from "drizzle-orm";
import { fetch } from "undici";
import type { CollectionResponse, InsightsResponse, Recommendation, Signal, SignalConfigDto, SignalType, WatchlistResponse } from "@retrowatchdog/shared";
import { isHigh } from "@retrowatchdog/shared";
import type { Db } from "../db/index.js";
import { alertsSent } from "../db/schema.js";

/**
 * Phone notification (ntfy) when a signal APPEARS on a watched game. Not web
 * push: that needs HTTPS, and the app is served over plain LAN http.
 *
 * Off unless `NTFY_TOPIC` is set; on public ntfy.sh the topic name IS the
 * secret. Signals come from `GET /api/watchlist` itself, so an alert never
 * says something the screen does not show.
 */

/** The signal types worth interrupting someone for: a price to act on. */
const ACTIONABLE: ReadonlySet<SignalType> = new Set<SignalType>([
  "UNDERPRICED",
  "FLIP",
  "PROFIT",
  "TARGET_HIT",
  "BACK_IN_STOCK",
  "PRICE_DROP",
  "NEW_LOW",
]);

/** Per run, then one summary: the first run finds every standing signal "new". */
const MAX_PER_RUN = 5;

/** One notification. `url` is where a tap should land, when there is one. */
export interface Alert {
  title: string;
  message: string;
  url?: string;
}

export type AlertSender = (alert: Alert) => Promise<void>;

/**
 * "The same signal": watch, type, sources, instrument and listing URL, but
 * NOT the price (a penny move is not news). The URL keeps a new cheaper
 * listing from hiding behind a standing one; measured stable (14 extra URLs
 * in 1,957 eBay listings over three days).
 */
export function alertKey(watchId: number, signal: Signal): string {
  return [
    watchId,
    signal.type,
    signal.source ?? "",
    signal.buySource ?? "",
    signal.sellSource ?? "",
    signal.sellKind ?? "",
    signal.url ?? "",
  ].join("|");
}

/**
 * Sends the watchlist's NEW actionable signals, and forgets the ones that are
 * gone so they alert again if they come back. Send first, record second: a
 * crash duplicates an alert rather than losing it.
 */
export async function runWatchlistAlerts(
  db: Db,
  deps: { fetchWatchlist: () => Promise<WatchlistResponse>; send: AlertSender; config: SignalConfigDto },
): Promise<{ current: number; sent: number }> {
  const { items } = await deps.fetchWatchlist();
  const current = new Map<string, Alert>();
  for (const item of items) {
    for (const signal of item.signals) {
      if (!ACTIONABLE.has(signal.type)) continue;
      // only what the screens lead with, unless the user asked for the rest too
      if (!isHigh(signal) && !deps.config.alertLowConfidence) continue;
      current.set(alertKey(item.id, signal), {
        title: `${item.game.title}: ${signal.type.replace(/_/g, " ").toLowerCase()}`,
        message: signal.reasoning,
        ...(signal.url === undefined ? {} : { url: signal.url }),
      });
    }
  }

  const keys = [...current.keys()];
  // the table also holds recommendation keys (REC_PREFIX): this run forgets only its own
  const own = notLike(alertsSent.key, `${REC_PREFIX}%`);
  if (keys.length === 0) {
    await db.delete(alertsSent).where(own);
    return { current: 0, sent: 0 };
  }
  await db.delete(alertsSent).where(and(own, notInArray(alertsSent.key, keys)));

  const known = new Set(
    (await db.select({ key: alertsSent.key }).from(alertsSent).where(inArray(alertsSent.key, keys))).map(
      (row) => row.key,
    ),
  );
  const fresh = keys.filter((key) => !known.has(key));

  let sent = 0;
  for (const key of fresh.slice(0, MAX_PER_RUN)) {
    await deps.send(current.get(key)!);
    await db.insert(alertsSent).values({ key }).onConflictDoNothing();
    sent += 1;
  }
  const rest = fresh.slice(MAX_PER_RUN);
  if (rest.length > 0) {
    await deps.send({
      title: "RetroWatchdog",
      message: `${rest.length} more new bark${rest.length === 1 ? "" : "s"} (signal${rest.length === 1 ? "" : "s"}) on your watchlist.`,
    });
    await db
      .insert(alertsSent)
      .values(rest.map((key) => ({ key })))
      .onConflictDoNothing();
    sent += 1;
  }
  return { current: keys.length, sent };
}

const REC_PREFIX = "rec|";
const ALERTED_ACTIONS = new Set(["sell_now", "buy_now"]);

/**
 * "The same recommendation": action and subject. Not `since`: it slides with
 * the rule's window, so it would re-alert a standing one every day. Going away
 * and coming back alerts again, because a run forgets keys no longer current.
 */
export function recommendationKey(r: Recommendation): string {
  const subject =
    r.subject.kind === "copy" ? `c${r.subject.copyId}` : r.subject.kind === "watch" ? `w${r.subject.watchId}` : r.subject.kind;
  return `${REC_PREFIX}${r.action}|${subject}`;
}

/**
 * Sends the NEW high-confidence sell-now and buy-now recommendations, with the
 * watchlist run's rules: send then record, MAX_PER_RUN then one summary, and
 * forget the ones that are gone (only recommendation keys).
 */
export async function runRecommendationAlerts(
  db: Db,
  deps: { fetchInsights: () => Promise<InsightsResponse>; send: AlertSender },
): Promise<{ current: number; sent: number }> {
  const { recommendations } = await deps.fetchInsights();
  const current = new Map<string, Alert>();
  for (const r of recommendations) {
    if (!ALERTED_ACTIONS.has(r.action) || r.confidence !== "high") continue;
    current.set(recommendationKey(r), { title: r.title, message: r.reason, ...(r.link === undefined ? {} : { url: r.link.url }) });
  }
  const keys = [...current.keys()];
  const own = like(alertsSent.key, `${REC_PREFIX}%`);
  await db.delete(alertsSent).where(keys.length === 0 ? own : and(own, notInArray(alertsSent.key, keys)));
  if (keys.length === 0) return { current: 0, sent: 0 };

  const known = new Set(
    (await db.select({ key: alertsSent.key }).from(alertsSent).where(inArray(alertsSent.key, keys))).map((row) => row.key),
  );
  const fresh = keys.filter((key) => !known.has(key));
  let sent = 0;
  for (const key of fresh.slice(0, MAX_PER_RUN)) {
    await deps.send(current.get(key)!);
    await db.insert(alertsSent).values({ key }).onConflictDoNothing();
    sent += 1;
  }
  const rest = fresh.slice(MAX_PER_RUN);
  if (rest.length > 0) {
    await deps.send({ title: "RetroWatchdog", message: `${rest.length} more thing${rest.length === 1 ? "" : "s"} to sell or buy.` });
    await db.insert(alertsSent).values(rest.map((key) => ({ key }))).onConflictDoNothing();
    sent += 1;
  }
  return { current: keys.length, sent };
}

export function insightsFrom(apiUrl: string): () => Promise<InsightsResponse> {
  return async () => {
    const res = await fetch(`${apiUrl}/api/insights`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`GET /api/insights answered HTTP ${res.status}`);
    return (await res.json()) as InsightsResponse;
  };
}

/** ntfy's JSON publish, not headers: a header title must be Latin-1 ("ポケモン" is not). */
export function ntfySender(baseUrl: string, topic: string): AlertSender {
  return async (alert) => {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic,
        title: alert.title,
        message: alert.message,
        tags: ["video_game"],
        ...(alert.url === undefined ? {} : { click: alert.url }),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`ntfy answered HTTP ${res.status}`);
  };
}

/** The watchlist exactly as the screen reads it, from the api next door. */
export function watchlistFrom(apiUrl: string): () => Promise<WatchlistResponse> {
  return async () => {
    const res = await fetch(`${apiUrl}/api/watchlist`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`GET /api/watchlist answered HTTP ${res.status}`);
    return (await res.json()) as WatchlistResponse;
  };
}


/** The collection exactly as the screen reads it (market basis, default markets), from the api next door. */
export function collectionFrom(apiUrl: string): () => Promise<CollectionResponse> {
  return async () => {
    const res = await fetch(`${apiUrl}/api/collection`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`GET /api/collection answered HTTP ${res.status}`);
    return (await res.json()) as CollectionResponse;
  };
}
