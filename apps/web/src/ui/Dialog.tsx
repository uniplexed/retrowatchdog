import { useEffect, useRef } from "react";
import { Button } from "./Button.js";
import { useModal } from "./modal.js";

/** A confirmation: one sentence of consequence, Cancel, and the action. Esc cancels. */
export function Dialog({
  open,
  title,
  body,
  confirmLabel,
  tone = "primary",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  tone?: "danger" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  const box = useRef<HTMLElement>(null);
  useModal(box, open);
  useEffect(() => {
    if (!open) return;
    // capture phase, and marked handled: a Sheet under this dialog must not
    // close on the same Esc
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      cancel.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;
  return (
    <>
      <div className="ui-sheet-backdrop" onClick={() => onCancel()} />
      <section ref={box} className="ui-dialog" role="alertdialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <h3>{title}</h3>
        <p>{body}</p>
        <div className="ui-dialog-actions">
          {/* a destructive dialog starts on Cancel: a reflex Enter must not destroy */}
          <Button onClick={() => onCancel()} autoFocus={tone === "danger"}>
            Cancel
          </Button>
          <Button variant={tone} onClick={() => onConfirm()} autoFocus={tone !== "danger"}>
            {confirmLabel}
          </Button>
        </div>
      </section>
    </>
  );
}
