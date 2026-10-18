import type { ReactNode } from "react";
import type { HelpTopic } from "../lib/help.js";
import { InfoTip } from "./InfoTip.js";

/** One headline number; a button only when it leads somewhere. */
export function KPI({
  label,
  value,
  delta,
  onClick,
  info,
}: {
  label: string;
  /** an ⓘ explaining the number; kept outside the button (no button in a button) */
  info?: HelpTopic;
  value: ReactNode;
  delta?: ReactNode;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="ui-kpi-label">{label}</span>
      <span className="kpi-value ui-kpi-value">{value}</span>
      {delta !== undefined && <span className="ui-kpi-delta">{delta}</span>}
    </>
  );
  const kpi =
    onClick === undefined ? (
      <div className="ui-kpi">{body}</div>
    ) : (
      <button type="button" className="ui-kpi ui-kpi-link" onClick={onClick}>
        {body}
      </button>
    );
  if (info === undefined) return kpi;
  return (
    <div className="ui-kpi-box">
      {kpi}
      <span className="ui-kpi-info">
        <InfoTip topic={info} />
      </span>
    </div>
  );
}
