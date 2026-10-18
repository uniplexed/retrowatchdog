import { useState } from "react";
import { CurrencyOptions } from "./CurrencySelector.js";
import type { Condition, Region, SupportedCurrency, UpdateWatchInput, WatchlistItemDto } from "@retrowatchdog/shared";
import { CONDITIONS, REGIONS } from "@retrowatchdog/shared";
import { updateWatch } from "../api/client.js";
import { loadLastPaidCurrency } from "../lib/money.js";

const ANY = "";
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

/**
 * Narrows a watch: region, condition and a buy target. Save sends only what
 * changed; an empty target clears it.
 */
export function WatchEditor({
  item,
  onSaved,
  onCancel,
}: {
  item: WatchlistItemDto;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [region, setRegion] = useState<string>(item.region ?? ANY);
  const [condition, setCondition] = useState<string>(item.condition ?? ANY);
  const [target, setTarget] = useState(item.targetPriceOriginal === null ? "" : String(item.targetPriceOriginal));
  const [currency, setCurrency] = useState<SupportedCurrency>(item.targetCurrency ?? loadLastPaidCurrency());
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    const trimmed = target.trim();
    if (trimmed !== "" && !AMOUNT_RE.test(trimmed)) {
      setError("Target must be an amount like 25 or 25.50");
      return;
    }
    const patch: UpdateWatchInput = {};
    const nextRegion = region === ANY ? null : (region as Region);
    const nextCondition = condition === ANY ? null : (condition as Condition);
    if (nextRegion !== item.region) patch.region = nextRegion;
    if (nextCondition !== item.condition) patch.condition = nextCondition;
    const nextTarget = trimmed === "" ? null : Number(trimmed);
    if (nextTarget === null) {
      if (item.targetPriceOriginal !== null || item.targetPriceUsd !== null) {
        patch.targetPriceOriginal = null;
        patch.targetCurrency = null;
      }
    } else if (nextTarget !== item.targetPriceOriginal || currency !== item.targetCurrency) {
      patch.targetPriceOriginal = nextTarget;
      patch.targetCurrency = currency;
    }
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    try {
      await updateWatch(item.id, patch);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the watch");
    }
  };

  return (
    <form
      className="source-block copy-editor"
      aria-label={`Edit watch ${item.game.title}`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label>
        Region{" "}
        <select value={region} onChange={(e) => setRegion(e.target.value)}>
          <option value={ANY}>any</option>
          {REGIONS.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>{" "}
      <label>
        Condition{" "}
        <select value={condition} onChange={(e) => setCondition(e.target.value)}>
          <option value={ANY}>any</option>
          {CONDITIONS.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>{" "}
      <label>
        Buy at or under{" "}
        <input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" size={6} />
      </label>{" "}
      <select
        aria-label="Target currency"
        value={currency}
        onChange={(e) => setCurrency(e.target.value as SupportedCurrency)}
      >
        <CurrencyOptions current={currency} />
      </select>{" "}
      <button type="submit">Save</button>{" "}
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      {error && <p className="source-note">{error}</p>}
    </form>
  );
}
