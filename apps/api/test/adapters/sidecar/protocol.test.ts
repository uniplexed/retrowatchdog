import { describe, it, expect } from "vitest";
import { PLUGIN_PROTOCOL_VERSION } from "@retrowatchdog/shared";
import {
  MAX_STORABLE_AMOUNT,
  SIDECAR_PROTOCOL_VERSION,
  parseSidecarListing,
  parseSyncRow,
} from "../../../src/adapters/sidecar/protocol.js";

/**
 * The validator is the trust boundary in code form (docs/sidecar-protocol.md).
 * A sidecar is community-maintained code the app cannot review, so nothing it
 * sends is believed until it has been checked, and what survives the check is
 * built field by field — never spread — so a key the protocol does not define
 * cannot ride along into a stored price row.
 */
const validRow = () => ({
  sourceProductId: "1234567890",
  title: "Legend of Zelda Ocarina of Time N64 boxed PAL",
  prices: [{ kind: "active_listing", amount: 42.5, currency: "GBP" }],
  url: "https://example.test/items/1234567890",
  categoryText: "Video games & consoles",
  conditionText: "Very good",
  observedAt: "2026-09-03T09:15:00Z",
  available: true,
});

/** U+0000: refused by Postgres, and never safe to echo into a log line. */
const NUL = String.fromCharCode(0);

function expectRejected(value: unknown, matching: RegExp): void {
  const parsed = parseSidecarListing(value);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.reason).toMatch(matching);
}

describe("the sidecar protocol version", () => {
  it("is 3, and is the same number a manifest is checked against", () => {
    // One protocol, one version. It was a separate constant reading 1 while
    // shared's read 2 — a protocol that could disagree with itself about which
    // one it speaks. What this file describes on the wire (`source=`
    // required, `alt=` forwarded, the catalog endpoints v1 had none of) is
    // unchanged since v2: v3 only raised requirements on the MANIFEST, which
    // is packages/shared's file and not this one — this constant just shares
    // its number rather than keeping a second one that could disagree.
    expect(SIDECAR_PROTOCOL_VERSION).toBe(3);
    expect(SIDECAR_PROTOCOL_VERSION).toBe(PLUGIN_PROTOCOL_VERSION);
  });
});

