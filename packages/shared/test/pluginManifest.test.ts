import { describe, it, expect } from "vitest";
import { validateManifest, readStoredManifest, PLUGIN_PROTOCOL_VERSION, echo, MAX_ECHO_LENGTH } from "../src/index.js";
// The same function reached without going through the package index. The
// import ABOVE is what decides this file's module evaluation order — see the
// cycle canary at the bottom for what that does and does not prove.
import { validateManifest as validateFromTheModuleItself } from "../src/pluginManifest.js";

/** A manifest that must pass, so every negative case below differs in ONE field. */
function valid(): Record<string, unknown> {
  return {
    protocol: 3,
    plugin: { name: "vinted", version: "1.0.0" },
    sources: [
      {
        id: "vinted_uk",
        kind: "live",
        label: "Vinted UK",
        family: "vinted",
        familyLabel: "Vinted",
        country: "GB",
        reach: "global",
        kindRoles: { active_listing: "buy_listing" },
        kindLabels: { active_listing: "Vinted UK asking price" },
        caveat: "unofficial community scraper",
        defaultRegion: null,
        expectedCurrencies: ["GBP"],
      },
    ],
  };
}

describe("validateManifest accepts a well-formed v3 manifest", () => {
  it("round-trips every field it was given", () => {
    // ONE comparison against the whole expected manifest, deliberately: the
    // result is hand-rebuilt field by field, and the way a hand-written rebuild
    // fails is by DROPPING one. A list of per-field assertions only catches the
    // fields someone remembered to list — a rebuild that quietly stopped
    // copying `caveat` would sail through nine of them. Every field the fixture
    // sends is named here, so any one dropped or mis-copied fails this test.
    const result = validateManifest(valid());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest).toEqual({
      protocol: 3,
      plugin: { name: "vinted", version: "1.0.0" },
      requiredSecrets: [],
      sources: [
        {
          id: "vinted_uk",
          kind: "live",
          label: "Vinted UK",
          family: "vinted",
          familyLabel: "Vinted",
          country: "GB",
          reach: "global",
          defaultRegion: null,
          expectedCurrencies: ["GBP"],
          kindRoles: { active_listing: "buy_listing" },
          kindLabels: { active_listing: "Vinted UK asking price" },
          caveat: "unofficial community scraper",
        },
      ],
    });
  });

  it("rebuilds the source rather than spreading it, so a classification field cannot ride along", () => {
    // The binding rule: a plugin FETCHES, the app INTERPRETS. A manifest that
    // tries to declare how its listings should be read must not carry that
    // key through into the registry.
    const manifest = valid();
    (manifest.sources as Record<string, unknown>[])[0].platform = "n64";
    const result = validateManifest(manifest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("platform" in result.manifest.sources[0]).toBe(false);
  });

  it("accepts a sync source with a schedule", () => {
    const manifest = valid();
    (manifest.sources as Record<string, unknown>[])[0] = {
      ...(manifest.sources as Record<string, unknown>[])[0],
      id: "cex_pt", kind: "sync", family: "cex", familyLabel: "CeX", country: "ES",
      reach: "local", defaultRegion: "PAL", expectedCurrencies: ["EUR"],
      kindRoles: { sell: "buy_store", cash: "bid" },
      kindLabels: { sell: "CeX PT sells for", cash: "CeX PT pays cash" },
      schedule: { catalogCron: "0 3 * * *", trackedRefreshHours: 4 },
    };
    const result = validateManifest(manifest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.sources[0].schedule).toEqual({ catalogCron: "0 3 * * *", trackedRefreshHours: 4 });
  });
});

