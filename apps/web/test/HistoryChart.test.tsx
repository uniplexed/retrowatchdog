import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HistoryChart } from "../src/components/HistoryChart.js";

// What the chart DRAWS is chartOption's, tested in chartOption.test.ts; a test
// DOM has no layout, so the component's own job here is the box and its words.
afterEach(cleanup);

const fmt = (usd: number): string => `$${usd.toFixed(2)}`;

describe("HistoryChart", () => {
  it("names the game, the window and every series' latest value for a screen reader", () => {
    render(
      <HistoryChart
        series={[{ points: [{ day: "2026-01-01", usd: 10 }, { day: "2026-01-02", usd: 12 }] }, { points: [] }, { points: [{ day: "2026-01-02", usd: 30 }] }]}
        from="2026-01-01"
        to="2026-01-31"
        format={fmt}
        labels={["CeX", "empty", "eBay"]}
        title="Zelda"
      />,
    );
    expect(screen.getByRole("img")).toHaveAccessibleName(
      "History of Zelda, 2026-01-01 to 2026-01-31. CeX: $12.00 on 2026-01-02. eBay: $30.00 on 2026-01-02.",
    );
  });

  it("renders nothing rather than an empty box when no series has a point", () => {
    const { container } = render(
      <HistoryChart series={[{ points: [] }]} from="2026-01-01" to="2026-01-31" format={fmt} labels={["CeX"]} title="Zelda" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
