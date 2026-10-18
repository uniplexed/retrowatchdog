import type { CollectionResponse, SourceInfo, WatchlistResponse } from "@retrowatchdog/shared";
import type { Db } from "../db/index.js";
import type { SignalConfig } from "../signals/computeSignals.js";
import { evaluateSignals, logKey, purgeSignalLog, recordSignals, type LoggedSignal } from "../signals/log.js";

/**
 * After a refresh: log every signal the watchlist and the active copies carry
 * (INSUFFICIENT_DATA is not advice and is skipped), judge the ones old enough,
 * and drop the ones past retention.
 */
export async function runSignalLogStep(
  db: Db,
  deps: {
    fetchWatchlist: () => Promise<WatchlistResponse>;
    fetchCollection: () => Promise<CollectionResponse>;
    registry: Record<string, SourceInfo>;
    config: SignalConfig;
  },
  now: Date = new Date(),
): Promise<{ recorded: number; evaluated: number; purged: number }> {
  const [watchlist, collection] = await Promise.all([deps.fetchWatchlist(), deps.fetchCollection()]);
  const items: LoggedSignal[] = [];
  for (const w of watchlist.items) {
    for (const signal of w.signals) {
      if (signal.type === "INSUFFICIENT_DATA") continue;
      items.push({ key: logKey("w", w.id, signal), gameId: w.game.id, watchId: w.id, region: w.region ?? "any", condition: w.condition ?? "any", signal });
    }
  }
  for (const c of collection.items) {
    if (c.status === "sold" || c.status === "returned") continue;
    for (const signal of c.signals) {
      if (signal.type === "INSUFFICIENT_DATA") continue;
      items.push({ key: logKey("c", c.id, signal), gameId: c.game.id, copyId: c.id, region: c.region, condition: c.condition, signal });
    }
  }
  const { inserted, refreshed } = await recordSignals(db, items, deps.config, now);
  const { evaluated } = await evaluateSignals(db, deps.registry, deps.config, now);
  const purged = await purgeSignalLog(db, deps.config, now);
  return { recorded: inserted + refreshed, evaluated, purged };
}
