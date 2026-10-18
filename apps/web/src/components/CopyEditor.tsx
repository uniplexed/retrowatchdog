import { useState } from "react";
import { CurrencyOptions } from "./CurrencySelector.js";
import type {
  AcquiredSource,
  Condition,
  CopyStatus,
  ItemGrade,
  OwnedCopyDto,
  Region,
  SupportedCurrency,
  UpdateCopyInput,
} from "@retrowatchdog/shared";
import { ACQUIRED_SOURCES, CONDITIONS, COPY_STATUSES, REGIONS } from "@retrowatchdog/shared";
import { updateCopy } from "../api/client.js";
import { formatOriginal, loadLastPaidCurrency, saveLastPaidCurrency } from "../lib/money.js";
import { statusPatchFor, type StatusPatch } from "../lib/copyStatus.js";
import { GradeSlider } from "./GradeSlider.js";

/** set only by the PriceCharting importer: shown on such a copy, never offered or re-sent */
const IMPORTER_SOURCE: AcquiredSource = "pricecharting_import";
const MANUAL_SOURCES: readonly AcquiredSource[] = ACQUIRED_SOURCES.filter((s) => s !== IMPORTER_SOURCE);

/** The editor's local state; "" is an empty nullable, and the USD twin is the server's to freeze. */
export interface CopyEditorForm {
  paid: string;
  paidCurrency: SupportedCurrency;
  acquiredAt: string;
  acquiredSource: AcquiredSource | "";
  region: Region;
  condition: Condition;
  grade: ItemGrade | null;
  /** the status change's PATCH fragment (statusPatchFor); null while untouched */
  statusPatch: StatusPatch | null;
  notes: string;
}

export function formFor(copy: OwnedCopyDto): CopyEditorForm {
  return {
    paid: copy.acquiredPriceOriginal === null ? "" : String(copy.acquiredPriceOriginal),
    // the copy's own currency, else the user's last pick (initially GBP)
    paidCurrency: copy.acquiredCurrency ?? loadLastPaidCurrency(),
    acquiredAt: copy.acquiredAt ?? "",
    acquiredSource: copy.acquiredSource ?? "",
    region: copy.region,
    condition: copy.condition,
    grade: copy.itemGrade,
    statusPatch: null,
    notes: copy.notes ?? "",
  };
}

/**
 * The PATCH for the form's edits: only changed fields, null for a cleared one.
 * Paid travels both-or-neither (a currency change re-sends the amount so the
 * server re-freezes the USD twin); the importer-only source is never sent;
 * the status fragment only when the status actually differs.
 */
export function buildCopyPatch(
  copy: OwnedCopyDto,
  form: CopyEditorForm,
): { patch: UpdateCopyInput } | { error: string } {
  const patch: UpdateCopyInput = {};
  const paid = form.paid.trim();
  if (paid === "") {
    if (copy.acquiredPriceOriginal !== null || copy.acquiredCurrency !== null) {
      patch.acquiredPriceOriginal = null;
      patch.acquiredCurrency = null;
    }
  } else {
    const amount = Number(paid);
    if (!Number.isFinite(amount) || amount < 0) return { error: "Invalid price" };
    if (amount !== copy.acquiredPriceOriginal || form.paidCurrency !== copy.acquiredCurrency) {
      patch.acquiredPriceOriginal = amount;
      patch.acquiredCurrency = form.paidCurrency;
    }
  }
  const acquiredAt = form.acquiredAt === "" ? null : form.acquiredAt;
  if (acquiredAt !== copy.acquiredAt) patch.acquiredAt = acquiredAt;
  if (copy.acquiredSource !== IMPORTER_SOURCE) {
    const source = form.acquiredSource === "" ? null : form.acquiredSource;
    if (source !== copy.acquiredSource) patch.acquiredSource = source;
  }
  if (form.region !== copy.region) patch.region = form.region;
  if (form.condition !== copy.condition) patch.condition = form.condition;
  if (form.grade !== copy.itemGrade) patch.itemGrade = form.grade;
  if (form.statusPatch !== null && form.statusPatch.status !== copy.status) {
    Object.assign(patch, form.statusPatch);
  }
  const notes = form.notes.trim() === "" ? null : form.notes;
  if (notes !== copy.notes) patch.notes = notes;
  return { patch };
}

/**
 * The accessible name a copy's ✎ edit button and its editor share; "#2" etc.
 * is appended only when a sibling copy of the same game shares the tier.
 */
export function editCopyLabel(base: string, copy: OwnedCopyDto, siblings: readonly OwnedCopyDto[]): string {
  const sameTier = siblings.filter(
    (s) => s.game.id === copy.game.id && s.region === copy.region && s.condition === copy.condition,
  );
  if (sameTier.length < 2) return base;
  return `${base} #${sameTier.findIndex((s) => s.id === copy.id) + 1}`;
}

