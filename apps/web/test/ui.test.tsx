import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Button, Dialog, Field, Fold, KPI, Menu, Panel, Pill, Row, Segmented, Sheet, StatusBand, SwipeRow, Switch } from "../src/ui/index.js";

afterEach(cleanup);

describe("Button", () => {
  it("applies variant and size classes and fires onClick", async () => {
    const onClick = vi.fn();
    render(
      <Button variant="danger" size="sm" onClick={onClick}>
        Remove
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Remove" });
    expect(button).toHaveClass("ui-btn", "ui-btn-danger", "ui-btn-sm");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("defaults to a secondary medium button that never submits a form", () => {
    render(<Button>Go</Button>);
    const button = screen.getByRole("button", { name: "Go" });
    expect(button).toHaveClass("ui-btn-secondary", "ui-btn-md");
    expect(button).toHaveAttribute("type", "button");
  });

  it("does not fire when disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Pill", () => {
  it.each(["buy", "avoid", "neutral", "potential"] as const)("applies the %s tone", (tone) => {
    render(<Pill tone={tone}>label</Pill>);
    expect(screen.getByText("label")).toHaveClass("ui-pill", `ui-pill-${tone}`);
  });
});

describe("Panel", () => {
  it("renders a header with the title and the action", () => {
    render(
      <Panel title="Prices" action={<button>All</button>}>
        body
      </Panel>,
    );
    expect(screen.getByRole("heading", { name: "Prices" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("renders no header without a title or action", () => {
    const { container } = render(<Panel>body</Panel>);
    expect(container.querySelector("header")).toBeNull();
  });
});

describe("KPI", () => {
  it("shows label, value and delta, and is a button only when it leads somewhere", async () => {
    const onClick = vi.fn();
    const { rerender } = render(<KPI label="Value" value="$739" delta="+2%" />);
    expect(screen.getByText("$739")).toBeInTheDocument();
    expect(screen.getByText("+2%")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<KPI label="Value" value="$739" onClick={onClick} />);
    await userEvent.click(screen.getByRole("button", { name: /Value/ }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("Row", () => {
  it("renders cover, title, meta and right slot; the body is a button when clickable", async () => {
    const onClick = vi.fn();
    render(
      <Row
        cover="https://covers.example/x.jpg"
        title="Shenmue"
        meta="Dreamcast · PAL"
        right={<b>$45</b>}
        onClick={onClick}
        actions={<button>Unwatch</button>}
      />,
    );
    expect(document.querySelector("img")).toHaveAttribute("src", "https://covers.example/x.jpg");
    expect(screen.getByText("Dreamcast · PAL")).toBeInTheDocument();
    expect(screen.getByText("$45")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Shenmue/ }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Unwatch" })).toBeInTheDocument();
  });

  it("has no button when it is not clickable", () => {
    render(<Row title="Static" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("Segmented", () => {
  it("is a labelled group of toggle buttons that reports the choice", async () => {
    const onChange = vi.fn();
    render(
      <Segmented
        aria-label="Region"
        value="PAL"
        onChange={onChange}
        options={[
          { value: "PAL", label: "PAL" },
          { value: "NTSC_U", label: "NTSC-U", ariaLabel: "North America" },
        ]}
      />,
    );
    expect(screen.getByRole("group", { name: "Region" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "PAL" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "North America" })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByRole("button", { name: "North America" }));
    expect(onChange).toHaveBeenCalledWith("NTSC_U");
  });
});

describe("Switch", () => {
  it("reports the opposite value on click and does nothing when disabled", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<Switch checked={false} onChange={onChange} aria-label="Enabled" />);
    const control = screen.getByRole("switch", { name: "Enabled" });
    expect(control).toHaveAttribute("aria-checked", "false");
    await userEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<Switch checked disabled onChange={onChange} aria-label="Enabled" />);
    expect(screen.getByRole("switch", { name: "Enabled" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("switch", { name: "Enabled" }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("Field", () => {
  it("labels its control and keeps the help out of the accessible name", () => {
    render(
      <Field label="Paid" help="What you paid, in the currency you paid it.">
        <input />
      </Field>,
    );
    const input = screen.getByLabelText("Paid");
    expect(input).toHaveAccessibleName("Paid");
    expect(input).toHaveAccessibleDescription("What you paid, in the currency you paid it.");
  });
});

describe("Fold", () => {
  it("shows its body only once opened", async () => {
    render(<Fold summary="7 possible signals">hidden body</Fold>);
    const details = document.querySelector("details")!;
    expect(details.open).toBe(false);
    await userEvent.click(screen.getByText("7 possible signals"));
    expect(details.open).toBe(true);
  });
});

describe("StatusBand", () => {
  it("renders nothing for no notices", () => {
    const { container } = render(<StatusBand notices={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one line per notice with its action", async () => {
    const retry = vi.fn();
    render(
      <StatusBand
        notices={[
          { id: "sources", text: "Sources failed", action: { label: "Retry sources", onClick: retry } },
          { id: "fx", text: "FX is down" },
        ]}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Sources failed");
    expect(screen.getByText("FX is down")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry sources" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe("Pill extra classes", () => {
  it("keeps a caller's extra classes beside the tone", () => {
    render(
      <Pill tone="avoid" className="badge-compact warning">
        tagged
      </Pill>,
    );
    expect(screen.getByText("tagged")).toHaveClass("ui-pill", "ui-pill-avoid", "badge-compact", "warning");
  });
});

describe("Sheet", () => {
  function Harness({ onClose }: { onClose?: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>Open</button>
        <Sheet
          open={open}
          title="Edit copy"
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
        >
          <input aria-label="Notes" />
        </Sheet>
      </>
    );
  }

  it("renders nothing when closed", () => {
    render(<Sheet open={false} title="Edit copy" onClose={() => {}}>body</Sheet>);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("body")).toBeNull();
  });

  it("Esc closes and returns focus", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Open" });
    await userEvent.click(opener);
    expect(screen.getByRole("dialog", { name: "Edit copy" })).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Notes"));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("backdrop click and the close button close", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await userEvent.click(document.querySelector(".ui-sheet-backdrop") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("modal focus and scroll", () => {
  it("Tab stays inside an open sheet and the page behind does not scroll", async () => {
    render(
      <>
        <button type="button">Behind</button>
        <Sheet open title="Edit copy" onClose={() => {}}>
          <input aria-label="Notes" />
        </Sheet>
      </>,
    );
    expect(document.body.style.overflow).toBe("hidden");
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Behind" })).not.toHaveFocus();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("closing gives the page its scroll back", () => {
    const { rerender } = render(<Sheet open title="Edit copy" onClose={() => {}}>body</Sheet>);
    rerender(<Sheet open={false} title="Edit copy" onClose={() => {}}>body</Sheet>);
    expect(document.body.style.overflow).toBe("");
  });

  it("a dialog over a sheet keeps Tab to itself", async () => {
    render(
      <Sheet open title="cex" onClose={() => {}}>
        <input aria-label="Pace" />
        <Dialog open title="Remove plugin" body="Gone." confirmLabel="Remove" tone="danger" onConfirm={() => {}} onCancel={() => {}} />
      </Sheet>,
    );
    for (let i = 0; i < 4; i += 1) {
      await userEvent.tab();
      expect(screen.getByRole("alertdialog").contains(document.activeElement)).toBe(true);
    }
  });
});

describe("Sheet on the phone", () => {
  it("dragging the handle down closes it; a short drag does not", () => {
    const onClose = vi.fn();
    render(<Sheet open title="Edit copy" onClose={onClose}>body</Sheet>);
    const handle = document.querySelector(".ui-sheet-handle") as HTMLElement;
    const drag = (dy: number) => {
      fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
      fireEvent.pointerUp(handle, { clientY: 100 + dy, pointerId: 1 });
    };
    drag(40);
    expect(onClose).not.toHaveBeenCalled();
    drag(120);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("Dialog", () => {
  it("confirms and cancels", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <Dialog open title="Remove eBay?" body="Its stored prices are deleted." confirmLabel="Remove" tone="danger" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    const dialog = screen.getByRole("alertdialog", { name: "Remove eBay?" });
    expect(dialog).toHaveTextContent("Its stored prices are deleted.");
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("Dialog inside a Sheet", () => {
  it("Esc closes only the dialog", async () => {
    const onClose = vi.fn();
    const onCancel = vi.fn();
    render(
      <Sheet open title="cex" onClose={onClose}>
        <Dialog open title="Remove plugin" body="Gone." confirmLabel="Remove" tone="danger" onConfirm={() => {}} onCancel={onCancel} />
      </Sheet>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a danger dialog starts on Cancel, so a reflex Enter does not destroy", () => {
    render(<Dialog open title="Remove plugin" body="Gone." confirmLabel="Remove" tone="danger" onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });
});

describe("Menu outside clicks", () => {
  it("closes on a click outside", async () => {
    render(
      <>
        <p>page</p>
        <Menu label="Game options">
          <button type="button">Refresh now</button>
        </Menu>
      </>,
    );
    const details = document.querySelector("details.ui-menu") as HTMLDetailsElement;
    await userEvent.click(screen.getByLabelText("Game options"));
    expect(details.open).toBe(true);
    await userEvent.click(screen.getByText("page"));
    expect(details.open).toBe(false);
  });
});

describe("SwipeRow, more than one", () => {
  const two = (onOpen = vi.fn()) => {
    render(
      <>
        <p>page</p>
        <SwipeRow actions={[{ label: "Edit", onClick: () => {} }]}>
          <Row title="Dr. Mario" onClick={onOpen} />
        </SwipeRow>
        <SwipeRow actions={[{ label: "Edit", ariaLabel: "Edit two", onClick: () => {} }]}>
          <Row title="Tetris" />
        </SwipeRow>
      </>,
    );
    return [...document.querySelectorAll(".ui-swipe")] as HTMLElement[];
  };
  const swipeOpen = (el: HTMLElement) => {
    fireEvent.pointerDown(el, { clientX: 200, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(el, { clientX: 100, clientY: 100, pointerId: 1 });
  };

  it("a tap elsewhere closes an open row", async () => {
    const [first] = two();
    swipeOpen(first);
    expect(first).toHaveClass("open");
    fireEvent.pointerDown(screen.getByText("page"));
    expect(first).not.toHaveClass("open");
  });

  it("opening one row closes the other", () => {
    const [first, second] = two();
    swipeOpen(first);
    swipeOpen(second);
    expect(first).not.toHaveClass("open");
    expect(second).toHaveClass("open");
  });

  it("a tap on an open row closes it instead of opening the game", async () => {
    const onOpen = vi.fn();
    const [first] = two(onOpen);
    swipeOpen(first);
    await userEvent.click(screen.getByText("Dr. Mario"));
    expect(onOpen).not.toHaveBeenCalled();
    expect(first).not.toHaveClass("open");
    await userEvent.click(screen.getByText("Dr. Mario"));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe("Menu", () => {
  it("closes after an item is chosen", async () => {
    const onPick = vi.fn();
    render(
      <Menu label="Game options">
        <button type="button" onClick={onPick}>Refresh now</button>
      </Menu>,
    );
    const details = document.querySelector("details.ui-menu") as HTMLDetailsElement;
    await userEvent.click(screen.getByLabelText("Game options"));
    expect(details.open).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    expect(onPick).toHaveBeenCalledOnce();
    expect(details.open).toBe(false);
  });
});

describe("SwipeRow", () => {
  const renderRow = (onEdit = vi.fn()) => {
    render(
      <SwipeRow actions={[{ label: "Edit", onClick: onEdit }, { label: "Unwatch", onClick: () => {}, tone: "danger" }]}>
        <Row title="Dr. Mario" />
      </SwipeRow>,
    );
    return document.querySelector(".ui-swipe") as HTMLElement;
  };
  const drag = (el: HTMLElement, dx: number, dy: number) => {
    fireEvent.pointerDown(el, { clientX: 200, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 200 + dx, clientY: 100 + dy, pointerId: 1 });
    fireEvent.pointerUp(el, { clientX: 200 + dx, clientY: 100 + dy, pointerId: 1 });
  };

  it("actions are in the DOM before any swipe", async () => {
    const onEdit = vi.fn();
    const row = renderRow(onEdit);
    expect(row).not.toHaveClass("open");
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Unwatch" })).toBeInTheDocument();
  });

  it("a left drag past 64 px opens, a right drag closes", () => {
    const row = renderRow();
    drag(row, -40, 0);
    expect(row).not.toHaveClass("open");
    drag(row, -80, 4);
    expect(row).toHaveClass("open");
    drag(row, 80, 0);
    expect(row).not.toHaveClass("open");
  });

  it("a mostly vertical drag does not open", () => {
    const row = renderRow();
    drag(row, -70, 90);
    expect(row).not.toHaveClass("open");
  });
});
