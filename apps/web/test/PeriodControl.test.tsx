import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PeriodControl } from "../src/components/PeriodControl.js";
import { loadPeriod, resolvePeriod } from "../src/lib/period.js";

afterEach(cleanup);

describe("PeriodControl", () => {
  it("starts on 90 days and stores the period chosen, for every chart at once", async () => {
    render(<PeriodControl />);
    const group = screen.getByRole("group", { name: "Period" });
    expect(within(group).getByRole("button", { name: "90 days" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(group).getByRole("button", { name: "1 year" }));
    expect(loadPeriod()).toEqual({ preset: "1y" });
    expect(screen.queryByLabelText("From")).toBeNull();
  });

  it("custom opens two dates seeded with the window on screen", async () => {
    render(<PeriodControl />);
    const before = resolvePeriod({ preset: "90d" });
    await userEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect(screen.getByLabelText("From")).toHaveValue(before.from);
    expect(screen.getByLabelText("To")).toHaveValue(before.to);
    expect(loadPeriod()).toEqual({ preset: "custom", from: before.from, to: before.to });
  });
});
