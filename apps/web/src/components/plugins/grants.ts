import type {
  PluginDto,
  PluginSourceDto,
  PriceKind,
  PriceRole,
  SourceId,
} from "@retrowatchdog/shared";
import { KIND_LABEL_FALLBACK, PRICE_KINDS } from "@retrowatchdog/shared";
import { ROLE_SHORT } from "./copy.js";

/**
 * What a plugin is granted, and what a review would grant it — the Plugins
 * panel's arithmetic, kept out of the DOM so it is testable against fixtures.
 */

/** Which question the editor is open to answer. */
export type EditorMode = "approve" | "update" | "edit" | "enable";

/**
 * What the approval form proposes, decided PER SOURCE (not per plugin).
 *
 * FIRST review (`approvedKinds` empty): everything declared except
 * `reference`, the baseline every other source is judged against — granting
 * it must be deliberate. A source granted nothing is dropped by the registry,
 * so an empty grant is read as "not reviewed yet"; re-offering is the lesser
 * error.
 *
 * RE-REVIEW: what the user chose last time, so a republish never undoes a
 * refusal. A kind is re-checked only if previously approved AND its role is
 * unchanged (`approvedKindRoles`) — a kind promoted to `reference` arrives
 * unchecked.
 */
export function defaultCheckedKinds(source: PluginSourceDto): PriceKind[] {
  const declared = Object.keys(source.kindRoles) as PriceKind[];
  if (source.approvedKinds.length === 0) {
    return declared.filter((kind) => source.kindRoles[kind] !== "reference");
  }
  return standingGrant(source);
}

/** What this source holds right now: granted, and under the role it still declares. */
function standingGrant(source: PluginSourceDto): PriceKind[] {
  return (Object.keys(source.kindRoles) as PriceKind[]).filter(
    (kind) =>
      source.approvedKinds.includes(kind) &&
      source.approvedKindRoles[kind] === source.kindRoles[kind],
  );
}

/**
 * The ticks the editor OPENS with. `approve`/`update`/`enable` answer the
 * plugin's question and use `defaultCheckedKinds`; `edit` answers the user's
 * and opens on the standing grant only, so Edit + Save never grants a source
 * nobody chose.
 */
export function checkedForMode(source: PluginSourceDto, mode: EditorMode): PriceKind[] {
  return mode === "edit" ? standingGrant(source) : defaultCheckedKinds(source);
}

/** This source's own wording for a kind, or the app's shared wording. */
export function kindWording(source: PluginSourceDto, kind: PriceKind): string {
  return source.kindLabels?.[kind] ?? KIND_LABEL_FALLBACK[kind];
}

/**
 * The columns of the grants table: every kind any source of this document
 * declares or has been granted, in the app's own order. A granted kind no
 * longer declared keeps its column: that is the case the user most needs to see.
 */
export function kindColumns(sources: readonly PluginSourceDto[]): PriceKind[] {
  return PRICE_KINDS.filter((kind) =>
    sources.some((source) => kind in source.kindRoles || source.approvedKinds.includes(kind)),
  );
}

/**
 * The role to print in a column header: the one every source that declares
 * this kind agrees on, `"varies"` when they disagree, or null when none
 * declares it. On `"varies"` each cell carries its own role.
 */
export function columnRole(
  sources: readonly PluginSourceDto[],
  kind: PriceKind,
): PriceRole | "varies" | null {
  const roles = new Set<PriceRole>();
  for (const source of sources) {
    const role = source.kindRoles[kind];
    if (role !== undefined) roles.add(role);
  }
  if (roles.size === 0) return null;
  if (roles.size > 1) return "varies";
  return [...roles][0]!;
}

export type CellState = "granted" | "offered" | "absent" | "granted-no-role";

/**
 * What one cell of the grants table says about one (source, kind).
 * `granted-no-role`: granted, but no declared role reads it.
 */
