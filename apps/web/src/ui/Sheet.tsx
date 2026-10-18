import { useEffect, useRef, type ReactNode } from "react";
import { useModal } from "./modal.js";

/** how far down the handle must be dragged to close the sheet */
const CLOSE_DRAG_PX = 80;

/**
 * A panel over the page for one task (edit, add, configure): a right-hand
 * panel on desktop, a bottom sheet on the phone — the CSS decides which.
 * Esc, the close button and the backdrop close it; focus goes back to
 * whatever opened it.
 */
export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  // the phone's handle: a drag down past CLOSE_DRAG_PX closes the sheet
  const dragFrom = useRef<number | null>(null);
  // latest onClose without re-running the open effect on every render
  const close = useRef(onClose);
  close.current = onClose;
  useModal(panel, open);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      // an Esc a dialog on top already handled is not this sheet's
      if (e.key === "Escape" && !e.defaultPrevented) close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <>
      <div className="ui-sheet-backdrop" onClick={() => onClose()} />
      <section ref={panel} className="ui-sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <span
          className="ui-sheet-handle"
          aria-hidden="true"
          onPointerDown={(e) => (dragFrom.current = e.clientY)}
          onPointerUp={(e) => {
            const from = dragFrom.current;
            dragFrom.current = null;
            if (from !== null && e.clientY - from >= CLOSE_DRAG_PX) onClose();
          }}
          onPointerCancel={() => (dragFrom.current = null)}
        />
        <header className="ui-sheet-head">
          <h3>{title}</h3>
          <button type="button" className="ui-sheet-close" aria-label="Close" onClick={() => onClose()}>
            ✕
          </button>
        </header>
        <div className="ui-sheet-body">{children}</div>
      </section>
    </>
  );
}
