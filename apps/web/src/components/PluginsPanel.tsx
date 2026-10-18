import { useEffect, useRef, useState } from "react";
import type { PluginDto } from "@retrowatchdog/shared";
import { addPlugin, getPlugins } from "../api/plugins.js";
import { loadSources } from "../lib/sources.js";
import { PluginCard } from "./plugins/PluginCard.js";
import { pluginState } from "./plugins/copy.js";
import { documentUnderReview, needsReview } from "./plugins/grants.js";
import { Button, Row, Sheet } from "../ui/index.js";

/**
 * Settings → Plugins: where a person decides to trust someone else's software.
 *
 *  - Nothing is approved by arriving: an import stores a PROPOSAL.
 *  - The approval is bound to the document on screen (see GrantEditor).
 *  - Every field that changes what the app does with prices is shown at consent.
 *  - Every consequence is written next to its control, BEFORE the click.
 *
 * The list is one row per plugin with one action; everything else about a
 * plugin lives in its sheet. A card is a record; consequences live in the
 * editor. One plugin: ./plugins/.
 */

// Re-exported for the tests that pin the pre-tick rule.
export { defaultCheckedKinds } from "./plugins/grants.js";

/** `onChanged` refreshes the Markets block, which does not read the registry. */
export function PluginsPanel({ onChanged }: { onChanged?: () => void }) {
  const [plugins, setPlugins] = useState<PluginDto[] | null>(null);
  // The budget a plugin's pace must fit; the fallback only covers first paint.
  const [adapterTimeoutMs, setAdapterTimeoutMs] = useState(8000);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  // the plugin whose sheet is open
  const [openId, setOpenId] = useState<number | null>(null);
  const urlField = useRef<HTMLInputElement>(null);

  const reload = async (): Promise<void> => {
    try {
      const answer = await getPlugins();
      setPlugins(answer.plugins);
      setAdapterTimeoutMs(answer.adapterTimeoutMs);
      setLoadError(null);
    } catch (err) {
      // A failed reload keeps the old list; the banner says so.
      setLoadError(err instanceof Error ? err.message : "Could not load plugins");
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  /** After any mutation: this list, the registry, and the screen around us. */
  const refreshAll = async (): Promise<void> => {
    await reload();
    await loadSources();
    onChanged?.();
  };

  const add = async (): Promise<void> => {
    setAdding(true);
    try {
      await addPlugin(url.trim());
      setAddError(null);
      setUrl("");
      await refreshAll();
    } catch (err) {
      // A rejected import stores nothing, so this is the only explanation.
      setAddError(err instanceof Error ? err.message : "Could not add this plugin");
    } finally {
      setAdding(false);
    }
  };

  const list = plugins ?? [];
  // a plugin removed while its sheet was open closes the sheet
  const shown = list.find((p) => p.id === openId) ?? null;
  // removed from its own sheet: the button that opened it is gone, so the
  // keyboard lands on the field that adds the next one
  const removedWhileOpen = openId !== null && plugins !== null && shown === null;
  useEffect(() => {
    if (!removedWhileOpen) return;
    setOpenId(null);
    urlField.current?.focus();
  }, [removedWhileOpen]);
  return (
    <div className="source-block">
      <h3>Plugins</h3>
      <p className="source-note">
        Plugins are separate services that fetch prices from other markets. They keep their own API
        keys.
      </p>
      <p className="source-note legal-note">
        Each plugin reads another company's service under that company's terms; the note under each source says what
        they allow. Switching one on is your decision and your responsibility.
      </p>
      {loadError !== null && (
        <p className="source-note">
          {loadError}
          {plugins !== null && ". Showing the last list loaded."}{" "}
          <button onClick={() => void reload()}>Retry</button>
        </p>
      )}
      {plugins === null && loadError === null && <p className="source-note">Loading plugins…</p>}
      {plugins !== null && plugins.length === 0 && <p className="meta">No plugins added.</p>}
      {list.map((plugin) => {
        const state = pluginState(plugin);
        // a plugin turned off on purpose is configured, not reviewed: its sheet offers "Turn on…"
        const review =
          plugin.status !== "disabled" && needsReview(plugin) && documentUnderReview(plugin).sources.length > 0;
        return (
          <Row
            key={plugin.id}
            title={
              <>
                <span className={`dot dot-${state.tone}`} aria-hidden="true" /> {plugin.name}
              </>
            }
            meta={state.chip}
            actions={
              <Button
                size="sm"
                variant={review ? "primary" : "secondary"}
                aria-label={`${review ? "Review" : "Configure"} ${plugin.name}`}
                // both open the sheet on its record: what changed is said there, in words,
                // before the review it leads to
                onClick={() => setOpenId(plugin.id)}
              >
                {review ? "Review" : "Configure"}
              </Button>
            }
          />
        );
      })}
      <div className="market-field">
        <label className="source-note" htmlFor="plugin-url">
          Plugin URL
        </label>{" "}
        <input
          ref={urlField}
          id="plugin-url"
          value={url}
          size={28}
          placeholder="http://host:8000"
          onChange={(e) => setUrl(e.target.value)}
        />{" "}
        <button disabled={adding || url.trim() === ""} onClick={() => void add()}>
          Add
        </button>
        <p className="meta">Nothing is read until you approve it.</p>
        {addError !== null && <p className="source-note">{addError}</p>}
      </div>
      {shown !== null && (
        <Sheet open title={shown.name} onClose={() => setOpenId(null)}>
          <PluginCard
            key={shown.id}
            plugin={shown}
            adapterTimeoutMs={adapterTimeoutMs}
            // only the panel can see the other rows
            othersHoldBaseline={holdsBaseline(list, shown.id)}
            onChanged={refreshAll}
            // a refused approval changed nothing else
            onReread={reload}
          />
        </Sheet>
      )}
    </div>
  );
}

/**
 * Whether any APPROVED plugin other than `exceptId` holds a `reference`
 * grant, read from what was granted (`approvedKindRoles`), never declared.
 */
function holdsBaseline(plugins: readonly PluginDto[], exceptId: number): boolean {
  return plugins.some(
    (plugin) =>
      plugin.id !== exceptId &&
      plugin.status === "approved" &&
      plugin.sources.some((source) =>
        source.approvedKinds.some((kind) => source.approvedKindRoles[kind] === "reference"),
      ),
  );
}