export function cellState(source: PluginSourceDto, kind: PriceKind): CellState {
  const granted = source.approvedKinds.includes(kind);
  const declared = kind in source.kindRoles;
  if (granted) return declared ? "granted" : "granted-no-role";
  return declared ? "offered" : "absent";
}

/** What one source of a non-approved row is granted, in the roles it was granted under. */
export function grantSummary(source: PluginSourceDto): string[] {
  return source.approvedKinds.map((kind) => {
    const role = source.approvedKindRoles[kind];
    return role === undefined
      ? kindWording(source, kind)
      : `${kindWording(source, kind)} (${ROLE_SHORT[role]})`;
  });
}

/**
 * The document a review is ABOUT, and its fingerprint: the `proposed` one
 * when the plugin published something newer, else the served one.
 */
export interface ReviewDocument {
  name: string;
  version: string;
  requiredSecrets: string[];
  sources: PluginSourceDto[];
  fingerprint: string | null;
  /** whether this is the document the row is otherwise described by */
  isProposal: boolean;
}

export function documentUnderReview(plugin: PluginDto): ReviewDocument {
  const proposed = plugin.proposed;
  if (proposed !== null) {
    return { ...proposed, fingerprint: proposed.manifestFingerprint, isProposal: true };
  }
  return {
    name: plugin.name,
    version: plugin.version,
    requiredSecrets: plugin.requiredSecrets,
    sources: plugin.sources,
    fingerprint: plugin.manifestFingerprint,
    isProposal: false,
  };
}

/**
 * Whether this row has anything to review the plugin ASKED for, which is
 * exactly two cases: it has never been approved (pending, or disabled and
 * waiting to be switched back on), or the plugin has published a document the
 * user has not seen. `edit` is offered separately.
 */
export function needsReview(plugin: PluginDto): boolean {
  return plugin.status !== "approved" || plugin.proposed !== null;
}

/** Which mode the plugin's own pending question would open in, if it has one. */
export function reviewMode(plugin: PluginDto): EditorMode {
  if (plugin.proposed !== null) return "update";
  if (plugin.status === "disabled") return "enable";
  return "approve";
}

/**
 * The payload of an approval: every source of the document. `approvePlugin`
 * replaces `approved_kinds` wholesale, so an omitted source is a revoked one.
 */
export function approvalPayload(
  sources: readonly PluginSourceDto[],
  checked: Record<SourceId, PriceKind[]>,
): Record<SourceId, PriceKind[]> {
  const payload: Record<SourceId, PriceKind[]> = {};
  for (const source of sources) payload[source.id] = checked[source.id] ?? [];
  return payload;
}

/** Whether the ticks differ from what the editor opened with. */
export function grantsChanged(
  sources: readonly PluginSourceDto[],
  seed: Record<SourceId, PriceKind[]>,
  checked: Record<SourceId, PriceKind[]>,
): boolean {
  return sources.some((source) => {
    const before = [...(seed[source.id] ?? [])].sort();
    const now = [...(checked[source.id] ?? [])].sort();
    return before.length !== now.length || before.some((kind, i) => kind !== now[i]);
  });
}

/**
 * Whether saving these ticks would leave the deployment with no `reference`
 * (baseline) grant at all — valuation, PROFIT and every bargain/flip bark
 * depend on one. `othersHoldBaseline` covers grants held by other plugins.
 */
export function dropsLastBaseline(
  sources: readonly PluginSourceDto[],
  checked: Record<SourceId, PriceKind[]>,
  othersHoldBaseline: boolean,
): boolean {
  if (othersHoldBaseline) return false;
  const heldBefore = sources.some((source) =>
    source.approvedKinds.some((kind) => source.approvedKindRoles[kind] === "reference"),
  );
  if (!heldBefore) return false;
  const heldAfter = sources.some((source) =>
    (checked[source.id] ?? []).some((kind) => source.kindRoles[kind] === "reference"),
  );
  return !heldAfter;
}