describe("kindLabelsShort", () => {
  it("accepts a short word for a kind the source gives a role", () => {
    const m = valid();
    (m.sources as Record<string, unknown>[])[0].kindLabelsShort = { active_listing: "asks" };
    const checked = validateManifest(m);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.manifest.sources[0].kindLabelsShort?.active_listing).toBe("asks");
  });

  it("is optional per kind: a source may shorten one word and not another", () => {
    const m = valid();
    const s = (m.sources as Record<string, unknown>[])[0];
    s.kindRoles = { active_listing: "buy_listing", cash: "bid" };
    s.kindLabels = { active_listing: "Vinted UK asking price", cash: "Vinted UK pays cash" };
    s.kindLabelsShort = { active_listing: "asks" };
    expect(validateManifest(m).ok).toBe(true);
  });

  it("round-trips an empty declaration as absent, not as a stored {}", () => {
    // Unlike categoryPlatforms (which refuses an empty map) and kindLabels
    // (forced non-empty by its completeness loop), kindLabelsShort is
    // optional per kind, so `{}` and "field not sent" are the same fact —
    // "no short word for any kind" — and must hash the same. Attaching `{}`
    // would make manifestFingerprint see a source that later drops the key
    // as having changed, and raise a false drift line.
    const m = valid();
    (m.sources as Record<string, unknown>[])[0].kindLabelsShort = {};
    const checked = validateManifest(m);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.manifest.sources[0].kindLabelsShort).toBeUndefined();
  });
});

