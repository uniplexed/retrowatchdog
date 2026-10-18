import type { PluginSourceDto, PriceKind } from "@retrowatchdog/shared";
import { KIND_LABEL_FALLBACK } from "@retrowatchdog/shared";
import { ROLE_SHORT } from "./copy.js";
import { cellState, columnRole, kindColumns } from "./grants.js";

/**
 * What each market of an APPROVED plugin is allowed to do, as a table.
 *
 * APPROVED ROWS ONLY, for correctness: header roles come from `kindRoles`,
 * which matches the granted roles only for an approved row; a drifted
 * `manifest_seen` could print `baseline` over a `bid` grant.
 *
 * Uses the app's wording, never the plugin's `kindLabels`: a plugin must not
 * be able to disguise a column.
 */
export function GrantMatrix({ sources }: { sources: readonly PluginSourceDto[] }) {
  const kinds = kindColumns(sources);
  if (kinds.length === 0) return null;
  const roles = kinds.map((kind) => columnRole(sources, kind));
  const anyNoRole = sources.some((source) =>
    kinds.some((kind) => cellState(source, kind) === "granted-no-role"),
  );

  return (
    <>
      <table className="grant-table">
        <thead>
          <tr>
            <th scope="col">Market</th>
            {kinds.map((kind, i) => (
              <th className="grant" scope="col" key={kind}>
                {KIND_LABEL_FALLBACK[kind]}
                <span className="meta"> {headerRole(roles[i])}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => (
            <tr key={source.id}>
              <th scope="row">{source.label}</th>
              {kinds.map((kind, i) => (
                <Cell key={kind} source={source} kind={kind} varies={roles[i] === "varies"} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="meta">
        ✓ granted · offered, not granted — not offered
        {anyNoRole && " ✓? granted, no role declared"}
      </p>
      {sources
        .filter((source) => source.approvedKinds.length === 0)
        .map((source) => (
          <p className="meta" key={source.id}>
            {source.label}: nothing granted, not in Markets.
          </p>
        ))}
    </>
  );
}

/** The role a column header prints, when one role can speak for the column. */
function headerRole(role: ReturnType<typeof columnRole>): string {
  if (role === null) return "no role";
  if (role === "varies") return "varies";
  return ROLE_SHORT[role];
}

/** One cell; the aria-label is the whole sentence, since glyphs are ambiguous. */
function Cell({
  source,
  kind,
  varies,
}: {
  source: PluginSourceDto;
  kind: PriceKind;
  varies: boolean;
}) {
  const state = cellState(source, kind);
  const wording = KIND_LABEL_FALLBACK[kind];
  const role = source.kindRoles[kind];
  if (state === "absent") {
    return (
      <td className="grant" aria-label={`${source.label} does not offer ${wording}`}>
        —
      </td>
    );
  }
  if (state === "offered") {
    return (
      <td className="grant" aria-label={`${source.label}: ${wording} offered, not granted`}>
        ·
      </td>
    );
  }
  if (state === "granted-no-role") {
    return (
      <td
        className="grant"
        aria-label={`${source.label}: ${wording} granted, but this plugin declares no role for it`}
      >
        ✓?
      </td>
    );
  }
  return (
    <td
      className="grant"
      aria-label={`${source.label}: ${wording} granted as ${role === undefined ? "no role" : ROLE_SHORT[role]}`}
    >
      {/* A "varies" column: the cell names its own role. */}
      {varies && role !== undefined ? `✓ ${ROLE_SHORT[role]}` : "✓"}
    </td>
  );
}
