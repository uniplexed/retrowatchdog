import type { ReactNode } from "react";
import type { HelpTopic } from "../lib/help.js";
import { InfoTip } from "./InfoTip.js";

/** A titled block; the header exists only when there is a title or an action. */
export function Panel({
  title,
  info,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  /** an ⓘ beside the title explaining the block */
  info?: HelpTopic;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={["ui-panel", className].filter(Boolean).join(" ")}>
      {(title !== undefined || action !== undefined) && (
        <header className="ui-panel-head">
          {title !== undefined && (
            <span className="ui-panel-title">
              <h3>{title}</h3>
              {info !== undefined && <InfoTip topic={info} />}
            </span>
          )}
          {action !== undefined && <div className="ui-panel-action">{action}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
