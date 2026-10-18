import { useState } from "react";
import { ITEM_GRADES, kindLabelShort, type ItemGrade, type PriceRole, type PricesResponse } from "@retrowatchdog/shared";
import { formatMoney } from "../lib/money.js";
import { kindLabel, sourceLabel, useSources } from "../lib/sources.js";
import { useEbayOwnBlock } from "../lib/viewPrefs.js";
import { Fold, Panel, InfoTip, Segmented } from "../ui/index.js";
import { gradeLabel } from "./GradeSlider.js";
import { SourceStatusNote } from "./SourceStatusNote.js";

type Block = PricesResponse["sources"][number];
type Point = Block["points"][number];
interface PriceRow {
  point: Point;
  role: PriceRole | undefined;
  fetchedAt: string | null;
}

/** best first; ungraded last */
const gradeRank = (grade: ItemGrade | null | undefined): number =>
  grade == null ? ITEM_GRADES.length : ITEM_GRADES.indexOf(grade);

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Every source's prices in one place, split by the direction of the money:
 * what you can buy (and the baselines it is judged against), and what shops
 * pay you. A shop's charges and its payouts never share a table. Roles come
 * from the registry, so without it nothing renders.
 */
export function UnifiedPriceTable({ blocks }: { blocks: Block[] }) {
  const sources = useSources();
  const ebayOwnBlock = useEbayOwnBlock();
  const [sourceFilter, setSourceFilter] = useState("all");
  if (sources.status !== "ready") return null;

  const allRows: PriceRow[] = blocks.flatMap((b) =>
    b.points.map((point) => ({ point, role: sources.byId[b.source]?.kindRoles[point.kind], fetchedAt: b.fetchedAt ?? null })),
  );
  const present = [...new Set(allRows.map((r) => r.point.source))];
  const rows = sourceFilter === "all" ? allRows : allRows.filter((r) => r.point.source === sourceFilter);
  const payouts = rows.filter((r) => r.role === "bid");
  // a kind with no declared role cannot be called a price to pay or a payout
  const unroled = rows.filter((r) => r.role === undefined);
  const offers = rows.filter((r) => r.role !== "bid" && r.role !== undefined);
  // a box the shop has sold out of is not an offer; null (unknown) counts as in stock
  const soldOut = (r: PriceRow): boolean => r.role === "buy_store" && r.point.available === false;
  const inStock = offers.filter((r) => !soldOut(r));
  const outOfStock = offers.filter(soldOut);
  const notes = blocks
    .map((b) => ({ block: b, caveat: sources.byId[b.source]?.caveat ?? null }))
    .filter(({ block, caveat }) => caveat !== null || block.status === "error" || (block.status === "ok" && block.points.length === 0));

  // Settings -> Appearance: eBay's API licence wants its content "visually
  // isolated" from other sources. A view choice only: the engine never sees it.
  const isEbay = (r: PriceRow): boolean => sources.byId[r.point.source]?.family === "ebay";
  const table = (list: PriceRow[], stockTag: boolean) => {
    const ebay = ebayOwnBlock ? list.filter(isEbay) : [];
    const others = ebayOwnBlock ? list.filter((r) => !isEbay(r)) : list;
    if (ebay.length === 0 || others.length === 0) return <PriceRows rows={list} stockTag={stockTag} />;
    return (
      <>
        <section className="ebay-block">
          <h4>eBay</h4>
          <p className="source-note">Shown apart from other sources, as eBay's API licence asks.</p>
          <PriceRows rows={ebay} stockTag={stockTag} />
        </section>
        <div>
          <h4>Other sources</h4>
          <PriceRows rows={others} stockTag={stockTag} />
        </div>
      </>
    );
  };
  return (
    <>
      {present.length > 1 && (
        <Segmented
          aria-label="Source"
          options={[{ value: "all", label: "all" }, ...present.map((id) => ({ value: id, label: sourceLabel(id, sources) }))]}
          value={present.includes(sourceFilter) ? sourceFilter : "all"}
          onChange={setSourceFilter}
        />
      )}
      {offers.length > 0 && (
        <Panel title="To buy" info="price.toBuy">
          {inStock.length > 0 ? (
            table(inStock, false)
          ) : (
            <p className="source-note">
              Nothing in stock — {plural(outOfStock.length, "out-of-stock listing", "out-of-stock listings")} below
            </p>
          )}
          {outOfStock.length > 0 && <Fold summary={<>Out of stock ({outOfStock.length}) <InfoTip topic="price.outOfStock" /></>}>{table(outOfStock, false)}</Fold>}
        </Panel>
      )}
      {payouts.length > 0 && <Panel title="Shops pay you" info="price.shopsPay">{table(payouts, true)}</Panel>}
      {unroled.length > 0 && <Panel title="Other prices" info="price.other">{table(unroled, false)}</Panel>}
      {notes.map(({ block, caveat }) => (
        <div className="source-note price-note" key={block.source}>
          <strong>{sourceLabel(block.source, sources)}:</strong> {caveat}
          <SourceStatusNote block={block} />
        </div>
      ))}
    </>
  );
}

