import { useId, useState, type MouseEvent } from "react";
import { HELP, type HelpTopic } from "../lib/help.js";

/**
 * ⓘ beside a title: hover, focus or a tap shows what the title does with one
 * concrete example. The box exists only while shown, so its sample prices are
 * never read as the page's own. Inside a fold's <summary> the click is kept
 * from toggling the fold.
 */
export function InfoTip({ topic }: { topic: HelpTopic }) {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const help = HELP[topic];
  const open = hovered || pinned;
  const toggle = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setPinned((p) => !p);
  };
  return (
    <span className="info-tip" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <button
        type="button"
        className="info-tip-button"
        aria-label={`About ${help.name}`}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={toggle}
        onFocus={() => setHovered(true)}
        onBlur={() => {
          setHovered(false);
          setPinned(false);
        }}
      >
        ⓘ
      </button>
      {open && (
        <span role="tooltip" id={id} className="info-tip-box">
          {help.what} <span className="info-tip-example">e.g. {help.example}</span>
        </span>
      )}
    </span>
  );
}