describe("validateManifest rejects, naming the field", () => {
  const reject = (mutate: (m: Record<string, unknown>) => void): string => {
    const manifest = valid();
    mutate(manifest);
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.reason;
  };

  it("a protocol this app does not speak", () => {
    expect(reject((m) => { m.protocol = 1; })).toMatch(/protocol 1.*requires 3/i);
    expect(PLUGIN_PROTOCOL_VERSION).toBe(3);
  });

  it("a plugin name that is not a slug, and a version that is a novel", () => {
    expect(reject((m) => { (m.plugin as Record<string, unknown>).name = "Vinted UK!"; })).toMatch(/plugin\.name/);
    expect(reject((m) => { (m.plugin as Record<string, unknown>).version = "v".repeat(33); })).toMatch(/plugin\.version/);
  });

  it("a role the app does not have", () => {
    // `sold_median` is not a role this app UNDERSTANDS, which is the whole
    // test: PRICE_ROLES is the vocabulary a manifest may claim from, and
    // understood is not the same as acted upon — `guide` is understood and
    // deliberately fires no signal, so "has no engine rule" would be the
    // wrong ground to refuse anything on.
    expect(reject((m) => {
      (m.sources as Record<string, unknown>[])[0].kindRoles = { active_listing: "sold_median" };
    })).toMatch(/kindRoles/);
  });

  it("a price kind the app does not have", () => {
    expect(reject((m) => {
      (m.sources as Record<string, unknown>[])[0].kindRoles = { auction_high: "buy_listing" };
    })).toMatch(/kindRoles/);
  });

  it("an empty kindRoles: a source with no role is inert and has no business being imported", () => {
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].kindRoles = {}; })).toMatch(/kindRoles/);
  });

  it("a source that labels none of its kinds", () => {
    expect(reject((m) => { delete (m.sources as Record<string, unknown>[])[0].kindLabels; }))
      .toMatch(/sources\[0\]\.kindLabels/);
  });

  it("a source that labels some of its kinds and not others", () => {
    // The message names the KIND that has no label, not just the field: the
    // author is looking for which one they missed.
    expect(reject((m) => {
      const s = (m.sources as Record<string, unknown>[])[0];
      s.kindRoles = { active_listing: "buy_listing", cash: "bid" };
      s.kindLabels = { active_listing: "Vinted UK asking price" };
    })).toMatch(/cash/);
  });

  it("a short word for a kind the source declares no role for", () => {
    expect(reject((m) => {
      (m.sources as Record<string, unknown>[])[0].kindLabelsShort = { guide: "guide" };
    })).toMatch(/guide/);
  });

  it("a short word that is not short", () => {
    expect(reject((m) => {
      (m.sources as Record<string, unknown>[])[0].kindLabelsShort = { active_listing: "a".repeat(31) };
    })).toMatch(/kindLabelsShort\.active_listing/);
  });

  it("a country the app has no market in", () => {
    // Adding a country is an app change, honestly: COUNTRY_CODES drives the
    // valuation-markets picker, and a code nothing can select would be a
    // source no collection could ever value.
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].country = "RU"; })).toMatch(/country.*RU/);
  });

  it("a currency that is not an ISO code, and more than five of them", () => {
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].expectedCurrencies = ["pounds"]; })).toMatch(/expectedCurrencies/);
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].expectedCurrencies = []; })).toMatch(/expectedCurrencies/);
    expect(reject((m) => {
      (m.sources as Record<string, unknown>[])[0].expectedCurrencies = ["GBP","EUR","USD","JPY","CHF","CAD"];
    })).toMatch(/expectedCurrencies/);
  });

  it("a currency the rate provider does not quote", () => {
    // ISO-shaped and still refused: `ZZZ` passes the regex above and is
    // nothing this app's rate provider (Frankfurter) can price.
    expect(reject((m) => {
      (m.sources as Record<string, unknown>[])[0].expectedCurrencies = ["ZZZ"];
    })).toMatch(/ZZZ/);
  });

  it("a defaultRegion that is not one of the app's regions", () => {
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].defaultRegion = "EUR"; })).toMatch(/defaultRegion/);
  });

  it("a defaultRegion that is merely missing (null is the declaration, absence is an omission)", () => {
    expect(reject((m) => { delete (m.sources as Record<string, unknown>[])[0].defaultRegion; })).toMatch(/defaultRegion/);
  });

  it("two sources sharing an id inside the one manifest", () => {
    expect(reject((m) => {
      const first = (m.sources as Record<string, unknown>[])[0];
      (m.sources as Record<string, unknown>[]).push({ ...first });
    })).toMatch(/vinted_uk/);
  });

  it("more than twenty sources, and none at all", () => {
    expect(reject((m) => {
      const first = (m.sources as Record<string, unknown>[])[0];
      m.sources = Array.from({ length: 21 }, (_, i) => ({ ...first, id: `s${i}` }));
    })).toMatch(/sources/);
    expect(reject((m) => { m.sources = []; })).toMatch(/sources/);
  });

  it("a requiredSecrets entry shaped like anything but an env var name, and more than ten of them", () => {
    // Secrets live in the plugin; the manifest lists NAMES. The shape check
    // catches the common paste — a lowercase value, a key with punctuation in
    // it — but it cannot prove a name is not a value: an upper-cased token
    // matches this regex too. What actually protects the user is that the app
    // never asks for or stores a secret at all.
    expect(reject((m) => { m.requiredSecrets = ["ebay_client_id"]; })).toMatch(/requiredSecrets/);
    expect(reject((m) => { m.requiredSecrets = Array.from({ length: 11 }, (_, i) => `SECRET_${i}`); })).toMatch(/requiredSecrets/);
  });

  it("the same secret name listed twice, which declares one secret while claiming two", () => {
    expect(reject((m) => { m.requiredSecrets = ["EBAY_KEY", "EBAY_KEY"]; })).toMatch(/requiredSecrets.*EBAY_KEY.*twice/);
  });

  it("the same currency listed five times, which is one currency wearing a list's clothes", () => {
    expect(reject((m) => {
      (m.sources as Record<string, unknown>[])[0].expectedCurrencies = ["GBP", "GBP", "GBP", "GBP", "GBP"];
    })).toMatch(/expectedCurrencies.*GBP.*twice/);
  });

  it("a schedule on a live source, which has no catalog to sweep", () => {
    // The spec scopes `schedule` to sync sources. A live source declaring a
    // catalog cadence has contradicted itself about what it is, and the
    // cadence would be carried into the registry and read by nothing.
    expect(reject((m) => {
      const s = (m.sources as Record<string, unknown>[])[0];
      s.kind = "live";
      s.schedule = { catalogCron: "0 3 * * *", trackedRefreshHours: 4 };
    })).toMatch(/schedule/);
  });

  it("a sync source that does not say when it sweeps", () => {
    // The fixture is `live` and carries no `schedule`, so the `delete` below
    // is a no-op that documents the intent. Paired with the case above, the
    // two together are the whole rule: `schedule` is required on `sync` and
    // refused on `live`.
    expect(reject((m) => {
      const s = (m.sources as Record<string, unknown>[])[0];
      s.kind = "sync";
      delete s.schedule;
    })).toMatch(/sources\[0\]\.schedule/);
  });

  it("a sellFeeRate outside [0, 1]", () => {
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].sellFeeRate = 13; })).toMatch(/sellFeeRate/);
  });

  it("a cron that is not five fields", () => {
    expect(reject((m) => {
      const s = (m.sources as Record<string, unknown>[])[0];
      s.kind = "sync";
      s.schedule = { catalogCron: "nightly please", trackedRefreshHours: 4 };
    })).toMatch(/catalogCron/);
  });

  it("a trackedRefreshHours outside 1..168", () => {
    expect(reject((m) => {
      const s = (m.sources as Record<string, unknown>[])[0];
      s.kind = "sync";
      s.schedule = { catalogCron: "0 3 * * *", trackedRefreshHours: 0 };
    })).toMatch(/trackedRefreshHours/);
  });

  it("anything that is not an object at all", () => {
    expect(validateManifest("hello").ok).toBe(false);
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest([valid()]).ok).toBe(false);
  });

  it("a manifest that nested its fields under a __proto__ key, and so declares no protocol", () => {
    // Nothing about the prototype happens here, and the test does not claim
    // it: JSON.parse writes `__proto__` as an ORDINARY own data property,
    // leaving the object's prototype untouched at Object.prototype. What that
    // leaves is simply a manifest with no `protocol` field of its own, which
    // the very first version check refuses by name — and `undefined` is what
    // it quotes back, so the author can see the field never arrived.
    const nested = JSON.parse('{"__proto__": {"protocol": 2}}');
    expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
    const result = validateManifest(nested);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe(
      "this plugin speaks protocol undefined; this app requires 3",
    );
  });
});

