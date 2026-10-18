import type { VitePWAOptions } from "vite-plugin-pwa";

/**
 * Navigation requests the service worker must NOT answer with the app shell:
 * a `<a href="/api/collection/export" download>` click is a navigation, and
 * without this an installed PWA saved index.html under the .csv name.
 */
export const NAVIGATE_FALLBACK_DENYLIST: readonly RegExp[] = [/^\/api\//];

/** Test hook: would a navigation to this path fall back to the app shell? */
export function servedByNavigationFallback(path: string): boolean {
  return !NAVIGATE_FALLBACK_DENYLIST.some((re) => re.test(path));
}

/** The one PWA configuration, shared by vite.config.ts and the tests. */
export const pwaOptions: Partial<VitePWAOptions> = {
  registerType: "autoUpdate",
  manifest: {
    name: "RetroWatchdog",
    short_name: "RetroWatchdog",
    display: "standalone",
    theme_color: "#f4f6f9",
    background_color: "#f4f6f9",
    icons: [], // placeholder icons are a Phase 2 nicety
  },
  workbox: {
    navigateFallbackDenylist: [...NAVIGATE_FALLBACK_DENYLIST],
  },
};
