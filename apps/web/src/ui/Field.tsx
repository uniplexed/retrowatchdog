import { Children, cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";

/**
 * Label, control and one help line. The help sits outside the <label> and is
 * attached with aria-describedby, so it never becomes part of the control's
 * accessible name.
 */
export function Field({ label, help, className, children }: { label: string; help?: string; className?: string; children: ReactNode }) {
  const id = useId();
  const helpId = `${id}-help`;
  const control = Children.only(children);
  const wired = isValidElement(control)
    ? cloneElement(control as ReactElement<Record<string, unknown>>, {
        id,
        ...(help !== undefined ? { "aria-describedby": helpId } : {}),
      })
    : control;
  return (
    <div className={["ui-field", className].filter(Boolean).join(" ")}>
      <label htmlFor={id}>{label}</label>
      {wired}
      {help !== undefined && (
        <p className="ui-help" id={helpId}>
          {help}
        </p>
      )}
    </div>
  );
}
