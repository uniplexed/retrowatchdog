import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VERDICT_EMPTY_TITLE, type Signal, type Verdict as VerdictData } from "@retrowatchdog/shared";
import { Verdict } from "../src/ui/Verdict.js";

afterEach(cleanup);

const signal: Signal = { type: "UNDERPRICED", reasoning: "r", confidence: "high" };

describe("Verdict", () => {
  it("shows the title, the reason and a listing link that opens a new tab", () => {
    const verdict: VerdictData = {
      tone: "buy", title: "Buy on eBay UK for £31.90", reason: "68% under the median", signal,
      action: { label: "View listing →", url: "https://ebay.example/1" },
    };
    const { container } = render(<Verdict verdict={verdict} />);
    expect(screen.getByText("Best move today")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Buy on eBay UK for £31.90" })).toBeInTheDocument();
    expect(screen.getByText("68% under the median")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "View listing →" });
    expect(link).toHaveAttribute("href", "https://ebay.example/1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(container.querySelector(".ui-verdict")).toHaveAttribute("data-tone", "buy");
  });

  it("offers Edit watch only when the screen can open the editor", async () => {
    const verdict: VerdictData = { tone: "buy", title: "Target hit", reason: "r", signal, action: { label: "Edit watch", kind: "edit-watch" } };
    const { rerender } = render(<Verdict verdict={verdict} />);
    expect(screen.queryByRole("button", { name: "Edit watch" })).toBeNull();
    const onEditWatch = vi.fn();
    rerender(<Verdict verdict={verdict} onEditWatch={onEditWatch} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit watch" }));
    expect(onEditWatch).toHaveBeenCalledOnce();
  });

  it("says nothing is clear when there is no verdict", () => {
    const { container } = render(<Verdict verdict={null} />);
    expect(screen.getByRole("heading", { name: VERDICT_EMPTY_TITLE })).toBeInTheDocument();
    expect(container.querySelector(".ui-verdict")).toHaveAttribute("data-tone", "neutral");
    expect(screen.queryByText("Best move today")).toBeNull();
  });
});
