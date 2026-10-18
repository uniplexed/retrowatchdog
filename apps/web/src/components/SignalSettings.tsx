import { useEffect, useRef, useState } from "react";
import { CurrencyOptions } from "./CurrencySelector.js";
import {
  RECOMMENDATION_DEFAULTS,
  type RecommendationThresholds,
  type SignalConfigDto,
  type SignalPreviewResponse,
  type SignalType,
  type SuggestedThresholdsResponse,
  type SupportedCurrency,
} from "@retrowatchdog/shared";
import { getSignalSettings, getSuggestedThresholds, previewSignalSettings, putSignalSettings, resetSignalSettings } from "../api/client.js";
import { useSources } from "../lib/sources.js";
import { SIGNAL_TYPE_INFO } from "../lib/signalTypes.js";
import { Button, Field, Panel, Switch } from "../ui/index.js";

/** every type a person can switch off, in the order Settings lists them */
const TYPES: SignalType[] = ["TARGET_HIT", "UNDERPRICED", "FLIP", "PROFIT", "PRICE_DROP", "NEW_LOW", "BACK_IN_STOCK", "RISING", "OVERPRICED_STORE"];

type NumericKey = {
  [K in keyof SignalConfigDto]: SignalConfigDto[K] extends number ? K : never;
}[keyof SignalConfigDto];

const THRESHOLDS: Array<{ key: NumericKey; label: string; step: string }> = [
  { key: "underpricedFactor", label: "Underpriced below × median", step: "0.01" },
  { key: "overpricedFactor", label: "Overpriced above × median", step: "0.01" },
  { key: "flipFactor", label: "Flip margin ×", step: "0.01" },
  { key: "profitFactor", label: "Profit margin ×", step: "0.01" },
  { key: "crossStoreFactor", label: "Cheaper than a shop ×", step: "0.01" },
  { key: "minSample", label: "Minimum listings for a median", step: "1" },
  { key: "priceDropPct", label: "Price drop %", step: "1" },
  { key: "priceDropDays", label: "Price drop over days", step: "1" },
  { key: "newLowDays", label: "New low window (days)", step: "1" },
  { key: "risingPct", label: "Rising %", step: "1" },
  { key: "risingDays", label: "Rising over days", step: "1" },
];

type RecKey = keyof RecommendationThresholds;

/** the recommendation thresholds, in the order a person reads them */
const RECOMMENDATION_FIELDS: Array<{ key: RecKey; label: string }> = [
  { key: "sellHighDays", label: "Sell: highest payout in (days)" },
  { key: "trendDays", label: "Trend window (days)" },
  { key: "buyLowDays", label: "Buy: lowest price in (days)" },
  { key: "buyBelowAvgPct", label: "Buy: % under the average" },
  { key: "targetWindowDays", label: "Target review window (days)" },
  { key: "targetNearPct", label: "Raise target: low within %" },
  { key: "targetOftenPct", label: "Lower target: under it on % of days" },
  { key: "quietPct", label: "Stop watching: price moved under %" },
  { key: "quietDays", label: "Stop watching / check copy after (days)" },
  { key: "sourceWindowDays", label: "Best source window (days)" },
  { key: "sourceDominancePct", label: "Best source: wins % of games" },
  { key: "minGamesPerConsole", label: "Best source: minimum games per console" },
  { key: "reliabilityMinPct", label: "Review thresholds: held under %" },
  { key: "evalDays", label: "Judge a bark (signal) after (days)" },
  { key: "beatenPct", label: "Beaten by %" },
  { key: "logRetentionDays", label: "Keep the bark (signal) log (days)" },
  { key: "historyDays", label: "History and sparklines (days)" },
];

const PREVIEW_DELAY_MS = 400;

/** an emptied number field holds NaN until the user types again */
const hasEmptyThreshold = (c: SignalConfigDto): boolean =>
  THRESHOLDS.some((t) => !Number.isFinite(c[t.key])) || RECOMMENDATION_FIELDS.some((f) => !Number.isFinite(c[f.key]));

