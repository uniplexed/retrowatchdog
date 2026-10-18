import { useEffect, useState } from "react";
import type { GameSummary } from "@retrowatchdog/shared";
import { searchGames } from "../api/client.js";

/** Debounced game search: nothing under two characters, 300 ms after the last keystroke. */
export function useGameSearch(query: string): { results: GameSummary[]; error: string | null } {
  const [results, setResults] = useState<GameSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      searchGames(query.trim())
        .then((r) => {
          setResults(r.games);
          setError(null);
        })
        .catch(() => setError("Search failed — is the API running?"));
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  return { results, error };
}
