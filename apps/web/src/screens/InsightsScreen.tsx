import { useEffect, useState } from "react";
import { ACTION_ORDER, PLATFORMS, type GameSummary, type InsightsResponse, type Platform, type Recommendation, type ReliabilityRow } from "@retrowatchdog/shared";
import { ListControls, type ControlGroupDef } from "../components/ListControls.js";
import { descNullsLast, loadStoredControls, saveStoredControls } from "../lib/listControls.js";
import { getInsights, getReliability } from "../api/client.js";
import { PeriodControl } from "../components/PeriodControl.js";
import { resolvePeriod, usePeriod } from "../lib/period.js";
import { CollectionValueHistory } from "../components/CollectionValueHistory.js";
import { RecommendationRow } from "../components/RecommendationRow.js";
import { WatchlistHistory } from "../components/WatchlistHistory.js";
import { ACTION_LABELS } from "../lib/insights.js";
import { SIGNAL_TYPE_INFO } from "../lib/signalTypes.js";
import { formatMoney, useMoney } from "../lib/money.js";
import { loadValuationBasis } from "../lib/valuationBasis.js";
import { loadValuationMarkets } from "../lib/valuationMarkets.js";
import { Fold, InfoTip, Panel } from "../ui/index.js";
import { actionTopic, signalTopic } from "../lib/help.js";
import type { ShellTab } from "../ui/AppShell.js";

export const HONESTY_LINE =
  "eBay and Vinted prices are asking prices, not sales: held means the price was not beaten, not that you could have bought at it.";

type RelKey = "type" | "logged" | "judged" | "held" | "gain";
const REL_COLUMNS: Array<{ key: RelKey; label: string }> = [
  { key: "type", label: "Type" },
  { key: "logged", label: "Logged" },
  { key: "judged", label: "Judged" },
  { key: "held", label: "Held" },
  { key: "gain", label: "Mean gain" },
];
const relValue = (r: ReliabilityRow, key: RelKey): number | string | null =>
  key === "type"
    ? `${SIGNAL_TYPE_INFO[r.type].label} ${r.source ?? ""}`
    : key === "logged"
      ? r.logged
      : key === "judged"
        ? r.held + r.beaten
        : key === "held"
          ? r.heldPct
          : r.meanGainUsd;

