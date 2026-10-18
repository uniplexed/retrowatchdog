import type { ReactNode } from "react";

export type PillTone = "buy" | "avoid" | "neutral" | "potential";

/** A small status tag; `potential` is the dashed, low-confidence look. */
export function Pill({
  tone,
  title,
  className,
  children,
}: {
  tone: PillTone;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={["ui-pill", `ui-pill-${tone}`, className].filter(Boolean).join(" ")} title={title}>
      {children}
    </span>
  );
}
