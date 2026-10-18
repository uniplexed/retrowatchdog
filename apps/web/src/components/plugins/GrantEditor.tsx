import { useEffect, useState } from "react";
import type {
  PluginDto,
  PluginSourceDto,
  PriceKind,
  PriceRole,
  SourceId,
} from "@retrowatchdog/shared";
import { COUNTRY_LABEL } from "@retrowatchdog/shared";
import { approvePlugin, saveEnabledMarkets } from "../../api/plugins.js";
import { getMarketSettings } from "../../api/client.js";
import { ROLE_SHORT, driftPhrases, sentenceList } from "./copy.js";
import {
  approvalPayload,
  checkedForMode,
  dropsLastBaseline,
  grantsChanged,
  kindWording,
  type EditorMode,
  type ReviewDocument,
} from "./grants.js";
import { RoleLegend } from "./RoleLegend.js";

/**
/**
 * The DECISION half of a plugin card: the boxes, and every consequence of
 * ticking one, shown next to the control that causes it.
 *
 * The fingerprint and the ticks come from ONE initialiser and are never
 * re-seeded: the API answers 409 when the row no longer hashes to it, which
 * stops a plugin promoting a kind to `reference` mid-review. The caller keys
 * this component on the fingerprint, so a moved manifest replaces the editor.
 */
