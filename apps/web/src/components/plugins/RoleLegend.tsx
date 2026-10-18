import type { PriceRole } from "@retrowatchdog/shared";
import { ROLE_MEANING, ROLE_SHORT } from "./copy.js";

/**
 * What the roles on this card mean, once per card, listing only roles present.
 * `open` in the EDITOR, where the definitions are part of the consent;
 * collapsed on the record.
 */
export function RoleLegend({ roles, open }: { roles: readonly PriceRole[]; open: boolean }) {
  if (roles.length === 0) return null;
  const lines = roles.map((role) => (
    <p className="meta" key={role}>
      <strong>{ROLE_SHORT[role]}</strong> — {ROLE_MEANING[role]}
    </p>
  ));
  if (open) return <div className="role-legend">{lines}</div>;
  return (
    <details className="stock-details">
      <summary>Roles</summary>
      {lines}
    </details>
  );
}
