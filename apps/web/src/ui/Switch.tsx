/** An on/off setting that takes effect at once (a switch, not a form checkbox). */
export function Switch({
  checked,
  onChange,
  disabled,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label": string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className="ui-switch"
      onClick={() => onChange(!checked)}
    >
      <i />
    </button>
  );
}
