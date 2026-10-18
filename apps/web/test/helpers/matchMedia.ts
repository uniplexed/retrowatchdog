import { vi } from "vitest";

export interface MediaStub {
  readonly matches: boolean;
  /** sets `matches` and fires every registered change listener */
  emit(matches: boolean): void;
}

type Listener = (event: { matches: boolean }) => void;

/**
 * Replaces window.matchMedia with a controllable stub. `dark` answers the
 * prefers-color-scheme query, `desktop` the min-width query; any other query
 * answers false. Undo with vi.unstubAllGlobals().
 */
export function stubMatchMedia(initial: { dark?: boolean; desktop?: boolean } = {}): {
  dark: MediaStub;
  desktop: MediaStub;
} {
  const make = (start: boolean) => {
    const listeners = new Set<Listener>();
    const stub = {
      matches: start,
      listeners,
      emit(next: boolean) {
        stub.matches = next;
        for (const listener of [...listeners]) listener({ matches: next });
      },
    };
    return stub;
  };
  const dark = make(initial.dark ?? false);
  const desktop = make(initial.desktop ?? false);
  vi.stubGlobal("matchMedia", (query: string) => {
    const target = query.includes("prefers-color-scheme") ? dark : query.includes("min-width") ? desktop : null;
    return {
      media: query,
      get matches() {
        return target?.matches ?? false;
      },
      addEventListener: (_type: string, listener: Listener) => target?.listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => target?.listeners.delete(listener),
    };
  });
  return { dark, desktop };
}
