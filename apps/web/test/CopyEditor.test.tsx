import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CopyEditor, editCopyLabel } from "../src/components/CopyEditor.js";
import type { OwnedCopyDto } from "@retrowatchdog/shared";

// One owned copy with every editable field set, so each test can prove the
// editor shows the DTO's value and sends ONLY what it changed (copy-editor
// spec, 2026-09-02): the paid leg travels as the verbatim original + its
// currency, explicit null clears a leg, and the USD twin is never computed
// or sent from here — the server freezes it.
const copy: OwnedCopyDto = {
  id: 201,
  game: { id: 7, title: "Panzer Dragoon Saga", platform: "saturn", year: 1998, coverUrl: null },
  region: "PAL", condition: "loose", notes: "boxed, minor wear",
  acquiredAt: "2026-01-01",
  acquiredPriceOriginal: 10, acquiredCurrency: "GBP", acquiredPriceUsd: 12.7,
  status: "owned",
  itemGrade: null, workingState: "working", authenticity: "genuine",
  acquiredSource: "ebay", acquiredUrl: null, acquisitionId: null,
  soldAt: null, soldPriceOriginal: null, soldFeesOriginal: null, soldCurrency: null,
  soldPriceUsd: null, soldFeesUsd: null, soldVenue: null,
  returnedAt: null, refundOriginal: null, returnCostsOriginal: null,
  refundUsd: null, returnCostsUsd: null,
  estimatedValueUsd: null, valueBasis: null, valueFetchedAt: null,
  signals: [], matchBasis: null, matchScore: null,
};

/** the API's YYYY-MM-DD "today", the way the sold/returned flow stamps it */
const today = new Date().toISOString().slice(0, 10);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear(); // lastPaidCurrency persists
});

type FetchCall = [RequestInfo | URL, RequestInit | undefined];

/** PATCH answers with the given status/body; anything else is unexpected here */
function stubPatch(status = 204, body: unknown = null): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      return new Response(body === null ? null : JSON.stringify(body), { status });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** every PATCH the editor sent: its URL and its parsed JSON body */
function patches(fetchMock: ReturnType<typeof vi.fn>): Array<{ url: string; body: unknown }> {
  return (fetchMock.mock.calls as unknown as FetchCall[])
    .filter((c) => c[1]?.method === "PATCH")
    .map((c) => ({ url: String(c[0]), body: JSON.parse(String(c[1]?.body)) as unknown }));
}

function renderEditor(dto: OwnedCopyDto = copy) {
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  render(<CopyEditor copy={dto} onSaved={onSaved} onCancel={onCancel} />);
  return { onSaved, onCancel };
}

const save = (): Promise<void> => userEvent.click(screen.getByRole("button", { name: "Save" }));