describe("validateManifest treats a key as data, never as a place on the prototype", () => {
  const reject = (mutate: (m: Record<string, unknown>) => void): string => {
    const manifest = valid();
    mutate(manifest);
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.reason;
  };

  it("refuses a kindLabels key of 'constructor' as a kind the app does not have, before any membership question", () => {
    // The exact message matters, and pins the ORDER of the two checks in the
    // kindLabels loop: the known-kind test runs FIRST, so a prototype name is
    // out on the same ground as "auction_high" — the app has no such price
    // kind — and never reaches the `Object.hasOwn` line below it. Assert the
    // wording, or this test would pass just as happily against the other
    // check and name a guard it is not exercising.
    expect(reject((m) => {
      (m.sources as Record<string, unknown>[])[0].kindLabels = { constructor: "constructed" };
    })).toBe('sources[0].kindLabels key "constructor" is not a price kind this app knows');
  });

  it("refuses a kindLabels key of __proto__ the same way, by name and not by membership", () => {
    // JSON.parse makes `__proto__` an ordinary own key, so it reaches the loop
    // and is refused for not being a price kind. Had it got past that, the
    // assignment that would follow hits the prototype setter and leaves no own
    // key behind, and a stored manifest would disagree with the approved one.
    expect(reject((m) => {
      (m.sources as Record<string, unknown>[])[0].kindLabels =
        JSON.parse('{"__proto__": "Vinted UK asking price"}');
    })).toBe('sources[0].kindLabels key "__proto__" is not a price kind this app knows');
  });

  it("is the Object.hasOwn line that refuses a real kind the source declares no role for", () => {
    // This is the case the second check exists for, and the only one that
    // reaches it: `guide` IS a price kind, so the known-kind test passes and
    // `Object.hasOwn(kindRoles, "guide")` is what says no.
    //
    // What the pinned message buys is that this rejection keeps ITS OWN
    // ground: delete the `Object.hasOwn` line and the label is simply
    // accepted. It does NOT pin the order of the two checks, and must not be
    // read as if it did — swap them and `Object.hasOwn(kindRoles, "guide")` is
    // still false and this exact message is still what comes back. The
    // 'constructor' test above is the one the order is pinned by, because
    // there the two checks answer with different messages.
    expect(reject((m) => {
      (m.sources as Record<string, unknown>[])[0].kindLabels = { guide: "price guide" };
    })).toBe("sources[0].kindLabels.guide labels a kind this source declares no role for");
  });

  it("rejects an id of 'constructor', which the id regex is perfectly happy with", () => {
    // Eleven lowercase letters: `^[a-z][a-z0-9_]{1,31}$` accepts it. An id is
    // a Record key, and `registry["constructor"]` answers a function rather
    // than undefined, so a lookup meant to ask "do I have this source?" would
    // say yes to a source nobody imported.
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].id = "constructor"; }))
      .toMatch(/id "constructor".*Object\.prototype/);
  });

  it("rejects a family of 'constructor', which is grouped by the same kind of lookup", () => {
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].family = "constructor"; }))
      .toMatch(/family "constructor".*Object\.prototype/);
  });

  it("still accepts an ordinary id and family, which name nothing on Object.prototype", () => {
    const manifest = valid();
    (manifest.sources as Record<string, unknown>[])[0].id = "toolate";
    (manifest.sources as Record<string, unknown>[])[0].family = "valueof";
    expect(validateManifest(manifest).ok).toBe(true);
  });

  it("rejects a kindRoles key of __proto__ arriving the way a real manifest arrives", () => {
    // JSON.parse makes `__proto__` an ordinary own key (it never pollutes),
    // so it reaches the loop as a candidate price kind and is refused by name.
    expect(reject((m) => {
      (m.sources as Record<string, unknown>[])[0].kindRoles = JSON.parse('{"__proto__": "buy_listing"}');
    })).toMatch(/kindRoles/);
    // And had it got past that check, the write the loop would then do is
    // `kindRoles["__proto__"] = role`. That assignment does NOT create an own
    // key: it hits Object.prototype's `__proto__` SETTER, which silently
    // ignores any value that is not an object or null — and a role is a
    // string. So the danger is not pollution but a manifest the app stored
    // that disagrees with the one it approved: the key vanishes.
    const bystander: Record<string, unknown> = {};
    bystander["__proto__"] = "buy_listing";
    expect(Object.hasOwn(bystander, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(bystander)).toBe(Object.prototype);
  });

  it("rejects an id of __proto__ at the id regex, which no id may begin with an underscore to reach", () => {
    // Not the prototype guard, despite the name of the value: `__proto__`
    // starts with `_` and the id regex requires a leading [a-z], so it is out
    // one line earlier. The exact message says which guard answered — the
    // prototype guard's own coverage is the 'constructor' test above, which is
    // the id that passes the regex and still names something every object has.
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].id = "__proto__"; }))
      .toBe('sources[0].id "__proto__" must match ^[a-z][a-z0-9_]{1,31}$');
  });
});

