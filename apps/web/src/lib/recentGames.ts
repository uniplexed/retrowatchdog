import type { GameSummary } from "@retrowatchdog/shared";

/** A game opened lately, with the verdict line it had then (null when none). */
export interface RecentGame {
  game: GameSummary;
  verdictTitle: string | null;
  at: string;
}

const KEY = "recentGames";
const KEEP = 8;

const isRecent = (x: unknown): x is RecentGame => {
  const r = x as RecentGame | null;
  return (
    typeof r?.game?.id === "number" &&
    typeof r.game.title === "string" &&
    (r.game.coverUrl == null || (typeof r.game.coverUrl === "string" && /^https?:\/\//.test(r.game.coverUrl)))
  );
};

/** Newest first; anything unreadable is dropped, never thrown. */
export function loadRecent(): RecentGame[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isRecent).slice(0, KEEP) : [];
  } catch {
    return [];
  }
}

function save(list: RecentGame[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // storage blocked: Recent stays as it was
  }
}

/**
 * Puts a game first, once, keeping the newest eight. `undefined` records the
 * visit and keeps the verdict line the game had (a filtered view's verdict is
 * about a slice, not the game).
 */
export function rememberGame(game: GameSummary, verdictTitle: string | null | undefined): void {
  const recent = loadRecent();
  const kept = recent.find((r) => r.game.id === game.id)?.verdictTitle ?? null;
  save(
    [
      { game, verdictTitle: verdictTitle === undefined ? kept : verdictTitle, at: new Date().toISOString() },
      ...recent.filter((r) => r.game.id !== game.id),
    ].slice(0, KEEP),
  );
}

/** Drops a game the server no longer has. */
export function forgetGame(id: number): void {
  save(loadRecent().filter((r) => r.game.id !== id));
}
