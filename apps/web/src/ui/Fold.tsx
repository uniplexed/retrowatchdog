import type { ReactNode } from "react";

/** A collapsed line that opens to more: the "N possible signals" pattern. */
export function Fold({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="ui-fold">
      <summary>{summary}</summary>
      <div className="ui-fold-body">{children}</div>
    </details>
  );
}