describe("validateManifest rejects values that are the right type and still wrong", () => {
  const reject = (mutate: (m: Record<string, unknown>) => void): string => {
    const manifest = valid();
    mutate(manifest);
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.reason;
  };

  it("a sellFeeRate of NaN, which passes every comparison, and of Infinity, which does not", () => {
    // The two are refused by DIFFERENT lines, and only one of them needs
    // `Number.isFinite`. NaN < 0 and NaN > 1 are both false, so the range
    // check alone would admit NaN and turn this source's every PROFIT gain
    // into NaN — that case is `Number.isFinite`'s alone. Infinity > 1 is
    // simply true, so the range check already has it; it is asserted here
    // because it is the value a reader assumes shares NaN's escape, and it
    // does not.
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].sellFeeRate = Number.NaN; })).toMatch(/sellFeeRate/);
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].sellFeeRate = Number.POSITIVE_INFINITY; })).toMatch(/sellFeeRate/);
  });

  it("a trackedRefreshHours that is a fraction of an hour", () => {
    expect(reject((m) => {
      const s = (m.sources as Record<string, unknown>[])[0];
      s.kind = "sync";
      s.schedule = { catalogCron: "0 3 * * *", trackedRefreshHours: 4.5 };
    })).toMatch(/trackedRefreshHours/);
  });

  it("a label that is a hundred kilobytes of one letter", () => {
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].label = "a".repeat(100_000); })).toMatch(/label/);
  });

  it("a caveat of nothing but spaces: the minimum is about meaning, so it is measured trimmed", () => {
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].caveat = " ".repeat(300); })).toMatch(/caveat/);
  });

  it("a label of zero-width spaces, which trim() calls non-empty and a screen calls blank", () => {
    // `trim()` strips ECMAScript whitespace only, and none of these are that:
    // U+200B zero-width space, U+2060 word joiner, U+00AD soft hyphen. Each
    // renders as nothing, so the heading this bound exists to prevent is
    // exactly what the user would get.
    // Built from code points on purpose: pasted literally, they would be
    // invisible to the next reader of this file too.
    const zeroWidthSpace = String.fromCharCode(0x200b);
    const wordJoiner = String.fromCharCode(0x2060);
    const softHyphen = String.fromCharCode(0x00ad);
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].label = zeroWidthSpace.repeat(3); })).toMatch(/label/);
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].familyLabel = wordJoiner.repeat(2); })).toMatch(/familyLabel/);
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].caveat = softHyphen.repeat(2); })).toMatch(/caveat/);
    expect(reject((m) => {
      (m.sources as Record<string, unknown>[])[0].kindLabels = { active_listing: zeroWidthSpace };
    })).toMatch(/kindLabels/);
  });

  it("a NUL in any printed string, which the jsonb column it is stored in cannot hold", () => {
    // Postgres refuses a NUL inside a jsonb value outright — measured against
    // the real sink, `SELECT ('"a' || chr(0) || 'b"')::jsonb` answers
    // `ERROR: null character not permitted`. `plugins.manifest_seen` is that
    // column, so without this rule the insert dies and the panel prints
    // Fastify's bare "Internal Server Error" on a screen whose whole contract
    // is that a refusal names the field to fix. Every field is asserted
    // separately because each one is a separate call to the length check.
    // Built from code points, like the zero-width case above: pasted
    // literally, a control byte would corrupt this file too.
    const nul = String.fromCharCode(0);
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].label = `Shop${nul} GB`; })).toMatch(/label/);
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].familyLabel = `Shop${nul}`; })).toMatch(/familyLabel/);
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].caveat = `unofficial${nul}`; })).toMatch(/caveat/);
    expect(reject((m) => {
      (m.sources as Record<string, unknown>[])[0].kindLabels = { active_listing: `asking${nul} price` };
    })).toMatch(/kindLabels/);
    expect(reject((m) => { (m.plugin as Record<string, unknown>).version = `1.0${nul}.0`; })).toMatch(/plugin\.version/);
  });

  it("the rest of C0 and DEL too, because none of them can be typed on purpose", () => {
    // A heading the app prints in its own voice is one line. A tab or a
    // newline in it is a broken layout rather than meaning, which is why this
    // validator refuses the three bytes that
    // apps/api/src/adapters/sidecar/protocol.ts deliberately allows: that one
    // guards a product title a SHOP wrote, where a line break is a fact about
    // the listing.
    const chars = [0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f].map((c) => String.fromCharCode(c));
    for (const char of chars) {
      expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].label = `Shop${char}GB`; })).toMatch(/label/);
    }
  });

  it("a label whose only visible character is punctuation, which names nothing either", () => {
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].label = "--- ..."; })).toMatch(/label/);
  });

  it("a label of one digit, because a name may legitimately be that short", () => {
    const accepted = valid();
    (accepted.sources as Record<string, unknown>[])[0].label = "7";
    expect(validateManifest(accepted).ok).toBe(true);
  });

  it("a cron of the right shape and a hundred thousand characters", () => {
    // CRON_5 bounds the shape, not the size. Every other string a manifest
    // sends has a cap, and this one is in a document the app will store whole
    // and re-read on every health check once it can import a plugin.
    expect(reject((m) => {
      const s = (m.sources as Record<string, unknown>[])[0];
      s.kind = "sync";
      s.schedule = { catalogCron: `0 3 * * ${"1,".repeat(50_000)}1`, trackedRefreshHours: 4 };
    })).toMatch(/catalogCron/);
  });

  it("echoes an offending value truncated, since a rejection is written for a person to read", () => {
    const reason = reject((m) => {
      (m.sources as Record<string, unknown>[])[0].expectedCurrencies = ["x".repeat(5_000)];
    });
    expect(reason).toMatch(/expectedCurrencies/);
    expect(reason.length).toBeLessThan(200);
    expect(reason).toContain("…");
  });

  it("a cron padded with whitespace, because nothing here repairs a value", () => {
    expect(reject((m) => {
      const s = (m.sources as Record<string, unknown>[])[0];
      s.kind = "sync";
      s.schedule = { catalogCron: " 0 3 * * * ", trackedRefreshHours: 4 };
    })).toMatch(/catalogCron/);
  });

  it("a six-field cron, the realistic mistake a shape check is here to catch", () => {
    expect(reject((m) => {
      const s = (m.sources as Record<string, unknown>[])[0];
      s.kind = "sync";
      s.schedule = { catalogCron: "0 0 3 * * *", trackedRefreshHours: 4 };
    })).toMatch(/catalogCron/);
  });

  it("pins the id length cap: 32 characters is an id, 33 is not", () => {
    const accepted = valid();
    (accepted.sources as Record<string, unknown>[])[0].id = "a".repeat(32);
    expect(validateManifest(accepted).ok).toBe(true);
    expect(reject((m) => { (m.sources as Record<string, unknown>[])[0].id = "a".repeat(33); })).toMatch(/id/);
  });
});