function ReliabilityTable({ rows }: { rows: ReliabilityRow[] }) {
  // the API's order until a header is clicked; the type column reads A-Z, a number high first; a second click flips it
  const [sort, setSort] = useState<{ key: RelKey; desc: boolean } | null>(null);
  const sorted = [...rows].sort((a, b) => {
    if (sort === null) return 0;
    const x = relValue(a, sort.key);
    const y = relValue(b, sort.key);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const c = typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number);
    return sort.desc ? -c : c;
  });
  const choose = (key: RelKey): void =>
    setSort((cur) => (cur?.key === key ? { key, desc: !cur.desc } : { key, desc: key !== "type" }));
  return (
    <table className="reliability">
      <thead>
        <tr>
          {REL_COLUMNS.map((c) => (
            <th key={c.key} aria-sort={sort?.key === c.key ? (sort.desc ? "descending" : "ascending") : undefined}>
              <button type="button" className="th-sort" onClick={() => choose(c.key)}>
                {c.label}
              </button>
              {sort?.key === c.key && <span aria-hidden="true">{sort.desc ? " ▾" : " ▴"}</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr key={`${r.type}|${r.source ?? ""}`}>
            <td>
              {SIGNAL_TYPE_INFO[r.type].label}
              <InfoTip topic={signalTopic(r.type)} />
              {r.source !== null && ` · ${r.source}`}
            </td>
            <td>{r.logged}</td>
            <td>{r.held + r.beaten}</td>
            <td>{r.heldPct === null ? "—" : `${r.heldPct}%`}</td>
            <td>{r.meanGainUsd === null ? "—" : formatMoney(r.meanGainUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type InsightsSort = "api" | "gain" | "title";
interface InsightsControls {
  sort: InsightsSort;
  console: string;
  confidence: string;
}
const DEFAULT_INSIGHTS_CONTROLS: InsightsControls = { sort: "api", console: "all", confidence: "all" };
const sanitizeInsightsControls = (raw: unknown): InsightsControls => {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    sort: r.sort === "gain" || r.sort === "title" ? r.sort : "api",
    console: typeof r.console === "string" ? r.console : "all",
    confidence: r.confidence === "high" || r.confidence === "potential" ? r.confidence : "all",
  };
};
const recConsole = (r: Recommendation): string | null =>
  r.subject.kind === "console" ? r.subject.platform : r.subject.kind === "signal_type" ? null : r.subject.game.platform;

/** Desktop only: every recommendation by action, how often signals held, and both price histories. */
export function InsightsScreen({
  onOpenGame,
  onNavigate,
}: {
  onOpenGame: (game: GameSummary) => void;
  onNavigate: (tab: ShellTab) => void;
}) {
  useMoney(); // re-render on a display-currency change
  const [data, setData] = useState<InsightsResponse | "error" | null>(null);
  const [basis] = useState(loadValuationBasis);
  const [markets] = useState(loadValuationMarkets);
  const [controls, setControls] = useState<InsightsControls>(() => loadStoredControls("insightsControls", sanitizeInsightsControls));
  const update = (patch: Partial<InsightsControls>): void => {
    const next = { ...controls, ...patch };
    setControls(next);
    saveStoredControls("insightsControls", next);
  };
  useEffect(() => {
    getInsights().then(setData, () => setData("error"));
  }, []);
  const { from, to } = resolvePeriod(usePeriod());
  const [reliability, setReliability] = useState<InsightsResponse["reliability"] | null>(null);
  useEffect(() => {
    let cancelled = false;
    getReliability({ from, to }).then(
      (r) => !cancelled && setReliability(r.reliability),
      () => !cancelled && setReliability(null),
    );
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  if (data === null || data === "error") {
    return <p className="source-note">{data === null ? "Loading…" : "Could not load insights."}</p>;
  }
  const row = (r: InsightsResponse["recommendations"][number]) => (
    <RecommendationRow key={`${r.action}|${r.title}`} rec={r} onOpenGame={onOpenGame} onNavigate={onNavigate} />
  );
  const consoles = [...new Set(data.recommendations.map(recConsole).filter((p): p is string => p !== null))].sort();
  const recs = data.recommendations
    .filter((r) => controls.console === "all" || recConsole(r) === controls.console)
    .filter((r) => controls.confidence === "all" || r.confidence === controls.confidence)
    .sort((a, b) =>
      controls.sort === "gain" ? descNullsLast(a.gainUsd, b.gainUsd) : controls.sort === "title" ? a.title.localeCompare(b.title) : 0,
    );
  const controlGroups: ControlGroupDef[] = [
    {
      id: "sort",
      label: "Sort",
      options: [
        { value: "api", label: "recommended order" },
        { value: "gain", label: "gain, high first" },
        { value: "title", label: "title A-Z" },
      ],
      value: controls.sort,
      defaultValue: "api",
      onChange: (v) => update({ sort: v as InsightsSort }),
    },
    ...(consoles.length > 1 || controls.console !== "all"
      ? [
          {
            id: "console",
            label: "Console",
            options: [{ value: "all", label: "all" }, ...consoles.map((p) => ({ value: p, label: PLATFORMS[p as Platform]?.label ?? p }))],
            value: controls.console,
            defaultValue: "all",
            onChange: (v: string) => update({ console: v }),
          },
        ]
      : []),
    {
      id: "confidence",
      label: "Confidence",
      options: ["all", "high", "potential"].map((v) => ({ value: v, label: v })),
      value: controls.confidence,
      defaultValue: "all",
      onChange: (v) => update({ confidence: v }),
    },
  ];
  // the period's table once it arrives; the all-time one meanwhile
  const shown = reliability ?? data.reliability;
  const aggregate = shown.filter((r) => r.source === null);
  const bySource = shown.filter((r) => r.source !== null);
  return (
    <div className="insights">
      <PeriodControl />
      <ListControls groups={controlGroups} onClear={() => update(DEFAULT_INSIGHTS_CONTROLS)} />
      {recs.length === 0 && <p className="source-note">Nothing to do right now.</p>}
      {ACTION_ORDER.map((action) => {
        const ofAction = recs.filter((r) => r.action === action);
        if (ofAction.length === 0) return null;
        const high = ofAction.filter((r) => r.confidence === "high");
        const potential = ofAction.filter((r) => r.confidence !== "high");
        return (
          <Panel key={action} title={`${ACTION_LABELS[action]} (${ofAction.length})`} info={actionTopic(action)}>
            {high.map(row)}
            {potential.length > 0 && <Fold summary={<>{potential.length} possible <InfoTip topic="fold.possible" /></>}>{potential.map(row)}</Fold>}
          </Panel>
        );
      })}
      <Panel title="Barks (Signals) reliability" info="panel.reliability">
        {data.measuredSince === null ? (
          <p className="source-note">Barks (signals) are being logged; the first are judged 14 days after they appear.</p>
        ) : (
          <>
            <p className="source-note">
              Barks (signals) first seen from {from} to {to}; measured since {new Date(data.measuredSince).toLocaleDateString()}
            </p>
            <ReliabilityTable rows={aggregate} />
            {bySource.length > 0 && (
              <Fold summary="By source">
                <ReliabilityTable rows={bySource} />
              </Fold>
            )}
          </>
        )}
        <p className="source-note">{HONESTY_LINE}</p>
      </Panel>
      <div className="insights-charts">
        <Panel>
          <WatchlistHistory defaultOpen />
        </Panel>
        <Panel>
          <CollectionValueHistory basis={basis} markets={markets} defaultOpen />
        </Panel>
      </div>
    </div>
  );
}
