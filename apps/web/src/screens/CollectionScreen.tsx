import { Fragment, useCallback, useEffect, useState } from "react";
import type {
  SparklinesResponse,
  CollectionResponse,
  CopyStatus,
  CsvCollectionImportRow,
  GameSummary,
  OwnedCopyDto,
  PcImportResponse,
  PcImportRow,
  Platform,
} from "@retrowatchdog/shared";
import { ITEM_GRADES, PLATFORMS, realizedUsd, returnedUsd } from "@retrowatchdog/shared";
import {
  confirmLink,
  deleteCollection,
  deleteCopy,
  getCollection,
  importCollectionCsv,
  importPricecharting,
  linkCopy,
  getCollectionSparklines,
} from "../api/client.js";
import { Sparkline } from "../components/Sparkline.js";
import { GamePicker } from "../components/GamePicker.js";
import { CsvImportPanel } from "../components/CsvImportPanel.js";
import { CandidatePicker, chosenGameId, type ReviewChoice } from "../components/ImportReview.js";
import { formatMoney, formatOriginal } from "../lib/money.js";
import { loadValuationBasis, VALUATION_BASIS_LABEL, valueBasisTag } from "../lib/valuationBasis.js";
import { sourceLabel, useSources } from "../lib/sources.js";
import { COLLECTION_FACETS, facetGroups } from "../lib/facets.js";
import { loadValuationMarkets, valuationMarketsLabel } from "../lib/valuationMarkets.js";
import { CollectionValueHistory } from "../components/CollectionValueHistory.js";
import { gradeLabel } from "../components/GradeSlider.js";
import { CopyEditor, editCopyLabel } from "../components/CopyEditor.js";
import { VerdictLine } from "../components/VerdictLine.js";
import { Dialog, KPI, Menu, Row, Segmented, Sheet, SwipeRow } from "../ui/index.js";
import { ListControls, type ControlGroupDef } from "../components/ListControls.js";
import {
  applyControls,
  buildCollectionSpec,
  COLLECTION_CONDITION_FILTERS,
  COLLECTION_GROUPS,
  COLLECTION_REGION_FILTERS,
  COLLECTION_SORTS,
  DEFAULT_COLLECTION_CONTROLS,
  hasActiveCollectionFilters,
  loadStoredControls,
  sanitizeCollectionControls,
  saveStoredControls,
  type CollectionControls,
} from "../lib/listControls.js";

const STATUSES: Array<CopyStatus | "all"> = ["all", "incoming", "owned", "listed", "sold", "returned"];

/** review is a transient mode: reachable, never persisted as a default (the cards view is gone) */
type ScreenView = "list" | "review";

// PriceCharting is natively USD: shown verbatim, never converted
function valueLabel(row: PcImportRow): string {
  if (row.valueUsd === null) return "";
  return ` · ${formatOriginal(row.valueUsd, "USD")}`;
}

/** Meta line for a CSV preview row: paid shows the verbatim original when present. */
function csvRowMeta(row: CsvCollectionImportRow): string {
  const parts = [
    row.platform !== null ? PLATFORMS[row.platform].label : row.platformValue,
    row.region,
    row.condition,
  ];
  if (row.grade !== null) parts.push(row.grade);
  if (row.status !== "owned") parts.push(`[${row.status}]`);
  if (row.paidOriginal !== null && row.paidCurrency !== null) {
    parts.push(`paid ${formatOriginal(row.paidOriginal, row.paidCurrency)}`);
  } else if (row.paidUsd !== null) {
    parts.push(`paid ${formatMoney(row.paidUsd)}`);
  }
  return parts.join(" · ");
}

/** human label for a copy's match provenance, with the fuzzy score when known */
function basisLabel(item: OwnedCopyDto): string {
  if (item.matchBasis === null) return "hand-added";
  return item.matchScore !== null
    // floor, not round: a 0.999 near-miss must never claim 100%
    ? `${item.matchBasis} ${Math.floor(item.matchScore * 100)}%`
    : item.matchBasis;
}

/**
 * One match-review row with Confirm and Re-link. A re-link PATCHes the link
 * (basis becomes manual) and the row stays listed until confirmed.
 */