describe("productUrl", () => {
  const withUrl = (productUrl: unknown) => {
    const m = valid();
    (m.sources as Record<string, unknown>[])[0].productUrl = productUrl;
    return validateManifest(m);
  };

  it("accepts a template whose host is fixed and whose id is a parameter", () => {
    const checked = withUrl("https://uk.webuy.com/product-detail?id={id}");
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.manifest.sources[0].productUrl).toBe("https://uk.webuy.com/product-detail?id={id}");
    }
  });

  it("accepts an id in the path as readily as in the query", () => {
    expect(withUrl("https://shop.example/item/{id}").ok).toBe(true);
  });

  it("accepts a host cased differently from what URL.origin lowercases it to", () => {
    // The origin check is a probe, not a string comparison: `origin`
    // lowercases the host but the prefix text does not, and a naive
    // `prefix.startsWith(origin + "/")` refused this even though the
    // substituted URL resolves to the same origin either way.
    expect(withUrl("https://UK.WEBUY.COM/p?id={id}").ok).toBe(true);
  });

  it("accepts an explicit default port, which URL.origin drops", () => {
    expect(withUrl("https://uk.webuy.com:443/p?id={id}").ok).toBe(true);
  });

  it("accepts a query with no path segment", () => {
    // `origin + "/"` is one character longer than a prefix that never had a
    // path to begin with; the probe substitutes an id and compares origins
    // instead of comparing that extra character.
    expect(withUrl("https://uk.webuy.com?id={id}").ok).toBe(true);
  });

  it("refuses a template that is not https", () => {
    expect(withUrl("http://uk.webuy.com/p?id={id}").ok).toBe(false);
  });

  it("refuses a template with no id, or with more than one", () => {
    expect(withUrl("https://uk.webuy.com/p").ok).toBe(false);
    expect(withUrl("https://uk.webuy.com/{id}/{id}").ok).toBe(false);
  });

  it("refuses a template whose HOST depends on the id", () => {
    // Everything before {id} must be a complete https URL AND reach past the
    // origin, so no substitution can move the request to another host.
    expect(withUrl("https://{id}.webuy.com/p").ok).toBe(false);
    expect(withUrl("https://uk.webuy{id}.com/p").ok).toBe(false);
    expect(withUrl("https://uk.webuy.com{id}").ok).toBe(false);
  });

  it("refuses a template carrying credentials", () => {
    expect(withUrl("https://user:pw@uk.webuy.com/p?id={id}").ok).toBe(false);
  });

  it("refuses a template that is not a string, is empty, or is absurdly long", () => {
    expect(withUrl(42).ok).toBe(false);
    expect(withUrl("").ok).toBe(false);
    expect(withUrl(`https://uk.webuy.com/${"a".repeat(600)}?id={id}`).ok).toBe(false);
  });
});

