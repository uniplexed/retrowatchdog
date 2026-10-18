import { useSyncExternalStore } from "react";

/**
 * Per-browser view preferences: how things are drawn, never what is computed.
 * The engine does not read them, so a preference can change nothing a bark
 * (signal) says. Same shape as theme.ts: localStorage, guarded, one store.
 */
const EBAY_OWN_BLOCK_KEY = "ebayOwnBlock";

let ebayOwnBlock: boolean | null = null;
const listeners = new Set<() => void>();

function load(): boolean {
  try {
    return window.localStorage.getItem(EBAY_OWN_BLOCK_KEY) === "1";
  } catch {
    return false;
  }
}

function current(): boolean {
  if (ebayOwnBlock === null) ebayOwnBlock = load();
  return ebayOwnBlock;
}

/** eBay rows drawn in a block of their own inside each price panel (eBay's licence asks for it). */
export function setEbayOwnBlock(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(EBAY_OWN_BLOCK_KEY, "1");
    else window.localStorage.removeItem(EBAY_OWN_BLOCK_KEY);
  } catch {
    // storage unavailable: the choice still holds for this session
  }
  ebayOwnBlock = on;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEbayOwnBlock(): boolean {
  return useSyncExternalStore(subscribe, current, () => false);
}

export function resetViewPrefsForTests(): void {
  ebayOwnBlock = null;
  listeners.clear();
}
