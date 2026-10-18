import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Recommendation,
  WatchlistItemDto,
  Condition,
  GameSummary,
  ItemGrade,
  OwnedCopyDto,
  PriceKind,
  PricePointDto,
  PricesResponse,
  Region,
  Signal,
  SignalAmount,
  SignalType,
  SourceId,
  SupportedCurrency,
} from "@retrowatchdog/shared";
import { CONDITIONS, kindDisplayLabel, pickVerdict, PLATFORMS, PROFIT_FEE_CAVEAT, verdictTitle } from "@retrowatchdog/shared";
import { addCopy, addWatch, deleteWatch, getCollection, getInsights, getPrices, getWatchlist, setGamePriceMode } from "../api/client.js";
import { subjectGame } from "../lib/insights.js";
import { CurrencyOptions } from "../components/CurrencySelector.js";
import { formatMoney, formatOriginal, loadLastPaidCurrency, saveLastPaidCurrency } from "../lib/money.js";
import { loadSources, sourceLabel as sourceLabelOf, useSources, type SourcesState } from "../lib/sources.js";
import { loadValuationBasis, valueBasisTag } from "../lib/valuationBasis.js";
import { loadValuationMarkets } from "../lib/valuationMarkets.js";
import { SignalBadge, profitInstrument } from "../components/SignalBadge.js";
import { FindingsDisclosure, SignalGroups } from "../components/SignalGroups.js";
import { sortByConfidence, type BestSide } from "../lib/signalGroups.js";
import { possibleCount, splitByConfidence } from "../lib/signalVisibility.js";
import { Button, Fold, InfoTip, Menu, Panel, Row, Segmented, Sheet } from "../ui/index.js";
import { forgetGame, rememberGame } from "../lib/recentGames.js";
import { Verdict } from "../ui/Verdict.js";
import { UnifiedPriceTable } from "../components/UnifiedPriceTable.js";
import { PriceHistory } from "../components/PriceHistory.js";
import { GradeSlider, gradeLabel } from "../components/GradeSlider.js";
import { CopyEditor, editCopyLabel } from "../components/CopyEditor.js";
import { bestBy } from "../lib/listControls.js";

const REGIONS: Array<Region | "all"> = ["all", "PAL", "NTSC_U", "NTSC_J"];

/** what the signals are judged for: any state, a watch's fixed state, or a copy's */
interface SignalScope {
  key: string;
  label: string;
  region: string | null;
  condition: string | null;
}
const ANY_SCOPE: SignalScope = { key: "any", label: "Any state", region: null, condition: null };
const scopeStorageKey = (gameId: number): string => `signalScope:${gameId}`;
function loadScopeKey(gameId: number): string | null {
  try {
    return window.localStorage.getItem(scopeStorageKey(gameId));
  } catch {
    return null;
  }
}
function saveScopeKey(gameId: number, key: string): void {
  try {
    window.localStorage.setItem(scopeStorageKey(gameId), key);
  } catch {
    // a convenience only: without storage the default applies next time
  }
}
/** "unknown" says nothing about a state, so it scopes nothing */
const known = (v: string | null): string | undefined => (v === null || v === "unknown" ? undefined : v);
// price-table chips: the tiers sources actually price (accessory-only tiers
// and unknown are reachable through "all")
const CONDITION_FILTERS: Array<Condition | "all"> = ["all", "loose", "boxed_no_manual", "cib", "new"];

/**
 * The "Watchdog barks" subsections, grouped by transaction direction.
 * OVERPRICED_STORE is sell-side pressure, so it sits under "Sell now".
 * `side`: "min"/"max" = one group per source headed by its best amount;
 * null = one flat section (a FLIP has no single `source` to group by).
 */
