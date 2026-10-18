import { useState } from "react";
import { SUPPORTED_CURRENCIES, type SupportedCurrency } from "@retrowatchdog/shared";
import { saveEnabledCurrencies, useEnabledCurrencies } from "../lib/currencies.js";
import { useMoney } from "../lib/money.js";

/** The currencies the menus offer: a short list with remove buttons and one "Add currency" picker. */
export function CurrenciesBlock() {
  const enabled = useEnabledCurrencies();
  const display = useMoney().currency;
  const [error, setError] = useState<string | null>(null);
  const save = (next: SupportedCurrency[]): void => {
    setError(null);
    saveEnabledCurrencies(next).catch((e: Error) => setError(e.message));
  };
  const rest = SUPPORTED_CURRENCIES.filter((c) => !enabled.includes(c));
  return (
    <div className="source-block">
      <h3>Currencies</h3>
      <p className="source-note">The currencies offered in every menu. Amounts already saved in a removed one stay as they are.</p>
      <ul className="currency-chips">
        {enabled.map((c) => (
          <li key={c} className="ui-pill ui-pill-neutral">
            {c}
            {c !== "USD" && c !== display && (
              <button type="button" aria-label={`Remove ${c}`} onClick={() => save(enabled.filter((e) => e !== c))}>
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {rest.length > 0 && (
        <select aria-label="Add currency" value="" onChange={(e) => save([...enabled, e.target.value as SupportedCurrency])}>
          <option value="">+ Add currency</option>
          {rest.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}
      {error !== null && <p className="source-note">{error}</p>}
    </div>
  );
}
