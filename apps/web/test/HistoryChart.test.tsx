import { afterEach, describe, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { HistoryChart } from "../src/components/HistoryChart.js";
import type { HistorySeriesDto } from "@retrowatchdog/shared";

afterEach(() => cleanup());

const money = (usd: number) => `$${usd.toFixed(2)}`;

const oneSeries: HistorySeriesDto[] = [
  {
    source: "cex" as HistorySeriesDto["source"],
    kind: "sell" as HistorySeriesDto["kind"],
    role: "buy_store",
    points: [
      { day: "2026-09-15", usd: 40, original: { amount: 40, currency: "USD" } },
      { day: "2026-09-16", usd: 44, original: { amount: 44, currency: "USD" } },
    ],
  },
];

describe("HistoryChart", () => {
  it("draws one path per series", () => {
    const { container } = render(
      <HistoryChart series={oneSeries} from="2026-09-15" to="2026-09-16" format={money} labels={["CeX sells"]} title="Pilotwings 64" />,
    );
    expect(container.querySelectorAll("path.history-line")).toHaveLength(1);
  });

  it("breaks the line at a gap instead of drawing across it", () => {
    const gapped: HistorySeriesDto[] = [
      {
        ...oneSeries[0],
        points: [
          { day: "2026-09-15", usd: 40, original: { amount: 40, currency: "USD" } },
          { day: "2026-09-16", usd: 42, original: { amount: 42, currency: "USD" } },
          // 17th missing: the app did not look
          { day: "2026-09-18", usd: 44, original: { amount: 44, currency: "USD" } },
        ],
      },
    ];
    const { container } = render(
      <HistoryChart series={gapped} from="2026-09-15" to="2026-09-18" format={money} labels={["CeX sells"]} title="Pilotwings 64" />,
    );
    // the consecutive 15-16 run draws a connected line...
    const paths = container.querySelectorAll("path.history-line");
    expect(paths).toHaveLength(1);
    expect(paths[0].getAttribute("d") ?? "").toContain("L");
    // ...and the isolated day after the gap is its own dot, not stitched onto the line
    expect(container.querySelectorAll("circle.history-dot")).toHaveLength(1);
  });

  it("breaks the line only once across a two-day gap, not once per missing day", () => {
    const gapped: HistorySeriesDto[] = [
      {
        ...oneSeries[0],
        points: [
          { day: "2026-09-15", usd: 40, original: { amount: 40, currency: "USD" } },
          // 16th and 17th missing: the app did not look either day
          { day: "2026-09-18", usd: 44, original: { amount: 44, currency: "USD" } },
          { day: "2026-09-19", usd: 46, original: { amount: 46, currency: "USD" } },
        ],
      },
    ];
    const { container } = render(
      <HistoryChart series={gapped} from="2026-09-15" to="2026-09-19" format={money} labels={["CeX sells"]} title="Pilotwings 64" />,
    );
    // the isolated day before the gap is a dot, not a stray path
    expect(container.querySelectorAll("circle.history-dot")).toHaveLength(1);
    // the consecutive 18-19 run is a single path with exactly one M, whatever
    // the size of the gap that preceded it
    const paths = container.querySelectorAll("path.history-line");
    expect(paths).toHaveLength(1);
    const d = paths[0].getAttribute("d") ?? "";
    expect(d.match(/M/g)).toHaveLength(1);
    expect(d).toContain("L");
  });

  it("renders three non-adjacent days as three dots and no path", () => {
    const scattered: HistorySeriesDto[] = [
      {
        ...oneSeries[0],
        points: [
          { day: "2026-09-15", usd: 40, original: { amount: 40, currency: "USD" } },
          { day: "2026-09-17", usd: 42, original: { amount: 42, currency: "USD" } },
          { day: "2026-09-19", usd: 44, original: { amount: 44, currency: "USD" } },
        ],
      },
    ];
    const { container } = render(
      <HistoryChart series={scattered} from="2026-09-15" to="2026-09-19" format={money} labels={["CeX sells"]} title="Pilotwings 64" />,
    );
    expect(container.querySelectorAll("circle.history-dot")).toHaveLength(3);
    expect(container.querySelectorAll("path.history-line")).toHaveLength(0);
  });

  it("renders a run of two plus a trailing isolated day as one path and one dot", () => {
    const mixed: HistorySeriesDto[] = [
      {
        ...oneSeries[0],
        points: [
          { day: "2026-09-15", usd: 40, original: { amount: 40, currency: "USD" } },
          { day: "2026-09-16", usd: 42, original: { amount: 42, currency: "USD" } },
          { day: "2026-09-19", usd: 44, original: { amount: 44, currency: "USD" } },
        ],
      },
    ];
    const { container } = render(
      <HistoryChart series={mixed} from="2026-09-15" to="2026-09-19" format={money} labels={["CeX sells"]} title="Pilotwings 64" />,
    );
    expect(container.querySelectorAll("path.history-line")).toHaveLength(1);
    expect(container.querySelectorAll("circle.history-dot")).toHaveLength(1);
  });

  it("labels the y axis with the window's low, middle and high", () => {
    render(
      <HistoryChart series={oneSeries} from="2026-09-15" to="2026-09-16" format={money} labels={["CeX sells"]} title="Pilotwings 64" />,
    );
    expect(screen.getByText("$40.00")).toBeInTheDocument();
    expect(screen.getByText("$42.00")).toBeInTheDocument();
    expect(screen.getByText("$44.00")).toBeInTheDocument();
  });

  it("labels the x axis with the window's first and last day", () => {
    render(
      <HistoryChart series={oneSeries} from="2026-09-15" to="2026-09-16" format={money} labels={["CeX sells"]} title="Pilotwings 64" />,
    );
    expect(screen.getByText("2026-09-15")).toBeInTheDocument();
    expect(screen.getByText("2026-09-16")).toBeInTheDocument();
  });

  it("names the game and every series in its aria-label, so it is not a hole for a screen reader", () => {
    render(
      <HistoryChart series={oneSeries} from="2026-09-15" to="2026-09-16" format={money} labels={["CeX sells"]} title="Pilotwings 64" />,
    );
    const img = screen.getByRole("img");
    expect(img).toHaveAccessibleName(/Pilotwings 64/);
    expect(img).toHaveAccessibleName(/CeX sells/);
    expect(img).toHaveAccessibleName(/\$44\.00/);
  });

  it("renders nothing rather than an empty box when no series has a point", () => {
    const { container } = render(
      <HistoryChart series={[]} from="2026-09-15" to="2026-09-16" format={money} labels={[]} title="Pilotwings 64" />,
    );
    expect(container.querySelector("svg")).toBeNull();
  });

  it("draws a single-point series as a dot, not a zero-length line", () => {
    const one: HistorySeriesDto[] = [{ ...oneSeries[0], points: [{ day: "2026-09-15", usd: 40, original: { amount: 40, currency: "USD" } }] }];
    const { container } = render(
      <HistoryChart series={one} from="2026-09-15" to="2026-09-16" format={money} labels={["CeX sells"]} title="Pilotwings 64" />,
    );
    const dot = container.querySelector("circle.history-dot");
    expect(container.querySelectorAll("circle.history-dot")).toHaveLength(1);
    // a single point has no high/low to scale against: it sits at the plot's
    // vertical centre (VIEW_H 120, PAD.top 6, PAD.bottom 14 -> centre 56)
    expect(dot?.getAttribute("cy")).toBe("56");
  });

  it("renders a flat series at the vertical centre with one honest tick, not a fabricated middle", () => {
    const flat: HistorySeriesDto[] = [
      {
        ...oneSeries[0],
        points: [
          { day: "2026-09-15", usd: 40, original: { amount: 40, currency: "USD" } },
          { day: "2026-09-16", usd: 40, original: { amount: 40, currency: "USD" } },
          { day: "2026-09-17", usd: 40, original: { amount: 40, currency: "USD" } },
        ],
      },
    ];
    const { container } = render(
      <HistoryChart series={flat} from="2026-09-15" to="2026-09-17" format={money} labels={["CeX sells"]} title="Pilotwings 64" />,
    );
    const d = container.querySelector("path.history-line")?.getAttribute("d") ?? "";
    // every coordinate pair's y half sits at the plot's vertical centre (56.0)
    const ys = [...d.matchAll(/[ML][0-9.]+,([0-9.]+)/g)].map((m) => m[1]);
    expect(ys.length).toBeGreaterThan(0);
    expect(ys.every((v) => v === "56.0")).toBe(true);
    expect(screen.getAllByText("$40.00")).toHaveLength(1);
    expect(screen.queryByText("$60.00")).not.toBeInTheDocument();
  });

  it("keeps a series' colour and label aligned to its own index when an earlier series has no points", () => {
    const withGap: HistorySeriesDto[] = [
      { ...oneSeries[0], points: [{ day: "2026-09-15", usd: 40, original: { amount: 40, currency: "USD" } }, { day: "2026-09-16", usd: 44, original: { amount: 44, currency: "USD" } }] },
      { ...oneSeries[0], kind: "cash" as HistorySeriesDto["kind"], points: [] },
      { ...oneSeries[0], kind: "voucher" as HistorySeriesDto["kind"], points: [{ day: "2026-09-15", usd: 30, original: { amount: 30, currency: "USD" } }, { day: "2026-09-16", usd: 32, original: { amount: 32, currency: "USD" } }] },
    ];
    const { container } = render(
      <HistoryChart
        series={withGap}
        from="2026-09-15"
        to="2026-09-16"
        format={money}
        labels={["CeX sells", "CeX pays cash", "CeX pays voucher"]}
        title="Pilotwings 64"
      />,
    );
    const paths = container.querySelectorAll("path.history-line");
    // the empty middle series is skipped in the DOM, but the remaining
    // series must keep the colour/label that matches ITS OWN index in the
    // original `series` array, not a re-numbered position among the drawn ones
    expect(paths).toHaveLength(2);
    expect(paths[1].getAttribute("stroke")).toBe("var(--series-2)");
    const img = screen.getByRole("img");
    expect(img).toHaveAccessibleName(/CeX pays voucher/);
  });

  it("marks a series past the 8-colour palette with a dashed stroke instead of a silently reused solid colour", () => {
    const nine: HistorySeriesDto[] = Array.from({ length: 9 }, (_, i) => ({
      ...oneSeries[0],
      kind: `k${i}` as HistorySeriesDto["kind"],
      points: [
        { day: "2026-09-15", usd: 40 + i, original: { amount: 40 + i, currency: "USD" } },
        { day: "2026-09-16", usd: 44 + i, original: { amount: 44 + i, currency: "USD" } },
      ],
    }));
    const { container } = render(
      <HistoryChart
        series={nine}
        from="2026-09-15"
        to="2026-09-16"
        format={money}
        labels={nine.map((_, i) => `series ${i}`)}
        title="Pilotwings 64"
      />,
    );
    const paths = container.querySelectorAll("path.history-line");
    expect(paths).toHaveLength(9);
    // the 9th series (index 8) wraps back to colour 0 (8 % 8 === 0), same as
    // the 1st (index 0) — the dash is what tells them apart in the chart
    expect(paths[0].getAttribute("stroke")).toBe("var(--series-0)");
    expect(paths[0].hasAttribute("stroke-dasharray")).toBe(false);
    expect(paths[8].getAttribute("stroke")).toBe("var(--series-0)");
    expect(paths[8].hasAttribute("stroke-dasharray")).toBe(true);
  });

  it("floors a sub-2%-span window's y-domain so FX noise reads flat-ish, not as a climb", () => {
    // priceUsd is frozen per day from that day's FX rate: a GBP price the shop
    // never touched still drifts a little in USD as the rate moves. Scaling
    // the y-axis to this window's true [low, high] would stretch that ~0.7%
    // wobble across the whole plot height.
    const fxNoise: HistorySeriesDto[] = [
      {
        ...oneSeries[0],
        points: [
          { day: "2026-09-15", usd: 396.95, original: { amount: 396.95, currency: "USD" } },
          { day: "2026-09-16", usd: 397.8, original: { amount: 397.8, currency: "USD" } },
          { day: "2026-09-17", usd: 398.5, original: { amount: 398.5, currency: "USD" } },
          { day: "2026-09-18", usd: 399.1, original: { amount: 399.1, currency: "USD" } },
          { day: "2026-09-19", usd: 399.61, original: { amount: 399.61, currency: "USD" } },
        ],
      },
    ];
    const { container } = render(
      <HistoryChart series={fxNoise} from="2026-09-15" to="2026-09-19" format={money} labels={["CeX sells"]} title="Pilotwings 64" />,
    );
    const d = container.querySelector("path.history-line")?.getAttribute("d") ?? "";
    const ys = [...d.matchAll(/[ML][0-9.]+,([0-9.]+)/g)].map((m) => Number(m[1]));
    expect(ys.length).toBeGreaterThan(0);
    const plotHeight = 120 - 6 - 14; // VIEW_H - PAD.top - PAD.bottom
    const drawnSpan = Math.max(...ys) - Math.min(...ys);
    expect(drawnSpan).toBeLessThan(plotHeight / 2);
  });
});
