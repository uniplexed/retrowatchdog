import { useSyncExternalStore } from "react";
import type { PriceKind, SourceInfo, SourceInfoDto } from "@retrowatchdog/shared";
import { KIND_LABEL_FALLBACK } from "@retrowatchdog/shared";
import { getSources } from "../api/client.js";

/**
 * Every source THIS deployment has, fetched at boot from GET /api/sources —
 * never bundled, since plugin sources arrive at runtime. Same module-store
 * shape as lib/money.ts.
 */

/**
 * Whether this app KNOWS its deployment's sources yet.
 *
 * - `loading`: boot, or a retry in flight.
 * - `ready`: an id absent from the registry is genuinely absent.
 * - `failed`: nothing is known; App shows a retry banner.
 *
 * Not cosmetic: `kindRoles` carries the buy/sell split, so GameDetail hides
 * a source's prices entirely until `ready` rather than guess.
 */
export type SourcesStatus = "loading" | "ready" | "failed";

export interface SourcesState {
  /** the registry in the order the API served it */
  list: SourceInfoDto[];
  /**
   * The same sources keyed by id. NULL-PROTOTYPE: ids are plugin-authored
   * data, and a plain `{}` answers `byId["constructor"]` with an inherited
   * function that `?.` does not stop.
   */
  byId: Record<string, SourceInfo>;
  /** see SourcesStatus — read by GameDetail's price gate and App's banner */
  status: SourcesStatus;
}

function emptyById(): Record<string, SourceInfo> {
  return Object.create(null) as Record<string, SourceInfo>;
}

const EMPTY_STATE: SourcesState = { list: [], byId: emptyById(), status: "loading" };

let state: SourcesState = EMPTY_STATE;
const listeners = new Set<() => void>();
/** Drops out-of-order loads; bumped by every load and both test hooks. */
let loadSeq = 0;

/**
 * Automatic re-attempts after a failed load: enough to cover the api
 * container starting during a redeploy, bounded so a down API is not polled
 * forever by every tab.
 */
const RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 10_000];
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** Drop any scheduled re-attempt: a newer load, or a test, has taken over. */
function cancelScheduledRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function publish(next: SourcesState): void {
  state = next;
  for (const listener of listeners) listener();
}

function index(list: SourceInfoDto[]): SourcesState {
  const byId = emptyById();
  for (const source of list) byId[source.id] = source;
  return { list, byId, status: "ready" };
}

export function subscribeSources(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSourcesSnapshot(): SourcesState {
  return state;
}

/** React binding: a subscribing component re-renders when the registry lands. */
export function useSources(): SourcesState {
  return useSyncExternalStore(subscribeSources, getSourcesSnapshot);
}

/**
 * Fetch the registry. Never rejects: a failure is recorded as `failed` (so
 * it is visible) and schedules RETRY_DELAYS_MS re-attempts, restarted from
 * the top by every outside call.
 */
export async function loadSources(): Promise<void> {
  cancelScheduledRetry();
  await attemptLoad(0);
}

/** One attempt, plus the scheduling of the next. */
async function attemptLoad(retryIndex: number): Promise<void> {
  const seq = ++loadSeq;
  // a retry shows "loading" while in flight
  if (state.status === "failed") publish(EMPTY_STATE);
  try {
    const { sources } = await getSources();
    if (seq !== loadSeq) return; // a later load, or a test, won the race
    publish(index(sources));
  } catch {
    if (seq !== loadSeq) return;
    publish({ list: [], byId: emptyById(), status: "failed" });
    const delay = RETRY_DELAYS_MS[retryIndex];
    if (delay === undefined) return; // ladder spent: the banner is the way back
    cancelScheduledRetry();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      // anything that moved the registry since owns the state now
      if (seq !== loadSeq) return;
      void attemptLoad(retryIndex + 1);
    }, delay);
  }
}

/**
 * The display name of a source; an id absent from the registry renders as itself.
 */
export function sourceLabel(id: string, snapshot: SourcesState = state): string {
  return snapshot.byId[id]?.label ?? id;
}

/**
 * This source's own wording for a price kind ("CeX UK pays voucher"), falling
 * back to the kind's shared wording ("pays voucher"), which still names the
 * direction the money flows.
 */
export function kindLabel(id: string, kind: PriceKind, snapshot: SourcesState = state): string {
  return snapshot.byId[id]?.kindLabels?.[kind] ?? KIND_LABEL_FALLBACK[kind];
}

/**
 * Test hook: the registry a test wants, marked `ready`. `[]` means "no
 * sources", not "not loaded" — for that, see resetSourcesForTests.
 */
export function setSourcesForTests(list: SourceInfoDto[]): void {
  loadSeq++;
  cancelScheduledRetry();
  publish(index(list));
}

/** Test hook: back to the boot state — nothing loaded, nothing known yet. */
export function resetSourcesForTests(): void {
  loadSeq++;
  cancelScheduledRetry();
  publish(EMPTY_STATE);
}
