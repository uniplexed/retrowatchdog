import { useEffect, useState } from "react";
import {
  verdictTitle,
  type CollectionHistoryResponse,
  type CollectionResponse,
  type GameSummary,
  type InsightsResponse,
  type PluginDto,
  type Signal,
  type WatchlistResponse,
} from "@retrowatchdog/shared";
import { getCollection, getCollectionHistory, getInsights, getWatchlist } from "../api/client.js";
import { RecommendationRow } from "../components/RecommendationRow.js";
import { groupRecommendations } from "../lib/insights.js";
import { getPlugins } from "../api/plugins.js";
import { CollectionValueHistory } from "../components/CollectionValueHistory.js";
import { PeriodControl } from "../components/PeriodControl.js";
import { periodPhrase, resolvePeriod, usePeriod } from "../lib/period.js";
import { actOnToday, needsYou, valueDelta, watchesWithSignals } from "../lib/dashboard.js";
import { formatMoney, formatOriginal, useMoney } from "../lib/money.js";
import { sourceLabel, useSources } from "../lib/sources.js";
import { loadValuationBasis } from "../lib/valuationBasis.js";
import { loadValuationMarkets } from "../lib/valuationMarkets.js";
import { Button, Fold, InfoTip, KPI, Panel, Row } from "../ui/index.js";
import { saveSection } from "./SettingsScreen.js";
import type { ShellTab } from "../ui/AppShell.js";

/** each block renders from its own request: one failure never blanks the page */
type Loaded<T> = T | "error" | null;

const ok = <T,>(v: Loaded<T>): T | null => (v === null || v === "error" ? null : v);
const loadingNote = (v: Loaded<unknown>): string => (v === "error" ? "Could not load this." : "Loading…");

const DO_NEXT_MAX = 10;

