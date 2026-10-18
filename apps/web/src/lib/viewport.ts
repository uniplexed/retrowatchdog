import { useSyncExternalStore } from "react";

/** The one breakpoint: at or above it the app is the desktop experience. */
export const DESKTOP_QUERY = "(min-width: 1024px)";

export type Viewport = "desktop" | "mobile";

const media = (): MediaQueryList | null =>
  typeof window.matchMedia === "function" ? window.matchMedia(DESKTOP_QUERY) : null;

function subscribe(onChange: () => void): () => void {
  const list = media();
  if (list === null) return () => {};
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

const snapshot = (): Viewport => (media()?.matches ? "desktop" : "mobile");

/** "desktop" | "mobile", live; mobile where matchMedia does not exist. */
export function useViewport(): Viewport {
  return useSyncExternalStore(subscribe, snapshot);
}