function recommendationsLine(p: SignalPreviewResponse): string | null {
  const r = p.recommendations;
  if (r === undefined) return null;
  return `With these values: ${r.sellNow} sell now, ${r.buyNow} buy now, ${r.targets} target changes, ${r.cleanUps} clean-ups`;
}

function previewLine(p: SignalPreviewResponse): string {
  const base = `With these values, ${p.withSignal} of ${p.watches} watches have a bark (signal)`;
  return p.example === null ? base : `${base} — e.g. ${p.example.title}: ${p.example.verdictTitle}`;
}

/** Settings → Signals: which types fire, how strict each is, and what reaches the phone. */
export function SignalSettings() {
  const sources = useSources();
  const [config, setConfig] = useState<SignalConfigDto | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [recPreview, setRecPreview] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<SuggestedThresholdsResponse | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previewSeq = useRef(0);

  useEffect(() => {
    getSignalSettings()
      .then(setConfig)
      .catch(() => setError("Could not load the Barks (Signals) settings."));
    // an offer, not a requirement: without it only the fixed recommendation shows
    getSuggestedThresholds()
      .then(setSuggested)
      .catch(() => setSuggested(null));
  }, []);

  // every change is previewed against the watchlist, debounced, never saved
  useEffect(() => {
    if (config === null || hasEmptyThreshold(config)) return;
    const seq = ++previewSeq.current;
    const timer = setTimeout(() => {
      previewSignalSettings(config)
        .then((p) => {
          if (seq !== previewSeq.current) return;
          setPreview(previewLine(p));
          setRecPreview(recommendationsLine(p));
        })
        .catch(() => {
          if (seq !== previewSeq.current) return;
          setPreview(null);
          setRecPreview(null);
        });
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [config]);

  if (config === null) {
    return (
      <Panel title="Barks (Signals)">
        <p className="source-note">{error ?? "Loading…"}</p>
      </Panel>
    );
  }

  const update = (patch: Partial<SignalConfigDto>): void => {
    setNote(null);
    setError(null);
    setConfig({ ...config, ...patch });
  };
  const toggleIn = <T,>(list: T[], item: T, on: boolean): T[] =>
    on ? [...list.filter((x) => x !== item), item] : list.filter((x) => x !== item);

  const save = async (): Promise<void> => {
    if (hasEmptyThreshold(config)) {
      setError("Every threshold needs a number.");
      return;
    }
    try {
      setConfig(await putSignalSettings(config));
      setNote("Saved");
    } catch (err) {
      // the API names fields; the screen says what to do
      setError(
        err instanceof Error && err.message.includes(" 400 ")
          ? "A value is out of range. Check the thresholds and save again."
          : "Could not save the Barks (Signals) settings. Try again.",
      );
    }
  };
  const reset = async (): Promise<void> => {
    try {
      setConfig(await resetSignalSettings());
      setNote("Defaults restored");
    } catch {
      setError("Could not restore the defaults. Try again.");
    }
  };

  return (
    <div className="signal-settings">
      <h3>Barks (Signals)</h3>
      <Panel title="Types" info="signals.types">
        {TYPES.map((type) => (
          <div className="setting-row" key={type}>
            <span>
              <span className="setting-label">{SIGNAL_TYPE_INFO[type].label}</span>
              <span className="ui-help">
                {SIGNAL_TYPE_INFO[type].help} E.g. {SIGNAL_TYPE_INFO[type].example}
              </span>
            </span>
            <Switch
              aria-label={SIGNAL_TYPE_INFO[type].label}
              checked={config.enabledTypes.includes(type)}
              onChange={(on) => update({ enabledTypes: toggleIn(config.enabledTypes, type, on) })}
            />
          </div>
        ))}
      </Panel>
      <Panel title="Thresholds" info="signals.thresholds">
        <div className="setting-grid">
          {THRESHOLDS.map((t) => (
            <Field key={t.key} label={t.label}>
              <input
                type="number"
                inputMode="decimal"
                step={t.step}
                min="0"
                value={Number.isNaN(config[t.key]) ? "" : config[t.key]}
                onChange={(e) => update({ [t.key]: e.target.value === "" ? Number.NaN : Number(e.target.value) })}
              />
            </Field>
          ))}
        </div>
      </Panel>
      <Panel title="Scope" info="signals.scope">
        <Field label="Minimum gain" help="Flips and profits below this are not barks (signals). Empty means no floor.">
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={config.minGain?.amount ?? ""}
            onChange={(e) =>
              update({
                minGain:
                  e.target.value === ""
                    ? null
                    : { amount: Number(e.target.value), currency: config.minGain?.currency ?? "GBP" },
              })
            }
          />
        </Field>
        <label className="setting-inline">
          <span className="ui-help">Currency</span>{" "}
          <select
            aria-label="Gain currency"
            value={config.minGain?.currency ?? "GBP"}
            onChange={(e) =>
              update({ minGain: { amount: config.minGain?.amount ?? 0, currency: e.target.value as SupportedCurrency } })
            }
          >
            <CurrencyOptions current={config.minGain?.currency} />
          </select>
        </label>
        <div className="setting-row">
          <span>
            <span className="setting-label">Send low-confidence alerts</span>
            <span className="ui-help">Phone alerts also for barks (signals) built on incomplete data.</span>
          </span>
          <Switch
            aria-label="Send low-confidence alerts"
            checked={config.alertLowConfidence}
            onChange={(on) => update({ alertLowConfidence: on })}
          />
        </div>
        {sources.list.length > 0 && <p className="setting-label">Raise barks (signals) from</p>}
        {sources.list.map((src) => (
          <div className="setting-row" key={src.id}>
            <span className="setting-label">{src.label}</span>
            <Switch
              aria-label={`Barks (signals) from ${src.label}`}
              checked={!config.excludedSources.includes(src.id)}
              onChange={(on) => update({ excludedSources: toggleIn(config.excludedSources, src.id, !on) })}
            />
          </div>
        ))}
      </Panel>
      <Panel title="Recommendations" info="signals.recommendations">
        {suggested !== null && suggested.basis === null && <p className="source-note">From your data: {suggested.notes.history}</p>}
        {suggested !== null && suggested.basis !== null && <p className="source-note">{suggested.basis}</p>}
        <div className="setting-grid">
          {RECOMMENDATION_FIELDS.map((f) => {
            const fixed = RECOMMENDATION_DEFAULTS[f.key];
            const value = config[f.key];
            const derived = suggested?.values[f.key as keyof SuggestedThresholdsResponse["values"]];
            const note = suggested?.notes[f.key];
            return (
              <div className="rec-field" key={f.key}>
                <Field label={f.label} help={`Recommended: ${fixed}`} className={value !== fixed ? "off-default" : undefined}>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="1"
                    min="0"
                    value={Number.isNaN(value) ? "" : value}
                    onChange={(e) => update({ [f.key]: e.target.value === "" ? Number.NaN : Number(e.target.value) })}
                  />
                </Field>
                {value !== fixed && (
                  <Button variant="ghost" size="sm" aria-label={`Use ${fixed} for ${f.label}`} onClick={() => update({ [f.key]: fixed })}>
                    Use {fixed}
                  </Button>
                )}
                {derived !== undefined && (
                  <p className="ui-help">
                    {`From your data: ${derived}${note ? ` — ${note}` : ""}`}{" "}
                    {value !== derived && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Use ${derived} from your data for ${f.label}`}
                        onClick={() => update({ [f.key]: derived })}
                      >
                        Use
                      </Button>
                    )}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </Panel>
      {preview !== null && <p className="source-note">{preview}</p>}
      {recPreview !== null && <p className="source-note">{recPreview}</p>}
      <div className="setting-actions">
        <Button onClick={() => void reset()}>Reset to defaults</Button>
        <Button variant="primary" onClick={() => void save()}>
          Save
        </Button>
        {note !== null && <span className="source-note">{note}</span>}
      </div>
      {error !== null && <p className="source-note">{error}</p>}
    </div>
  );
}