type ColKey = "source" | "what" | "region" | "condition" | "grade" | "price" | "updated";
const COLUMNS: Array<{ key: ColKey; label: string; className?: string }> = [
  { key: "source", label: "Source", className: "col-source" },
  { key: "what", label: "What" },
  { key: "region", label: "Region", className: "col-tier" },
  { key: "condition", label: "Condition", className: "col-tier" },
  { key: "grade", label: "Grade", className: "col-grade" },
  { key: "price", label: "Price", className: "col-price" },
  { key: "updated", label: "Updated", className: "col-updated" },
];

/** one table; any header sorts this table alone, a second click flips it */
function PriceRows({ rows: given, stockTag }: { rows: PriceRow[]; stockTag: boolean }) {
  const sources = useSources();
  const [sort, setSort] = useState<{ key: ColKey; desc: boolean } | null>(null);
  const valueOf = (r: PriceRow, key: ColKey): string | number => {
    const p = r.point;
    switch (key) {
      case "source":
        return sourceLabel(p.source, sources);
      case "what":
        return p.listingTitle ?? kindLabel(p.source, p.kind, sources);
      case "region":
        return p.region;
      case "condition":
        return p.condition;
      case "grade":
        return gradeRank(p.grade);
      case "price":
        return p.priceUsd;
      case "updated":
        return r.fetchedAt ?? "";
    }
  };
  const rows =
    sort === null
      ? given
      : [...given].sort((a, b) => {
          const x = valueOf(a, sort.key);
          const y = valueOf(b, sort.key);
          const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
          return sort.desc ? -c : c;
        });
  // newest first for Updated, low first for everything else
  const choose = (key: ColKey): void =>
    setSort((cur) => (cur?.key === key ? { key, desc: !cur.desc } : { key, desc: key === "updated" }));
  // a wide table scrolls inside its panel; it never widens the page
  return (
    <div className="table-scroll">
    <table className="price-table">
      <thead>
        <tr>
          {COLUMNS.map((c) => (
            <th key={c.key} className={c.className} aria-sort={sort?.key === c.key ? (sort.desc ? "descending" : "ascending") : undefined}>
              <button type="button" className="th-sort" onClick={() => choose(c.key)}>
                {c.label}
              </button>
              {sort?.key === c.key && <span aria-hidden="true">{sort.desc ? " ▾" : " ▴"}</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ point: p, fetchedAt }, i) => {
          const money = formatMoney(p.priceUsd, { amount: p.priceOriginal, currency: p.currencyOriginal });
          return (
            <tr key={i}>
              <td>
                {sourceLabel(p.source, sources)}
                {/* the phone has no region/condition columns: the tier rides under the source */}
                <span className="meta row-tier">
                  {p.region} · {p.condition}
                  {fetchedAt === null ? "" : ` · ${new Date(fetchedAt).toLocaleDateString()}`}
                </span>
              </td>
              <td className="what">
                {p.listingTitle ? (
                  // a listing shows its own title (WHICH item) behind the short,
                  // source-free kind word: the Source column names the shop
                  <>
                    <span className="meta">{kindLabelShort(sources.byId, p.source, p.kind)} · </span>
                    {p.listingTitle}
                  </>
                ) : (
                  <>
                    {kindLabel(p.source, p.kind, sources)}
                    {p.sampleSize != null ? ` (${p.sampleSize} listings)` : ""}
                  </>
                )}
                {stockTag && p.available === false && (
                  <span className="meta"> · out of stock at {sourceLabel(p.source, sources)}</span>
                )}
              </td>
              <td className="col-tier">{p.region}</td>
              <td className="col-tier">{p.condition}</td>
              <td>{p.grade ? gradeLabel(p.grade) : ""}</td>
              {/* the source's own quote wins when already in the display currency */}
              <td className="price">
                {p.url ? (
                  <a href={p.url} target="_blank" rel="noreferrer">
                    {money}
                  </a>
                ) : (
                  money
                )}
              </td>
              <td className="meta col-updated">{fetchedAt === null ? "" : new Date(fetchedAt).toLocaleDateString()}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}