describe("parseSidecarListing accepts", () => {
  it("a complete row, every field carried through unchanged", () => {
    const parsed = parseSidecarListing(validRow());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.listing).toEqual({
      sourceProductId: "1234567890",
      title: "Legend of Zelda Ocarina of Time N64 boxed PAL",
      prices: [{ kind: "active_listing", amount: 42.5, currency: "GBP" }],
      url: "https://example.test/items/1234567890",
      categoryText: "Video games & consoles",
      conditionText: "Very good",
      observedAt: new Date("2026-09-03T09:15:00Z"),
      available: true,
    });
  });

  it("a minimal row: the three required fields and nothing else", () => {
    const parsed = parseSidecarListing({
      sourceProductId: "7",
      title: "Pilotwings 64",
      prices: [{ kind: "active_listing", amount: 12, currency: "EUR" }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // absent url reads as null (the app's RawListing has no "missing" url),
    // and no optional field is invented
    expect(parsed.listing).toEqual({
      sourceProductId: "7",
      title: "Pilotwings 64",
      prices: [{ kind: "active_listing", amount: 12, currency: "EUR" }],
      url: null,
    });
  });

  it("a listing with no price at all", () => {
    const parsed = parseSidecarListing({ sourceProductId: "7", title: "Pilotwings 64", prices: [] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.listing.prices).toEqual([]);
  });

  it("an explicit null url and a null availability", () => {
    const parsed = parseSidecarListing({ ...validRow(), url: null, available: null });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.listing.url).toBeNull();
    expect(parsed.listing.available).toBeNull();
  });

  it("either http scheme, since a source may serve its pages over plain http", () => {
    for (const url of ["https://example.test/items/1", "http://sidecar.test:8000/items/1"]) {
      const parsed = parseSidecarListing({ ...validRow(), url });
      expect(parsed.ok, url).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.listing.url).toBe(url);
    }
  });

  it("a free amount of 0 (given, not sold — still a real quote)", () => {
    const parsed = parseSidecarListing({
      ...validRow(),
      prices: [{ kind: "active_listing", amount: 0, currency: "GBP" }],
    });
    expect(parsed.ok).toBe(true);
  });

  it("carries a price's sampleSize through", () => {
    const parsed = parseSidecarListing({
      ...validRow(),
      prices: [{ kind: "active_median", amount: 40, currency: "GBP", sampleSize: 17 }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.listing.prices).toEqual([{ kind: "active_median", amount: 40, currency: "GBP", sampleSize: 17 }]);
  });

  it("adds no sampleSize key to a price that sent none", () => {
    const parsed = parseSidecarListing(validRow());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.listing.prices[0]).not.toHaveProperty("sampleSize");
  });
});

  /**
   * `null` for an optional field means "I have nothing to say about this",
   * which is what leaving it out means. parseSyncRow has always read it that
   * way; until S3b's follow-up the live parser dropped the whole row for it,
   * which is the kind of difference between the two transports spec §3 says
   * should not exist.
   */
  it("reads a null optional field as absent, exactly as a sync row does", () => {
    const parsed = parseSidecarListing({
      ...validRow(),
      categoryText: null,
      conditionText: null,
      observedAt: null,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.listing).not.toHaveProperty("categoryText");
    expect(parsed.listing).not.toHaveProperty("conditionText");
    expect(parsed.listing).not.toHaveProperty("observedAt");
  });

  it("still refuses a value that is neither a string nor null", () => {
    for (const [field, reason] of [
      ["categoryText", /categoryText must be a string/],
      ["conditionText", /conditionText must be a string/],
    ] as const) {
      const parsed = parseSidecarListing({ ...validRow(), [field]: 5 });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(reason);
    }
    const badDate = parseSidecarListing({ ...validRow(), observedAt: 5 });
    expect(badDate.ok).toBe(false);
    if (!badDate.ok) expect(badDate.reason).toMatch(/observedAt must be an ISO-8601 string/);
  });

describe("parseSidecarListing never lets a sidecar classify", () => {
  it("drops the fields only the app is allowed to decide, without failing the row", () => {
    const parsed = parseSidecarListing({
      ...validRow(),
      platform: "n64",
      region: "PAL",
      condition: "cib",
      grade: "mint",
      image: "https://example.test/pic.jpg",
      seller: "someone",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // the app reads the TITLE for all four of those; a sidecar's guess must
    // never reach a stored price row, and an extra key is not an error either
    expect(Object.keys(parsed.listing).sort()).toEqual([
      "available",
      "categoryText",
      "conditionText",
      "observedAt",
      "prices",
      "sourceProductId",
      "title",
      "url",
    ]);
  });
});

describe("parseSidecarListing rejects", () => {
  it("anything that is not an object", () => {
    expectRejected(null, /object/i);
    expectRejected("a listing", /object/i);
    expectRejected([], /object/i);
  });

  it("a missing or empty sourceProductId", () => {
    const { sourceProductId: _dropped, ...rest } = validRow();
    expectRejected(rest, /sourceProductId/);
    expectRejected({ ...validRow(), sourceProductId: "" }, /sourceProductId/);
    expectRejected({ ...validRow(), sourceProductId: 1234567890 }, /sourceProductId/);
  });

  it("a missing or empty title", () => {
    const { title: _dropped, ...rest } = validRow();
    expectRejected(rest, /title/);
    expectRejected({ ...validRow(), title: "   " }, /title/);
  });

  it("prices that are not an array", () => {
    expectRejected({ ...validRow(), prices: { kind: "active_listing" } }, /prices/);
    const { prices: _dropped, ...rest } = validRow();
    expectRejected(rest, /prices/);
  });

  it("a price kind the app does not know", () => {
    expectRejected(
      { ...validRow(), prices: [{ kind: "asking_price", amount: 1, currency: "GBP" }] },
      /kind/,
    );
  });

  it("an amount that is not a finite non-negative number", () => {
    for (const amount of ["42.5", Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expectRejected({ ...validRow(), prices: [{ kind: "sell", amount, currency: "GBP" }] }, /amount/);
    }
  });

  it("refuses a sampleSize that is not a whole number from 1 to 1 000 000", () => {
    for (const bad of [0, -1, 2.5, 1_000_001, "17", null]) {
      const parsed = parseSidecarListing({
        ...validRow(),
        prices: [{ kind: "active_listing", amount: 40, currency: "GBP", sampleSize: bad }],
      });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/prices\[0\]\.sampleSize must be a whole number from 1 to 1000000/);
    }
  });

  /**
   * The strictest rule in the protocol, and the one with teeth: the app's
   * conversion looks the code up in a rate table and an unrecognised one would
   * be stored at rate 1 — a EUR 42 listing filed as $42, silently. So the
   * shape is checked rather than trusted, and "gbp" is not "GBP".
   */
  it("a currency that is not a 3-letter ISO code", () => {
    for (const currency of ["gbp", "GB", "POUNDS", "£", "", 826]) {
      expectRejected({ ...validRow(), prices: [{ kind: "sell", amount: 1, currency }] }, /currency/);
    }
  });

  /**
   * F12/F19 (whole-branch review, 2026-09-09): `parsePrice`'s non-string
   * branches for `kind` and `currency` build their refusal out of a value
   * that is still `unknown` -- so it can be an object or array bounded only
   * by the response byte cap (SIDECAR_MAX_BYTES, 8 MB), and both reasons
   * reach the collector's "sidecar listing dropped" warn line verbatim
   * (adapters/sidecar/index.ts). `echo` must keep the refusal itself short
   * regardless of what a plugin actually sent.
   */
  it("keeps the refusal short even when kind or currency is a huge object", () => {
    const huge = { junk: "x".repeat(10_000) };
    const kindReason = (() => {
      const parsed = parseSidecarListing({
        ...validRow(),
        prices: [{ kind: huge, amount: 1, currency: "GBP" }],
      });
      expect(parsed.ok).toBe(false);
      return parsed.ok ? "" : parsed.reason;
    })();
    expect(kindReason).toMatch(/kind/);
    expect(kindReason.length).toBeLessThan(200);

    const currencyReason = (() => {
      const parsed = parseSidecarListing({
        ...validRow(),
        prices: [{ kind: "sell", amount: 1, currency: huge }],
      });
      expect(parsed.ok).toBe(false);
      return parsed.ok ? "" : parsed.reason;
    })();
    expect(currencyReason).toMatch(/currency/);
    expect(currencyReason.length).toBeLessThan(200);
  });

  /**
   * `url` is the one field whose whole purpose is to be clicked: it is stored
   * as the point's source_url and rendered as the listing's link in the price
   * table, the cheapest strip and the bark. Everywhere else in this file a row
   * is rebuilt from what survived a check; a bare "it is a string" left the
   * destination of that link entirely to the plugin. Not an injection worry —
   * React refuses a `javascript:` href — but the app presents the link as a
   * page on the source, and a string that is not an http(s) URL at all is not
   * one, so it is a present-and-invalid optional field like any other.
   */
  it("a url that is not an http(s) link", () => {
    for (const url of [
      "javascript:fetch('/api/collection/1',{method:'DELETE'})",
      "data:text/html,<b>hello",
      "mailto:seller@example.test",
      "//example.test/items/1",
      "not a url at all",
      "",
    ]) {
      expectRejected({ ...validRow(), url }, /url/);
    }
  });

  /**
   * F14 (whole-branch review, 2026-09-09): `url` was the only plugin-supplied
   * string in the tree to reach a stored column with no length bound at all
   * -- every other live-row string gained one this batch (id 128, title 512,
   * categoryText 256).
   */
  it("a url over the 2048-character bound", () => {
    const longUrl = `https://example.test/items/${"x".repeat(2030)}`;
    expect(longUrl.length).toBeGreaterThan(2048);
    expectRejected({ ...validRow(), url: longUrl }, /url/);
    // one character under the bound is still an ordinary valid url
    const parsed = parseSidecarListing({
      ...validRow(),
      url: `https://example.test/${"x".repeat(2048 - "https://example.test/".length)}`,
    });
    expect(parsed.ok).toBe(true);
  });

  it("an optional field that is present and invalid", () => {
    // absent is fine; present-and-wrong is a protocol violation, because a
    // broken timestamp or a bogus flag would otherwise be stored as evidence
    expectRejected({ ...validRow(), observedAt: "last tuesday" }, /observedAt/);
    expectRejected({ ...validRow(), observedAt: 1788453477 }, /observedAt/);
    expectRejected({ ...validRow(), available: "yes" }, /available/);
    expectRejected({ ...validRow(), url: 12 }, /url/);
    expectRejected({ ...validRow(), categoryText: ["games"] }, /categoryText/);
    expectRejected({ ...validRow(), conditionText: {} }, /conditionText/);
  });

  /**
   * `observedAt` is the only field whose value the app repeats back to the
   * user about ITSELF: the block's timestamp is the earliest observedAt of its
   * points, rendered as "· updated <date>" and as "showing stale data from
   * <date>". So a sidecar was choosing the freshness statement the app makes
   * about its own data — `2099` printing a future update time beside prices
   * that may be months old, `1970` on one row of a fresh batch ageing the
   * whole block.
   *
   * "Whatever `new Date` can parse" was also looser than the documented
   * ISO-8601, and the difference matters: `"2026"` and `"March 3, 2026"` parse
   * to engine- and locale-dependent instants, and a timestamp with no zone at
   * all is read in the API container's timezone, which is nobody's claim.
   */
  it("a timestamp that is not ISO-8601 with an explicit zone", () => {
    for (const observedAt of ["2026", "March 3, 2026", "12/31/2026", "2026-09-03", "2026-09-03T09:15:00"]) {
      expectRejected({ ...validRow(), observedAt }, /observedAt/);
    }
  });

  it("a timestamp in the future, or from before this app could have seen it", () => {
    const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
    expectRejected({ ...validRow(), observedAt: "2099-01-01T00:00:00Z" }, /observedAt/);
    expectRejected({ ...validRow(), observedAt: "1970-01-01T00:00:00Z" }, /observedAt/);
    expectRejected({ ...validRow(), observedAt: iso(6 * 3_600_000) }, /observedAt/);
    // a modest skew is a clock, not a claim: two hosts are never in step
    const skewed = parseSidecarListing({ ...validRow(), observedAt: iso(30_000) });
    expect(skewed.ok).toBe(true);
  });

  it("naming the listing in the reason, so a log line points at a row", () => {
    const parsed = parseSidecarListing({ ...validRow(), available: "yes" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("1234567890");
  });
});

/**
 * The audit's sharpest finding: a live row had no bounds at all, so a
 * control character or an oversized amount that the catalog path already
 * refused sailed through the parser here and was refused by POSTGRES
 * instead, at INSERT — which costs the whole game-and-source block on every
 * fetch (see MAX_STORABLE_AMOUNT's own doc), where the catalog path drops
 * one row with a reason. This pins the live parser now refusing the same
 * shapes `parseSyncRow` already did, before either transport reaches its
 * sink.
 */
describe("parseSidecarListing gains the sync row's bounds", () => {
  it("refuses a live row whose id is too long, the way a catalog row is", () => {
    const parsed = parseSidecarListing({ ...validRow(), sourceProductId: "x".repeat(129) });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/sourceProductId/);
  });

  it("refuses a live id carrying a control character, before that id reaches a message", () => {
    const parsed = parseSidecarListing({ ...validRow(), sourceProductId: `a${NUL}b` });
    expect(parsed.ok).toBe(false);
    // The reason it is refused is that it is not safe to print, so printing it
    // in the refusal would be the same defect.
    if (!parsed.ok) expect(parsed.reason).not.toContain(NUL);
  });

  it("refuses a live title or category that is too long or carries a control character", () => {
    expect(parseSidecarListing({ ...validRow(), title: "x".repeat(513) }).ok).toBe(false);
    expect(parseSidecarListing({ ...validRow(), title: `a${NUL}b` }).ok).toBe(false);
    expect(parseSidecarListing({ ...validRow(), categoryText: "x".repeat(257) }).ok).toBe(false);
    expect(parseSidecarListing({ ...validRow(), categoryText: `a${NUL}b` }).ok).toBe(false);
  });

  it("refuses a live price the database could not store", () => {
    const parsed = parseSidecarListing({
      ...validRow(),
      prices: [{ kind: "active_listing", amount: 1e12, currency: "GBP" }],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/amount/);
  });

  it("bounds conditionText the way the sync row does", () => {
    const long = parseSidecarListing({ ...validRow(), conditionText: "x".repeat(257) });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.reason).toMatch(/conditionText must be a string of at most 256 characters/);
    const nul = parseSidecarListing({ ...validRow(), conditionText: `a${NUL}b` });
    expect(nul.ok).toBe(false);
    if (!nul.ok) expect(nul.reason).toMatch(/conditionText carries a control character/);
  });
});

/**
 * The one rule docs/sidecar-protocol.md §6 called "armed, not dormant".
 *
 * Before this, ONE unapproved kind refused the WHOLE row, so a live plugin
 * declaring two kinds and approved for one refused every row it ever
 * returned — and a batch in which every row is malformed is a failure, so that
 * source showed an error on every screen and never said why. The sync path
 * (`parseSyncRow`) has always narrowed instead. The live path now agrees with
 * it, for this one reason and no other: the narrowing is about CONSENT, not
 * about parsing.
 */
describe("a kind the source declares no role for", () => {
  const kinds = new Set(["active_listing"]);

  it("keeps the row and drops just that price", () => {
    const parsed = parseSidecarListing(
      {
        sourceProductId: "v1|123|0",
        title: "Super Mario World SNES",
        prices: [
          { kind: "active_median", amount: 30, currency: "GBP" },
          { kind: "active_listing", amount: 25, currency: "GBP" },
        ],
      },
      { kinds },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.listing.prices).toEqual([{ kind: "active_listing", amount: 25, currency: "GBP" }]);
    // reported so the adapter can say so once per batch rather than once per
    // row — the same courtesy the sync path already pays a plugin's maintainer
    expect(parsed.droppedKinds).toEqual(["active_median"]);
  });

  it("drops the row whole when every price it ARRIVED with was refused", () => {
    // Not a silent empty listing: a row left with nothing storable is a row
    // with nothing to store, and the app must not count it as a listing it
    // found. The reason names the kinds, because that is what a maintainer
    // needs in the log line.
    const parsed = parseSidecarListing(
      {
        sourceProductId: "v1|124|0",
        title: "x",
        prices: [{ kind: "active_median", amount: 30, currency: "GBP" }],
      },
      { kinds },
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("active_median");
    expect(parsed.reason).toContain("v1|124|0");
  });

  it("keeps a row that ARRIVED with no prices at all — that is not this rule's business", () => {
    // The distinction this whole change turns on, pinned from both sides (the
    // other side is "a listing with no price at all", above). `prices: []` is
    // legal and is a real row: the app's own eBay mapper emits it for a Browse
    // item that carries no price, and the adapter sorts such a row LAST rather
    // than dropping it. Gating the whole-row drop on `prices.length === 0`
    // alone would change the protocol for every plugin to fix a problem no
    // plugin has.
    const parsed = parseSidecarListing(
      { sourceProductId: "v1|126|0", title: "Pilotwings 64", prices: [] },
      { kinds },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.listing.prices).toEqual([]);
    expect(parsed.droppedKinds ?? []).toEqual([]);
  });

  it("still condemns the row for a bad amount, an unknown kind or a bad currency", () => {
    // The narrowing is about CONSENT, not about parsing. A broken claim beside
    // real evidence is still worse than a dropped row.
    for (const price of [
      { kind: "active_listing", amount: -1, currency: "GBP" },
      { kind: "not_a_kind", amount: 5, currency: "GBP" },
      { kind: "active_listing", amount: 5, currency: "XXXX" },
    ]) {
      const parsed = parseSidecarListing(
        { sourceProductId: "v1|125|0", title: "x", prices: [price] },
        { kinds },
      );
      expect(parsed.ok, JSON.stringify(price)).toBe(false);
    }
  });

  it("does not read the amount of a price it may not store", () => {
    // The permission check runs before the amount and currency ones, on both
    // paths, and the consequence is worth pinning: a broken number under a
    // kind the app was never going to keep does not condemn the row. It also
    // means an approval change cannot retroactively turn a row this source
    // already answered with into a failing one.
    const parsed = parseSidecarListing(
      {
        sourceProductId: "v1|128|0",
        title: "Super Mario World SNES",
        prices: [
          { kind: "active_median", amount: "not a number", currency: "not a currency" },
          { kind: "active_listing", amount: 25, currency: "GBP" },
        ],
      },
      { kinds },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.listing.prices).toEqual([{ kind: "active_listing", amount: 25, currency: "GBP" }]);
    expect(parsed.droppedKinds).toEqual(["active_median"]);
  });

  it("does not rescue a row that is broken somewhere else as well", () => {
    // Dropping a price is not a pardon for the rest of the row: the url check
    // runs after the price loop, and a row whose only surviving evidence links
    // nowhere the app can render is still condemned.
    const parsed = parseSidecarListing(
      {
        sourceProductId: "v1|127|0",
        title: "Super Mario World SNES",
        prices: [
          { kind: "active_median", amount: 30, currency: "GBP" },
          { kind: "active_listing", amount: 25, currency: "GBP" },
        ],
        url: "mailto:seller@example.test",
      },
      { kinds },
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toMatch(/url/);
  });
});

/**
 * The other kind of "unknown", and the change this whole file exists for:
 * until 2026-09-05 an unapproved kind condemned the row above; until
 * 2026-09-09 a kind this app has never heard of at all still did, even though
 * `parseSyncRow` below never condemned a row for it. It now costs only the
 * price, exactly as an unapproved kind does, and the two kinds of "unknown"
 * are kept distinguishable downstream (adapters/sidecar/index.ts) rather than
 * collapsed into one report.
 */
describe("a kind this app has never heard of", () => {
  it("keeps a live row whose price names a kind this app has never heard of", () => {
    const parsed = parseSidecarListing({
      sourceProductId: "v2|1|0",
      title: "Super Mario World SNES",
      prices: [
        { kind: "active_listing", amount: 10, currency: "GBP" },
        { kind: "auction_high", amount: 12, currency: "GBP" },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.listing.prices).toEqual([{ kind: "active_listing", amount: 10, currency: "GBP" }]);
    expect(parsed.droppedKinds).toContain("auction_high");
  });

  it("drops a live row that loses every price, the way a catalog row is dropped", () => {
    // The distinction the whole batch turns on, pinned from the OTHER side of
    // it this time: `prices: []` on arrival (asserted elsewhere in this file)
    // is a real row with nothing to quote. A row that ARRIVED with a price
    // and then lost it to this rule is not that — it is a row with nothing
    // LEFT to store, and the app must not count it as one it found.
    const parsed = parseSidecarListing({
      sourceProductId: "v2|2|0",
      title: "Super Mario World SNES",
      prices: [{ kind: "auction_high", amount: 12, currency: "GBP" }],
    });
    expect(parsed.ok).toBe(false);
  });

  it("still names the row's id in the reason, for a maintainer reading the log", () => {
    const parsed = parseSidecarListing({
      sourceProductId: "v2|3|0",
      title: "Super Mario World SNES",
      prices: [{ kind: "auction_high", amount: 12, currency: "GBP" }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("auction_high");
    expect(parsed.reason).toContain("v2|3|0");
  });

  it("clips an invented kind before it can reach a log line", () => {
    // The trap this task exists to avoid: once an unrecognised kind no longer
    // condemns the row, `droppedKinds` can carry ANY string a plugin wrote —
    // unbounded in length and free to carry a control byte like the one Task
    // 1 guarded titles and ids against. Nothing here asserts `droppedKinds`
    // itself is already clipped (it is data, not a message — see this file's
    // `ParsedListing` doc) — it asserts that the value the collector would
    // actually log from it is both short and free of the byte.
    const invented = `x${NUL}${"y".repeat(200)}`;
    const parsed = parseSidecarListing({
      sourceProductId: "v2|4|0",
      title: "Super Mario World SNES",
      prices: [
        { kind: "active_listing", amount: 10, currency: "GBP" },
        { kind: invented, amount: 12, currency: "GBP" },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.listing.prices).toEqual([{ kind: "active_listing", amount: 10, currency: "GBP" }]);
    expect(parsed.droppedKinds).toHaveLength(1);
    const forLog = parsed.droppedKinds!.map((kind) => JSON.stringify(kind.slice(0, 32)));
    for (const line of forLog) {
      expect(line).not.toContain(NUL);
      expect(line.length).toBeLessThan(40);
    }
  });

  it("keeps the row-condemning reason itself log-safe when the last price standing is the invented one", () => {
    // The row-emptiness check builds its OWN message out of `droppedKinds`
    // (protocol.ts, just above `parseSyncRow`) -- this pins that it clips
    // there too, not only in the batch report a caller builds later.
    const invented = `x${NUL}${"y".repeat(200)}`;
    const parsed = parseSidecarListing({
      sourceProductId: "v2|5|0",
      title: "Super Mario World SNES",
      prices: [{ kind: invented, amount: 12, currency: "GBP" }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).not.toContain(NUL);
    expect(parsed.reason.length).toBeLessThan(200);
  });
});

/**
 * The catalog half of the same boundary (protocol A.3). A synced row is
 * stored, not just rendered, so its two numbers — the amount and the currency
 * — are the ones with lasting consequences.
 */
describe("parseSyncRow", () => {
  const validSyncRow = (): Record<string, unknown> => ({
    sourceProductId: "SGBOS074A",
    title: "Castlevania II: Belmont's Revenge",
    categoryText: "Game Boy Games",
    prices: { sell: 38, cash: 20 },
    currency: "GBP",
    available: true,
    sourceMetadata: { categoryId: 1014 },
  });

  const limits = { kinds: new Set(["sell", "cash"]), currencies: new Set(["GBP"]) };

  const rejectSync = (mutate: (row: Record<string, unknown>) => void): string => {
    const row = validSyncRow();
    mutate(row);
    const parsed = parseSyncRow(row, limits);
    expect(parsed.ok).toBe(false);
    return parsed.ok ? "" : parsed.reason;
  };

  it("rebuilds the row field by field, so a classification key cannot ride along", () => {
    const row = { ...validSyncRow(), platform: "gb", region: "PAL", url: "http://shop/x" };
    const parsed = parseSyncRow(row, limits);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.item).toEqual({
      sourceProductId: "SGBOS074A",
      title: "Castlevania II: Belmont's Revenge",
      categoryText: "Game Boy Games",
      prices: { sell: "38.00", cash: "20.00" },
      currency: "GBP",
      available: true,
      observedAt: null,
      conditionText: null,
      sampleSizes: null,
    });
  });

  it("writes an amount as the two-decimal string the price columns keep", () => {
    // `String(amount)` was the draft, and it writes 0.30000000000000004 into a
    // column every reader treats as money.
    const parsed = parseSyncRow({ ...validSyncRow(), prices: { sell: 0.1 + 0.2, cash: 38.567 } }, limits);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.item.prices).toEqual({ sell: "0.30", cash: "38.57" });
  });

  it("accepts a free item and the largest amount the column can hold", () => {
    for (const amount of [0, MAX_STORABLE_AMOUNT]) {
      const parsed = parseSyncRow({ ...validSyncRow(), prices: { sell: amount } }, limits);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.item.prices.sell).toBe(amount.toFixed(2));
    }
  });

  it("refuses an amount no price column can hold", () => {
    // Measured: price_points.price_original is numeric(10,2), which takes
    // '99999999.99' and refuses '100000000.00', '9007199254740991' and
    // '1e+21'. Stored anyway, such a row parses and syncs fine and then throws
    // at the first game view whose confirmed mappings include it, taking that
    // game's whole price batch for this source with it (one insert). The
    // pricing service catches it per source block and serves stale-if-error:
    // `status: "error"` carrying the last stored points, so the block goes on
    // showing old numbers for that one game instead of going blank.
    expect(rejectSync((r) => { r.prices = { sell: MAX_STORABLE_AMOUNT + 0.01 }; })).toMatch(/prices\.sell/);
    expect(rejectSync((r) => { r.prices = { sell: Number.MAX_SAFE_INTEGER }; })).toMatch(/prices\.sell/);
    // 1e21 is the one whose String() and toFixed(2) are BOTH "1e+21": it would
    // have reached the column as exponential text
    expect(rejectSync((r) => { r.prices = { sell: 1e21 }; })).toMatch(/prices\.sell/);
    expect(rejectSync((r) => { r.prices = { sell: -1 }; })).toMatch(/prices\.sell/);
    expect(rejectSync((r) => { r.prices = { sell: Number.NaN }; })).toMatch(/prices\.sell/);
    expect(rejectSync((r) => { r.prices = { sell: "38.00" }; })).toMatch(/prices\.sell/);
  });

  it("keeps a row for its approved kinds and drops only the others", () => {
    // The rule this replaced condemned the whole ROW for mentioning one
    // unapproved kind, which is not what an approval says. A shop plugin
    // sending sell/cash/voucher to a user who approved sell and cash produces
    // every row it has, minus the voucher; under the old rule it produced none,
    // on every page of every unit, and the sweep then threw on a wholly
    // malformed page — a catalogue that never syncs and never says why.
    const parsed = parseSyncRow({ ...validSyncRow(), prices: { sell: 38, voucher: 26 } }, limits);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.item.prices).toEqual({ sell: "38.00" });
    // reported back so the caller can say it ONCE per page instead of per row
    expect(parsed.droppedKinds).toEqual(["voucher"]);
  });

  it("drops a kind the app does not know the same way, rather than condemning the row", () => {
    // The app could not store it whichever way it decided, so refusing the row
    // over it buys nothing and costs the row's real prices.
    const parsed = parseSyncRow({ ...validSyncRow(), prices: { sell: 38, auction_high: 10 } }, limits);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.item.prices).toEqual({ sell: "38.00" });
    expect(parsed.droppedKinds).toEqual(["auction_high"]);
  });

  it("drops the row when NOTHING approved is left, naming what it carried", () => {
    // There is no price to store, so there is no row: the narrowing keeps a row
    // that still says something, it does not invent one that does not.
    const reason = rejectSync((r) => { r.prices = { voucher: 10, auction_high: 5 }; });
    expect(reason).toMatch(/no kind this source has an approved role for/);
    expect(reason).toContain("voucher");
    expect(rejectSync((r) => { r.prices = {}; })).toMatch(/at least one kind/);
  });

  it("still condemns the row for a broken AMOUNT under an approved kind", () => {
    // The asymmetry inside the narrowing: an unapproved kind is a kind the user
    // did not ask to see, while a broken amount under an approved one is a
    // broken claim about a price they did.
    expect(rejectSync((r) => { r.prices = { sell: "38.00", cash: 20 }; })).toMatch(/prices\.sell/);
  });

  it("narrows the LIVE path the same way, so the two agree about consent", () => {
    // Stated from the sync side as well, because this used to be the place the
    // two functions DISAGREED: `parseSidecarListing` refused a listing that
    // mentioned an unapproved kind at all. It did not bite while the one live
    // plugin declared a single kind, and it stopped being defensible the
    // moment one declared two. The same row, put to both, now keeps its
    // approved price and reports the loss the same way.
    const listing = parseSidecarListing(
      { sourceProductId: "L1", title: "Game", prices: [{ kind: "sell", amount: 5, currency: "GBP" }, { kind: "voucher", amount: 4, currency: "GBP" }] },
      limits,
    );
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    expect(listing.listing.prices).toEqual([{ kind: "sell", amount: 5, currency: "GBP" }]);
    expect(listing.droppedKinds).toEqual(["voucher"]);
  });

  it("no longer differs over an unknown kind either, since 2026-09-09", () => {
    // Until 2026-09-09 this WAS the one difference: a synced row's prices are
    // an object keyed by kind, so an unknown key was a key with no meaning
    // and the row was still worth what its known kinds said; a live row's
    // prices are an array of claims the app renders and links, and refusing
    // one it could not read at all used to condemn the whole row. The shapes
    // still differ -- that reasoning is not wrong -- but it stopped being a
    // reason to hide every OTHER price a live row did carry, so the live path
    // now drops just the one price, the same as the sync path always has.
    const synced = parseSyncRow({ ...validSyncRow(), prices: { sell: 38, auction_high: 10 } }, limits);
    expect(synced.ok).toBe(true);
    if (synced.ok) expect(synced.item.prices).toEqual({ sell: "38.00" });
    const live = parseSidecarListing(
      { sourceProductId: "L2", title: "Game", prices: [{ kind: "sell", amount: 5, currency: "GBP" }, { kind: "not_a_kind", amount: 4, currency: "GBP" }] },
      limits,
    );
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    expect(live.listing.prices).toEqual([{ kind: "sell", amount: 5, currency: "GBP" }]);
    expect(live.droppedKinds).toEqual(["not_a_kind"]);
  });

  it("refuses a control character in any field the database would store", () => {
    // U+0000 passes every check above and is refused by POSTGRES (measured:
    // `22021, invalid byte sequence for encoding "UTF8": 0x00`, which failed
    // the INSERT of the 500-row chunk it landed in), and the sink runs outside
    // the try that guards a page (sync.ts), so the throw ends the whole unit —
    // one unwritable byte costing far more than its own row.
    // This repository has had 0x00 and 0x08
    // bytes written into it twice by its own tooling; a shop's product data
    // never carries either.
    const BACKSPACE = String.fromCharCode(8);
    expect(rejectSync((r) => { r.title = `Zelda${NUL}`; })).toMatch(/title carries a control character/);
    expect(rejectSync((r) => { r.sourceProductId = `SGB${NUL}074A`; })).toMatch(
      /sourceProductId carries a control character/,
    );
    expect(rejectSync((r) => { r.categoryText = `Game Boy${BACKSPACE} Games`; })).toMatch(
      /categoryText carries a control character/,
    );
    // and the byte itself never travels into the reason a log line prints
    for (const reason of [
      rejectSync((r) => { r.title = `Zelda${NUL}`; }),
      rejectSync((r) => { r.sourceProductId = `SGB${NUL}`; }),
    ]) {
      expect(reason).not.toContain(NUL);
    }
    // the three C0 characters a shop legitimately writes are left alone
    const tabbed = parseSyncRow({ ...validSyncRow(), title: "Zelda\tOoT" }, limits);
    expect(tabbed.ok).toBe(true);
  });

  it("refuses a currency that is not this source's, and one that is not a code at all", () => {
    // A code the FX table cannot serve makes the lookup throw, costing the
    // source its whole block; a wrong-but-quotable one freezes a USD twin at
    // another country's rate, permanently.
    expect(rejectSync((r) => { r.currency = "EUR"; })).toMatch(/not one this source's site quotes/);
    expect(rejectSync((r) => { r.currency = "pounds"; })).toMatch(/ISO 4217/);
    expect(rejectSync((r) => { delete r.currency; })).toMatch(/ISO 4217/);
  });

  /**
   * F12/F19 (whole-branch review, 2026-09-09): when `currency` fails the
   * `typeof` check it is still `unknown`, so it can be an object or array
   * bounded only by the response byte cap (SIDECAR_SYNC_MAX_BYTES, 16 MB) —
   * and this reason is the one logged ONCE PER ROW by sync.ts, the site with
   * the most amplification in the whole cluster. `echo` must keep the
   * refusal itself short and person-readable regardless of what was sent.
   */
  it("keeps the refusal short even when currency is a huge object, not a bare unbounded echo", () => {
    const huge = { junk: "x".repeat(10_000) };
    const reason = rejectSync((r) => { r.currency = huge as unknown as string; });
    expect(reason).toMatch(/ISO 4217/);
    // MAX_ECHO_LENGTH (80) plus the surrounding message text and the
    // ellipsis -- nowhere near the 10,000-character payload that was sent
    expect(reason.length).toBeLessThan(200);
  });

  it("refuses the fields a stored row cannot do without", () => {
    expect(rejectSync((r) => { delete r.sourceProductId; })).toMatch(/sourceProductId/);
    expect(rejectSync((r) => { r.sourceProductId = " "; })).toMatch(/sourceProductId/);
    expect(rejectSync((r) => { r.sourceProductId = "x".repeat(129); })).toMatch(/sourceProductId/);
    expect(rejectSync((r) => { r.title = ""; })).toMatch(/title/);
    expect(rejectSync((r) => { r.title = "x".repeat(513); })).toMatch(/title/);
    expect(rejectSync((r) => { r.categoryText = "x".repeat(257); })).toMatch(/categoryText/);
    expect(rejectSync((r) => { r.available = "yes"; })).toMatch(/available/);
    expect(parseSyncRow("hello", limits).ok).toBe(false);
    expect(parseSyncRow([validSyncRow()], limits).ok).toBe(false);
  });

  it("settles an absent optional field to the null the column stores", () => {
    // Named for what it asserts. This is the opposite of `parseSidecarListing`,
    // whose optional fields stay ABSENT (a RawListing is rendered, and an
    // absent field is "the source said nothing"); a sync row is written to
    // catalog_items, whose columns are nullable, so "said nothing" IS null and
    // saying so here keeps the sink from having to guess per field.
    const parsed = parseSyncRow(
      { sourceProductId: "A1", title: "Game", prices: { sell: 1 }, currency: "GBP" },
      limits,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.item.categoryText).toBeNull();
    expect(parsed.item.available).toBeNull();
  });

  it("ignores sourceMetadata: the row parses and the key goes nowhere", () => {
    const parsed = parseSyncRow({ ...validSyncRow(), sourceMetadata: { blob: "x".repeat(10_000) } }, limits);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.item).not.toHaveProperty("sourceMetadata");
  });

  it("names the row in every reason after the id, so a log line points at one", () => {
    expect(rejectSync((r) => { r.currency = "EUR"; })).toContain("SGBOS074A");
  });

  describe("the S3b fields (spec §3)", () => {
    it("accepts observedAt, conditionText and sampleSizes", () => {
      const parsed = parseSyncRow(
        {
          ...validSyncRow(),
          observedAt: "2026-09-16T21:30:00Z",
          conditionText: "Very good",
          sampleSizes: { sell: 12 },
        },
        limits,
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.item.observedAt).toEqual(new Date("2026-09-16T21:30:00Z"));
      expect(parsed.item.conditionText).toBe("Very good");
      expect(parsed.item.sampleSizes).toEqual({ sell: 12 });
    });

    it("leaves all three null when the row does not send them", () => {
      const parsed = parseSyncRow(validSyncRow(), limits);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.item.observedAt).toBeNull();
      expect(parsed.item.conditionText).toBeNull();
      expect(parsed.item.sampleSizes).toBeNull();
    });

    it("holds observedAt to the live row's bounds", () => {
      expect(rejectSync((r) => { r.observedAt = "2026-09-16T21:30:00"; })).toMatch(/explicit zone/);
      expect(rejectSync((r) => { r.observedAt = "1999-12-31T23:59:59Z"; })).toMatch(/predates/);
      expect(rejectSync((r) => { r.observedAt = "2999-01-01T00:00:00Z"; })).toMatch(/in the future/);
      expect(rejectSync((r) => { r.observedAt = 1726522200; })).toMatch(/ISO-8601 string/);
    });

    it("bounds conditionText", () => {
      expect(rejectSync((r) => { r.conditionText = "x".repeat(257); })).toMatch(/at most 256 characters/);
      expect(rejectSync((r) => { r.conditionText = `a${NUL}b`; })).toMatch(/conditionText carries a control character/);
      expect(rejectSync((r) => { r.conditionText = 5; })).toMatch(/conditionText must be a string/);
    });

    it("refuses a sample that is not a whole number from 1 to 1 000 000", () => {
      for (const bad of [0, -3, 1.5, 1_000_001, "12", null]) {
        expect(rejectSync((r) => { r.sampleSizes = { sell: bad }; })).toMatch(/sampleSizes\.sell must be a whole number/);
      }
      expect(rejectSync((r) => { r.sampleSizes = [12]; })).toMatch(/sampleSizes must be an object or null/);
    });

    it("drops a sample whose price was dropped, and a sample for a kind the row never priced", () => {
      const parsed = parseSyncRow(
        { ...validSyncRow(), prices: { sell: 38, voucher: 25 }, sampleSizes: { sell: 4, voucher: 9, cash: 2 } },
        limits, // voucher is not approved; cash is approved but not priced on this row
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.item.sampleSizes).toEqual({ sell: 4 });
    });

    it("stores null, not an empty object, when no sample survives", () => {
      const parsed = parseSyncRow({ ...validSyncRow(), sampleSizes: { voucher: 9 } }, limits);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.item.sampleSizes).toBeNull();
    });

    it("ignores a sampleSizes key that only exists on Object.prototype, not on the priced kinds", () => {
      // `kind in prices` would walk the prototype chain: "toString" and
      // "constructor" are IN every plain object without ever being an own
      // key. A row priced for `sell` only must ignore both the same way it
      // ignores any other kind it never priced.
      for (const bad of [{ toString: 5 }, { constructor: 3 }]) {
        const parsed = parseSyncRow(
          { ...validSyncRow(), prices: { sell: 38 }, sampleSizes: bad },
          limits,
        );
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.item.sampleSizes).toBeNull();
      }
    });
  });
});