describe("categoryPlatforms", () => {
  const syncWith = (categoryPlatforms: unknown) => {
    const m = valid();
    const s = (m.sources as Record<string, unknown>[])[0];
    s.kind = "sync";
    s.schedule = { catalogCron: "0 3 * * *", trackedRefreshHours: 12 };
    s.categoryPlatforms = categoryPlatforms;
    return validateManifest(m);
  };

  it("accepts a map from this source's own category text to an app platform", () => {
    const checked = syncWith({ "Nintendo NES Software": "nes", "Sega Mega Drive Games": "megadrive" });
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.manifest.sources[0].categoryPlatforms?.["Nintendo NES Software"]).toBe("nes");
    }
  });

  it("refuses a platform this app does not have", () => {
    const checked = syncWith({ "3DO Games": "3do" });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toMatch(/3do/);
  });

  it("refuses it on a live source, the way a schedule is refused", () => {
    // The fixture's source is live and stays live here.
    const m = valid();
    (m.sources as Record<string, unknown>[])[0].categoryPlatforms = { Games: "nes" };
    const checked = validateManifest(m);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toMatch(/categoryPlatforms/);
  });

  it("refuses an empty map, a huge one, and a key that is not category text", () => {
    expect(syncWith({}).ok).toBe(false);
    const huge: Record<string, string> = {};
    for (let i = 0; i < 201; i += 1) huge[`c${i}`] = "nes";
    expect(syncWith(huge).ok).toBe(false);
    expect(syncWith({ [" ".repeat(300)]: "nes" }).ok).toBe(false);
  });

  it("refuses a category named after a property every object already has", () => {
    // An object LITERAL with a `__proto__` key sets the prototype instead of
    // adding an own property, so the fixture is parsed from JSON — the same
    // construction this file's existing prototype cases use.
    expect(syncWith(JSON.parse('{"__proto__":"nes"}')).ok).toBe(false);
    expect(syncWith({ constructor: "nes" }).ok).toBe(false);
  });
});

