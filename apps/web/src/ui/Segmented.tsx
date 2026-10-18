import type { ReactNode } from "react";

/** A single choice: one bar of toggle buttons, the chosen one filled. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
}: {
  options: Array<{ value: T; label: ReactNode; ariaLabel?: string }>;
  value: T;
  onChange: (value: T) => void;
  "aria-label": string;
}) {
  return (
    <div className="ui-seg" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-label={o.ariaLabel}
          aria-pressed={o.value === value}
          className={o.value === value ? "active" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
