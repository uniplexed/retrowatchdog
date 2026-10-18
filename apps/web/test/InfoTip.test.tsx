import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InfoTip } from "../src/ui/InfoTip.js";
import { Panel } from "../src/ui/Panel.js";
import { HELP } from "../src/lib/help.js";

afterEach(cleanup);

describe("InfoTip", () => {
  it("names what it explains and, on hover, shows the description and an example", async () => {
    render(<InfoTip topic="kpi.paid" />);
    const button = screen.getByRole("button", { name: "About Paid" });
    // nothing in the page until it is shown: its sample prices are not the page's
    expect(screen.queryByRole("tooltip")).toBeNull();
    await userEvent.hover(button);
    const box = document.getElementById(button.getAttribute("aria-describedby")!)!;
    expect(box).toHaveTextContent(HELP["kpi.paid"].what);
    expect(box).toHaveTextContent(`e.g. ${HELP["kpi.paid"].example}`);
    await userEvent.unhover(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("a tap pins the box open and a second tap closes it", async () => {
    render(<InfoTip topic="kpi.paid" />);
    const button = screen.getByRole("button", { name: "About Paid" });
    await userEvent.click(button);
    await userEvent.unhover(button);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await userEvent.click(button);
    await userEvent.unhover(button);
    // focus still holds it: leaving the button closes it
    await userEvent.tab();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("inside a fold's summary it does not toggle the fold", async () => {
    render(
      <details>
        <summary>
          Clean up <InfoTip topic="fold.cleanUp" />
        </summary>
        body
      </details>,
    );
    await userEvent.click(screen.getByRole("button", { name: "About Clean up" }));
    expect(document.querySelector("details")?.open).toBe(false);
  });

  it("a panel with a topic shows its tip beside the title", () => {
    render(<Panel title="Needs you" info="panel.needsYou">x</Panel>);
    expect(screen.getByRole("button", { name: "About Needs you" })).toBeInTheDocument();
  });

  it("every topic has a description and an example", () => {
    for (const [key, h] of Object.entries(HELP)) {
      expect(h.name, key).not.toBe("");
      expect(h.what.length, key).toBeGreaterThan(10);
      expect(h.example.length, key).toBeGreaterThan(5);
    }
  });
});
