import type { SupportedCurrency } from "@retrowatchdog/shared";
import { fxNote, setDisplayCurrency, useMoney } from "../lib/money.js";
import { offered, useEnabledCurrencies } from "../lib/currencies.js";

/** App-header display-currency selector; the note surfaces FX problems. */
export function CurrencySelector() {
  const state = useMoney();
  const note = fxNote(state);
  const currencies = offered(useEnabledCurrencies(), state.currency);
  return (
    <div className="currency-bar">
      {note !== null && <span className="source-note">{note}</span>}
      <label className="source-note">
        Currency{" "}
        <select
          value={state.currency}
          onChange={(e) => void setDisplayCurrency(e.target.value as SupportedCurrency)}
        >
          {currencies.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** A currency <select>'s options: the enabled currencies, plus the one it already holds. */
export function CurrencyOptions({ current }: { current?: string | null }) {
  return (
    <>
      {offered(useEnabledCurrencies(), current).map((c) => (
        <option key={c}>{c}</option>
      ))}
    </>
  );
}
