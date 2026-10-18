import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

/** The ⋯ menu: secondary actions of a page or a row. Choosing an item, or clicking anywhere else, closes it. */
export function Menu({ label, children }: { label: string; children: ReactNode }) {
  const box = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent | globalThis.MouseEvent): void => {
      if (box.current !== null && !box.current.contains(e.target as Node)) box.current.removeAttribute("open");
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const closeOnChoice = (e: MouseEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest("button")) e.currentTarget.closest("details")?.removeAttribute("open");
  };
  return (
    <details ref={box} className="ui-menu" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary aria-label={label}>⋯</summary>
      <div className="ui-menu-items" onClick={closeOnChoice}>
        {children}
      </div>
    </details>
  );
}
