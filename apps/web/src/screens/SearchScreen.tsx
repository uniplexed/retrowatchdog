import { useEffect, useState } from "react";
import { PLATFORMS, type GameSummary, type Recommendation } from "@retrowatchdog/shared";
import { getInsights, getWatchlist } from "../api/client.js";
import { RecommendationRow } from "../components/RecommendationRow.js";
import { groupRecommendations } from "../lib/insights.js";
import { watchesWithSignals } from "../lib/dashboard.js";
import { useGameSearch } from "../lib/gameSearch.js";
import { loadRecent } from "../lib/recentGames.js";
import { useViewport } from "../lib/viewport.js";
import { Panel, Row, Sheet } from "../ui/index.js";

const consoleLine = (game: GameSummary): string =>
  `${PLATFORMS[game.platform].label}${game.year ? ` · ${game.year}` : ""}`;

export function SearchScreen({
  onSelect,
  onOpenWatchlist,
}: {
  onSelect: (game: GameSummary) => void;
  /** the phone's "Today" line opens the watchlist */
  onOpenWatchlist?: () => void;
}) {
  const [query, setQuery] = useState("");
  const { results, error } = useGameSearch(query);
  const [recent] = useState(loadRecent);
  const phone = useViewport() === "mobile";
  // the phone has no dashboard: its one line of it lives here
  const [today, setToday] = useState<string | null>(null);
  // keyed on whether there is a watchlist to open, never on the callback's
  // identity: App passes a new arrow on every render
  const canOpenWatchlist = onOpenWatchlist !== undefined;
  useEffect(() => {
    if (!phone || !canOpenWatchlist) return;
    getWatchlist()
      .then((w) => setToday(`Today: ${watchesWithSignals(w.items)} of ${w.items.length} watches have a bark (signal)`))
      .catch(() => setToday(null));
  }, [phone, canOpenWatchlist]);
  // the phone's recommended actions: the high money actions, in a sheet
  const [doNext, setDoNext] = useState<Recommendation[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => {
    if (!phone) return;
    getInsights()
      .then((r) => setDoNext(groupRecommendations(Array.isArray(r?.recommendations) ? r.recommendations : []).money.high))
      .catch(() => setDoNext([]));
  }, [phone]);

  const searching = query.trim().length >= 2;
  return (
    <div>
      <input
        className="search-input"
        placeholder="Search a game…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      {error && <p className="source-note">{error}</p>}
      {searching ? (
        results.map((game) => (
          <Row key={game.id} cover={game.coverUrl} title={game.title} meta={consoleLine(game)} onClick={() => onSelect(game)} />
        ))
      ) : (
        <>
          {/* phone only, even after the window grows past the phone width */}
          {phone && today !== null && onOpenWatchlist !== undefined && (
            <button type="button" className="today-line" onClick={onOpenWatchlist}>
              {today}
            </button>
          )}
          {phone && doNext.length > 0 && (
            <button type="button" className="today-line" onClick={() => setSheetOpen(true)}>
              Recommended actions: {doNext.length}
            </button>
          )}
          {recent.length > 0 && (
            <Panel title="Recent" info="search.recent">
              {recent.map((r) => (
                <Row
                  key={r.game.id}
                  cover={r.game.coverUrl}
                  title={r.game.title}
                  meta={r.verdictTitle ?? consoleLine(r.game)}
                  onClick={() => onSelect(r.game)}
                />
              ))}
            </Panel>
          )}
        </>
      )}
      <Sheet open={phone && sheetOpen} title="Recommended actions" onClose={() => setSheetOpen(false)}>
        {doNext.map((r) => (
          <RecommendationRow
            key={`${r.action}|${r.title}`}
            rec={r}
            onOpenGame={(game) => {
              setSheetOpen(false);
              onSelect(game);
            }}
            onNavigate={(tab) => {
              setSheetOpen(false);
              if (tab === "watchlist") onOpenWatchlist?.();
            }}
          />
        ))}
      </Sheet>
    </div>
  );
}
