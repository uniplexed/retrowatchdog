import { SignalSettings } from "../components/SignalSettings.js";
import { CurrencySelector } from "../components/CurrencySelector.js";
import { CurrenciesBlock } from "../components/CurrenciesBlock.js";
import { InfoTip } from "../ui/InfoTip.js";
import type { HelpTopic } from "../lib/help.js";
import { useEnabledCurrencies } from "../lib/currencies.js";
import { useViewport } from "../lib/viewport.js";
import { Fold, Switch, ThemeControl } from "../ui/index.js";
import { setEbayOwnBlock, useEbayOwnBlock } from "../lib/viewPrefs.js";
import { useEffect, useState } from "react";
import type {
  CountryCode,
  FxSettingDto,
  FxSettingsResponse,
  MarketDto,
  MarketSettingsResponse,
  SourceFamily,
  SourceId,
  UpdateFxSettingInput,
  ValuationBasis,
  ValuationMarkets,
} from "@retrowatchdog/shared";
import { COUNTRY_CODES, COUNTRY_LABEL, VALUATION_BASES } from "@retrowatchdog/shared";
import {
  getFxSettings,
  getMarketSettings,
  updateFxSetting,
  updateMarketSettings,
} from "../api/client.js";
import { PluginsPanel } from "../components/PluginsPanel.js";
import { refreshRate } from "../lib/money.js";
import { useSources, type SourcesState } from "../lib/sources.js";
import {
  loadValuationBasis,
  saveValuationBasis,
  VALUATION_BASIS_EXPLANATION,
  VALUATION_BASIS_LABEL,
} from "../lib/valuationBasis.js";
import { loadValuationMarkets, saveValuationMarkets } from "../lib/valuationMarkets.js";

/** compact rate rendering for the settings rows ("0.79", "147.25") */
function fmtRate(rate: number): string {
  return String(Number(rate.toFixed(4)));
}

/**
 * One per-currency FX row: auto (Frankfurter daily rate) or manual (a
 * USD->currency rate that wins everywhere until switched back).
 */
function FxRow({ dto, onSaved }: { dto: FxSettingDto; onSaved: (updated: FxSettingDto) => void }) {
  const [rateInput, setRateInput] = useState(dto.manualRate !== null ? String(dto.manualRate) : "");
  // manual picked but no valid rate stored yet: show the input, wait for Save
  const [pendingManual, setPendingManual] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (input: UpdateFxSettingInput): Promise<void> => {
    try {
      const updated = await updateFxSetting(dto.currency, input);
      onSaved(updated);
      setPendingManual(false);
      setError(null);
      // the header selector may be displaying this currency: pick up the change
      await refreshRate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    }
  };

  const manualActive = pendingManual || dto.mode === "manual";

  const saveManual = (): void => {
    const rate = Number(rateInput);
    if (rateInput.trim() === "" || !Number.isFinite(rate) || rate <= 0) {
      setError("Enter a rate greater than 0");
      return;
    }
    void save({ mode: "manual", manualRate: rate });
  };

  return (
    <div className="fx-row">
      <strong>{dto.currency}</strong>
      <label className="source-note">
        <input
          type="radio"
          name={`fx-mode-${dto.currency}`}
          checked={!manualActive}
          onChange={() => {
            setPendingManual(false);
            // the server keeps the stored manualRate for a later re-toggle
            void save({ mode: "auto" });
          }}
        />{" "}
        Auto
      </label>
      <label className="source-note">
        <input
          type="radio"
          name={`fx-mode-${dto.currency}`}
          checked={manualActive}
          onChange={() => {
            // re-activate a stored rate; otherwise wait for Save (manual needs a rate > 0)
            if (dto.manualRate !== null) void save({ mode: "manual", manualRate: dto.manualRate });
            else setPendingManual(true);
          }}
        />{" "}
        Manual
      </label>
      {manualActive ? (
        <>
          <input
            aria-label={`Manual USD to ${dto.currency} rate`}
            value={rateInput}
            inputMode="decimal"
            size={8}
            onChange={(e) => setRateInput(e.target.value)}
          />
          <button onClick={saveManual}>Save</button>
          <span className="meta">
            Auto: {dto.autoRate !== null ? fmtRate(dto.autoRate) : "no rate"}
          </span>
        </>
      ) : (
        <span>
          {dto.autoRate !== null ? fmtRate(dto.autoRate) : <span className="meta">No rate</span>}
          {dto.fetchedAt !== null && (
            <span className="meta"> · updated {new Date(dto.fetchedAt).toLocaleString()}</span>
          )}
        </span>
      )}
      {error !== null && <span className="source-note">{error}</span>}
    </div>
  );
}