describe("echo", () => {
  it("quotes a short value unchanged", () => {
    expect(echo("GBP")).toBe('"GBP"');
  });

  it("cuts a long value at MAX_ECHO_LENGTH and says it was cut", () => {
    const out = echo("x".repeat(500));
    expect(out).toHaveLength(MAX_ECHO_LENGTH + 1);
    expect(out.endsWith("…")).toBe(true);
  });

  it("prints the word for undefined, which JSON.stringify cannot", () => {
    expect(echo(undefined)).toBe("undefined");
  });
});

describe("the module works when the cycle is entered through the package index", () => {
  // `pluginManifest.ts` imports the app's vocabulary from `index.ts`, which
  // re-exports it: a real ESM cycle. Which module is entered FIRST decides
  // whether a module-level read of an imported value works, and one module
  // graph has ONE evaluation order: this file's first import statement is
  // `../src/index.js`, so index-first is the order every test here runs
  // under — the direct import below re-uses a module that has already
  // finished evaluating, it does not re-enter the graph the other way.
  //
  // Index-first is the order that matters, because it is the dangerous one
  // and the one the app takes: `from "@retrowatchdog/shared"` enters through
  // the index, and that is the order in which a module-level
  // `new Set(PRICE_KINDS)` reads the binding in its temporal dead zone. The
  // leaf-first order is the forgiving one. Covering the dangerous order with
  // the whole suite is the coverage worth having.
  it("validates the same manifest through the binding taken from the module itself", () => {
    const result = validateFromTheModuleItself(valid());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.sources[0].country).toBe("GB");
  });
});

describe("reading a manifest back off a row", () => {
  it("reads a document written by a build that spoke another protocol", () => {
    const stored = valid();
    stored.protocol = PLUGIN_PROTOCOL_VERSION - 1;
    const read = readStoredManifest(stored);
    expect(read.ok).toBe(true);
    // The number is PRESERVED, not restamped: the row records what was
    // approved, and relabelling it as today's protocol would be this app
    // rewriting a person's decision.
    if (read.ok) expect(read.manifest.protocol).toBe(PLUGIN_PROTOCOL_VERSION - 1);
  });

  it("still refuses a stored document whose shape is wrong, whatever protocol it claims", () => {
    const stored = valid();
    delete (stored.sources as Record<string, unknown>[])[0].defaultRegion;
    const read = readStoredManifest(stored);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toMatch(/defaultRegion/);
  });

  it("refuses a protocol that is not a positive whole number", () => {
    for (const protocol of [0, -1, 2.5, "2", null, undefined]) {
      const stored = valid();
      stored.protocol = protocol;
      expect(readStoredManifest(stored).ok, `protocol ${String(protocol)}`).toBe(false);
    }
  });

  it("still refuses a PUBLISHED document that speaks another protocol", () => {
    const published = valid();
    published.protocol = PLUGIN_PROTOCOL_VERSION - 1;
    const checked = validateManifest(published);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toMatch(/this app requires/);
  });
});
