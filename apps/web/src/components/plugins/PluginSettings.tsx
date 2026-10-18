import { useState } from "react";
import type { PluginDto } from "@retrowatchdog/shared";
import { paceBudget, pacedSourceCount } from "@retrowatchdog/shared";
import { savePluginAddress, savePluginPace } from "../../api/plugins.js";

/**
 * How fast this deployment may call one plugin. A plugin's sources share ONE
 * queue, so a slow pace silently starves the last markets past the timeout
 * (five at 3000 ms start the fifth 12 s into an 8 s budget). The budget is
 * checked before the save with the same shared function the API uses.
 */
export function PluginSettings({
  plugin,
  adapterTimeoutMs,
  onSaved,
}: {
  plugin: PluginDto;
  adapterTimeoutMs: number;
  onSaved: () => Promise<void>;
}) {
  return (
    <>
      <PaceRow plugin={plugin} adapterTimeoutMs={adapterTimeoutMs} onSaved={onSaved} />
      <AddressRow plugin={plugin} onSaved={onSaved} />
    </>
  );
}

/**
 * Where the plugin runs; moving keeps its grants. A new address offering
 * anything different stops being served until reviewed, and says so up front.
 */
function AddressRow({
  plugin,
  onSaved,
}: {
  plugin: PluginDto;
  onSaved: () => Promise<void>;
}) {
  const [value, setValue] = useState(plugin.baseUrl);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await savePluginAddress(plugin.id, value.trim());
      setError(null);
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not move this plugin");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="market-field">
      <p className="source-note">Address</p>
      <div className="fx-row">
        <input
          type="text"
          size={26}
          aria-label={`Address for ${plugin.name}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button disabled={busy || value.trim() === "" || value.trim() === plugin.baseUrl} onClick={() => void save()}>
          {busy ? "Moving…" : "Move"}
        </button>
      </div>
      <p className="meta">Grants are kept. If the new address offers something different, you must review it.</p>
      {error !== null && <p className="source-note">{error}</p>}
    </div>
  );
}

function PaceRow({
  plugin,
  adapterTimeoutMs,
  onSaved,
}: {
  plugin: PluginDto;
  adapterTimeoutMs: number;
  onSaved: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"auto" | "manual">(
    plugin.rateLimitMs === null ? "auto" : "manual",
  );
  const [value, setValue] = useState(String(plugin.effectiveRateLimitMs));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  // live sources only: a sync source serves no game view
  const sources = pacedSourceCount(plugin.sources);
  // from the EFFECTIVE pace: an automatic one can be too slow too
  const typed = Number(value);
  const effective =
    mode === "auto"
      ? plugin.rateLimitSource === "plugin"
        ? // unsaved switch to auto: its value is not on the DTO, so don't guess
          null
        : plugin.effectiveRateLimitMs
      : Number.isInteger(typed) && typed > 0
        ? typed
        : null;
  const budget = effective === null ? null : paceBudget(sources, effective, adapterTimeoutMs);

  const save = async (): Promise<void> => {
    const next = mode === "auto" ? null : typed;
    if (next !== null && (!Number.isInteger(next) || next <= 0)) {
      setError("Enter a whole number above 0.");
      return;
    }
    setBusy(true);
    try {
      await savePluginPace(plugin.id, next);
      setError(null);
      setSaved(true);
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the pace");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="market-field">
      <p className="source-note">Time between requests</p>
      {sources > 1 && <p className="meta">One queue shared by its {sources} markets.</p>}
      <div className="fx-row">
        <label>
          <input
            type="radio"
            name={`pace-${plugin.id}`}
            checked={mode === "auto"}
            onChange={() => {
              setMode("auto");
              setSaved(false);
            }}
          />{" "}
          Automatic
        </label>
        <label>
          <input
            type="radio"
            name={`pace-${plugin.id}`}
            checked={mode === "manual"}
            onChange={() => {
              setMode("manual");
              setSaved(false);
            }}
          />{" "}
          <input
            type="text"
            inputMode="decimal"
            size={6}
            aria-label={`Pace for ${plugin.name}, in milliseconds`}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setMode("manual");
              setSaved(false);
            }}
          />{" "}
          ms
        </label>
      </div>
      <p className="meta">{sourceSentence(plugin)}</p>
      {budget !== null && (
        <p className={budget.fits ? "meta" : "source-note delta-neg"}>
          {budget.fits
            ? `OK: the last request starts at ${seconds(budget.lastStartMs)} s, within the ${seconds(adapterTimeoutMs)} s limit.`
            : `Too slow: the last request starts at ${seconds(budget.lastStartMs)} s, past the ${seconds(adapterTimeoutMs)} s limit, so those markets return nothing. Use ${budget.largestThatFitsMs} ms or less.`}
        </p>
      )}
      <button disabled={busy} onClick={() => void save()}>
        {busy ? "Saving…" : "Save pace"}
      </button>
      {saved && error === null && (
        <p className="meta">Saved. The background worker applies it within 5 minutes.</p>
      )}
      {error !== null && <p className="source-note">{error}</p>}
    </div>
  );
}

/** Where the number in force came from — this plugin's row, or the default. */
function sourceSentence(plugin: PluginDto): string {
  if (plugin.rateLimitSource === "plugin") {
    return `In use: ${plugin.effectiveRateLimitMs} ms (manual).`;
  }
  return `In use: ${plugin.effectiveRateLimitMs} ms (default).`;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}
