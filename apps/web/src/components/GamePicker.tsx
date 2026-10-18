import { useEffect, useState } from "react";
import type { GameSummary, Platform } from "@retrowatchdog/shared";
import { PLATFORMS } from "@retrowatchdog/shared";
import { searchGames } from "../api/client.js";

/**
 * Console + game picker with a debounced catalog search (which can pull a
 * missing game in from IGDB). Cross-platform picks are deliberate.
 */
export function GamePicker({
  defaultPlatform,
  onPick,
}: {
  defaultPlatform: Platform | null;
  onPick: (game: GameSummary) => void;
}) {
  const platformIds = Object.keys(PLATFORMS) as Platform[];
  const [platform, setPlatform] = useState<Platform>(defaultPlatform ?? platformIds[0]);
  const [query, setQuery] = useState("");
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

  // hide games on other consoles; changing the select re-filters live
  const visible = results.filter((g) => g.platform === platform).slice(0, 8);

  return (
    <div>
      <label className="source-note">
        Console{" "}
        <select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
          {platformIds.map((p) => (
            <option key={p} value={p}>
              {PLATFORMS[p].label}
            </option>
          ))}
        </select>
      </label>{" "}
      <input
        aria-label="Search game"
        placeholder="Search the catalog…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && <p className="source-note">{error}</p>}
      {visible.map((g) => (
        <div key={g.id}>
          <button onClick={() => onPick(g)}>
            {g.title} <span className="meta">({PLATFORMS[g.platform].label})</span>
          </button>
        </div>
      ))}
    </div>
  );
}
