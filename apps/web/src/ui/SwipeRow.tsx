import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode } from "react";

/** how far left a drag must travel to open the actions */
const OPEN_PX = 64;
/** the width of one action on the phone */
const ACTION_PX = 80;

/** the one open row on screen: opening another closes it */
let closeOpenRow: (() => void) | null = null;

/**
 * A list row with actions behind it: swipe left on a touch screen, hover or
 * focus on desktop. The action buttons always exist, so a keyboard (and a
 * test) reaches them without swiping. One row is open at a time; a tap
 * anywhere else, or on the open row itself, closes it.
 */
export function SwipeRow({
  actions,
  children,
}: {
  actions: Array<{ label: string; ariaLabel?: string; onClick: () => void; tone?: "danger" }>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    closeOpenRow?.();
    closeOpenRow = close;
    const onDown = (e: globalThis.PointerEvent): void => {
      if (box.current !== null && !box.current.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      if (closeOpenRow === close) closeOpenRow = null;
    };
  }, [open]);

  const down = (e: PointerEvent<HTMLDivElement>): void => {
    start.current = { x: e.clientX, y: e.clientY };
  };
  const up = (e: PointerEvent<HTMLDivElement>): void => {
    const from = start.current;
    start.current = null;
    if (from === null) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    // a drag that is mostly vertical is a scroll, never a swipe
    if (Math.abs(dy) >= Math.abs(dx)) return;
    if (dx <= -OPEN_PX) setOpen(true);
    else if (dx >= OPEN_PX / 2) setOpen(false);
  };
  // a tap on the open row closes it; it does not also open what the row leads to
  const tapWhileOpen = (e: MouseEvent<HTMLDivElement>): void => {
    if (!open) return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
  };

  return (
    <div
      ref={box}
      className={open ? "ui-swipe open" : "ui-swipe"}
      // the row slides exactly as far as its actions are wide
      style={{ "--swipe-w": `${actions.length * ACTION_PX}px` } as CSSProperties}
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={() => (start.current = null)}
    >
      <div className="ui-swipe-body" onClickCapture={tapWhileOpen}>
        {children}
      </div>
      <div className="ui-swipe-actions">
        {actions.map((a) => (
          <button
            key={a.label}
            type="button"
            aria-label={a.ariaLabel ?? a.label}
            className={a.tone === "danger" ? "ui-swipe-action danger" : "ui-swipe-action"}
            onClick={() => {
              setOpen(false);
              a.onClick();
            }}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
