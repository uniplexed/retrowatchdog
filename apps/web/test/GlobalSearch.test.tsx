import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SearchResponse } from "@retrowatchdog/shared";
import { GlobalSearch } from "../src/components/GlobalSearch.js";

const response: SearchResponse = {
  games: [{ id: 7, title: "Panzer Dragoon Saga", platform: "saturn", year: 1998, coverUrl: null }],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stubSearch = () => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(response))));

describe("GlobalSearch", () => {
  it("typing shows results and choosing opens the game", async () => {
    stubSearch();
    const onSelect = vi.fn();
    render(<GlobalSearch onSelect={onSelect} />);
    await userEvent.type(screen.getByLabelText("Search games"), "panzer");
    const list = await screen.findByRole("listbox");
    await userEvent.click(await screen.findByText("Panzer Dragoon Saga"));
    expect(onSelect).toHaveBeenCalledWith(response.games[0]);
    expect(list).not.toBeInTheDocument();
    expect(screen.getByLabelText("Search games")).toHaveValue("");
  });

  it("slash focuses the box from the page", async () => {
    render(<GlobalSearch onSelect={() => {}} />);
    await userEvent.keyboard("/");
    expect(screen.getByLabelText("Search games")).toHaveFocus();
    expect(screen.getByLabelText("Search games")).toHaveValue("");
  });

  it("slash inside an input types normally", async () => {
    render(
      <>
        <input aria-label="Notes" />
        <GlobalSearch onSelect={() => {}} />
      </>,
    );
    await userEvent.type(screen.getByLabelText("Notes"), "a/b");
    expect(screen.getByLabelText("Notes")).toHaveValue("a/b");
    expect(screen.getByLabelText("Notes")).toHaveFocus();
  });

  it("slash does nothing while a sheet is open over the page", async () => {
    render(
      <>
        <GlobalSearch onSelect={() => {}} />
        <section role="dialog" aria-modal="true" aria-label="Edit copy" />
      </>,
    );
    await userEvent.keyboard("/");
    expect(screen.getByLabelText("Search games")).not.toHaveFocus();
  });

  it("a click outside closes the results; typing again opens them", async () => {
    stubSearch();
    render(
      <>
        <p>page</p>
        <GlobalSearch onSelect={() => {}} />
      </>,
    );
    await userEvent.type(screen.getByLabelText("Search games"), "panzer");
    await screen.findByRole("listbox");
    await userEvent.click(screen.getByText("page"));
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.type(screen.getByLabelText("Search games"), "r");
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
  });

  it("arrow keys walk the results and Enter opens one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ games: [...response.games, { id: 8, title: "Shenmue", platform: "dreamcast", year: 1999, coverUrl: null }] })),
      ),
    );
    const onSelect = vi.fn();
    render(<GlobalSearch onSelect={onSelect} />);
    await userEvent.type(screen.getByLabelText("Search games"), "sa");
    await screen.findByText("Shenmue");
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: /Panzer Dragoon Saga/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: /Shenmue/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getByLabelText("Search games")).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ title: "Shenmue" }));
  });

  it("Esc clears and closes", async () => {
    stubSearch();
    render(<GlobalSearch onSelect={() => {}} />);
    await userEvent.type(screen.getByLabelText("Search games"), "panzer");
    await screen.findByRole("listbox");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByLabelText("Search games")).toHaveValue("");
  });
});