/** Desktop only: the collection's numbers, what to act on today, and what waits on you. */
export function DashboardScreen({
  onOpenGame,
  onNavigate,
}: {
  onOpenGame: (game: GameSummary) => void;
  onNavigate: (tab: ShellTab) => void;
}) {
  const money = useMoney();
  const sources = useSources();
  const [basis] = useState(loadValuationBasis);
  const [markets] = useState(loadValuationMarkets);
  const [collection, setCollection] = useState<Loaded<CollectionResponse>>(null);
  const [history, setHistory] = useState<Loaded<CollectionHistoryResponse>>(null);
  const [watchlist, setWatchlist] = useState<Loaded<WatchlistResponse>>(null);
  const [plugins, setPlugins] = useState<Loaded<PluginDto[]>>(null);
  const [insights, setInsights] = useState<Loaded<InsightsResponse>>(null);
  const period = usePeriod();
  const { from, to } = resolvePeriod(period);

  useEffect(() => {
    getCollection(basis, markets).then(setCollection, () => setCollection("error"));
    getWatchlist().then(setWatchlist, () => setWatchlist("error"));
    getPlugins().then((r) => setPlugins(r.plugins), () => setPlugins("error"));
    getInsights().then(setInsights, () => setInsights("error"));
  }, [basis, markets]);
  useEffect(() => {
    getCollectionHistory(basis, markets, { from, to }).then(setHistory, () => setHistory("error"));
  }, [basis, markets, from, to]);

  const coll = ok(collection);
  const watches = ok(watchlist);
  const points = ok(history)?.points;
  const label = (s: Signal): string =>
    verdictTitle(s, (id) => sourceLabel(id, sources), (a) => formatOriginal(a.original, a.currency));
  const rows = actOnToday(watches?.items ?? [], coll?.items ?? [], label);
  const delta = points === undefined ? null : valueDelta(points);
  const todo = needsYou(ok(plugins), coll?.items ?? [], money);
  const actPending = watches === null && coll === null;
  const groups = groupRecommendations(ok(insights)?.recommendations ?? []);
  // the subjects a money recommendation already speaks for, in actOnToday's key shape
  const recommended = new Set(
    groups.money.high.map((r) => (r.subject.kind === "watch" ? `w:${r.subject.watchId}` : r.subject.kind === "copy" ? `c:${r.subject.copyId}` : "")),
  );
  const recRow = (r: InsightsResponse["recommendations"][number]) => (
    <RecommendationRow key={`${r.action}|${r.title}`} rec={r} onOpenGame={onOpenGame} onNavigate={onNavigate} />
  );

  return (
    <div className="dashboard">
      <PeriodControl />
      <div className="dash-kpis">
        <KPI
          label="Collection value"
          info="kpi.value"
          value={coll ? formatMoney(coll.totalEstimatedUsd) : "—"}
          delta={
            delta === null
              ? undefined
              : // a cent either way is no change worth a sign
                Math.abs(delta) < 0.005
                ? `No change ${periodPhrase(period)}`
                : `${delta > 0 ? "+" : "−"}${formatMoney(Math.abs(delta))} ${periodPhrase(period)}`
          }
          onClick={() => onNavigate("collection")}
        />
        <KPI label="Paid" info="kpi.paid" value={coll ? formatMoney(coll.totalPaidUsd) : "—"} onClick={() => onNavigate("collection")} />
        <KPI
          label="Realized"
          info="kpi.realized"
          value={coll ? formatMoney(coll.totalRealizedUsd) : "—"}
          onClick={() => onNavigate("collection")}
        />
        <KPI
          label="Barks (Signals)"
          info="kpi.signals"
          value={watches ? watchesWithSignals(watches.items) : "—"}
          delta={watches ? `of ${watches.items.length} watches` : undefined}
          onClick={() => onNavigate("watchlist")}
        />
      </div>
      <div className="dash-grid">
        <div className="dash-main">
          <Panel
            title="Recommended actions"
            info="panel.recommended"
            action={
              <Button variant="ghost" size="sm" onClick={() => onNavigate("insights")}>
                All →
              </Button>
            }
          >
            {insights === "error" && <p className="source-note">Could not load the recommendations.</p>}
            {insights === null && actPending ? (
              <p className="source-note">Loading…</p>
            ) : (
              <>
                {groups.money.high.slice(0, DO_NEXT_MAX).map(recRow)}
                {/* today's good prices, minus the watches and copies a recommendation already covers */}
                {rows
                  .filter((r) => !recommended.has(r.key))
                  .map((r) => {
                    const price = r.verdict.signal.price;
                    return (
                      <Row
                        key={r.key}
                        cover={r.game.coverUrl}
                        title={
                          <>
                            {r.game.title} <span className="meta">{r.verdict.title}</span>
                          </>
                        }
                        meta={r.meta}
                        right={price === undefined ? undefined : formatOriginal(price.original, price.currency)}
                        onClick={() => onOpenGame(r.game)}
                      />
                    );
                  })}
                {groups.money.high.length === 0 && rows.length === 0 && insights !== null && !actPending && (
                  <p className="source-note">Nothing to do right now.</p>
                )}
                <p className="source-note legal-note">
                  Automatic suggestions from the prices stored here, not financial advice. Check the source before you act.
                </p>
                {groups.money.potential.length > 0 && (
                  <Fold summary={<>{groups.money.potential.length} possible <InfoTip topic="fold.possible" /></>}>{groups.money.potential.map(recRow)}</Fold>
                )}
                {groups.cleanUp.length > 0 && <Fold summary={<>Clean up ({groups.cleanUp.length}) <InfoTip topic="fold.cleanUp" /></>}>{groups.cleanUp.map(recRow)}</Fold>}
                {groups.sources.length > 0 && <Fold summary={<>Best sources ({groups.sources.length}) <InfoTip topic="fold.sources" /></>}>{groups.sources.map(recRow)}</Fold>}
              </>
            )}
          </Panel>
        </div>
        <div className="dash-side">
          <Panel title="Needs you" info="panel.needsYou">
            {todo.length === 0 ? (
              // "nothing" is a claim: only once the requests it rests on have answered
              <p className="source-note">{collection === null || plugins === null ? "Loading…" : "Nothing needs you."}</p>
            ) : (
              <ul className="dash-todo">
                {todo.map((t) => (
                  <li key={t.key}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (t.section !== undefined) saveSection(t.section);
                        onNavigate(t.target);
                      }}
                    >
                      {t.text}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel>
            <CollectionValueHistory basis={basis} markets={markets} defaultOpen />
          </Panel>
        </div>
      </div>
    </div>
  );
}