function ReviewRow({
  item,
  onChanged,
  onConfirmed,
}: {
  item: OwnedCopyDto;
  onChanged: () => void;
  /** extra hook for a successful Confirm only — re-links never trigger it */
  onConfirmed?: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const act = (action: Promise<unknown>, after?: () => void): void => {
    void action
      .then(() => {
        setNote(null);
        setPickerOpen(false);
        onChanged();
        after?.();
      })
      .catch((err: unknown) => setNote(err instanceof Error ? err.message : "Action failed"));
  };
  return (
    <div className="source-block review-row">
      <p>
        {item.game.coverUrl && <img src={item.game.coverUrl} alt="" />}
        <span className="meta">
          {item.region} · {item.condition}:
        </span>{" "}
        currently → <strong>{item.game.title}</strong>{" "}
        <span className="meta">
          ({PLATFORMS[item.game.platform].label}) · basis {basisLabel(item)}
        </span>
      </p>
      {item.notes && <p className="source-note">{item.notes}</p>}
      <button onClick={() => act(confirmLink(item.id), onConfirmed)}>Confirm</button>{" "}
      <button onClick={() => setPickerOpen((v) => !v)}>Re-link…</button>
      {pickerOpen && (
        <GamePicker
          defaultPlatform={item.game.platform}
          onPick={(g) => act(linkCopy(item.id, { gameId: g.id }))}
        />
      )}
      {note && <p className="source-note">{note}</p>}
    </div>
  );
}

function PcImportPanel({ onImported }: { onImported: () => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PcImportResponse | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [choices, setChoices] = useState<Record<string, ReviewChoice>>({});
  const [result, setResult] = useState<string | null>(null);

  const runPreview = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setResult(null);
    setPreview(null);
    setChoices({});
    try {
      const res = await importPricecharting({ url, dryRun: true });
      setPreview(res);
      // exact matches only; review rows need an active pick
      setChecked(
        new Set(
          res.rows.filter((r) => r.matchStatus === "matched" && !r.duplicate).map((r) => r.offerId),
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  };

  const matchedRows = preview?.rows.filter((r) => r.matchStatus === "matched") ?? [];
  const reviewRows = preview?.rows.filter((r) => r.matchStatus === "review") ?? [];

  // offerId -> chosen gameId; rows left on "Don't import" have no entry
  const overrides: Record<string, number> = {};
  for (const row of reviewRows) {
    if (row.duplicate) continue;
    const chosen = chosenGameId(choices[row.offerId]);
    if (chosen !== null) overrides[row.offerId] = chosen;
  }
  const importCount = checked.size + Object.keys(overrides).length;

  const runImport = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await importPricecharting({
        url,
        dryRun: false,
        includeOfferIds: [...checked],
        overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
      });
      setResult(`Imported ${res.imported}, skipped ${res.skippedDuplicates} duplicates`);
      setPreview(null);
      setChoices({});
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (offerId: string): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(offerId)) next.delete(offerId);
      else next.add(offerId);
      return next;
    });
  };

  const setChoice = (offerId: string, choice: ReviewChoice | undefined): void => {
    setChoices((prev) => {
      const next = { ...prev };
      if (choice === undefined) delete next[offerId];
      else next[offerId] = choice;
      return next;
    });
  };
  const unsupported = preview?.rows.filter((r) => r.matchStatus === "unsupported_platform") ?? [];
  const unmatched = preview?.rows.filter((r) => r.matchStatus === "unmatched") ?? [];
  const unsupportedConsoles = [...new Set(unsupported.map((r) => r.consoleName))];

  return (
    <div className="source-block">
      <label>
        Collection URL{" "}
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.pricecharting.com/offers?seller=...&status=collection"
          size={40}
        />
      </label>{" "}
      <button onClick={() => void runPreview()} disabled={busy || url.trim() === ""}>
        Preview
      </button>
      <p className="source-note">
        Purchase prices are not available from the public link; items are imported without
        acquisition cost.
      </p>
      {busy && (
        <p className="source-note">Fetching from PriceCharting… large collections can take a minute.</p>
      )}
      {error && <p className="source-note">{error}</p>}
      {result && <p className="source-note">{result}</p>}
      {preview && (
        <>
          <p className="source-note">
            {preview.totals.matched} matched · {preview.totals.review} need review ·{" "}
            {preview.totals.unmatched} unmatched · {preview.totals.unsupported} unsupported
          </p>
          {preview.truncated && (
            <p className="source-note">
              Showing {preview.rows.length} of {preview.totalCount} items — the rest could not be
              fetched.
            </p>
          )}
          {matchedRows.length > 0 && <h4>Matched</h4>}
          {matchedRows.map((row) => (
            <div key={row.offerId}>
              <label className="source-note">
                <input
                  type="checkbox"
                  checked={checked.has(row.offerId)}
                  disabled={row.duplicate}
                  onChange={() => toggle(row.offerId)}
                />{" "}
                {row.title}{" "}
                <span className="meta">
                  {row.consoleName} · {row.includes}
                  {valueLabel(row)}
                </span>
                {row.game && <span className="meta"> → {row.game.title}</span>}
                {row.duplicate && <span className="meta"> · already imported</span>}
              </label>
            </div>
          ))}
          {reviewRows.length > 0 && (
            <>
              <h4>Import candidates</h4>
              <p className="source-note">
                These didn't match the catalog 100%. Pick the right game for each, or leave
                "Don't import".
              </p>
            </>
          )}
          {reviewRows.map((row) => (
            <div key={row.offerId}>
              <p className="source-note">
                {row.title}{" "}
                <span className="meta">
                  {row.consoleName} · {row.includes}
                  {valueLabel(row)}
                </span>
                {row.duplicate && <span className="meta"> · already imported</span>}
              </p>
              {!row.duplicate && (
                <CandidatePicker
                  rowKey={row.offerId}
                  platform={row.platform}
                  candidates={row.candidates}
                  choice={choices[row.offerId]}
                  onChoice={(c) => setChoice(row.offerId, c)}
                />
              )}
            </div>
          ))}
          {unsupported.length > 0 && (
            <p className="source-note">
              {unsupported.length} items on unsupported platforms ({unsupportedConsoles.join(", ")})
              — not supported yet; see packages/shared/src/platforms.ts to enable.
            </p>
          )}
          {unmatched.length > 0 && (
            <>
              <p className="source-note">No catalog match found for:</p>
              {unmatched.map((row) => (
                <p className="source-note" key={row.offerId}>
                  {row.title} <span className="meta">({row.consoleName})</span>
                </p>
              ))}
            </>
          )}
          <button onClick={() => void runImport()} disabled={busy || importCount === 0}>
            Import {importCount} items
          </button>
        </>
      )}
    </div>
  );
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

export function CollectionScreen({ onSelect }: { onSelect: (game: GameSummary) => void }) {
  const sources = useSources();
  const [data, setData] = useState<CollectionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [controls, setControls] = useState<CollectionControls>(() =>
    loadStoredControls("collectionControls", sanitizeCollectionControls),
  );
  const [importOpen, setImportOpen] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);
  const [view, setViewState] = useState<ScreenView>("list");
  // the copy review mode is focused on; null = the whole needs-review set
  const [reviewFocus, setReviewFocus] = useState<number | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  // the copy whose CopyEditor sheet is open; one at a time
  const [editingId, setEditingId] = useState<number | null>(null);
  // one confirmation at a time: a single copy, or the whole collection
  const [confirm, setConfirm] = useState<OwnedCopyDto | "all" | null>(null);

  const setView = (v: ScreenView): void => {
    setViewState(v);
    setEditingId(null);
    if (v !== "review") setReviewFocus(null);
  };

  const [sparks, setSparks] = useState<SparklinesResponse["series"]>({});
  const reload = useCallback(() => {
    // client-side Settings preferences, read at every reload
    getCollection(loadValuationBasis(), loadValuationMarkets())
      .then(setData)
      .catch(() => setError("Could not load collection"));
    // decoration: a failure leaves the rows without a line
    getCollectionSparklines(loadValuationBasis())
      .then((r) => setSparks(typeof r?.series === "object" && r.series !== null ? r.series : {}))
      .catch(() => undefined);
  }, []);
  useEffect(reload, [reload]);

  const remove = async (id: number): Promise<void> => {
    try {
      await deleteCopy(id);
      setActionNote(null);
      reload();
    } catch {
      setActionNote("Could not remove — is the API up? Try again.");
    }
  };

  const wipeAll = async (): Promise<void> => {
    if (!data) return;
    try {
      const res = await deleteCollection();
      setActionNote(`Deleted ${res.deleted} items`);
      reload();
    } catch {
      setActionNote("Could not delete the collection — is the API up? Try again.");
    }
  };

  const updateControls = (patch: Partial<CollectionControls>): void => {
    setControls((prev) => {
      const next = { ...prev, ...patch };
      saveStoredControls("collectionControls", next);
      return next;
    });
  };
  const clearControls = (): void => {
    setControls(DEFAULT_COLLECTION_CONTROLS);
    saveStoredControls("collectionControls", DEFAULT_COLLECTION_CONTROLS);
  };

  if (error) return <p className="source-note">{error}</p>;
  if (!data) return <p className="source-note">Loading collection…</p>;

  const groups = applyControls(data.items, buildCollectionSpec(controls));
  const shown = groups.flatMap((g) => g.items);
  const cardEditLabel = (item: OwnedCopyDto): string =>
    editCopyLabel(`Edit copy ${item.game.title} ${item.region} ${item.condition}`, item, shown);
  const filtersActive = hasActiveCollectionFilters(controls);
  // unconfirmed picks, over ALL items: the Review chip ignores the list filters
  const needsReview = data.items.filter(
    (i) => i.matchBasis === "candidate" || i.matchBasis === "manual",
  );

  // Honesty rule: never show global totals over a filtered list. Unfiltered,
  // the server totals win (only they know an acquisition lot's total price).
  const isActive = (i: OwnedCopyDto): boolean => i.status !== "sold" && i.status !== "returned";
  const shownActive = shown.filter(isActive);
  const totals = filtersActive
    ? {
        estimated: shownActive.reduce((sum, i) => sum + (i.estimatedValueUsd ?? 0), 0),
        paid: shownActive.reduce((sum, i) => sum + (i.acquiredPriceUsd ?? 0), 0),
        // the server's per-copy formulas over the visible items (lot costs are server-only)
        realized: shown.reduce((sum, i) => sum + realizedUsd(i), 0),
        returned: shown.reduce((sum, i) => sum + returnedUsd(i), 0),
      }
    : {
        estimated: data.totalEstimatedUsd,
        paid: data.totalPaidUsd,
        realized: data.totalRealizedUsd,
        returned: data.totalReturnedUsd,
      };

  // a persisted platform whose items are gone stays listed, so it can be cleared
  const platformsPresent = [...new Set(data.items.map((i) => i.game.platform))];
  if (controls.platform !== "all" && !platformsPresent.includes(controls.platform)) {
    platformsPresent.push(controls.platform);
  }
  platformsPresent.sort((a, b) => PLATFORMS[a].label.localeCompare(PLATFORMS[b].label));

  const controlGroups: ControlGroupDef[] = [
    {
      id: "region",
      label: "Region",
      options: COLLECTION_REGION_FILTERS.map((r) => ({ value: r, label: r })),
      value: controls.region,
      defaultValue: "all",
      onChange: (v) => updateControls({ region: v as CollectionControls["region"] }),
    },
    {
      id: "condition",
      label: "Condition",
      options: COLLECTION_CONDITION_FILTERS.map((c) => ({ value: c, label: c })),
      value: controls.condition,
      defaultValue: "all",
      onChange: (v) => updateControls({ condition: v as CollectionControls["condition"] }),
    },
    {
      id: "grade",
      label: "Grade",
      options: [
        { value: "all", label: "all" },
        ...ITEM_GRADES.map((g) => ({ value: g, label: gradeLabel(g) })),
        { value: "ungraded", label: "ungraded" },
      ],
      value: controls.grade,
      defaultValue: "all",
      onChange: (v) => updateControls({ grade: v as CollectionControls["grade"] }),
    },
    {
      id: "platform",
      label: "Platform",
      options: [
        { value: "all", label: "all" },
        ...platformsPresent.map((p) => ({ value: p, label: PLATFORMS[p].label })),
      ],
      value: controls.platform,
      defaultValue: "all",
      onChange: (v) => updateControls({ platform: v as CollectionControls["platform"] }),
    },
    ...facetGroups(COLLECTION_FACETS, data.items, controls.facets, (facets) => updateControls({ facets }), (id, v) =>
      id === "source" ? sourceLabel(v, sources) : v,
    ),
    {
      id: "sort",
      label: "Sort",
      options: COLLECTION_SORTS.map((s) => ({ value: s, label: sortLabel(s) })),
      value: controls.sort,
      defaultValue: "title",
      onChange: (v) => updateControls({ sort: v as CollectionControls["sort"] }),
    },
    {
      id: "group",
      label: "Group",
      options: COLLECTION_GROUPS.map((g) => ({ value: g, label: g })),
      value: controls.group,
      defaultValue: "none",
      onChange: (v) => updateControls({ group: v as CollectionControls["group"] }),
    },
  ];

  const editing = data.items.find((i) => i.id === editingId) ?? null;
  const meta = (item: OwnedCopyDto) => (
    <>
      {[
        PLATFORMS[item.game.platform].label,
        item.region,
        item.condition,
        ...(item.itemGrade ? [gradeLabel(item.itemGrade)] : []),
        ...(item.status !== "owned" ? [`[${item.status}]`] : []),
        ...(item.acquiredPriceOriginal !== null && item.acquiredCurrency !== null
          ? [`paid ${formatOriginal(item.acquiredPriceOriginal, item.acquiredCurrency)}`]
          : []),
        ...(item.workingState && item.workingState !== "working" ? [item.workingState] : []),
        ...(item.authenticity === "counterfeit" ? ["counterfeit"] : []),
        ...(item.valueFetchedAt ? [`priced ${new Date(item.valueFetchedAt).toLocaleDateString()}`] : []),
      ].join(" · ")}
    </>
  );
  /** the copy's value and how it was read; a bare value must never pass for a sale price */
  const value = (item: OwnedCopyDto) => (
    <span className="copy-value">
      {item.valueBasis?.readAs === "excluded" ? (
        <span className="meta">
          {valueBasisTag(item.valueBasis, sources.byId)}
          {/* the one exclusion the user can undo, and where */}
          {item.valueBasis.reason === "outside_valuation_markets" && " — change them in Settings → Valuation markets"}
        </span>
      ) : item.estimatedValueUsd !== null ? (
        <>
          {formatMoney(item.estimatedValueUsd)}
          <span className="meta value-basis">{valueBasisTag(item.valueBasis, sources.byId)}</span>
        </>
      ) : (
        <>
          —<span className="meta">no price data yet</span>
        </>
      )}
      {/* a cheap listing is not news about a copy you own: the collection allow-list */}
      <VerdictLine signals={item.signals} surface="collection" />
    </span>
  );

  return (
    <div>
      <div className="list-head">
        <div className="dash-kpis collection-kpis">
          <KPI
            label={`${filtersActive ? "Filtered value" : "Value"} (${VALUATION_BASIS_LABEL[data.valuationBasis]}, ${valuationMarketsLabel(data.valuationMarkets)})`}
            value={formatMoney(totals.estimated)}
            // the value sums active copies: when sold or returned ones are listed too, say how many count
            delta={
              shownActive.length === shown.length
                ? `${shown.length} ${shown.length === 1 ? "item" : "items"}`
                : `${shownActive.length} active of ${shown.length} ${shown.length === 1 ? "item" : "items"}`
            }
          />
          <KPI label={filtersActive ? "Filtered paid" : "Paid"} value={formatMoney(totals.paid)} />
          {totals.realized !== 0 && <KPI label="Realized" value={formatMoney(totals.realized)} />}
          {totals.returned !== 0 && <KPI label="Returns" value={formatMoney(totals.returned)} />}
        </div>
        <Menu label="Collection options">
          <button type="button" onClick={() => setImportOpen((v) => !v)}>
            Import from PriceCharting
          </button>
          <button type="button" onClick={() => setCsvOpen((v) => !v)}>
            Import CSV
          </button>
          {/* the server sets Content-Disposition */}
          <a href="/api/collection/export" download>
            Export CSV
          </a>
          <span className="meta">Includes sold and returned items with their sale and return details.</span>
          {data.items.length > 0 && (
            <button type="button" className="delta-neg" onClick={() => setConfirm("all")}>
              Delete entire collection…
            </button>
          )}
        </Menu>
      </div>
      {/* its own fold, closed: fetched only when opened */}
      <CollectionValueHistory basis={data.valuationBasis} markets={data.valuationMarkets} />
      {view !== "review" && (
        <Segmented
          aria-label="Status"
          options={STATUSES.map((s) => ({ value: s, label: s }))}
          value={controls.status}
          onChange={(v) => updateControls({ status: v })}
        />
      )}
      <div className="list-head">
        {view !== "review" && <ListControls groups={controlGroups} onClear={clearControls} />}
        {/* review hides the list's controls, so it always carries its own way back */}
        {view === "review" && (
          <button type="button" className="chip" onClick={() => setView("list")}>
            Back to the list
          </button>
        )}
        {needsReview.length > 0 && (
          <button
            type="button"
            className={view === "review" ? "chip active" : "chip"}
            onClick={() => {
              setReviewFocus(null);
              setView(view === "review" ? "list" : "review");
            }}
          >
            Review ({needsReview.length})
          </button>
        )}
      </div>
      {importOpen && <PcImportPanel onImported={reload} />}
      {csvOpen && (
        <CsvImportPanel
          send={importCollectionCsv}
          rowMeta={csvRowMeta}
          // a CSV restore may legitimately re-add an owned copy
          duplicatesSelectable
          duplicateNote="possible duplicate"
          resultMessage={(res) => `Imported ${res.imported} items`}
          onImported={reload}
        />
      )}
      {actionNote && <p className="source-note">{actionNote}</p>}
      {view === "review" && (
        <>
          {(reviewFocus !== null ? data.items.filter((i) => i.id === reviewFocus) : needsReview).map((item) => (
            <ReviewRow
              key={item.id}
              item={item}
              onChanged={reload}
              onConfirmed={
                // focused mode came from a row: Confirm returns there; a
                // re-link does not (the row stays until confirmed)
                reviewFocus !== null
                  ? () => {
                      setActionNote("Link confirmed ✓");
                      setView("list");
                    }
                  : undefined
              }
            />
          ))}
          {reviewFocus === null && needsReview.length === 0 && <p className="source-note">Nothing left to review.</p>}
        </>
      )}
      {view !== "review" &&
        groups.map((group) => (
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
                  { label: "Edit", ariaLabel: cardEditLabel(item), onClick: () => setEditingId(item.id) },
                  // ANY copy can be re-linked, not only flagged ones
                  {
                    label: "Re-link",
                    ariaLabel: `Re-link ${item.game.title}`,
                    onClick: () => {
                      setReviewFocus(item.id);
                      setView("review");
                    },
                  },
                  { label: "Remove", ariaLabel: `Remove ${item.game.title}`, tone: "danger", onClick: () => setConfirm(item) },
                ]}
              >
                <Row
                  cover={item.game.coverUrl}
                  title={item.game.title}
                  meta={meta(item)}
                  right={
                    <>
                      {/* a line beside "no price data yet" would contradict it */}
                      <Sparkline points={item.estimatedValueUsd === null ? [] : (sparks[item.id] ?? [])} />
                      {value(item)}
                    </>
                  }
                  onClick={() => onSelect(item.game)}
                />
              </SwipeRow>
            ))}
          </Fragment>
        ))}
      {view !== "review" && shown.length === 0 && (
        <p className="source-note">
          {filtersActive && data.items.length > 0
            ? "No items match these filters."
            : 'Nothing here yet — find a game and tap "I own this".'}
        </p>
      )}
      {editing !== null && (
        <Sheet open title={cardEditLabel(editing)} onClose={() => setEditingId(null)}>
          {/* the same CopyEditor the game screen's ownership panel uses */}
          <CopyEditor
            key={editing.id}
            copy={editing}
            label={cardEditLabel(editing)}
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
        title={confirm === "all" ? "Delete the collection" : "Remove copy"}
        body={
          confirm === "all"
            ? `Delete ALL ${data.items.length} items, including sold/returned history? This cannot be undone.`
            : `Remove ${confirm?.game.title ?? "this copy"} (${confirm?.region ?? ""} · ${confirm?.condition ?? ""}) from your collection?`
        }
        confirmLabel={confirm === "all" ? "Delete" : "Remove"}
        tone="danger"
        onConfirm={() => {
          const target = confirm;
          setConfirm(null);
          if (target === "all") void wipeAll();
          else if (target !== null) void remove(target.id);
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