export function GrantEditor({
  plugin,
  mode,
  document: reviewed,
  othersHoldBaseline,
  onSaved,
  onReread,
  onCancel,
}: {
  plugin: PluginDto;
  mode: EditorMode;
  document: ReviewDocument;
  /** whether any OTHER plugin still holds a baseline grant; see dropsLastBaseline */
  othersHoldBaseline: boolean;
  onSaved: () => Promise<void>;
  /** Re-read the plugin list from the API; see `reread` below. */
  onReread: () => Promise<void>;
  onCancel: () => void;
}) {
  const [state, setState] = useState(() => {
    const seed = Object.fromEntries(
      reviewed.sources.map((source) => [source.id, checkedForMode(source, mode)]),
    ) as Record<SourceId, PriceKind[]>;
    // The seed makes "has anything changed" a comparison, not a guess.
    return { fingerprint: reviewed.fingerprint, seed, checked: { ...seed } };
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Granting is where someone could switch a source on without knowing what
  // its terms say, so every grant (not a plain edit) needs this box ticked.
  const needsAck = mode !== "edit";
  const [ack, setAck] = useState(false);

  /**
   * Which markets this deployment queries. Read when the editor opens, never
   * cached by the panel: the Markets block edits the same setting and a cache
   * would go stale. `null` = not read yet; switches stay disabled.
   */
  const [markets, setMarkets] = useState<{ enabled: SourceId[]; seed: SourceId[] } | null>(null);
  const [marketsError, setMarketsError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getMarketSettings()
      .then((answer) => {
        if (!live) return;
        setMarkets({ enabled: [...answer.enabled], seed: [...answer.enabled] });
      })
      .catch(() => {
        if (live) setMarketsError("Could not load the market switches.");
      });
    return () => {
      live = false;
    };
  }, []);

  const toggleMarket = (sourceId: SourceId): void => {
    setMarkets((prev) => {
      if (prev === null) return prev;
      const on = prev.enabled.includes(sourceId);
      return {
        ...prev,
        enabled: on ? prev.enabled.filter((id) => id !== sourceId) : [...prev.enabled, sourceId],
      };
    });
  };

  const toggle = (sourceId: SourceId, kind: PriceKind): void => {
    setState((prev) => {
      const kinds = prev.checked[sourceId] ?? [];
      return {
        ...prev,
        checked: {
          ...prev.checked,
          [sourceId]: kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind],
        },
      };
    });
  };

  const changed = grantsChanged(reviewed.sources, state.seed, state.checked);
  const marketsChanged =
    markets !== null &&
    reviewed.sources.some(
      (source) => markets.enabled.includes(source.id) !== markets.seed.includes(source.id),
    );
  const losesBaseline = dropsLastBaseline(reviewed.sources, state.checked, othersHoldBaseline);

  const submit = async (): Promise<void> => {
    if (state.fingerprint === null) {
      setError("No manifest received yet.");
      return;
    }
    // A no-op save sends nothing: every approval stamps `approved_at`, the
    // registry's tie-break when two rows claim one id.
    if (!changed && !marketsChanged && mode === "edit") {
      onCancel();
      return;
    }
    setBusy(true);
    try {
      await approvePlugin(plugin.id, {
        approvedKinds: approvalPayload(reviewed.sources, state.checked),
        reviewedFingerprint: state.fingerprint,
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this plugin");
      setBusy(false);
      return;
    }
    // Switches are saved SECOND: the API refuses to switch on an id the
    // registry lacks, and a newly granted market enters it only once the
    // approval lands. A failure here is reported apart — the grants stored.
    if (marketsChanged) {
      try {
        await saveEnabledMarkets(markets!.enabled);
        setMarketsError(null);
      } catch (err) {
        setMarketsError(
          `Grants saved. Market switches not saved: ${err instanceof Error ? err.message : "request refused"}`,
        );
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    await onSaved();
  };

  /**
   * Fetch the plugin list again, so a 409 "review it again" is actionable. A
   * moved manifest changes the card's key and replaces this component.
   * Offered for every refusal, so the panel never parses the API's prose.
   */
  const reread = async (): Promise<void> => {
    setBusy(true);
    try {
      await onReread();
      setError(null);
    } finally {
      setBusy(false);
    }
  };

  const roles = rolesOnScreen(reviewed.sources);

  return (
    <div>
      <p className="source-note">{HEADING[mode](reviewed.name)}</p>
      {/* Every mode, not only `update`: a disabled row can drift without a `proposed`. */}
      {(reviewed.isProposal || plugin.drift.length > 0) && (
        <>
          <p className="meta">
            {reviewed.name} v{reviewed.version}
          </p>
          {plugin.drift.length > 0 ? (
            <p className="badge warning">
              Changed:{" "}
              {sentenceList(driftPhrases(plugin.drift, (id) => labelFor(reviewed.sources, id)))}.
            </p>
          ) : (
            <p className="meta">New version with no changes that affect prices.</p>
          )}
        </>
      )}
      <p className="meta">{seedExplanation(mode, reviewed.sources)}</p>
      {/* Keys are named even when configured: they are part of the trust. */}
      {reviewed.requiredSecrets.length > 0 && (
        <p className="meta">
          {plugin.configured
            ? `Uses ${sentenceList(reviewed.requiredSecrets)}.`
            : `Needs ${sentenceList(reviewed.requiredSecrets)}. Set them where the plugin runs.`}
        </p>
      )}
      {reviewed.sources.map((source) => (
        <SourceReview
          key={source.id}
          source={source}
          checked={state.checked[source.id] ?? []}
          onToggle={(kind) => toggle(source.id, kind)}
          switchedOn={markets === null ? null : markets.enabled.includes(source.id)}
          onSwitch={() => toggleMarket(source.id)}
        />
      ))}
      <RoleLegend roles={roles} open />
      {/* Whole-set warnings, not per source. */}
      {marketsError !== null && <p className="source-note">{marketsError}</p>}
      {losesBaseline && (
        <p className="badge warning">
          No baseline left: collection values, bargain and flip barks (signals) will stop.
        </p>
      )}
      {needsAck && (
        <label className="source-note legal-ack">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have read the source's
          terms in the note under each source, and switching it on is my decision and my responsibility.
        </label>
      )}
      <button disabled={busy || (needsAck && !ack)} onClick={() => void submit()}>
        {busy ? "Saving…" : SAVE_LABEL[mode]}
      </button>{" "}
      <button disabled={busy} onClick={onCancel}>
        {changed ? "Discard changes" : "Cancel"}
      </button>
      <p className="meta">{CONSEQUENCE[mode]}</p>
      {error !== null && (
        <p className="source-note">
          {error}{" "}
          <button disabled={busy} onClick={() => void reread()}>
            ↻ Reload plugin
          </button>
        </p>
      )}
    </div>
  );
}

const HEADING: Record<EditorMode, (name: string) => string> = {
  approve: (name) => `Review ${name}`,
  update: (name) => `Review ${name} update`,
  edit: (name) => `Edit ${name} grants`,
  enable: (name) => `Turn on ${name}`,
};

const SAVE_LABEL: Record<EditorMode, string> = {
  approve: "Approve",
  update: "Approve the update",
  edit: "Save grants",
  enable: "Turn on",
};

const CONSEQUENCE: Record<EditorMode, string> = {
  approve: "Only markets switched on are queried.",
  update: "Markets already on stay on. New markets start off.",
  edit: "Unticked prices stop being read and are hidden.",
  enable: "Only markets switched on are queried.",
};

/** Why the boxes arrive ticked as they do, which depends on the mode. */
function seedExplanation(mode: EditorMode, sources: readonly PluginSourceDto[]): string {
  if (mode === "edit") return "Ticked: your current grants.";
  const anyFirstReview = sources.some((source) => source.approvedKinds.length === 0);
  return anyFirstReview
    ? "Ticked: what the plugin requests. Baselines are never pre-ticked."
    : "Ticked: your current grants.";
}

/** Every role on screen, in the order the app lists them, without duplicates. */
function rolesOnScreen(sources: readonly PluginSourceDto[]): PriceRole[] {
  const seen: PriceRole[] = [];
  for (const source of sources) {
    for (const role of Object.values(source.kindRoles)) {
      if (role !== undefined && !seen.includes(role)) seen.push(role);
    }
  }
  return seen;
}

function labelFor(sources: readonly PluginSourceDto[], id: string): string {
  return sources.find((source) => source.id === id)?.label ?? id;
}

/** One source's facts line, its warnings, then its boxes. */
function SourceReview({
  source,
  checked,
  onToggle,
  switchedOn,
  onSwitch,
}: {
  source: PluginSourceDto;
  checked: PriceKind[];
  onToggle: (kind: PriceKind) => void;
  /** whether this market is queried, or null while that is still being read */
  switchedOn: boolean | null;
  onSwitch: () => void;
}) {
  const kinds = Object.keys(source.kindRoles) as PriceKind[];
  // Nothing ticked = not in the registry, and the API would refuse the switch.
  const canSwitch = checked.length > 0;
  return (
    <div className="market-field">
      <span className="plugin-head">
        <strong>{source.label}</strong>
        <button
          type="button"
          role="switch"
          className="market-switch"
          aria-checked={switchedOn === true && canSwitch}
          aria-label={`Query ${source.label}`}
          disabled={switchedOn === null || !canSwitch}
          onClick={onSwitch}
        >
          <i />
        </button>
        <span className="meta">
          {switchedOn === null ? "loading…" : canSwitch && switchedOn ? "on" : "off"}
        </span>
      </span>
      <p className="meta">{factsLine(source)}</p>
      {source.caveat !== undefined && <p className="meta">{source.caveat}</p>}
      {source.kind === "sync" && <p className="badge warning">{sweepSentence(source)}</p>}
      {linkSentence(source) !== null && <p className="badge warning">{linkSentence(source)}</p>}
      {categorySentence(source) !== null && <p className="badge warning">{categorySentence(source)}</p>}
      {kinds.map((kind) => (
        <div key={kind}>
          <label className="source-note basis-option">
            <input type="checkbox" checked={checked.includes(kind)} onChange={() => onToggle(kind)} />{" "}
            {kindWording(source, kind)}{" "}
            {source.kindLabelsShort?.[kind] !== undefined && (
              <span className="meta">({source.kindLabelsShort[kind]}) </span>
            )}
            <span className="meta">— {ROLE_SHORT[source.kindRoles[kind]!]}</span>
          </label>
          {source.kindRoles[kind] === "reference" && !checked.includes(kind) && (
            <p className="meta">{referenceNote(source, kind)}</p>
          )}
        </div>
      ))}
      {checked.length === 0 && (
        <p className="meta">Nothing ticked: {source.label} is removed from Markets.</p>
      )}
    </div>
  );
}

function factsLine(source: PluginSourceDto): string {
  return [
    COUNTRY_LABEL[source.country],
    source.expectedCurrencies.join("/"),
    source.defaultRegion === null ? null : `region ${source.defaultRegion}`,
    source.sellFeeRate === undefined ? null : `${Math.round(source.sellFeeRate * 1000) / 10}% fee`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

function sweepSentence(source: PluginSourceDto): string {
  if (source.schedule === undefined) {
    // Unreachable: `parseSource` rejects a sync source without a schedule.
    // Mirrors the guard in apps/api/src/sources/registry.ts.
    return `${source.label} has no sync schedule and serves no prices.`;
  }
  return `Syncs the full catalog on "${source.schedule.catalogCron}" and refreshes tracked games every ${source.schedule.trackedRefreshHours} h. A sync deletes stored rows no longer in the catalog.`;
}

/** `null` for a source that declares no template, so nothing is printed. */
function linkSentence(source: PluginSourceDto): string | null {
  if (source.productUrl === undefined) return null;
  return `Product links: ${source.productUrl}`;
}

/**
 * How a sync source's category text becomes a platform (`null` for a live
 * source). Says a count, not the list: `categoryPlatforms` may hold 200.
 */
function categorySentence(source: PluginSourceDto): string | null {
  if (source.kind !== "sync") return null;
  if (source.categoryPlatforms === undefined) {
    return "Categories are mapped with the app's own rules.";
  }
  const count = Object.keys(source.categoryPlatforms).length;
  return `Maps ${count} ${count === 1 ? "category" : "categories"} to platforms.`;
}

/**
 * What to say beside an UNTICKED baseline box. The middle case is a
 * PROMOTION, decided by `approvedKindRoles`, never `approvedKinds` alone.
 */
function referenceNote(source: PluginSourceDto, kind: PriceKind): string {
  const grantedRole = source.approvedKindRoles[kind];
  if (grantedRole === "reference") {
    return `Unticked: ${source.label} stops being a baseline and its stored prices are hidden.`;
  }
  if (source.approvedKinds.includes(kind)) {
    return `Previously granted as ${grantedRole === undefined ? "no role" : ROLE_SHORT[grantedRole]}, now asks to be a baseline. Not ticked by default.`;
  }
  return "Baselines are not ticked by default.";
}
