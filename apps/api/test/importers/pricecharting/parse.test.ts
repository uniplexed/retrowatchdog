import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { decodeEntities, parseCollectionPage } from "../../../src/importers/pricecharting/parse.js";

// REAL saved pages of a live public collection (fetched 2026-08-31): every
// assertion below is a value the live site actually served, not a synthetic.
const page1 = readFileSync(
  new URL("../../../src/importers/pricecharting/fixtures/collection-page1.html", import.meta.url),
  "utf8",
);
const page2 = readFileSync(
  new URL("../../../src/importers/pricecharting/fixtures/collection-page2.html", import.meta.url),
  "utf8",
);

describe("parseCollectionPage", () => {
  it("parses 30 items from page 1 with the exact first row", () => {
    const { items } = parseCollectionPage(page1);
    expect(items).toHaveLength(30);
    expect(items[0]).toEqual({
      offerId: "u7x5vryx3fnhulbjzihj4y2xou",
      title: "Legend of Zelda",
      consoleName: "Game & Watch", // &amp; decoded
      includes: "Item, Box, and Manual",
      valueUsd: 44.99,
      pcGameId: "2254176",
    });
  });

  it("skips the <th> header row (a tr.offer without data-offer-id)", () => {
    const { items } = parseCollectionPage(page1);
    // 30 real offers and none of them is the header masquerading as an item
    expect(items.every((i) => i.offerId.length > 0)).toBe(true);
    expect(items.some((i) => i.title.includes("Photo") || i.title.includes("Item"))).toBe(false);
  });

  it("extracts the next_page cursor token", () => {
    const { nextCursor } = parseCollectionPage(page1);
    expect(nextCursor).toBe(
      "ClAKEwoGU3RhcnRzEgkIxqrA4PGSlAMSNWoLc352Z3BjLWJvdHNyJgsSBm9mZmVycyIac2k0YzZjNDVwaW9hcXRqZ3gydjJzcHB2dTQMGAAgAQ",
    );
  });

  it("takes the next_page cursor, not the first_page form's empty one (page 2)", () => {
    const { items, nextCursor } = parseCollectionPage(page2);
    expect(items).toHaveLength(30);
    expect(items[0].offerId).toBe("a446hcx7vgnnxkruu2ougcbsim");
    // page 2 carries a first_page form with cursor="" BEFORE the next_page
    // form; grabbing the wrong one would end pagination after 2 pages
    expect(nextCursor).toBe(
      "ClAKEwoGU3RhcnRzEgkIkqSg9euSlAMSNWoLc352Z3BjLWJvdHNyJgsSBm9mZmVycyIabDZua2JtNXJ5ZDc2cmFtNW13b2tkYXE3cXEMGAAgAQ",
    );
  });

  it("returns valueUsd null (but keeps the game id) for an N/A price", () => {
    const { items } = parseCollectionPage(page1);
    const na = items.find((i) => i.offerId === "a6ujolj335kqwqtbe73o674yuy");
    expect(na).toBeDefined();
    expect(na!.title).toBe("Puyo Puyo Tetris");
    expect(na!.valueUsd).toBeNull();
    expect(na!.pcGameId).toBe("2253212");
  });

  it("decodes HTML entities in titles", () => {
    const { items } = parseCollectionPage(page2);
    const kof = items.find((i) => i.offerId === "awpypssimg2o65k75vb2uhuuga");
    expect(kof!.title).toBe("King of Fighters '99: Evolution"); // &#39;
    const drMario = items.find((i) => i.offerId === "pw7fkpleq336tvla65b3lmvksq");
    expect(drMario!.title).toBe("Dr. Mario & Panel de Pon"); // &amp;
  });

  it("reads the collection size from the summary table", () => {
    expect(parseCollectionPage(page1).totalCount).toBe(67);
  });

  it("parses region-prefixed console names and real includes variants", () => {
    const { items } = parseCollectionPage(page2);
    const wave = items.find((i) => i.offerId === "3c6tt3iv4zd2md4k3lt2iahowa");
    expect(wave!.consoleName).toBe("PAL GameBoy");
    expect(wave!.includes).toBe("Item and Manual only");
    const simCity = items.find((i) => i.offerId === "gkh65jn4g2on4dccvkql4l42xu");
    expect(simCity!.includes).toBe("Item and Box only");
  });

  it("returns no items and no cursor for a page without offers", () => {
    const parsed = parseCollectionPage("<html><body>Nothing here</body></html>");
    expect(parsed.items).toHaveLength(0);
    expect(parsed.nextCursor).toBeNull();
    expect(parsed.totalCount).toBeNull();
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities", () => {
    expect(decodeEntities("Game &amp; Watch")).toBe("Game & Watch");
    expect(decodeEntities("KoF &#39;99 &#x27;quoted&#x27;")).toBe("KoF '99 'quoted'");
    expect(decodeEntities("&lt;b&gt;&quot;x&quot;&lt;/b&gt;")).toBe('<b>"x"</b>');
    expect(decodeEntities("unknown &weird; stays")).toBe("unknown &weird; stays");
  });
});
