import { useSyncExternalStore } from "react";

/**
 * App-wide theme store. The preference (`auto | light | dark`) is kept in
 * localStorage; `auto` follows the system's prefers-color-scheme while the app
 * is open. The resolved theme is written to <html data-theme> and to the
 * theme-color meta. index.html resolves the same way before first paint, so the
 * page never flashes the wrong theme.
 */
export type ThemePreference = "auto" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

const STORAGE_KEY = "theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";
/** each theme's --bg, for <meta name="theme-color"> */
const THEME_COLOR: Record<ResolvedTheme, string> = { light: "#f4f6f9", dark: "#0b1220" };

const isPreference = (value: unknown): value is ThemePreference =>
  value === "auto" || value === "light" || value === "dark";

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === "auto") return systemDark ? "dark" : "light";
  return preference;
}

export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta === null) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = THEME_COLOR[theme];
}

/** localStorage can throw (private mode, blocked storage): every access is guarded */
export function loadThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isPreference(stored) ? stored : "auto";
  } catch {
    return "auto";
  }
}

const systemMedia = (): MediaQueryList | null =>
  typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;

const listeners = new Set<() => void>();
let state: ThemeState | null = null;
let stopWatching: (() => void) | null = null;

const compute = (preference: ThemePreference): ThemeState => ({
  preference,
  resolved: resolveTheme(preference, systemMedia()?.matches ?? false),
});

function publish(next: ThemeState): void {
  state = next;
  applyTheme(next.resolved);
  for (const listener of listeners) listener();
}

/** only `auto` listens to the system */
function watchSystem(preference: ThemePreference): void {
  stopWatching?.();
  stopWatching = null;
  const media = systemMedia();
  if (preference !== "auto" || media === null) return;
  const onChange = (): void => publish(compute("auto"));
  media.addEventListener("change", onChange);
  stopWatching = () => media.removeEventListener("change", onChange);
}

function ensureState(): ThemeState {
  if (state === null) {
    const preference = loadThemePreference();
    state = compute(preference);
    applyTheme(state.resolved);
    watchSystem(preference);
  }
  return state;
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // storage unavailable: the choice still holds for this session
  }
  watchSystem(preference);
  publish(compute(preference));
}

function subscribe(listener: () => void): () => void {
  ensureState();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): ThemeState {
  return useSyncExternalStore(subscribe, ensureState);
}

export function resetThemeForTests(): void {
  stopWatching?.();
  stopWatching = null;
  state = null;
  listeners.clear();
}
