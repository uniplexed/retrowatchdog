import type { SourceBlock } from "@retrowatchdog/shared";

export function SourceStatusNote({ block }: { block: SourceBlock }) {
  if (block.status === "not_configured") {
    return <p className="source-note">Not configured — add API keys to enable this source.</p>;
  }
  if (block.status === "error") {
    return (
      <p className="source-note">
        Source error — {block.points.length > 0
          ? `showing stale data from ${new Date(block.fetchedAt ?? "").toLocaleString()}`
          : "no data available"}.
      </p>
    );
  }
  if (block.status === "ok" && block.points.length === 0) {
    // points are filtered server-side, so empty means no match or no match under the filter
    return <p className="source-note">No listings match this game and filter.</p>;
  }
  return null;
}