/** What a pending status change will write: nothing is recorded until Save. */
export function pendingStatusHint(fragment: StatusPatch): string {
  const facts =
    fragment.status === "sold" && fragment.soldPriceOriginal != null && fragment.soldCurrency != null
      ? `sold ${formatOriginal(fragment.soldPriceOriginal, fragment.soldCurrency)}`
      : fragment.status === "returned" && fragment.returnedAt != null
        ? `returned ${fragment.returnedAt}`
        : fragment.status;
  return `${facts} — press Save to record`;
}

/**
 * Inline editor for one owned copy. A server failure shows inline and keeps
 * the edits; Save with nothing changed closes like Cancel.
 */
export function CopyEditor({
  copy,
  label,
  onSaved,
  onCancel,
}: {
  copy: OwnedCopyDto;
  /** the form's accessible name (editCopyLabel) */
  label?: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<CopyEditorForm>(() => formFor(copy));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof CopyEditorForm>(key: K, value: CopyEditorForm[K]): void =>
    setForm((f) => ({ ...f, [key]: value }));
  const status: CopyStatus = form.statusPatch?.status ?? copy.status;
  const importerCopy = copy.acquiredSource === IMPORTER_SOURCE;

  const save = async (): Promise<void> => {
    setError(null);
    const built = buildCopyPatch(copy, form);
    if ("error" in built) {
      setError(built.error);
      return;
    }
    if (Object.keys(built.patch).length === 0) {
      onCancel();
      return;
    }
    setSaving(true);
    try {
      await updateCopy(copy.id, built.patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save copy");
      return;
    } finally {
      // on both paths: an editor still mounted after onSaved needs Save back
      setSaving(false);
    }
    // a written paid leg or sale makes its currency the next default
    const remembered = built.patch.acquiredPriceOriginal != null ? form.paidCurrency : built.patch.soldCurrency;
    if (remembered != null) saveLastPaidCurrency(remembered);
    onSaved();
  };

  return (
    <form
      className="source-block copy-editor"
      aria-label={label ?? `Edit copy ${copy.region} ${copy.condition}`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label>
        Paid{" "}
        <input value={form.paid} onChange={(e) => set("paid", e.target.value)} inputMode="decimal" size={6} />
      </label>{" "}
      <select
        aria-label="Paid currency"
        value={form.paidCurrency}
        onChange={(e) => set("paidCurrency", e.target.value as SupportedCurrency)}
      >
        <CurrencyOptions current={form.paidCurrency} />
      </select>{" "}
      {/* Save then clears the whole paid leg */}
      <button type="button" onClick={() => set("paid", "")} disabled={form.paid === ""}>
        clear paid
      </button>{" "}
      <label>
        Acquired{" "}
        <input type="date" value={form.acquiredAt} onChange={(e) => set("acquiredAt", e.target.value)} />
      </label>{" "}
      {importerCopy ? (
        // importer provenance is a fact about the copy, not a choice
        <span className="source-note">Source {IMPORTER_SOURCE}</span>
      ) : (
        <label>
          Source{" "}
          <select
            value={form.acquiredSource}
            onChange={(e) => set("acquiredSource", e.target.value as AcquiredSource | "")}
          >
            <option value="">—</option>
            {MANUAL_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      )}{" "}
      <label>
        Region{" "}
        <select value={form.region} onChange={(e) => set("region", e.target.value as Region)}>
          {REGIONS.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>{" "}
      <label>
        Condition{" "}
        <select value={form.condition} onChange={(e) => set("condition", e.target.value as Condition)}>
          {/* every tier a copy can be stored as */}
          {CONDITIONS.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>{" "}
      <GradeSlider grade={form.grade} onChange={(g) => set("grade", g)} />{" "}
      {/* the slider cannot express "no grade": this keeps null representable */}
      <button type="button" onClick={() => set("grade", null)} disabled={form.grade === null}>
        clear grade
      </button>{" "}
      <label>
        Status{" "}
        <select
          value={status}
          onChange={(e) => {
            // prompts run now, the write waits for Save; a cancelled prompt changes nothing
            const fragment = statusPatchFor(e.target.value as CopyStatus);
            if (fragment !== null) set("statusPatch", fragment);
          }}
        >
          {COPY_STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>{" "}
      {form.statusPatch !== null && form.statusPatch.status !== copy.status && (
        <span className="source-note">{pendingStatusHint(form.statusPatch)}</span>
      )}{" "}
      <label>
        Notes{" "}
        <textarea aria-label="Notes" value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2} />
      </label>{" "}
      <button type="submit" disabled={saving}>
        Save
      </button>{" "}
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      {error && <p className="source-note">{error}</p>}
    </form>
  );
}
