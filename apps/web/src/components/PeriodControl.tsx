import { PERIOD_OPTIONS, resolvePeriod, setPeriod, usePeriod, type PeriodPreset } from "../lib/period.js";
import { Segmented } from "../ui/index.js";

/**
 * The period every chart on every screen is drawn over. One shared choice:
 * changing it here moves the dashboard's delta, the value and watchlist
 * histories, a game's price history and the reliability table together.
 */
export function PeriodControl() {
  const period = usePeriod();
  const window = resolvePeriod(period);
  const choose = (preset: PeriodPreset): void =>
    // custom starts from the window on screen, so switching to it changes nothing yet
    setPeriod(preset === "custom" ? { preset, from: window.from, to: window.to } : { preset });
  return (
    <div className="period-control">
      <Segmented aria-label="Period" options={PERIOD_OPTIONS} value={period.preset} onChange={choose} />
      {period.preset === "custom" && (
        <>
          <input
            type="date"
            aria-label="From"
            value={window.from}
            max={window.to}
            onChange={(e) => e.target.value && setPeriod({ preset: "custom", from: e.target.value, to: window.to })}
          />
          <input
            type="date"
            aria-label="To"
            value={window.to}
            min={window.from}
            max={resolvePeriod({ preset: "7d" }).to}
            onChange={(e) => e.target.value && setPeriod({ preset: "custom", from: window.from, to: e.target.value })}
          />
        </>
      )}
    </div>
  );
}
