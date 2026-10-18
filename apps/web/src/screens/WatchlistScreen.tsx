import { Fragment, useCallback, useEffect, useState } from "react";
import { Dialog, Menu, Row, Sheet, SwipeRow } from "../ui/index.js";
import { VerdictLine } from "../components/VerdictLine.js";
import type {
  SparklinesResponse,
  CsvWatchlistImportRow,
  Platform,
  SignalType,
  GameSummary,
  WatchlistItemDto,
  WatchlistResponse,
} from "@retrowatchdog/shared";
import { PLATFORMS } from "@retrowatchdog/shared";
import { deleteWatch, deleteWatchlist, getWatchlist, getWatchlistSparklines, importWatchlistCsv } from "../api/client.js";
import { Sparkline } from "../components/Sparkline.js";
import { WATCHLIST_FACETS, facetGroups } from "../lib/facets.js";
import { SIGNAL_TYPE_INFO } from "../lib/signalTypes.js";
import { sourceLabel, useSources } from "../lib/sources.js";
import { WatchlistHistory } from "../components/WatchlistHistory.js";
import { CsvImportPanel } from "../components/CsvImportPanel.js";
import { WatchEditor } from "../components/WatchEditor.js";
import { ListControls, type ControlGroupDef } from "../components/ListControls.js";
import { formatMoney, formatOriginal } from "../lib/money.js";
import {
  applyControls,
  buildWatchlistSpec,
  DEFAULT_WATCHLIST_CONTROLS,
  hasActiveWatchlistFilters,
  loadStoredControls,
  sanitizeWatchlistControls,
  saveStoredControls,
  WATCHLIST_CONDITION_FILTERS,
  WATCHLIST_GROUPS,
  WATCHLIST_REGION_FILTERS,
  WATCHLIST_SORTS,
  type WatchlistControls,
} from "../lib/listControls.js";

/** Meta line for a CSV preview row: null region/condition mean "any". */
function csvRowMeta(row: CsvWatchlistImportRow): string {
  const parts = [
    row.platform !== null ? PLATFORMS[row.platform].label : row.platformValue,
    row.region ?? "any",
    row.condition ?? "any",
  ];
  if (row.targetOriginal !== null && row.targetCurrency !== null) {
    parts.push(`target ${formatOriginal(row.targetOriginal, row.targetCurrency)}`);
  } else if (row.targetUsd !== null) {
    parts.push(`target ${formatMoney(row.targetUsd)}`);
  }
  return parts.join(" · ");
}

const SORT_LABEL: Record<string, string> = {
  title: "title A-Z",
  value: "value, high first",
  value_asc: "value, low first",
  paid: "paid, high first",
  paid_asc: "paid, low first",
  price_asc: "price, low first",
  price_desc: "price, high first",
};
const sortLabel = (s: string): string => SORT_LABEL[s] ?? s;