const SIGNAL_GROUPS: ReadonlyArray<{ type: SignalType; heading: string; side: BestSide | null }> = [
  { type: "TARGET_HIT", heading: "🎯 Target hit", side: "min" },
  { type: "UNDERPRICED", heading: "🛒 Buy now", side: "min" },
  { type: "FLIP", heading: "⇄ Buy to sell", side: null },
  { type: "PRICE_DROP", heading: "↓ Price drops", side: "min" },
  { type: "NEW_LOW", heading: "↓ New lows", side: "min" },
  { type: "BACK_IN_STOCK", heading: "↺ Back in stock", side: "min" },
  { type: "OVERPRICED_STORE", heading: "💰 Sell now", side: "max" },
];

/**
 * Every signal type the barks section renders. PROFIT is deliberately
 * absent: it is an owned copy's alert, shown on the collection and read by
 * the ownership panel, so here it is dropped.
 */
const BARK_TYPES: readonly SignalType[] = [...SIGNAL_GROUPS.map((g) => g.type), "INSUFFICIENT_DATA"];

/**
 * Best "what's it worth right now" figure for a copy, three rungs:
 * 1. the copy's best PROFIT signal (profitComparable);
 * 2. else the highest live bid-role point for this copy's exact
 *    region+condition, read from the UNFILTERED shop points so chips can't
 *    empty it; grade-aware;
 * 3. else the DTO's estimatedValueUsd, tagged with its basis.
 * Values are USD; labels always name the source or basis.
 *
 * Condition fail-safe: the bid match never widens to a neighbouring tier —
 * a boxed_no_manual copy must not borrow cib bids (CeX pays more for the
 * w/ Manual SKU). With nothing left it honestly shows "—".
 */
interface Comparable {
  value: number;
  label: string;
  /** the engine downgraded this reading: rendered with the ❓ marker */
  potential: boolean;
  /** caveats beside the marker (the fee caveat is already in the label) */
  notes: string[];
  /**
   * the engine's already-rounded gain, reused verbatim as the delta so it
   * never disagrees at a rounding boundary with the compact pill. Rung 1 only.
   */
  gainUsd?: number;
}

/**
 * Does this source both sell to you (`buy_store`) and buy from you (`bid`)?
 * Read from registry roles, never a source id. Only trustworthy once the
 * registry is `ready` — before that every source reads as one-sided, so the
 * price blocks are gated on the status.
 */
function hasBothTradeSides(id: SourceId, sources: SourcesState): boolean {
  const roles = Object.values(sources.byId[id]?.kindRoles ?? {});
  return roles.includes("buy_store") && roles.includes("bid");
}

/**
 * Every point of the two-sided shops: the pool rung 2 of comparableFor reads.
 * Deliberately NOT filtered by the Valuation-markets setting: rung 1 (PROFIT)
 * never is, so filtering rung 2 alone would make the same bid speak for one
 * copy and not another. Empty until the registry is `ready`; the panel then
 * falls to rungs 1/3, which are labelled server numbers.
 */
function tradeInPoints(blocks: PricesResponse["sources"], sources: SourcesState): PricePointDto[] {
  return blocks.filter((b) => hasBothTradeSides(b.source, sources)).flatMap((b) => b.points);
}

/**
 * Rung 1: the copy's best PROFIT signal, rendering the net reading the
 * engine compared (`Signal.price`) rather than reconstructing it from the
 * paid price and the gain. One PROFIT per (source, kind); the highest wins.
 * null when nothing can be read without inventing a number.
 */
