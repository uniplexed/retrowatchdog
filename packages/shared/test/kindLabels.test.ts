import { describe, expect, it } from "vitest";
import { kindDisplayLabel, kindLabelShort, type SourceInfo } from "../src/index.js";

const shop = (extra: Partial<SourceInfo>): Record<string, SourceInfo> => ({
  shop_gb: {
    label: "Shop GB",
    family: "shop",
    familyLabel: "Shop",
    kind: "live",
    country: "GB",
    reach: "local",
    defaultRegion: null,
    expectedCurrencies: ["GBP"],
    kindRoles: { sell: "buy_store" },
    kindLabels: { sell: "Shop GB sells for" },
    ...extra,
  } as SourceInfo,
});

describe("the two kind-label resolvers", () => {
  it("gives the long clause with the source's name, and the short word without it", () => {
    const byId = shop({ kindLabelsShort: { sell: "asks" } });
    expect(kindDisplayLabel(byId, "shop_gb", "sell")).toBe("Shop GB sells for");
    expect(kindLabelShort(byId, "shop_gb", "sell")).toBe("asks");
  });

  it("falls back to the app's own wording, each in its own register", () => {
    const byId = shop({});
    expect(kindDisplayLabel(byId, "shop_gb", "cash")).toBe("Shop GB pays cash");
    expect(kindLabelShort(byId, "shop_gb", "cash")).toBe("pays cash");
  });

  it("renders honestly for a source the registry does not know", () => {
    expect(kindDisplayLabel({}, "nobody", "sell")).toBe("nobody sells for");
    expect(kindLabelShort({}, "nobody", "sell")).toBe("sells for");
  });
});