/**
 * "Collection value": which valuation basis the collection screen asks for
 * (?valuation=). A client-side preference, no API round-trip.
 */
function CollectionValueSection() {
  const [basis, setBasis] = useState<ValuationBasis>(loadValuationBasis);
  return (
    // role="group" + aria-labelledby, not fieldset/legend: a legend breaks the
    // sibling panels' heading spacing
    <div className="source-block" role="group" aria-labelledby="collection-value-heading">
      <div className="title-with-tip">
        <h3 id="collection-value-heading">Collection value</h3>
        <InfoTip topic="settings.collectionValue" />
      </div>
      <p className="source-note">
        Which price sets the value of your copies. A copy without that price uses the next one.
      </p>
      {VALUATION_BASES.map((option) => (
        <label className="source-note basis-option" key={option}>
          <input
            type="radio"
            name="valuation-basis"
            value={option}
            checked={basis === option}
            onChange={() => {
              setBasis(option);
              saveValuationBasis(option);
            }}
          />{" "}
          {VALUATION_BASIS_LABEL[option]}
          <span className="meta"> — {VALUATION_BASIS_EXPLANATION[option]}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * "Valuation markets": which markets may value a copy you own (client-side,
 * sent as ?country=&includeForeign=). Signals are deliberately NOT limited
 * by it: a cross-country flip is exactly the arbitrage the watchdog wants.
 */
function ValuationMarketsSection() {
  const [markets, setMarkets] = useState<ValuationMarkets>(loadValuationMarkets);

  const apply = (next: ValuationMarkets): void => {
    setMarkets(next);
    saveValuationMarkets(next);
  };

  return (
    <div className="source-block">
      <div className="title-with-tip">
        <h3>Valuation markets</h3>
        <InfoTip topic="settings.valuationMarkets" />
      </div>
      <p className="source-note">Which markets can set the value of your copies. Barks (signals) use every market.</p>
      <div className="market-field">
        <label className="source-note">
          Your country{" "}
          <select
            value={markets.country}
            onChange={(e) => apply({ ...markets, country: e.target.value as CountryCode })}
          >
            {COUNTRY_CODES.map((code) => (
              <option key={code} value={code}>
                {COUNTRY_LABEL[code]}
              </option>
            ))}
          </select>
        </label>
        <p className="meta">Markets in this country value your copies.</p>
      </div>
      <div className="market-field">
        <label className="source-note">
          <input
            type="checkbox"
            checked={markets.includeForeign}
            onChange={(e) => apply({ ...markets, includeForeign: e.target.checked })}
          />{" "}
          Include other countries&apos; markets
        </label>
      </div>
    </div>
  );
}

/**
 * Service name for a Markets group heading, read off the FIRST registry
 * source of that family; the family id is the fallback. Nothing checks that
 * plugins of one family agree on familyLabel — if they differ, the first wins.
 */
function familyHeading(family: SourceFamily, rows: MarketDto[], sources: SourcesState): string {
  const member = rows.find((m) => m.family === family);
  return (member !== undefined ? sources.byId[member.source]?.familyLabel : undefined) ?? family;
}

/**
 * "Markets": which markets a game view queries and the worker syncs (server
 * setting). The block always shows the list the SERVER stored, so a refusal
 * never leaves a checkbox claiming a market is on.
 */
function MarketsSection({ reloadToken }: { reloadToken: number }) {
  const sources = useSources();
  const [data, setData] = useState<MarketSettingsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // re-fetch when the Plugins panel changes a plugin: `available` does not
  // follow the registry, so an approved plugin's markets would be missing
  useEffect(() => {
    getMarketSettings()
      .then((settings) => {
        setData(settings);
        // cleared on success, or one failed load would stick for the session
        setLoadError(null);
      })
      .catch(() => setLoadError("Could not load markets"));
  }, [reloadToken]);

  if (data === null && loadError !== null) {
    return (
      <div className="source-block">
        <h3>Markets</h3>
        <p className="source-note">{loadError}</p>
      </div>
    );
  }
  if (data === null) {
    return (
      <div className="source-block">
        <p className="source-note">Loading markets…</p>
      </div>
    );
  }

  const toggle = async (source: SourceId, on: boolean): Promise<void> => {
    const enabled = on ? [...data.enabled, source] : data.enabled.filter((s) => s !== source);
    setSaving(true);
    try {
      // the server's stored list, never the optimistic one
      setData(await updateMarketSettings(enabled));
      setSaveError(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save markets");
    } finally {
      setSaving(false);
    }
  };

  // families in registry order, each appearing once
  const families = [...new Set(data.available.map((m) => m.family))];

  return (
    <div className="source-block">
      <h3>Markets</h3>
      {loadError !== null && (
        // a refresh failed: keep the stale list visible, and say so
        <p className="source-note">
          {loadError}. Showing the last list loaded.
        </p>
      )}
      <p className="source-note">
        Markets checked for prices. Each live market adds a request per game you open. Each synced
        shop adds a background catalogue sync (several hours the first time).
      </p>
      {families.map((family) => (
        <div className="market-family" key={family}>
          <h4>{familyHeading(family, data.available, sources)}</h4>
          {data.available
            .filter((m) => m.family === family)
            .map((m) => (
              <div className="market-field" key={m.source}>
                <label className="source-note">
                  <input
                    type="checkbox"
                    // an unconfigured market that is ON stays clickable so it can be switched off
                    checked={data.enabled.includes(m.source)}
                    disabled={saving || (!m.configured && !data.enabled.includes(m.source))}
                    onChange={(e) => void toggle(m.source, e.target.checked)}
                  />{" "}
                  {m.label} <span className="meta">— {COUNTRY_LABEL[m.country]}</span>
                </label>
                {!m.configured && data.enabled.includes(m.source) && (
                  <p className="meta">Not configured. Turn it off.</p>
                )}
                {!m.configured && !data.enabled.includes(m.source) && (
                  <p className="meta">Not configured.</p>
                )}
              </div>
            ))}
        </div>
      ))}
      {saveError !== null && <p className="source-note">{saveError}</p>}
    </div>
  );
}

/** Owns its load state, so a failed /api/settings/fx stays inside this block. */
function FxSection() {
  const [data, setData] = useState<FxSettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // one rate row per enabled currency: re-read when that list changes
  const enabledKey = useEnabledCurrencies().join(",");

  useEffect(() => {
    getFxSettings()
      .then(setData)
      .catch(() => setError("Could not load FX settings"));
  }, [enabledKey]);

  if (error !== null) {
    return (
      <div className="source-block">
        <div className="title-with-tip">
        <h3>Exchange rates</h3>
        <InfoTip topic="settings.rates" />
      </div>
        <p className="source-note">{error}</p>
      </div>
    );
  }
  if (data === null) {
    return (
      <div className="source-block">
        <p className="source-note">Loading exchange rates…</p>
      </div>
    );
  }

  return (
    <div className="source-block">
      <div className="title-with-tip">
        <h3>Exchange rates</h3>
        <InfoTip topic="settings.rates" />
      </div>
      <p className="source-note">
        Rates from USD, used to show prices and convert amounts you enter. Manual replaces the
        daily rate. Saved amounts do not change.
      </p>
      {data.currencies.map((dto) => (
        <FxRow
          key={dto.currency}
          dto={dto}
          onSaved={(updated) =>
            setData((prev) =>
              prev === null
                ? prev
                : {
                    currencies: prev.currencies.map((c) =>
                      c.currency === updated.currency ? updated : c,
                    ),
                  },
            )
          }
        />
      ))}
    </div>
  );
}

const SETTINGS_SECTIONS = [
  { id: "appearance", title: "Appearance" },
  { id: "signals", title: "Barks (Signals)" },
  { id: "valuation", title: "Valuation" },
  { id: "markets", title: "Markets" },
  { id: "fx", title: "Currencies" },
  { id: "plugins", title: "Plugins" },
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

const SECTION_TOPIC: Record<SettingsSection, HelpTopic> = {
  appearance: "settings.appearance",
  signals: "settings.signals",
  valuation: "settings.valuation",
  markets: "settings.markets",
  fx: "settings.currencies",
  plugins: "settings.plugins",
};

const SECTION_KEY = "settingsSection";

function loadSection(): SettingsSection {
  try {
    const stored = window.localStorage.getItem(SECTION_KEY);
    const known = SETTINGS_SECTIONS.find((s) => s.id === stored);
    if (known !== undefined) return known.id;
  } catch {
    // storage blocked: start on the first section
  }
  return "appearance";
}

/** Also used by the dashboard, so a "Needs you" line opens its own section. */
export function saveSection(section: SettingsSection): void {
  try {
    window.localStorage.setItem(SECTION_KEY, section);
  } catch {
    // storage blocked: the choice lasts this visit
  }
}

function AppearanceSection() {
  const ebayOwnBlock = useEbayOwnBlock();
  return (
    <div className="source-block">
      <div className="setting-row">
        <span>
          <span className="setting-label">Theme</span>
          <span className="ui-help">Light, dark, or follow the system.</span>
        </span>
        <ThemeControl />
      </div>
      <div className="setting-row">
        <span>
          <span className="setting-label">eBay prices in their own block</span>
          <span className="ui-help">
            eBay's API licence asks for its content to be shown apart from other sources. Changes only how the price
            table is drawn, never a bark (signal).
          </span>
        </span>
        <Switch checked={ebayOwnBlock} onChange={setEbayOwnBlock} aria-label="eBay prices in their own block" />
      </div>
      <div className="setting-row">
        <span>
          <span className="setting-label">Currency</span>
          <span className="ui-help">Prices are shown in this currency; quoted amounts stay as quoted.</span>
        </span>
        <CurrencySelector />
      </div>
    </div>
  );
}

/**
 * Settings as sections: a list on the left on desktop, one section at a
 * time; folds on the phone, all closed.
 */
export function SettingsScreen() {
  const desktop = useViewport() === "desktop";
  // bumped by the Plugins panel so the Markets block re-reads its list
  const [marketsToken, setMarketsToken] = useState(0);
  const [section, setSection] = useState<SettingsSection>(loadSection);
  const body = (id: SettingsSection) => {
    switch (id) {
      case "appearance":
        return <AppearanceSection />;
      case "signals":
        return <SignalSettings />;
      case "valuation":
        return (
          <>
            <CollectionValueSection />
            <ValuationMarketsSection />
          </>
        );
      case "markets":
        return <MarketsSection reloadToken={marketsToken} />;
      case "fx":
        return (
          <>
            <CurrenciesBlock />
            <FxSection />
          </>
        );
      case "plugins":
        return <PluginsPanel onChanged={() => setMarketsToken((n) => n + 1)} />;
    }
  };

  if (!desktop) {
    return (
      <div className="settings">
        {SETTINGS_SECTIONS.map((s) => (
          <Fold key={s.id} summary={<>{s.title} <InfoTip topic={SECTION_TOPIC[s.id]} /></>}>
            {body(s.id)}
          </Fold>
        ))}
      </div>
    );
  }
  return (
    <div className="settings settings-desktop">
      <nav aria-label="Settings sections">
        {SETTINGS_SECTIONS.map((s) => (
          <span key={s.id} className="settings-nav-item">
            <button
              type="button"
              aria-current={section === s.id ? "true" : undefined}
              className={section === s.id ? "active" : ""}
              onClick={() => {
                setSection(s.id);
                saveSection(s.id);
              }}
            >
              {s.title}
            </button>
            <InfoTip topic={SECTION_TOPIC[s.id]} />
          </span>
        ))}
      </nav>
      <div className="settings-body">{body(section)}</div>
    </div>
  );
}
