import { useState } from "react";

/**
 * Collapsible controls row for the list screens; collapsed, active controls
 * stay visible as chips. Presentational: the screens own the state.
 */

export interface ControlOption {
  value: string;
  label: string;
}

export interface ControlGroupDef {
  id: string;
  label: string;
  options: ControlOption[];
  value: string;
  /** the value considered "off" — anything else renders as an active chip when collapsed */
  defaultValue: string;
  onChange: (value: string) => void;
}

export interface ControlToggleDef {
  id: string;
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}

function optionLabel(group: ControlGroupDef): string {
  return group.options.find((o) => o.value === group.value)?.label ?? group.value;
}

export function ListControls({
  groups,
  toggles = [],
  onClear,
}: {
  groups: ControlGroupDef[];
  toggles?: ControlToggleDef[];
  /** resets every control to its default; the Clear chip only shows when something is non-default */
  onClear: () => void;
}) {
  // not persisted: the row always reopens compact
  const [open, setOpen] = useState(false);
  const activeGroups = groups.filter((g) => g.value !== g.defaultValue);
  const activeToggles = toggles.filter((t) => t.value);
  const anyActive = activeGroups.length > 0 || activeToggles.length > 0;
  return (
    <div className="list-controls">
      <div className="chips">
        <button aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          ⚙ Filters &amp; sort
        </button>
        {/* collapsed summary: clicking an active chip expands to edit it */}
        {!open &&
          activeGroups.map((g) => (
            <button key={g.id} className="active" onClick={() => setOpen(true)}>
              {g.label.toLowerCase()}: {optionLabel(g)}
            </button>
          ))}
        {!open &&
          activeToggles.map((t) => (
            <button key={t.id} className="active" onClick={() => setOpen(true)}>
              {t.label}
            </button>
          ))}
        {anyActive && (
          <button className="control-clear" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      {open &&
        groups.map((g) => (
          <div key={g.id} className="chips control-group" role="group" aria-label={g.label}>
            <span className="meta control-label">{g.label}</span>
            {g.options.map((o) => (
              <button
                key={o.value}
                className={g.value === o.value ? "active" : ""}
                onClick={() => g.onChange(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        ))}
      {open && toggles.length > 0 && (
        <div className="chips control-group" role="group" aria-label="Show">
          <span className="meta control-label">Show</span>
          {toggles.map((t) => (
            <button
              key={t.id}
              className={t.value ? "active" : ""}
              aria-pressed={t.value}
              onClick={() => t.onChange(!t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
