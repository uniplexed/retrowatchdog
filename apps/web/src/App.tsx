import { useEffect, useRef, useState } from "react";
import type { GameSummary } from "@retrowatchdog/shared";
import { SearchScreen } from "./screens/SearchScreen.js";
import { GameDetail } from "./screens/GameDetail.js";
import { CollectionScreen } from "./screens/CollectionScreen.js";
import { WatchlistScreen } from "./screens/WatchlistScreen.js";
import { SettingsScreen } from "./screens/SettingsScreen.js";
import { DashboardScreen } from "./screens/DashboardScreen.js";
import { InsightsScreen } from "./screens/InsightsScreen.js";
import type { HelpTopic } from "./lib/help.js";
import { GlobalSearch } from "./components/GlobalSearch.js";
import { getPlugins } from "./api/plugins.js";
import { pluginsLine } from "./lib/dashboard.js";
import { AppShell, type ShellTab } from "./ui/AppShell.js";
import type { Notice } from "./ui/StatusBand.js";
import { loadDisplayCurrency, useMoney } from "./lib/money.js";
import { loadSources, useSources } from "./lib/sources.js";
import { DESKTOP_QUERY, useViewport } from "./lib/viewport.js";

// the tab a game was opened from, so Back returns there
type GameOrigin = "dashboard" | "insights" | "search" | "collection" | "watchlist" | "settings";

type View =
  | { screen: "dashboard" }
  | { screen: "insights" }
  | { screen: "search" }
  | { screen: "game"; game: GameSummary; from: GameOrigin }
  | { screen: "collection" }
  | { screen: "watchlist" }
  | { screen: "settings" };

const SIMPLE_SCREENS = ["dashboard", "insights", "search", "collection", "watchlist", "settings"] as const;

function isGameOrigin(value: unknown): value is GameOrigin {
  return (
    value === "dashboard" || value === "insights" || value === "search" || value === "collection" || value === "watchlist" || value === "settings"
  );
}

// Validates a `history.state` payload back into a View; anything else falls
// back to the search screen.
function coerceHistoryState(state: unknown): View {
  if (state && typeof state === "object") {
    const candidate = state as Record<string, unknown>;
    if ((SIMPLE_SCREENS as readonly unknown[]).includes(candidate.screen)) {
      return { screen: candidate.screen as (typeof SIMPLE_SCREENS)[number] };
    }
    if (candidate.screen === "game" && candidate.game && typeof candidate.game === "object") {
      const game = candidate.game as Record<string, unknown>;
      if (typeof game.id === "number" && isGameOrigin(candidate.from)) {
        return { screen: "game", game: game as unknown as GameSummary, from: candidate.from };
      }
    }
  }
  return { screen: "search" };
}

// "The same place" for history: repeated taps on the active tab must not
// grow history.
function isSameNav(a: View, b: View): boolean {
  if (a.screen !== b.screen) return false;
  if (a.screen === "game" && b.screen === "game") {
    return a.game.id === b.game.id && a.from === b.from;
  }
  return true;
}

const PAGE_TITLES: Record<ShellTab, string> = {
  dashboard: "Dashboard",
  insights: "Insights",
  search: "Search",
  watchlist: "Watchlist",
  collection: "Collection",
  settings: "Settings",
};

/** the desktop opens on the dashboard; the phone has none */
const initialView = (): View =>
  typeof window.matchMedia === "function" && window.matchMedia(DESKTOP_QUERY).matches
    ? { screen: "dashboard" }
    : { screen: "search" };

