import { PLATFORMS, type GameSummary, type Platform, type Recommendation, type SourceId } from "@retrowatchdog/shared";
import type { SignalConfig } from "../signals/computeSignals.js";
import type { DayReading } from "./series.js";

type Pick = (r: DayReading) => SourceId | null;
const SIDES: Array<{ pick: Pick; verb: string }> = [
  { pick: (r) => r.cheapestSource, verb: "had the lowest price in" },
  { pick: (r) => r.bestBidSource, verb: "paid the most in" },
];

/**
 * prefer_source: per console, the source that most often had the cheapest
 * price (and, separately, the best bid) on the latest reading of each game.
 * Only once a console has minGamesPerConsole games and a source wins
 * sourceDominancePct of them.
 */
export function preferSource(
  games: Array<{ game: GameSummary; readings: DayReading[] }>,
  cfg: SignalConfig,
  labels: (id: SourceId) => string,
): Recommendation[] {
  const byPlatform = new Map<Platform, DayReading[][]>();
  for (const g of games) byPlatform.set(g.game.platform, [...(byPlatform.get(g.game.platform) ?? []), g.readings]);
  const out: Recommendation[] = [];
  for (const [platform, all] of byPlatform) {
    for (const { pick, verb } of SIDES) {
      const latest = all.map((rs) => [...rs].reverse().find((r) => pick(r) !== null)).filter((r): r is DayReading => r !== undefined);
      if (latest.length < cfg.minGamesPerConsole) continue;
      const wins = new Map<SourceId, number>();
      for (const r of latest) wins.set(pick(r)!, (wins.get(pick(r)!) ?? 0) + 1);
      const [source, count] = [...wins].sort((a, b) => b[1] - a[1])[0];
      if ((count / latest.length) * 100 < cfg.sourceDominancePct) continue;
      out.push({
        action: "prefer_source",
        subject: { kind: "console", platform },
        title: `On ${PLATFORMS[platform].label}, ${labels(source)} ${verb} ${count} of ${latest.length} games`,
        reason: `Based on the latest price of each ${PLATFORMS[platform].label} game you watch or own`,
        gainUsd: null,
        confidence: "high",
        since: latest.map((r) => r.day).sort()[0],
      });
    }
  }
  return out;
}
