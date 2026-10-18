import { useEffect, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** whether some sheet or dialog is open over the page */
export const modalOpen = (): boolean => document.querySelector('[aria-modal="true"]') !== null;

/** the open modal drawn last, which is the one on top */
const topmost = (): Element | null => {
  const all = document.querySelectorAll('[aria-modal="true"]');
  return all.length === 0 ? null : all[all.length - 1];
};

/**
 * While `open`: Tab cycles inside the modal on top (a dialog over a sheet
 * keeps it to itself), and the page behind does not scroll.
 */
export function useModal(ref: RefObject<HTMLElement | null>, open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent): void => {
      const box = ref.current;
      if (e.key !== "Tab" || box === null || topmost() !== box) return;
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) {
        e.preventDefault();
        box.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const inside = box.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first || document.activeElement === box)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = before;
    };
  }, [open, ref]);
}
