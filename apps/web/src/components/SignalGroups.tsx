import { useId, useMemo, useState, type ReactNode } from "react";
import type { Signal } from "@retrowatchdog/shared";
import { SignalBadge } from "./SignalBadge.js";
import { formatMoney } from "../lib/money.js";
import { useSources, sourceLabel } from "../lib/sources.js";
import { groupSignalsBySource, type BestSide } from "../lib/signalGroups.js";

/**
 * A collapsible run of findings inside one bark category. One finding renders
 * flat. The region is always rendered and toggled with `hidden`, so
 * aria-controls always resolves. `label` names a count-only summary for
 * screen readers. Open/closed is session-only, deliberately.
 */
export function FindingsDisclosure({
  summary,
  signals,
  label,
}: {
  summary: ReactNode;
  signals: Signal[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  if (signals.length <= 1) {
    return <>{signals.map((signal, i) => <SignalBadge key={i} signal={signal} />)}</>;
  }
  return (
    <div className="bark-group">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
      >
        {summary}
      </button>
      <div id={regionId} hidden={!open}>
        {signals.map((signal, i) => <SignalBadge key={i} signal={signal} />)}
      </div>
    </div>
  );
}

/**
 * One bark category's findings, grouped by source. The header says who, how
 * many and the best amount — never a baseline, since pairwise UNDERPRICED has
 * none. `side` picks "best": min for buy-side, max for sell-side.
 */
export function SignalGroups({ signals, side }: { signals: Signal[]; side: BestSide }) {
  const sources = useSources();
  // memoized: a category can hold 126 signals
  const groups = useMemo(() => groupSignalsBySource(signals, side), [signals, side]);
  return (
    <>
      {groups.map((group) => (
        <FindingsDisclosure
          key={group.source ?? ""}
          signals={group.signals}
          // a source-less summary doesn't say what it groups
          label={group.source === null ? "Ungrouped findings" : undefined}
          summary={
            <>
              {group.source === null ? "" : sourceLabel(group.source, sources)}{" "}
              <span className="meta">({group.signals.length})</span>
              {group.best !== null && (
                <>
                  {" "}
                  {side === "max" ? "asks " : ""}
                  {formatMoney(group.best.usd, {
                    amount: group.best.original,
                    currency: group.best.currency,
                  })}
                </>
              )}
            </>
          }
        />
      ))}
    </>
  );
}