// no JSX.Element return types: the global JSX namespace is gone in @types/react 19
export function App() {
  const [view, setView] = useState<View>(initialView);
  const desktop = useViewport() === "desktop";

  // --- Browser-history sync -------------------------------------------
  // No router: `view` is the source of truth, mirrored into `history.state`
  // so the phone's Back gesture stays in the app. First mount replaces, every
  // other navigation pushes; `isSyncingFromHistoryRef` stops a popstate
  // restore from pushing a second entry. `view.game` is stored whole — store
  // just the id if GameSummary ever grows heavy.
  const isFirstRenderRef = useRef(true);
  const isSyncingFromHistoryRef = useRef(false);
  // entries pushed and not yet popped: only guards goBack's deep-start fallback
  const historyDepthRef = useRef(0);

  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      history.replaceState(view, "");
      return;
    }
    if (isSyncingFromHistoryRef.current) {
      isSyncingFromHistoryRef.current = false;
      return;
    }
    history.pushState(view, "");
    historyDepthRef.current += 1;
  }, [view]);

  useEffect(() => {
    function onPopState(event: PopStateEvent) {
      historyDepthRef.current = Math.max(0, historyDepthRef.current - 1);
      isSyncingFromHistoryRef.current = true;
      setView(coerceHistoryState(event.state));
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function navigate(next: View) {
    setView((current) => (isSameNav(current, next) ? current : next));
  }

  function goBack() {
    if (view.screen !== "game") return;
    if (historyDepthRef.current > 0) {
      history.back();
    } else {
      // Deep-start fallback: no history entry behind us to go back to.
      navigate({ screen: view.from });
    }
  }
  // --- end browser-history sync ----------------------------------------

  // the dashboard is desktop-only: on a phone width (restored, or after the
  // window shrank) its view shows Search instead
  const screenOf = (s: View["screen"] | GameOrigin): View["screen"] => (s === "dashboard" && !desktop ? "search" : s);
  const screen = screenOf(view.screen);
  const activeTab = (view.screen === "game" ? screenOf(view.from) : screen) as ShellTab;
  const title = view.screen === "game" ? view.game.title : PAGE_TITLES[activeTab];
  // root subscription: a currency or rate change re-renders every formatMoney
  useMoney();
  // root subscription so a failed registry load is visible on EVERY tab
  const sources = useSources();
  useEffect(() => {
    void loadDisplayCurrency();
    // never rejects: retries itself (RETRY_DELAYS_MS), then the banner below
    void loadSources();
  }, []);
  // One status band for app-wide problems. No notice for `loading`: one
  // flashing on every cold start would train the user to ignore this one.
  const notices: Notice[] =
    sources.status === "failed"
      ? [
          {
            id: "sources",
            text: "Source details unavailable — prices are hidden on the game view and sources show as raw ids.",
            action: { label: "Retry sources", onClick: () => void loadSources() },
          },
        ]
      : [];
  // plugin health for the desktop footer, read again whenever the source
  // registry reloads (every plugin change reloads it); a failed read keeps the last line
  const [plugins, setPlugins] = useState<string | null>(null);
  useEffect(() => {
    if (!desktop) return;
    getPlugins().then((r) => setPlugins(pluginsLine(r.plugins)), () => {});
  }, [desktop, sources]);
  const footer =
    sources.status === "ready"
      ? [`${sources.list.length} markets`, plugins].filter((x) => x !== null).join(" · ")
      : undefined;
  return (
    <AppShell
      title={title}
      info={view.screen === "game" ? undefined : (`page.${activeTab}` as HelpTopic)}
      search={<GlobalSearch onSelect={(game) => navigate({ screen: "game", game, from: activeTab })} />}
      active={activeTab}
      onNavigate={(tab: ShellTab) => navigate({ screen: tab })}
      notices={notices}
      footer={footer}
    >
      {screen === "dashboard" && (
        <DashboardScreen
          onOpenGame={(game) => navigate({ screen: "game", game, from: "dashboard" })}
          onNavigate={(tab) => navigate({ screen: tab })}
        />
      )}
      {screen === "insights" && (
        <InsightsScreen
          onOpenGame={(game) => navigate({ screen: "game", game, from: "insights" })}
          onNavigate={(tab) => navigate({ screen: tab })}
        />
      )}
      {screen === "search" && (
        <SearchScreen
          onSelect={(game) => navigate({ screen: "game", game, from: "search" })}
          onOpenWatchlist={() => navigate({ screen: "watchlist" })}
        />
      )}
      {view.screen === "game" && <GameDetail game={view.game} onBack={goBack} />}
      {screen === "collection" && (
        <CollectionScreen
          onSelect={(game) => navigate({ screen: "game", game, from: "collection" })}
        />
      )}
      {screen === "watchlist" && (
        <WatchlistScreen
          onSelect={(game) => navigate({ screen: "game", game, from: "watchlist" })}
        />
      )}
      {screen === "settings" && <SettingsScreen />}
    </AppShell>
  );
}