export function WatchlistScreen({ onSelect }: { onSelect: (game: GameSummary) => void }) {
  const [data, setData] = useState<WatchlistResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [controls, setControls] = useState<WatchlistControls>(() =>
    loadStoredControls("watchlistControls", sanitizeWatchlistControls),
  );
  const [csvOpen, setCsvOpen] = useState(false);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  // one confirmation at a time: a single watch, or the whole list
  const [confirm, setConfirm] = useState<WatchlistItemDto | "all" | null>(null);

  const [sparks, setSparks] = useState<SparklinesResponse["series"]>({});
  const reload = useCallback(() => {
    getWatchlist().then(setData).catch(() => setError("Could not load watchlist"));
    // decoration: a failure leaves the rows without a line
    getWatchlistSparklines()
      .then((r) => setSparks(typeof r?.series === "object" && r.series !== null ? r.series : {}))
      .catch(() => undefined);
  }, []);
  useEffect(reload, [reload]);

  const removeOne = async (item: WatchlistItemDto): Promise<void> => {
    try {
      await deleteWatch(item.id);
      setActionNote(null);
      reload();
    } catch {
      setActionNote("Could not remove — is the API up? Try again.");
    }
  };

  const clearAll = async (): Promise<void> => {
    if (!data) return;
    try {
      const res = await deleteWatchlist();
      setActionNote(`Removed ${res.deleted}`);
      reload();
    } catch {
      setActionNote("Could not clear the watchlist — is the API up? Try again.");
    }
  };

  const updateControls = (patch: Partial<WatchlistControls>): void => {
    setControls((prev) => {
      const next = { ...prev, ...patch };
      saveStoredControls("watchlistControls", next);
      return next;
    });
  };
  // Clear resets the ⚙ filters; the Signals chip is its own switch and stays
  const sources = useSources();
  const clearControls = (): void => {
    const next = { ...DEFAULT_WATCHLIST_CONTROLS, barkingOnly: controls.barkingOnly };
    setControls(next);
    saveStoredControls("watchlistControls", next);
  };

  if (error) return <p className="source-note">{error}</p>;
  if (!data) return <p className="source-note">Loading watchlist…</p>;

  const groups = applyControls(data.items, buildWatchlistSpec(controls));
  const shown = groups.flatMap((g) => g.items);
  const filtersActive = hasActiveWatchlistFilters(controls);

  const controlGroups: ControlGroupDef[] = [
    {
      id: "region",
      label: "Region",
      options: WATCHLIST_REGION_FILTERS.map((r) => ({ value: r, label: r })),
      value: controls.region,
      defaultValue: "all",
      onChange: (v) => updateControls({ region: v as WatchlistControls["region"] }),
    },
    {
      id: "condition",
      label: "Condition",
      options: WATCHLIST_CONDITION_FILTERS.map((c) => ({ value: c, label: c })),
      value: controls.condition,
      defaultValue: "all",
      onChange: (v) => updateControls({ condition: v as WatchlistControls["condition"] }),
    },
    ...facetGroups(WATCHLIST_FACETS, data.items, controls.facets, (facets) => updateControls({ facets }), (id, v) =>
      id === "platform" ? PLATFORMS[v as Platform].label : id === "source" ? sourceLabel(v, sources) : id === "signal" ? SIGNAL_TYPE_INFO[v as SignalType].label : v,
    ),
    {
      id: "sort",
      label: "Sort",
      options: WATCHLIST_SORTS.map((s) => ({ value: s, label: sortLabel(s) })),
      value: controls.sort,
      defaultValue: "actionability",
      onChange: (v) => updateControls({ sort: v as WatchlistControls["sort"] }),
    },
    {
      id: "group",
      label: "Group",
      options: WATCHLIST_GROUPS.map((g) => ({ value: g, label: g })),
      value: controls.group,
      defaultValue: "none",
      onChange: (v) => updateControls({ group: v as WatchlistControls["group"] }),
    },
  ];

  const editing = data.items.find((i) => i.id === editingId) ?? null;
  /** what the row says without a verdict: the shop's own offer, as it labelled it */
  const offerLine = (item: WatchlistItemDto): string | null =>
    item.storeOffer === null
      ? null
      : `${item.storeOffer.label} ${formatMoney(item.storeOffer.priceUsd, {
          amount: item.storeOffer.priceOriginal,
          currency: item.storeOffer.currencyOriginal,
        })}`;
  const meta = (item: WatchlistItemDto): string =>
    [
      PLATFORMS[item.game.platform].label,
      item.region ?? "any",
      item.condition ?? "any",
      ...(item.targetPriceOriginal !== null && item.targetCurrency !== null
        ? [`target ${formatOriginal(item.targetPriceOriginal, item.targetCurrency)}`]
        : []),
      ...(item.signalsAboveTarget > 0
        ? [`${item.signalsAboveTarget} buy bark${item.signalsAboveTarget === 1 ? "" : "s"} (signal${item.signalsAboveTarget === 1 ? "" : "s"}) above your target`]
        : []),
    ].join(" · ");

  return (
    <div>
      <div className="list-head">
        <button
          type="button"
          className={controls.barkingOnly ? "chip active" : "chip"}
          aria-pressed={controls.barkingOnly}
          onClick={() => updateControls({ barkingOnly: !controls.barkingOnly })}
        >
          Signals
        </button>
        <ListControls groups={controlGroups} onClear={clearControls} />
        <Menu label="Watchlist options">
          <button type="button" onClick={() => setCsvOpen((v) => !v)}>
            Import CSV
          </button>
          {/* the server sets Content-Disposition */}
          <a href="/api/watchlist/export" download>
            Export CSV
          </a>
        </Menu>
      </div>
      <WatchlistHistory />
      {csvOpen && (
        <CsvImportPanel
          send={importWatchlistCsv}
          rowMeta={csvRowMeta}
          // an existing watch conflict-skips at insert regardless
          duplicatesSelectable={false}
          duplicateNote="already watched — will be skipped"
          resultMessage={(res) => `Imported ${res.imported}, skipped ${res.skipped} already watched`}
          previewNote={(res) =>
            res.skipped > 0 ? `${res.skipped} rows are already watched and will be skipped` : null
          }
          onImported={reload}
        />
      )}
      {actionNote && <p className="source-note">{actionNote}</p>}
      {groups.map((group) => (
        <Fragment key={group.key}>
          {controls.group !== "none" && (
            <h4 className="group-header">
              {group.label} <span className="meta">({group.items.length})</span>
            </h4>
          )}
          {group.items.map((item) => (
            <SwipeRow
              key={item.id}
              actions={[
                { label: "Edit", ariaLabel: `Edit watch ${item.game.title}`, onClick: () => setEditingId(item.id) },
                { label: "Unwatch", ariaLabel: `Unwatch ${item.game.title}`, tone: "danger", onClick: () => setConfirm(item) },
              ]}
            >
              <Row
                cover={item.game.coverUrl}
                title={item.game.title}
                meta={meta(item)}
                // never 💰 PROFIT: a watch is not a copy (the surface allow-list)
                right={
                  <>
                    <Sparkline points={sparks[item.id] ?? []} />
                    <VerdictLine signals={item.signals} surface="watchlist" fallback={offerLine(item)} />
                  </>
                }
                onClick={() => onSelect(item.game)}
              />
            </SwipeRow>
          ))}
        </Fragment>
      ))}
      {filtersActive && shown.length === 0 && data.items.length > 0 && (
        <p className="source-note">
          {controls.barkingOnly && !hasActiveWatchlistFilters({ ...controls, barkingOnly: false })
            ? "No watched game has a bark (signal) right now."
            : "No watched games match these filters."}
        </p>
      )}
      {data.items.length === 0 && (
        <p className="source-note">Nothing watched yet — open a game and tap ★ Watch.</p>
      )}
      {data.items.length > 0 && (
        <p>
          <button className="delta-neg" onClick={() => setConfirm("all")}>
            Clear watchlist…
          </button>
        </p>
      )}
      {editing !== null && (
        <Sheet open title={`Edit watch ${editing.game.title}`} onClose={() => setEditingId(null)}>
          <WatchEditor
            key={editing.id}
            item={editing}
            onSaved={() => {
              setEditingId(null);
              reload();
            }}
            onCancel={() => setEditingId(null)}
          />
        </Sheet>
      )}
      <Dialog
        open={confirm !== null}
        title={confirm === "all" ? "Clear the watchlist" : "Unwatch"}
        body={
          confirm === "all"
            ? `Remove all ${data.items.length} watched games? This cannot be undone.`
            : `Remove ${confirm?.game.title ?? ""} from your watchlist?`
        }
        confirmLabel="Remove"
        tone="danger"
        onConfirm={() => {
          const target = confirm;
          setConfirm(null);
          if (target === "all") void clearAll();
          else if (target !== null) void removeOne(target);
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