describe("CopyEditor", () => {
  it("shows the DTO's values: verbatim paid original + currency, date, source, region, condition, grade, status, notes", () => {
    stubPatch();
    renderEditor();
    expect(screen.getByRole("form", { name: "Edit copy PAL loose" })).toBeInTheDocument();
    expect((screen.getByLabelText("Paid") as HTMLInputElement).value).toBe("10");
    expect(screen.getByLabelText("Paid")).toHaveAttribute("inputmode", "decimal");
    expect((screen.getByLabelText("Paid currency") as HTMLSelectElement).value).toBe("GBP");
    const date = screen.getByLabelText("Acquired") as HTMLInputElement;
    expect(date.type).toBe("date");
    expect(date.value).toBe("2026-01-01");
    expect((screen.getByLabelText("Source") as HTMLSelectElement).value).toBe("ebay");
    expect((screen.getByLabelText("Region") as HTMLSelectElement).value).toBe("PAL");
    expect((screen.getByLabelText("Condition") as HTMLSelectElement).value).toBe("loose");
    // an unset grade stays representable: thumb parked, label —, nothing chosen
    const slider = screen.getByLabelText("Grade") as HTMLInputElement;
    expect(slider.value).toBe("3");
    expect(slider.closest("label")?.textContent).toContain("—");
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("owned");
    expect((screen.getByLabelText("Notes") as HTMLTextAreaElement).value).toBe("boxed, minor wear");
  });

  it("names its form after the label its caller gives the ✎ edit button", () => {
    stubPatch();
    render(<CopyEditor copy={copy} label="Edit copy PAL loose #2" onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("form", { name: "Edit copy PAL loose #2" })).toBeInTheDocument();
  });

  it("offers the manual acquisition sources only — never the importer-only pricecharting_import", () => {
    stubPatch();
    renderEditor();
    const options = [...(screen.getByLabelText("Source") as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toContain("car_boot");
    expect(options).toContain("ebay");
    expect(options).not.toContain("pricecharting_import");
  });

  it("defaults the currency to the user's last pick when the copy has no paid leg", () => {
    stubPatch();
    window.localStorage.setItem("lastPaidCurrency", "EUR");
    renderEditor({ ...copy, acquiredPriceOriginal: null, acquiredCurrency: null, acquiredPriceUsd: null });
    expect((screen.getByLabelText("Paid") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Paid currency") as HTMLSelectElement).value).toBe("EUR");
  });

  it("Save sends ONE PATCH with only the changed paid leg (12.5 GBP), calls onSaved and remembers the currency", async () => {
    const fetchMock = stubPatch();
    const { onSaved, onCancel } = renderEditor();
    await userEvent.clear(screen.getByLabelText("Paid"));
    await userEvent.type(screen.getByLabelText("Paid"), "12.5");
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(patches(fetchMock)).toEqual([
      { url: "/api/collection/201", body: { acquiredPriceOriginal: 12.5, acquiredCurrency: "GBP" } },
    ]);
    expect(onCancel).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("lastPaidCurrency")).toBe("GBP");
  });

  it("re-enables Save after a successful write, for a caller that keeps the editor mounted", async () => {
    stubPatch();
    const { onSaved } = renderEditor();
    await userEvent.clear(screen.getByLabelText("Paid"));
    await userEvent.type(screen.getByLabelText("Paid"), "12.5");
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    // both current callers unmount the editor in onSaved; one that keeps it
    // open (a save-and-continue flow) must not be left with a dead Save
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
  });

  it("a currency change travels with the unchanged amount — both or neither, never a currency alone", async () => {
    const fetchMock = stubPatch();
    const { onSaved } = renderEditor();
    await userEvent.selectOptions(screen.getByLabelText("Paid currency"), "EUR");
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(patches(fetchMock)).toEqual([
      { url: "/api/collection/201", body: { acquiredPriceOriginal: 10, acquiredCurrency: "EUR" } },
    ]);
    expect(window.localStorage.getItem("lastPaidCurrency")).toBe("EUR");
  });

  it("selecting a currency without an amount sends nothing: no PATCH, the editor just closes", async () => {
    const fetchMock = stubPatch();
    const { onSaved, onCancel } = renderEditor({
      ...copy, acquiredPriceOriginal: null, acquiredCurrency: null, acquiredPriceUsd: null,
    });
    await userEvent.selectOptions(screen.getByLabelText("Paid currency"), "EUR");
    await save();
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(patches(fetchMock)).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("lastPaidCurrency")).toBeNull();
  });

  it("'clear paid' sends acquiredPriceOriginal null AND acquiredCurrency null", async () => {
    const fetchMock = stubPatch();
    const { onSaved } = renderEditor();
    await userEvent.click(screen.getByRole("button", { name: "clear paid" }));
    expect((screen.getByLabelText("Paid") as HTMLInputElement).value).toBe("");
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(patches(fetchMock)).toEqual([
      { url: "/api/collection/201", body: { acquiredPriceOriginal: null, acquiredCurrency: null } },
    ]);
    // nothing paid was recorded: the last-pick currency must not update
    expect(window.localStorage.getItem("lastPaidCurrency")).toBeNull();
  });

  it("rejects an unparsable amount inline without a PATCH", async () => {
    const fetchMock = stubPatch();
    const { onSaved } = renderEditor();
    await userEvent.clear(screen.getByLabelText("Paid"));
    await userEvent.type(screen.getByLabelText("Paid"), "abc");
    await save();
    expect(await screen.findByText("Invalid price")).toBeInTheDocument();
    expect(patches(fetchMock)).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole("form", { name: "Edit copy PAL loose" })).toBeInTheDocument();
  });

  it("sends a changed acquired date, and null when the date is emptied", async () => {
    const fetchMock = stubPatch();
    const { onSaved } = renderEditor();
    fireEvent.change(screen.getByLabelText("Acquired"), { target: { value: "2026-02-03" } });
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(patches(fetchMock)).toEqual([{ url: "/api/collection/201", body: { acquiredAt: "2026-02-03" } }]);
    cleanup();

    const fetchMock2 = stubPatch();
    const { onSaved: onSaved2 } = renderEditor();
    fireEvent.change(screen.getByLabelText("Acquired"), { target: { value: "" } });
    await save();
    await waitFor(() => expect(onSaved2).toHaveBeenCalledTimes(1));
    expect(patches(fetchMock2)).toEqual([{ url: "/api/collection/201", body: { acquiredAt: null } }]);
  });

  it("sends notes null when the textarea is emptied, and the new text otherwise", async () => {
    const fetchMock = stubPatch();
    const { onSaved } = renderEditor();
    await userEvent.clear(screen.getByLabelText("Notes"));
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(patches(fetchMock)).toEqual([{ url: "/api/collection/201", body: { notes: null } }]);
    cleanup();

    const fetchMock2 = stubPatch();
    const { onSaved: onSaved2 } = renderEditor();
    await userEvent.type(screen.getByLabelText("Notes"), ", manual torn");
    await save();
    await waitFor(() => expect(onSaved2).toHaveBeenCalledTimes(1));
    expect(patches(fetchMock2)).toEqual([
      { url: "/api/collection/201", body: { notes: "boxed, minor wear, manual torn" } },
    ]);
  });

  it("sends region, condition, source and the chosen grade together in one PATCH — and nothing else", async () => {
    const fetchMock = stubPatch();
    const { onSaved } = renderEditor();
    await userEvent.selectOptions(screen.getByLabelText("Region"), "NTSC_J");
    await userEvent.selectOptions(screen.getByLabelText("Condition"), "cib");
    await userEvent.selectOptions(screen.getByLabelText("Source"), "car_boot");
    fireEvent.change(screen.getByLabelText("Grade"), { target: { value: "5" } });
    expect(screen.getByLabelText("Grade").closest("label")?.textContent).toContain("mint");
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(patches(fetchMock)).toEqual([
      {
        url: "/api/collection/201",
        body: { region: "NTSC_J", condition: "cib", acquiredSource: "car_boot", itemGrade: "mint" },
      },
    ]);
  });

  it("'clear grade' sends itemGrade null for a graded copy; an untouched unset grade sends nothing", async () => {
    const fetchMock = stubPatch();
    const { onSaved } = renderEditor({ ...copy, itemGrade: "near_mint" });
    expect(screen.getByLabelText("Grade").closest("label")?.textContent).toContain("near mint");
    await userEvent.click(screen.getByRole("button", { name: "clear grade" }));
    expect(screen.getByLabelText("Grade").closest("label")?.textContent).toContain("—");
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(patches(fetchMock)).toEqual([{ url: "/api/collection/201", body: { itemGrade: null } }]);
    cleanup();

    // the untouched slider of an ungraded copy never invents a grade
    const fetchMock2 = stubPatch();
    const { onCancel } = renderEditor();
    await save();
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(patches(fetchMock2)).toEqual([]);
  });

  it("clearing the source sends acquiredSource null", async () => {
    const fetchMock = stubPatch();
    const { onSaved } = renderEditor();
    await userEvent.selectOptions(screen.getByLabelText("Source"), "");
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(patches(fetchMock)).toEqual([{ url: "/api/collection/201", body: { acquiredSource: null } }]);
  });

  it("shows an importer-created copy's source read-only and never re-sends it", async () => {
    const fetchMock = stubPatch();
    const { onSaved } = renderEditor({ ...copy, acquiredSource: "pricecharting_import" });
    expect(screen.queryByLabelText("Source")).not.toBeInTheDocument();
    expect(screen.getByText(/pricecharting_import/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Notes"), "!");
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(patches(fetchMock)).toEqual([{ url: "/api/collection/201", body: { notes: "boxed, minor wear!" } }]);
  });

  it("shows the server's {error} inline (FX-down 503) and keeps the form open with its edits", async () => {
    const fetchMock = stubPatch(503, { error: "FX rate for EUR is unavailable" });
    const { onSaved, onCancel } = renderEditor();
    await userEvent.selectOptions(screen.getByLabelText("Paid currency"), "EUR");
    await save();
    expect(
      await screen.findByText("API 503 updating copy: FX rate for EUR is unavailable"),
    ).toBeInTheDocument();
    expect(patches(fetchMock)).toHaveLength(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    // still editing, edits intact, nothing remembered as saved
    expect(screen.getByRole("form", { name: "Edit copy PAL loose" })).toBeInTheDocument();
    expect((screen.getByLabelText("Paid currency") as HTMLSelectElement).value).toBe("EUR");
    expect(window.localStorage.getItem("lastPaidCurrency")).toBeNull();
  });

  it("Cancel discards the edits: onCancel, no PATCH", async () => {
    const fetchMock = stubPatch();
    const { onSaved, onCancel } = renderEditor();
    await userEvent.clear(screen.getByLabelText("Paid"));
    await userEvent.type(screen.getByLabelText("Paid"), "99");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(patches(fetchMock)).toEqual([]);
  });

  describe("status flow (the Cards view's prompts, unchanged)", () => {
    it("marking sold prompts for amount + currency and Save PATCHes the sale facts with the status", async () => {
      const fetchMock = stubPatch();
      vi.stubGlobal("prompt", vi.fn().mockReturnValueOnce("40").mockReturnValueOnce("gbp"));
      const { onSaved } = renderEditor();
      await userEvent.selectOptions(screen.getByLabelText("Status"), "sold");
      expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("sold");
      // the prompts ran, the write has not: one PATCH, on Save
      expect(patches(fetchMock)).toEqual([]);
      await save();
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(patches(fetchMock)).toEqual([
        {
          url: "/api/collection/201",
          body: { status: "sold", soldAt: today, soldPriceOriginal: 40, soldCurrency: "GBP" },
        },
      ]);
      expect(window.localStorage.getItem("lastPaidCurrency")).toBe("GBP");
    });

    it("spells the pending sale next to Status until Save — the prompts are not the write — and drops it when the stored status is picked again", async () => {
      stubPatch();
      vi.stubGlobal("prompt", vi.fn().mockReturnValueOnce("40").mockReturnValueOnce("gbp"));
      renderEditor();
      expect(screen.queryByText(/press Save to record/)).not.toBeInTheDocument();
      await userEvent.selectOptions(screen.getByLabelText("Status"), "sold");
      // the prompt's verbatim amount in the currency it was given in
      expect(screen.getByText("sold £40.00 — press Save to record")).toBeInTheDocument();
      await userEvent.selectOptions(screen.getByLabelText("Status"), "owned");
      expect(screen.queryByText(/press Save to record/)).not.toBeInTheDocument();
      // a plain status change is pending too
      await userEvent.selectOptions(screen.getByLabelText("Status"), "listed");
      expect(screen.getByText("listed — press Save to record")).toBeInTheDocument();
    });

    it("remembers the sale currency only once the sale is written: Cancel after the prompts leaves the default alone", async () => {
      const fetchMock = stubPatch();
      vi.stubGlobal("prompt", vi.fn().mockReturnValueOnce("40").mockReturnValueOnce("EUR"));
      const { onCancel } = renderEditor();
      await userEvent.selectOptions(screen.getByLabelText("Status"), "sold");
      expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("sold");
      // the prompts ran; nothing is stored yet, so nothing is remembered yet
      expect(window.localStorage.getItem("lastPaidCurrency")).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(patches(fetchMock)).toEqual([]);
      expect(window.localStorage.getItem("lastPaidCurrency")).toBeNull();
    });

    it("a sold Save the server refused (FX-down 503) remembers no currency either", async () => {
      stubPatch(503, { error: "FX rate for EUR is unavailable" });
      vi.stubGlobal("prompt", vi.fn().mockReturnValueOnce("40").mockReturnValueOnce("EUR"));
      const { onSaved } = renderEditor();
      await userEvent.selectOptions(screen.getByLabelText("Status"), "sold");
      await save();
      expect(
        await screen.findByText("API 503 updating copy: FX rate for EUR is unavailable"),
      ).toBeInTheDocument();
      expect(onSaved).not.toHaveBeenCalled();
      expect(window.localStorage.getItem("lastPaidCurrency")).toBeNull();
    });

    it("a cancelled sold prompt snaps the select back and Save has nothing to send", async () => {
      const fetchMock = stubPatch();
      vi.stubGlobal("prompt", vi.fn(() => null));
      const { onSaved, onCancel } = renderEditor();
      const select = screen.getByLabelText("Status") as HTMLSelectElement;
      await userEvent.selectOptions(select, "sold");
      await waitFor(() => expect(select.value).toBe("owned"));
      await save();
      await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
      expect(patches(fetchMock)).toEqual([]);
      expect(onSaved).not.toHaveBeenCalled();
    });

    it("an invalid sold price alerts, snaps back and sends nothing", async () => {
      const fetchMock = stubPatch();
      vi.stubGlobal("prompt", vi.fn(() => "abc"));
      const alertMock = vi.fn();
      vi.stubGlobal("alert", alertMock);
      renderEditor();
      const select = screen.getByLabelText("Status") as HTMLSelectElement;
      await userEvent.selectOptions(select, "sold");
      await waitFor(() => expect(select.value).toBe("owned"));
      expect(alertMock).toHaveBeenCalledWith("Invalid price");
      expect(patches(fetchMock)).toEqual([]);
    });

    it("marking returned stamps returnedAt with the status", async () => {
      const fetchMock = stubPatch();
      const { onSaved } = renderEditor();
      await userEvent.selectOptions(screen.getByLabelText("Status"), "returned");
      expect(screen.getByText(`returned ${today} — press Save to record`)).toBeInTheDocument();
      await save();
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(patches(fetchMock)).toEqual([
        { url: "/api/collection/201", body: { status: "returned", returnedAt: today } },
      ]);
    });

    it("going back to the stored status drops the pending sale facts", async () => {
      const fetchMock = stubPatch();
      vi.stubGlobal("prompt", vi.fn().mockReturnValueOnce("40").mockReturnValueOnce("GBP"));
      const { onCancel } = renderEditor();
      await userEvent.selectOptions(screen.getByLabelText("Status"), "sold");
      await userEvent.selectOptions(screen.getByLabelText("Status"), "owned");
      await save();
      await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
      expect(patches(fetchMock)).toEqual([]);
    });
  });
});

describe("editCopyLabel", () => {
  it("keeps the caller's exact string for a unique (region, condition) and numbers same-tier siblings of one game", () => {
    const twin: OwnedCopyDto = { ...copy, id: 202 };
    const cib: OwnedCopyDto = { ...copy, id: 203, condition: "cib" };
    // the same tier of ANOTHER game is not a sibling (the Cards view lists every game)
    const otherGame: OwnedCopyDto = { ...copy, id: 204, game: { ...copy.game, id: 8 } };
    expect(editCopyLabel("Edit copy PAL loose", copy, [copy, cib])).toBe("Edit copy PAL loose");
    expect(editCopyLabel("Edit copy PAL loose", copy, [copy, otherGame])).toBe("Edit copy PAL loose");
    expect(editCopyLabel("Edit copy PAL loose", copy, [copy, twin, cib])).toBe("Edit copy PAL loose #1");
    expect(editCopyLabel("Edit copy PAL loose", twin, [copy, twin, cib])).toBe("Edit copy PAL loose #2");
    expect(editCopyLabel("Edit copy PAL cib", cib, [copy, twin, cib])).toBe("Edit copy PAL cib");
  });
});