function profitComparable(copy: OwnedCopyDto, sources: SourcesState): Comparable | null {
  if (copy.acquiredPriceUsd == null) return null;
  interface ProfitReading {
    source: SourceId;
    kind: PriceKind | undefined;
    /** the net sell-side reading the engine compared, in both spaces */
    price: SignalAmount;
    /** the engine's own already-rounded gain — see the Comparable field this becomes */
    gainUsd: number;
    afterFees: boolean;
    potential: boolean;
    notes: string[];
  }
  // Both price and gainUsd are required: a signal missing either is ignored,
  // never valued by reconstructing one from the other.
  const readings: ProfitReading[] = copy.signals.flatMap((s) =>
    s.type === "PROFIT" && s.sellSource !== undefined && s.price !== undefined && s.gainUsd !== undefined
      ? [
          {
            source: s.sellSource,
            kind: s.sellKind,
            price: s.price,
            gainUsd: s.gainUsd,
            afterFees: s.caveats?.includes(PROFIT_FEE_CAVEAT) ?? false,
            potential: s.confidence === "potential",
            notes: (s.caveats ?? []).filter((c) => c !== PROFIT_FEE_CAVEAT),
          },
        ]
      : [],
  );
  // one copy, one paid price: ranking on gainUsd equals ranking on price.usd
  const best = bestBy(readings, (r) => r.gainUsd);
  if (best === null) return null;
  const instrument = profitInstrument(best.source, best.kind, sources.byId);
  return {
    value: best.price.usd,
    label: `${sourceLabelOf(best.source, sources)}${instrument !== null ? ` ${instrument}` : ""} ${formatMoney(
      best.price.usd,
      { amount: best.price.original, currency: best.price.currency },
    )}${best.afterFees ? " (after fees)" : ""}`,
    potential: best.potential,
    notes: best.notes,
    gainUsd: best.gainUsd,
  };
}

function comparableFor(
  copy: OwnedCopyDto,
  shopPoints: PricePointDto[] | null,
  sources: SourcesState,
): Comparable | null {
  const profit = profitComparable(copy, sources);
  if (profit !== null) return profit;
  // a role, not an instrument: any `bid`-role kind is eligible, not only voucher
  const bids = (shopPoints ?? []).filter(
    (p) =>
      sources.byId[p.source]?.kindRoles[p.kind] === "bid" &&
      p.region === copy.region &&
      p.condition === copy.condition,
  );
  // Grade honesty: a graded SKU is only comparable to a copy of that grade (a
  // plain copy never inherits the mint premium); a graded copy falls back to
  // ungraded bids, never to a different grade.
  const grade = copy.itemGrade;
  const gradeMatched = grade === null ? [] : bids.filter((p) => p.grade === grade);
  const ungraded = bids.filter((p) => p.grade == null);
  const pool = gradeMatched.length > 0 ? gradeMatched : ungraded;
  // several bid kinds can match (cash and voucher): the highest wins
  const best = bestBy(pool, (p) => p.priceUsd);
  if (best !== null) {
    const gradeTag = gradeMatched.length > 0 && grade !== null ? ` (${gradeLabel(grade)})` : "";
    // kindDisplayLabel already names the shop; adding sourceLabelOf doubles it
    return {
      value: best.priceUsd,
      label: `${kindDisplayLabel(sources.byId, best.source, best.kind)}${gradeTag} ${formatMoney(best.priceUsd, {
        amount: best.priceOriginal,
        currency: best.currencyOriginal,
      })}`,
      potential: false,
      notes: [],
    };
  }
  if (copy.estimatedValueUsd != null) {
    const basis = valueBasisTag(copy.valueBasis, sources.byId) ?? "estimate";
    return {
      value: copy.estimatedValueUsd,
      label: `est. ${formatMoney(copy.estimatedValueUsd)} (${basis})`,
      potential: false,
      notes: [],
    };
  }
  return null;
}

