import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Sparkline } from "../src/components/Sparkline.js";

afterEach(cleanup);
const pts = (...usd: number[]) => usd.map((u, i) => ({ day: `2026-10-${String(i + 1).padStart(2, "0")}`, usd: u }));

describe("Sparkline", () => {
  it("draws a line and the percent", () => {
    const { container } = render(<Sparkline points={pts(10, 8, 12.5)} />);
    expect(container.querySelector("polyline")?.getAttribute("points")).toMatch(/^[\d.]+,[\d.]+ /);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".spark-change")?.textContent).toBe("+25%");
  });

  it("a fall reads with a minus sign", () => {
    const { container } = render(<Sparkline points={pts(12, 11)} />);
    expect(container.querySelector(".spark-change")?.textContent).toBe("−8%");
  });

  it("one point draws nothing", () => {
    const { container } = render(<Sparkline points={pts(10)} />);
    expect(container.innerHTML).toBe("");
  });

  it("a flat line has no NaN", () => {
    const { container } = render(<Sparkline points={pts(5, 5, 5)} />);
    expect(container.innerHTML).not.toContain("NaN");
    expect(container.querySelector(".spark-change")?.textContent).toBe("0%");
  });
});
