import { useState } from "react";
import type { PluginDto } from "@retrowatchdog/shared";
import { disablePlugin, recheckPlugin, removePlugin } from "../../api/plugins.js";
import { driftPhrases, pluginState, sentenceList } from "./copy.js";
import {
  documentUnderReview,
  grantSummary,
  needsReview,
  reviewMode,
  type EditorMode,
} from "./grants.js";
import { GrantEditor } from "./GrantEditor.js";
import { Button, Dialog, Segmented } from "../../ui/index.js";
import { PluginSettings } from "./PluginSettings.js";
import { GrantMatrix } from "./GrantMatrix.js";
import { RoleLegend } from "./RoleLegend.js";

type Section = "markets" | "pace" | "advanced";

/**
 * One plugin, as the configure sheet shows it: THE RECORD (is it working,
 * what is it allowed to do) in three sections, or THE EDITOR (what should it
 * be allowed to do), which carries the consequences.
 */
export function PluginCard({
  plugin,
  adapterTimeoutMs,
  othersHoldBaseline,
  onChanged,
  onReread,
}: {
  plugin: PluginDto;
  /** how long a game view waits for one source; the pace has to fit inside it */
  adapterTimeoutMs: number;
  /** whether any OTHER plugin holds a baseline grant; see dropsLastBaseline */
  othersHoldBaseline: boolean;
  onChanged: () => Promise<void>;
  /** re-read the list alone — no mutation happened, so nothing else needs it */
  onReread: () => Promise<void>;
}) {
  const [editor, setEditor] = useState<EditorMode | null>(null);
  const [section, setSection] = useState<Section>("markets");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (label: string, action: () => Promise<void>): Promise<void> => {
    setBusy(label);
    try {
      await action();
      setError(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change this plugin");
    } finally {
      setBusy(null);
    }
  };

  const state = pluginState(plugin);
  const reviewed = documentUnderReview(plugin);
  const canReview = needsReview(plugin) && reviewed.sources.length > 0;
  // Offered only where it can succeed: a drifted row would earn a 409, and a
  // null `seenFingerprint` a 400.
  const canEdit =
    plugin.status === "approved" && plugin.proposed === null && plugin.sources.length > 0;
  const editable = canEdit && plugin.seenFingerprint !== null;

  const remove = (): void => {
    setConfirmRemove(false);
    void run("Removing…", () => removePlugin(plugin.id));
  };
  const sections: Array<{ value: Section; label: string }> = [
    { value: "markets", label: "Markets" },
    // the pace and address endpoints refuse a disabled row
    // the pace is on the label: it can silently take markets dark
    ...(plugin.status !== "disabled"
      ? [{ value: "pace" as const, label: `Pace & address · ${plugin.effectiveRateLimitMs} ms` }]
      : []),
    { value: "advanced", label: "Advanced" },
  ];

  return (
    <div className="market-family">
      <p className="meta">
        v{plugin.version} · <span className={`badge-compact ${chipClass(state.tone)}`}>{state.chip}</span>
      </p>
      <p className="meta">{state.addressLine}</p>
      {state.statusNote !== null && <p className="meta">{state.statusNote}</p>}
      {state.healthBadge !== null && <p className="badge warning">{state.healthBadge}</p>}
      {plugin.lastError !== null && <p className="meta">Last error: {plugin.lastError}</p>}

      {/* Disclosure: the app approved this row itself. */}
      {plugin.adoptedAt !== null && <p className="meta">Approved automatically.</p>}

      {editor === null ? (
        <>
          {/* A version bump alone sets `proposed` with empty drift. */}
          {(plugin.proposed !== null || plugin.drift.length > 0) && (
            <>
              {plugin.drift.length > 0 ? (
                <p className="badge warning">
                  Changed:{" "}
                  {sentenceList(driftPhrases(plugin.drift, (id) => labelFor(plugin, id)))}.
                </p>
              ) : (
                <p className="meta">New version with no changes that affect prices.</p>
              )}
              {plugin.status === "approved" && (
                <p className="meta">The current approval stays in use until you approve the update.</p>
              )}
            </>
          )}
          <Segmented aria-label="Plugin section" options={sections} value={section} onChange={setSection} />
          {section === "markets" && (
            <>
              <Record plugin={plugin} />
              <div className="chips">
                {canReview && (
                  <button disabled={busy !== null} onClick={() => setEditor(reviewMode(plugin))}>
                    {REVIEW_LABEL[reviewMode(plugin)]}
                  </button>
                )}
                {canEdit && (
                  <button disabled={busy !== null || !editable} onClick={() => setEditor("edit")}>
                    Edit grants
                  </button>
                )}
              </div>
              {canEdit && !editable && <p className="meta">Nothing to edit yet: no manifest received.</p>}
            </>
          )}
          {section === "pace" && plugin.status !== "disabled" && (
            <PluginSettings plugin={plugin} adapterTimeoutMs={adapterTimeoutMs} onSaved={onChanged} />
          )}
          {section === "advanced" && (
            <div className="danger-zone">
              {/* The endpoint refuses a disabled row. */}
              {plugin.status !== "disabled" && (
                <Button
                  disabled={busy !== null}
                  onClick={() => void run("Checking…", async () => void (await recheckPlugin(plugin.id)))}
                >
                  {busy === "Checking…" ? busy : "↻ Check now"}
                </Button>
              )}
              {plugin.status === "approved" && (
                <Button
                  disabled={busy !== null}
                  onClick={() => void run("Turning off…", () => disablePlugin(plugin.id))}
                >
                  {busy === "Turning off…" ? busy : "Turn off"}
                </Button>
              )}
              <Button variant="danger" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
                {busy === "Removing…" ? busy : "Remove…"}
              </Button>
              {plugin.status === "approved" && (
                <p className="meta">Turn off stops all requests. Stored prices are kept.</p>
              )}
            </div>
          )}
          <Dialog
            open={confirmRemove}
            title="Remove plugin"
            body={removalWarning(plugin)}
            confirmLabel="Remove"
            tone="danger"
            onConfirm={remove}
            onCancel={() => setConfirmRemove(false)}
          />
        </>
      ) : (
        <GrantEditor
          // re-seeds ticks and fingerprint together when the manifest moves
          key={`${plugin.id}:${editor}:${(editor === "edit" ? plugin.manifestFingerprint : reviewed.fingerprint) ?? "none"}`}
          plugin={plugin}
          mode={editor}
          document={editor === "edit" ? servedDocument(plugin) : reviewed}
          othersHoldBaseline={othersHoldBaseline}
          onSaved={async () => {
            setEditor(null);
            await onChanged();
          }}
          onReread={onReread}
          onCancel={() => setEditor(null)}
        />
      )}
      {error !== null && <p className="source-note">{error}</p>}
    </div>
  );
}

const REVIEW_LABEL: Record<EditorMode, string> = {
  approve: "Review and approve…",
  update: "Review the update…",
  enable: "Turn on…",
  edit: "Edit grants",
};

function chipClass(tone: "ok" | "warning" | "muted"): string {
  return tone === "ok" ? "" : tone;
}

/**
 * What this row is granted right now: a matrix for approved rows (see
 * GrantMatrix), granted roles for disabled ones, offered markets for pending.
 */
function Record({ plugin }: { plugin: PluginDto }) {
  if (plugin.status === "approved") {
    const roles = plugin.sources.flatMap((source) =>
      source.approvedKinds.map((kind) => source.kindRoles[kind]).filter((r) => r !== undefined),
    );
    return (
      <>
        <GrantMatrix sources={plugin.sources} />
        <RoleLegend roles={[...new Set(roles)]} open={false} />
      </>
    );
  }
  if (plugin.status === "disabled") {
    return (
      <>
        {plugin.sources.map((source) => {
          const grants = grantSummary(source);
          return (
            <p className="meta" key={source.id}>
              {source.label} —{" "}
              {grants.length === 0 ? "nothing approved" : `approved: ${sentenceList(grants)}`}
            </p>
          );
        })}
      </>
    );
  }
  if (plugin.sources.length === 0) return null;
  return (
    <p className="meta">
      Offers {plugin.sources.length === 1 ? "1 market" : `${plugin.sources.length} markets`}:{" "}
      {sentenceList(plugin.sources.map((source) => source.label))}.
    </p>
  );
}

/** The document `edit` edits: the one the row SERVES, never `proposed`. */
function servedDocument(plugin: PluginDto) {
  return {
    name: plugin.name,
    version: plugin.version,
    requiredSecrets: plugin.requiredSecrets,
    sources: plugin.sources,
    fingerprint: plugin.manifestFingerprint,
    isProposal: false,
  };
}

function labelFor(plugin: PluginDto, id: string): string {
  const all = [...plugin.sources, ...(plugin.proposed?.sources ?? [])];
  return all.find((source) => source.id === id)?.label ?? id;
}

/** What Remove is about to do, in its confirmation dialog. It cannot be undone. */
function removalWarning(plugin: PluginDto): string {
  const n = plugin.sources.length;
  const markets = n === 1 ? "its market" : `its ${n} markets`;
  let text = `Remove "${plugin.name}" and ${markets}? Stored prices are kept. This cannot be undone.`;
  if (plugin.adoptedAt !== null) {
    text += `\n\nIf you add it again, you must approve it and turn its markets on yourself.`;
  }
  return text;
}