export function GameDetail({ game, onBack }: { game: GameSummary; onBack: () => void }) {
  // every label, caveat and role on this screen comes from the registry
  const sources = useSources();
  const [data, setData] = useState<PricesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [region, setRegion] = useState<Region | "all">("all");
  const [condition, setCondition] = useState<Condition | "all">("all");
  const [ownOpen, setOwnOpen] = useState(false);
  const [ownRegion, setOwnRegion] = useState<Region>("PAL");
  const [ownCondition, setOwnCondition] = useState<Condition>("loose");
  // null until the user moves the slider — an untouched grade is never POSTed
  const [ownGrade, setOwnGrade] = useState<ItemGrade | null>(null);
  const [paid, setPaid] = useState("");
  // defaults to the user's last pick (initially GBP)
  const [paidCurrency, setPaidCurrency] = useState<SupportedCurrency>(loadLastPaidCurrency);
  const [notes, setNotes] = useState("");
  const [added, setAdded] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [copies, setCopies] = useState<OwnedCopyDto[]>([]);
  // the own-row whose CopyEditor is open; one at a time
  const [editingCopyId, setEditingCopyId] = useState<number | null>(null);
  // this game's watches: the Watch button's state, and the fixed ones for the signal scope
  const [gameWatches, setGameWatches] = useState<WatchlistItemDto[]>([]);
  const [watchesLoaded, setWatchesLoaded] = useState(false);
  useEffect(() => {
    setWatchesLoaded(false);
    getWatchlist()
      .then((w) => {
        const mine = w.items.filter((i) => i.game.id === game.id);
        setGameWatches(mine);
      })
      .catch(() => {})
      .finally(() => setWatchesLoaded(true));
  }, [game.id]);
  // this game's first recommendation, if any; a failure shows nothing extra
  const [rec, setRec] = useState<Recommendation | null>(null);
  useEffect(() => {
    let cancelled = false;
    setRec(null);
    getInsights()
      .then((r) => {
        if (cancelled) return;
        const mine = (Array.isArray(r?.recommendations) ? r.recommendations : []).filter((x) => subjectGame(x)?.id === game.id);
        // the visibility rule: a high one leads even when a potential one comes first in the API's order
        setRec(mine.find((x) => x.confidence === "high") ?? mine[0] ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [game.id]);
  const [copiesLoaded, setCopiesLoaded] = useState(false);
  const loadCopies = useCallback((): void => {
    // the same persisted basis AND markets as the collection screen, so rung 3
    // shows the number the list shows
    getCollection(loadValuationBasis(), loadValuationMarkets())
      .then((c) =>
        setCopies(
          c.items.filter(
            (i) => i.game.id === game.id && i.status !== "sold" && i.status !== "returned",
          ),
        ),
      )
      .catch(() => {})
      .finally(() => setCopiesLoaded(true));
  }, [game.id]);
  useEffect(loadCopies, [loadCopies]);

  // the signal scope: any state, or a watch's or a copy's; remembered per title
  const scopes = useMemo<SignalScope[]>(
    () => [
      ANY_SCOPE,
      ...gameWatches
        .filter((w) => w.region !== null || w.condition !== null)
        .map((w) => ({ key: `w:${w.id}`, label: `Watch · ${w.region ?? "any"} · ${w.condition ?? "any"}`, region: w.region, condition: w.condition })),
      ...copies.map((c) => ({ key: `c:${c.id}`, label: `Your copy · ${c.region} · ${c.condition}`, region: c.region, condition: c.condition })),
    ],
    [gameWatches, copies],
  );
  const [chosenScope, setChosenScope] = useState<string | null>(() => loadScopeKey(game.id));
  useEffect(() => setChosenScope(loadScopeKey(game.id)), [game.id]);
  // a stored choice that no longer exists falls back to the default: the first watch, then the first copy
  const scope = scopes.find((x) => x.key === chosenScope) ?? scopes[1] ?? ANY_SCOPE;
  const scopeReady = watchesLoaded && copiesLoaded;

  // the history needs one concrete state: the filters', else the signal scope's, else the most priced one
  const historySlice = useMemo(() => {
    const wantRegion = region !== "all" ? region : known(scope.region);
    const wantCondition = condition !== "all" ? condition : known(scope.condition);
    const counts = new Map<string, number>();
    for (const p of (data?.sources ?? []).flatMap((b) => b.points)) {
      if (p.region === "unknown" || p.condition === "unknown") continue;
      if (wantRegion !== undefined && p.region !== wantRegion) continue;
      if (wantCondition !== undefined && p.condition !== wantCondition) continue;
      const key = `${p.region}|${p.condition}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0].split("|");
    return {
      region: (wantRegion ?? best?.[0] ?? "all") as Region | "all",
      condition: (wantCondition ?? best?.[1] ?? "all") as Condition | "all",
    };
  }, [data, region, condition, scope.region, scope.condition]);

  // the Watch button speaks for the state the filters show: one watch per state
  const watchState = `${region === "all" ? "any" : region} · ${condition === "all" ? "any" : condition}`;
  const watchHere = gameWatches.find((w) => (w.region ?? "all") === region && (w.condition ?? "all") === condition) ?? null;
  const toggleWatch = async (): Promise<void> => {
    if (watchHere !== null) {
      await deleteWatch(watchHere.id);
      setGameWatches((ws) => ws.filter((w) => w.id !== watchHere.id));
    } else {
      const { id } = await addWatch({
        gameId: game.id,
        ...(region === "all" ? {} : { region }),
        ...(condition === "all" ? {} : { condition }),
      });
      // enough of a row for the button and the scope; the Watchlist screen reads the full one
      setGameWatches((ws) => [
        ...ws,
        { id, game, region: region === "all" ? null : region, condition: condition === "all" ? null : condition } as WatchlistItemDto,
      ]);
    }
  };

  const requestSeq = useRef(0);
  // Price blocks from the last UNFILTERED load: the ownership panel reads
  // these, never the chip-filtered `data`. A ref is enough — it changes
  // alongside setData. Whole blocks, filtered at render, so the registry
  // landing doesn't refetch prices.
  const unfilteredBlocksRef = useRef<PricesResponse["sources"] | null>(null);
  const load = useCallback(
    (refresh = false): void => {
      const seq = ++requestSeq.current;
      const isUnfiltered = region === "all" && condition === "all";
      setData(null);
      setError(null);
      getPrices(game.id, {
        region: region === "all" ? undefined : region,
        condition: condition === "all" ? undefined : condition,
        signalRegion: known(scope.region),
        signalCondition: known(scope.condition),
        refresh,
      })
        .then((d) => {
          if (seq === requestSeq.current) {
            setData(d);
            if (isUnfiltered) {
              unfilteredBlocksRef.current = d.sources;
            }
          }
        })
        .catch((err: unknown) => {
          if (seq !== requestSeq.current) return;
          setError("Could not load prices");
          // the game is gone (deleted, reimported): Search's Recent forgets it
          if (err instanceof Error && err.message.startsWith("API 404 ")) forgetGame(game.id);
        });
    },
    [game.id, region, condition, scope.region, scope.condition],
  );
  // wait for the watches and copies so the first load already carries the scope
  useEffect(() => {
    if (scopeReady) load();
  }, [load, scopeReady]);

  const submitCopy = async (): Promise<void> => {
    setAddError(null);
    if (paid !== "" && !Number.isFinite(Number(paid))) {
      setAddError("Invalid price");
      return;
    }
    try {
      await addCopy({
        gameId: game.id,
        region: ownRegion,
        condition: ownCondition,
        notes: notes || undefined,
        ...(ownGrade !== null ? { itemGrade: ownGrade } : {}),
        // both or neither: an amount travels with its currency
        ...(paid !== ""
          ? { acquiredPriceOriginal: Number(paid), acquiredCurrency: paidCurrency }
          : {}),
      });
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Could not add copy");
      return;
    }
    if (paid !== "") saveLastPaidCurrency(paidCurrency);
    setAdded(true);
    setOwnOpen(false);
    loadCopies();
  };

  const unfilteredShopPoints =
    unfilteredBlocksRef.current === null ? null : tradeInPoints(unfilteredBlocksRef.current, sources);
  const copyComparables = copies.map((copy) => ({
    copy,
    comparable: comparableFor(copy, unfilteredShopPoints, sources),
  }));
  // Totals need BOTH a paid price and a current value; a copy missing either
  // is excluded rather than counted as a fabricated $0. Math on frozen USD.
  const copiesWithPaid = copyComparables.filter(
    (x) => x.copy.acquiredPriceUsd != null && x.comparable != null,
  );
  const totalPaid = copiesWithPaid.reduce((sum, x) => sum + (x.copy.acquiredPriceUsd as number), 0);
  const totalCurrent = copiesWithPaid.reduce((sum, x) => sum + (x.comparable as Comparable).value, 0);
  const totalDelta = totalCurrent - totalPaid;
  const totalsLine =
    copiesWithPaid.length > 1
      ? `total paid ${formatMoney(totalPaid)} → ${formatMoney(totalCurrent)} (${
          totalDelta >= 0 ? "+" : "−"
        }${formatMoney(Math.abs(totalDelta))})`
      : null;

  // memoized: a category has reached 126 signals on this deployment
  const barks = useMemo(
    () => data?.signals.filter((s) => BARK_TYPES.includes(s.type)) ?? [],
    [data?.signals],
  );
  // The visibility rule: high signals lead (the best one as the verdict),
  // potential ones fold into one line.
  const { high: highBarks, potential: possibleBarks } = useMemo(() => splitByConfidence(barks), [barks]);
  const verdict = useMemo(
    () =>
      pickVerdict(highBarks, (s) =>
        // the verdict quotes the amount as the source quoted it, as the reasoning does
        verdictTitle(s, (id) => sourceLabelOf(id, sources), (a) => formatOriginal(a.original, a.currency)),
      ),
    [highBarks, sources],
  );
  // Search's Recent list: this game, with the verdict line it has now
  useEffect(() => {
    if (data === null) return;
    // a filtered view records the visit and keeps the whole game's verdict
    const unfiltered = region === "all" && condition === "all";
    rememberGame(game, unfiltered ? (verdict?.title ?? null) : undefined);
  }, [data, game, verdict, region, condition]);
  const sectionsFor = (list: Signal[]) =>
    SIGNAL_GROUPS.map((section) => {
      const group = list.filter((s) => s.type === section.type);
      return { ...section, group, flatOrder: section.side === null ? sortByConfidence(group) : null };
    });
  const renderSections = (list: Signal[]) =>
    sectionsFor(list).map(({ type, heading, side, group, flatOrder }) => {
      if (group.length === 0) return null; // empty groups don't render
      return (
        <div key={type}>
          <h4>{heading}</h4>
          {side === null ? (
            <FindingsDisclosure
              signals={flatOrder as Signal[]}
              summary={<span className="meta">({group.length})</span>}
              label="Buy to sell"
            />
          ) : (
            <SignalGroups signals={group} side={side} />
          )}
        </div>
      );
    });
  const editingCopy = copies.find((c) => c.id === editingCopyId) ?? null;
  return (
    <div className="game-layout">
      <div className="game-main">
      <button onClick={onBack}>← Back</button>
      <div className="game-header">
        {game.coverUrl && <img src={game.coverUrl} alt={game.title} />}
        <h2>
          {game.title} <span className="meta">{PLATFORMS[game.platform].label}{game.year ? ` · ${game.year}` : ""}</span>
        </h2>
        <div className="game-actions">
          <Button onClick={() => void toggleWatch()}>{watchHere !== null ? `★ Watching · ${watchState}` : `☆ Watch · ${watchState}`}</Button>
          <Menu label="Game options">
            <button type="button" onClick={() => void load(true)}>↻ Refresh now</button>
            <label className="source-note">
              Price mode{" "}
              <select
                value={data?.gamePriceMode ?? "default"}
                onChange={(e) => {
                  const v = e.target.value;
                  void setGamePriceMode(game.id, v === "default" ? null : (v as "live" | "cached_only")).then(() => load());
                }}
              >
                <option value="default">default (cached + auto-update)</option>
                <option value="live">always live</option>
                <option value="cached_only">always cached</option>
              </select>
            </label>
          </Menu>
        </div>
      </div>

      {scopes.length > 1 && (
        <label className="signal-scope">
          Barks (Signals) for{" "}
          <select
            aria-label="Barks (Signals) for"
            value={scope.key}
            onChange={(e) => {
              setChosenScope(e.target.value);
              saveScopeKey(game.id, e.target.value);
            }}
          >
            {scopes.map((x) => (
              <option key={x.key} value={x.key}>
                {x.label}
              </option>
            ))}
          </select>
          <InfoTip topic="game.signalsFor" />
        </label>
      )}
      <Segmented
        aria-label="Region filter"
        options={REGIONS.map((r) => ({ value: r, label: r }))}
        value={region}
        onChange={setRegion}
      />
      <Segmented
        aria-label="Condition filter"
        options={CONDITION_FILTERS.map((c) => ({ value: c, label: c }))}
        value={condition}
        onChange={setCondition}
      />

      {error && <p className="source-note">{error}</p>}
      {!data && !error && <p className="source-note">Loading prices…</p>}
      {data && (
        <>
          {/* alt="" keeps the icon decorative: the heading reads "Watchdog barks" */}
          {barks.length > 0 && (
            <div className="title-with-tip">
              <h3>
                <img src="/dogfound.png" alt="" className="barks-icon" />
                Watchdog barks
              </h3>
              <InfoTip topic="game.barks" />
            </div>
          )}
          {barks.length > 0 && (
            <p className="source-note">
              Barks (signals): prices worth acting on, each compared with the market it beat.
            </p>
          )}
          {highBarks.length + possibleBarks.length > 0 && <Verdict verdict={verdict} />}
          {rec !== null && (
            <p className="game-rec">
              <strong>{rec.confidence === "high" ? rec.title : `Possibly: ${rec.title}`}</strong>
              <span className="meta"> {rec.reason}</span>
            </p>
          )}
          {renderSections(highBarks.filter((s) => s !== verdict?.signal))}
          {possibleBarks.length > 0 && (
            <Fold summary={<>{possibleCount(possibleBarks.length)} with incomplete data <InfoTip topic="game.possibleSignals" /></>}>
              {renderSections(possibleBarks)}
            </Fold>
          )}
          {highBarks.length + possibleBarks.length === 0 &&
            barks
              .filter((s) => s.type === "INSUFFICIENT_DATA")
              .map((s, i) => <SignalBadge key={i} signal={s} />)}
          {/* No registry, no prices: without its roles what a shop CHARGES and
              what it PAYS would share one table. The retry lives in the app's
              status band. An unconfigured source's empty block is hidden. */}
          {sources.status !== "ready" ? (
            <p className="source-note" role="status">
              {sources.status === "failed"
                ? "Prices hidden — could not load this deployment's source details."
                : "Loading source details…"}
            </p>
          ) : (
            <UnifiedPriceTable blocks={data.sources.filter((b) => b.status !== "not_configured")} />
          )}
        </>
      )}
      </div>
      <div className="game-side">
        {data && (
          <PriceHistory gameId={game.id} title={game.title} region={historySlice.region} condition={historySlice.condition} />
        )}
        <Panel
          title={copies.length > 0 ? `Your copies (${copies.length})` : "Your copies"}
          info="game.copies"
          action={
            <Button size="sm" onClick={() => setOwnOpen(true)}>
              + I own this
            </Button>
          }
        >
          {added && <p className="source-note">Added to collection ✓</p>}
          {copies.length === 0 && !added && <p className="source-note">You have no copy of this game.</p>}
          {copyComparables.map(({ copy, comparable }) => {
            // delta on the frozen USD legs; the paid text stays the verbatim original
            const delta =
              comparable != null && copy.acquiredPriceUsd != null
                ? (comparable.gainUsd ?? comparable.value - copy.acquiredPriceUsd)
                : null;
            return (
              <Row
                key={copy.id}
                title={
                  <>
                    {copy.region} · {copy.condition}
                    {copy.itemGrade ? ` · ${copy.itemGrade}` : ""}
                    {copy.status !== "owned" && <span className="source-note"> [{copy.status}]</span>}
                  </>
                }
                meta={
                  copy.acquiredPriceOriginal != null && copy.acquiredCurrency != null
                    ? `paid ${formatOriginal(copy.acquiredPriceOriginal, copy.acquiredCurrency)}`
                    : "paid —"
                }
                right={
                  <>
                    <span>{comparable ? comparable.label : "—"}</span>
                    {comparable?.potential && (
                      // caveats spelled out: a tooltip is invisible on a phone
                      <span className="confidence-marker">
                        {" "}
                        ❓ potential{comparable.notes.length > 0 ? `: ${comparable.notes.join("; ")}` : ""}
                      </span>
                    )}
                    {delta != null && (
                      <span className={delta >= 0 ? "delta-pos" : "delta-neg"}>
                        {" "}
                        {delta >= 0 ? `+${formatMoney(delta)} ▲` : `−${formatMoney(Math.abs(delta))} ▼`}
                      </span>
                    )}
                  </>
                }
                actions={
                  <button
                    className="edit-copy"
                    aria-label={editCopyLabel(`Edit copy ${copy.region} ${copy.condition}`, copy, copies)}
                    onClick={() => setEditingCopyId((id) => (id === copy.id ? null : copy.id))}
                  >
                    ✎ edit
                  </button>
                }
              />
            );
          })}
          {totalsLine && <p className="own-panel-totals source-note">{totalsLine}</p>}
        </Panel>
        <Sheet open={ownOpen} title="Add a copy" onClose={() => setOwnOpen(false)}>
          <div className="add-copy">
            <label>
              Region{" "}
              <select value={ownRegion} onChange={(e) => setOwnRegion(e.target.value as Region)}>
                {["PAL", "NTSC_U", "NTSC_J", "unknown"].map((r) => <option key={r}>{r}</option>)}
              </select>
            </label>{" "}
            <label>
              Condition{" "}
              <select value={ownCondition} onChange={(e) => setOwnCondition(e.target.value as Condition)}>
                {/* every tier a copy can be stored as */}
                {CONDITIONS.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>{" "}
            <GradeSlider grade={ownGrade} onChange={setOwnGrade} />{" "}
            <label>
              Paid <input value={paid} onChange={(e) => setPaid(e.target.value)} inputMode="decimal" size={6} />
            </label>{" "}
            <select
              aria-label="Paid currency"
              value={paidCurrency}
              onChange={(e) => setPaidCurrency(e.target.value as SupportedCurrency)}
            >
              <CurrencyOptions current={paidCurrency} />
            </select>{" "}
            <label>
              Notes <input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>{" "}
            <button onClick={() => void submitCopy()}>Add to collection</button>
            {addError && <p className="source-note">{addError}</p>}
          </div>
        </Sheet>
        {editingCopy !== null && (
          <Sheet
            open
            title={editCopyLabel(`Edit copy ${editingCopy.region} ${editingCopy.condition}`, editingCopy, copies)}
            onClose={() => setEditingCopyId(null)}
          >
            {/* reload after Save: paid text and comparable come from the fresh DTO */}
            <CopyEditor
              // one editor per copy: switching copies must not keep the last form
              key={editingCopy.id}
              copy={editingCopy}
              label={editCopyLabel(`Edit copy ${editingCopy.region} ${editingCopy.condition}`, editingCopy, copies)}
              onSaved={() => {
                setEditingCopyId(null);
                loadCopies();
              }}
              onCancel={() => setEditingCopyId(null)}
            />
          </Sheet>
        )}
      </div>
    </div>
  );
}
