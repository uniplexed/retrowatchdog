import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ApprovePluginInput,
  MarketDto,
  PluginDto,
  PluginSourceDto,
  SourceId,
  SourceInfoDto,
} from "@retrowatchdog/shared";
import { defaultCheckedKinds, PluginsPanel } from "../src/components/PluginsPanel.js";
import { SettingsScreen } from "../src/screens/SettingsScreen.js";
import { SOURCES_FIXTURE } from "./fixtures/sources.js";
import { setSourcesForTests } from "../src/lib/sources.js";

/**
 * Settings → Plugins, driven against a stub of the five plugin endpoints that
 * answers the way apps/api/src/routes/plugins.ts does — including the one
 * refusal this whole screen exists for: an approval whose
 * `reviewedFingerprint` is not what the plugin's manifest hashes to NOW is
 * refused with 409, whatever the panel had on screen.
 */

/** A plugin proposing one two-sided shop plus a market median, as imported. */
function pendingPlugin(): PluginDto {
  return {
    id: 1,
    baseUrl: "http://shop:8000",
    name: "shop",
    version: "1.2.0",
    status: "pending",
    configured: true,
    requiredSecrets: ["SHOP_TOKEN"],
    sources: [
      {
        id: "shop_gb",
        label: "Shop GB",
        family: "shop",
        familyLabel: "Shop",
        country: "GB",
        reach: "local",
        kind: "live",
        kindRoles: { sell: "buy_store", cash: "bid", active_median: "reference" },
        kindLabels: {
          sell: "Shop GB sells for",
          cash: "Shop GB pays cash",
          active_median: "Shop GB median (active)",
        },
        caveat: "community plugin, not an official feed",
        // the four fields the app ACTS on that the card must show
        defaultRegion: "PAL",
        expectedCurrencies: ["GBP"],
        sellFeeRate: 0.125,
        approvedKinds: [],
        // Never approved: no document exists yet under which any kind could
        // have been granted a role.
        approvedKindRoles: {},
      },
    ],
    drift: [],
    proposed: null,
    adoptedAt: null,
    lastError: null,
    lastHealthAt: "2026-09-04T06:00:00.000Z",
    manifestFingerprint: "fp-1",
    // What the plugin last published. For a row with no proposal it is the
    // same digest the served one is, which is exactly why an approved row can
    // be edited through the existing endpoint.
    seenFingerprint: "fp-1",
    // No opinion set here, so the deployment's own default is what runs.
    rateLimitMs: null,
    effectiveRateLimitMs: 3000,
    rateLimitSource: "default",
  };
}

function approvedPlugin(overrides: Partial<PluginDto> = {}): PluginDto {
  const base = pendingPlugin();
  return {
    ...base,
    status: "approved",
    sources: base.sources.map((s) => ({
      ...s,
      approvedKinds: ["sell", "cash"],
      // What this document itself declares for every kind — the approved
      // document and the served document are the SAME one here (nothing has
      // drifted), so the role each granted kind was approved under is just
      // this source's own kindRoles.
      approvedKindRoles: s.kindRoles,
    })),
    ...overrides,
  };
}

/**
 * An approved plugin that has since republished: the row is still described by
 * the APPROVED document, and the one it publishes now rides beside it as
 * `proposed`, with its own fingerprint — which is the fingerprint the API
 * compares an approval against.
 */
function driftedPlugin(): PluginDto {
  const approved = approvedPlugin();
  return {
    ...approved,
    drift: ["shop_gb.kindRoles", "+shop_ie"],
    // A drifted row IS described by the approved document, so its served
    // fingerprint is fp-1 while what the plugin published is fp-2. That gap is
    // the whole reason an edit is not offered here.
    seenFingerprint: "fp-2",
    proposed: {
      name: "shop",
      version: "1.3.0",
      requiredSecrets: ["SHOP_TOKEN"],
      manifestFingerprint: "fp-2",
      sources: [
        {
          ...approved.sources[0],
          // it wants the baseline role now, and it wants a second country
          kindRoles: { sell: "reference", cash: "bid" },
          kindLabels: { sell: "Shop GB sells for", cash: "Shop GB pays cash" },
          approvedKinds: ["sell", "cash"],
          // Unchanged from what was actually approved (`approved.sources[0]`
          // above): `sell` was granted as `buy_store`, not `reference` — the
          // very fact that makes this a PROMOTION rather than a re-offer.
          approvedKindRoles: approved.sources[0].approvedKindRoles,
        },
        {
          ...approved.sources[0],
          id: "shop_ie",
          label: "Shop IE",
          country: "IE",
          kindRoles: { sell: "buy_store" },
          kindLabels: { sell: "Shop IE sells for" },
          approvedKinds: [],
          // Never part of any approved manifest: this source is new.
          approvedKindRoles: {},
        },
      ],
    },
  };
}

/**
 * An approved plugin that republished a change OUTSIDE `DRIFT_FIELDS` — a
 * version bump, here, which is exactly what a real plugin does on every
 * release. `manifestFingerprint` hashes the whole document, so the two
 * differ and a `proposed` exists; `driftFields` never compares `version`, so
 * `drift` stays empty. This is the state the editor's empty-drift sentence
 * exists for, modelled on `driftedPlugin()` above but with nothing for
 * `driftFields` to name.
 */
function republishedWithoutDrift(): PluginDto {
  const approved = approvedPlugin();
  return {
    ...approved,
    seenFingerprint: "fp-2",
    proposed: {
      name: approved.name,
      version: "1.3.0",
      requiredSecrets: approved.requiredSecrets,
      manifestFingerprint: "fp-2",
      sources: approved.sources,
    },
    drift: [],
  };
}

/** The market row the API adds to /api/settings/markets once shop_gb is approved. */
const SHOP_MARKET: MarketDto = {
  source: "shop_gb",
  label: "Shop GB",
  family: "shop",
  country: "GB",
  configured: true,
};

const SHOP_SOURCE: SourceInfoDto = {
  id: "shop_gb",
  label: "Shop GB",
  family: "shop",
  familyLabel: "Shop",
  kind: "live",
  country: "GB",
  reach: "local",
  defaultRegion: null,
  expectedCurrencies: ["GBP"],
  kindRoles: { sell: "buy_store", cash: "bid" },
  configured: true,
  origin: "plugin",
  pluginId: 1,
};

interface Server {
  plugins: PluginDto[];
  /**
   * What the row's manifest hashes to NOW — which is what the real approve
   * handler compares `reviewedFingerprint` against, NOT what it once served.
   * A test moves this to make the plugin republish under the open panel.
   */
  fingerprintNow: string | null;
  sources: SourceInfoDto[];
  markets: { enabled: SourceId[]; available: MarketDto[] };
  addRejection: string | null;
  added: string[];
  approvals: Array<{ id: number; body: ApprovePluginInput }>;
  disabled: number[];
  removed: number[];
  rechecked: number[];
  paces: Array<{ id: number; rateLimitMs: number | null }>;
  moved: Array<{ id: number; baseUrl: string }>;
  marketSaves: SourceId[][];
  /** the API's refusal when a market cannot be switched on */
  marketsRejection: string | null;
  /** the API's refusal when the new address does not answer */
  addressRejection: string | null;
  /** what the row looks like after a successful move */
  moveResult: Partial<PluginDto>;
  /** what a successful recheck learns about the plugin */
  recheckResult: Partial<PluginDto>;
  /** how many GET /api/settings/markets calls fail before one succeeds */
  marketsFailures: number;
  /** how many GET /api/plugins calls are refused before one succeeds */
  pluginsFailures: number;
}

function stubApi(initial: Partial<Server> = {}): Server {
  const server: Server = {
    plugins: [],
    fingerprintNow: "fp-1",
    sources: SOURCES_FIXTURE,
    markets: { enabled: ["cex", "ebay_uk"], available: [] },
    addRejection: null,
    added: [],
    approvals: [],
    disabled: [],
    removed: [],
    rechecked: [],
    paces: [],
    moved: [],
    marketSaves: [],
    marketsRejection: null,
    addressRejection: null,
    moveResult: {},
    recheckResult: { configured: true, lastError: null, lastHealthAt: "2026-09-06T09:00:00.000Z" },
    marketsFailures: 0,
    pluginsFailures: 0,
    ...initial,
  };
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u === "/api/plugins" && method === "GET") {
        if (server.pluginsFailures > 0) {
          server.pluginsFailures -= 1;
          // the shape the real API refuses in: a sentence, not a status code
          return json({ error: "the database is not answering" }, 503);
        }
        return json({ plugins: server.plugins, adapterTimeoutMs: 8000 });
      }
      if (u === "/api/plugins" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { baseUrl: string };
        server.added.push(body.baseUrl);
        if (server.addRejection !== null) return json({ error: server.addRejection }, 400);
        const plugin = pendingPlugin();
        server.plugins = [...server.plugins, plugin];
        return json({ plugin }, 201);
      }
      const approve = /^\/api\/plugins\/(\d+)\/approve$/.exec(u);
      if (approve !== null && method === "POST") {
        const id = Number(approve[1]);
        const body = JSON.parse(String(init?.body)) as ApprovePluginInput;
        server.approvals.push({ id, body });
        if (body.reviewedFingerprint !== server.fingerprintNow) {
          return json(
            {
              error:
                "this plugin changed its manifest while you were reviewing it; review it again",
            },
            409,
          );
        }
        const row = server.plugins.find((p) => p.id === id)!;
        // What the real handler does: the SEEN document is promoted to the
        // served one, so a drifted row comes back described by the document
        // that was just approved and with nothing left to review.
        const adopted = row.proposed ?? {
          name: row.name,
          version: row.version,
          requiredSecrets: row.requiredSecrets,
          sources: row.sources,
          manifestFingerprint: row.manifestFingerprint!,
        };
        const plugin: PluginDto = {
          ...row,
          name: adopted.name,
          version: adopted.version,
          requiredSecrets: adopted.requiredSecrets,
          manifestFingerprint: adopted.manifestFingerprint,
          seenFingerprint: adopted.manifestFingerprint,
          proposed: null,
          drift: [],
          status: "approved",
          sources: adopted.sources.map((s) => ({
            ...s,
            approvedKinds: body.approvedKinds[s.id] ?? [],
          })),
        };
        server.plugins = server.plugins.map((p) => (p.id === id ? plugin : p));
        // the registry and the markets list both gain the approved source,
        // and the enabled list does NOT: approving is not enabling
        server.sources = [...SOURCES_FIXTURE, SHOP_SOURCE];
        server.markets = { ...server.markets, available: [SHOP_MARKET] };
        return json({ plugin });
      }
      const address = /^\/api\/plugins\/(\d+)\/address$/.exec(u);
      if (address !== null && method === "POST") {
        const id = Number(address[1]);
        const body = JSON.parse(String(init?.body)) as { baseUrl: string };
        if (server.addressRejection !== null) {
          return json({ error: server.addressRejection }, 400);
        }
        server.moved.push({ id, baseUrl: body.baseUrl });
        const row = server.plugins.find((p) => p.id === id)!;
        // What the real endpoint does: the row moves, and what the NEW address
        // publishes lands in the column the app has not approved — so a
        // different document shows up as drift rather than inheriting consent.
        const plugin: PluginDto = { ...row, baseUrl: body.baseUrl, ...server.moveResult };
        server.plugins = server.plugins.map((p) => (p.id === id ? plugin : p));
        return json({ plugin });
      }
      const pace = /^\/api\/plugins\/(\d+)\/pace$/.exec(u);
      if (pace !== null && method === "POST") {
        const id = Number(pace[1]);
        const body = JSON.parse(String(init?.body)) as { rateLimitMs: number | null };
        const row = server.plugins.find((p) => p.id === id)!;
        const ms = body.rateLimitMs;
        // the API's own rule, so a test cannot pass against a laxer stub: the
        // last of n sources must still have room to finish
        if (ms !== null) {
          const gaps = Math.max(0, row.sources.length - 1);
          if (gaps > 0 && gaps * ms + 2000 > 8000) {
            return json(
              {
                error:
                  `${row.name} serves ${row.sources.length} markets on one queue, so at ${ms} ms ` +
                  `the last one starts ${gaps * ms} ms in — too late to answer inside the 8000 ms ` +
                  `a game view waits. Use ${Math.floor(6000 / gaps)} ms or less.`,
              },
              400,
            );
          }
        }
        server.paces.push({ id, rateLimitMs: ms });
        const plugin: PluginDto = {
          ...row,
          rateLimitMs: ms,
          effectiveRateLimitMs: ms ?? 3000,
          rateLimitSource: ms === null ? "default" : "plugin",
        };
        server.plugins = server.plugins.map((p) => (p.id === id ? plugin : p));
        return json({ plugin });
      }
      const recheck = /^\/api\/plugins\/(\d+)\/recheck$/.exec(u);
      if (recheck !== null && method === "POST") {
        const id = Number(recheck[1]);
        server.rechecked.push(id);
        const row = server.plugins.find((p) => p.id === id)!;
        if (row.status === "disabled") {
          return json({ error: "this plugin is off; turn it on first" }, 409);
        }
        // what the real endpoint does on a probe that answered: a fresh
        // reading, and the error the last failure left is gone
        const plugin: PluginDto = { ...row, ...server.recheckResult };
        server.plugins = server.plugins.map((p) => (p.id === id ? plugin : p));
        return json({ plugin });
      }
      const disable = /^\/api\/plugins\/(\d+)\/disable$/.exec(u);
      if (disable !== null && method === "POST") {
        const id = Number(disable[1]);
        server.disabled.push(id);
        server.plugins = server.plugins.map((p) =>
          p.id === id ? { ...p, status: "disabled" } : p,
        );
        return json({ plugin: server.plugins.find((p) => p.id === id) });
      }
      const remove = /^\/api\/plugins\/(\d+)$/.exec(u);
      if (remove !== null && method === "DELETE") {
        const id = Number(remove[1]);
        server.removed.push(id);
        server.plugins = server.plugins.filter((p) => p.id !== id);
        return json({ ok: true });
      }
      if (u === "/api/sources") return json({ sources: server.sources });
      if (u === "/api/settings/markets" && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { enabled: SourceId[] };
        if (server.marketsRejection !== null) {
          return json({ error: server.marketsRejection }, 400);
        }
        server.marketSaves.push(body.enabled);
        server.markets = { ...server.markets, enabled: body.enabled };
        return json(server.markets);
      }
      if (u === "/api/settings/markets" && method === "GET") {
        if (server.marketsFailures > 0) {
          server.marketsFailures -= 1;
          return new Response(null, { status: 500 });
        }
        return json(server.markets);
      }
      if (u === "/api/settings/fx") return json({ currencies: [] });
      throw new Error(`unexpected fetch ${method} ${u}`);
    }),
  );
  return server;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSourcesForTests(SOURCES_FIXTURE);
});

const addPluginAt = async (url: string): Promise<void> => {
  await userEvent.type(screen.getByLabelText(/plugin url/i), url);
  await userEvent.click(screen.getByRole("button", { name: "Add" }));
};

/**
 * Open the card's editor.
 *
 * The boxes are no longer on screen permanently. A card is a RECORD — what a
 * plugin is and what it is allowed to do — and the boxes, with every
 * consequence of ticking one, are a DECISION the user opens on purpose. Every
 * test that ticks a box goes through here, which is also the coverage that the
 * button exists at all for each status.
 */
const openEditor = async (name: string | RegExp, plugin?: string): Promise<void> => {
  const review = typeof name === "string" && REVIEW_LABELS.includes(name);
  if (screen.queryByRole("dialog") === null) {
    // wait for the rows; a review opens from "Review", or from "Configure" on
    // a plugin turned off (its sheet offers "Turn on…")
    await screen.findAllByRole("button", { name: /^(Review|Configure) / });
    const hasReview = screen.queryAllByRole("button", { name: /^Review / }).length > 0;
    await openPlugin(plugin, review && hasReview ? "Review" : "Configure");
  }
  await userEvent.click(await screen.findByRole("button", { name }));
};

const REVIEW_LABELS = ["Review and approve…", "Review the update…", "Turn on…"];

/**
 * Open a plugin's sheet from its row. A row has one action: "Review" when
 * the plugin waits on a decision, "Configure" otherwise. Without a name, the
 * first row offering that action.
 */
const openPlugin = async (plugin?: string, action?: "Review" | "Configure"): Promise<void> => {
  const verb = action ?? "(Review|Configure)";
  const name = new RegExp(`^${verb} ${plugin === undefined ? "" : `${plugin}$`}`);
  const buttons = await screen.findAllByRole("button", { name });
  await userEvent.click(buttons[0]);
};

/** The sheet's section tabs: Markets, Pace & address, Advanced. */
const openSection = async (section: "Markets" | "Pace & address" | "Advanced"): Promise<void> => {
  const tabs = await screen.findByRole("group", { name: "Plugin section" });
  await userEvent.click(within(tabs).getByRole("button", { name: new RegExp(`^${section}`) }));
};

/** The open sheet. */
const sheet = (): HTMLElement => screen.getByRole("dialog");

/** Remove… asks in a dialog; `confirm` false clicks Cancel. Returns the dialog's text. */
const removeViaDialog = async (confirm = true): Promise<string> => {
  if (screen.queryByRole("button", { name: "Remove…" }) === null) await openSection("Advanced");
  await userEvent.click(screen.getByRole("button", { name: "Remove…" }));
  const dialog = screen.getByRole("alertdialog", { name: "Remove plugin" });
  const text = dialog.textContent ?? "";
  await userEvent.click(within(dialog).getByRole("button", { name: confirm ? "Remove" : "Cancel" }));
  return text;
};

/**
 * One eBay market, shaped as the adopted eBay row holds it: `active_median`
 * under `reference` — the market baseline — and `active_listing` under
 * `buy_listing`, both already approved under the SAME roles they carry now,
 * so a re-review must re-propose exactly this.
 */
const ebayUk: PluginSourceDto = {
  id: "ebay_uk",
  label: "eBay UK",
  family: "ebay",
  familyLabel: "eBay",
  country: "GB",
  reach: "global",
  kind: "live",
  kindRoles: { active_median: "reference", active_listing: "buy_listing" },
  kindLabels: { active_median: "eBay UK median (active)", active_listing: "eBay UK listing" },
  caveat: "eBay UK prices are active FIXED-PRICE listings, not sold prices.",
  defaultRegion: null,
  expectedCurrencies: ["GBP"],
  sellFeeRate: 0.13,
  approvedKinds: [],
  approvedKindRoles: {},
};

describe("defaultCheckedKinds", () => {
  it("re-proposes a reference kind that this source already holds", () => {
    // Filtering `reference` out of a re-review of a source already granted
    // active_median would offer only active_listing — and approving the form
    // as shown would revoke the app's only baseline. Unchecked-by-default
    // is right for a role nobody has granted yet; it is not a reason to
    // withdraw one silently.
    expect(
      defaultCheckedKinds({
        ...ebayUk,
        approvedKinds: ["active_median", "active_listing"],
        approvedKindRoles: { active_median: "reference", active_listing: "buy_listing" },
      }),
    ).toEqual(["active_median", "active_listing"]);
  });

  it("still leaves a reference kind unchecked the first time", () => {
    expect(defaultCheckedKinds({ ...ebayUk, approvedKinds: [], approvedKindRoles: {} })).toEqual([
      "active_listing",
    ]);
  });

  it("does not re-check a kind whose role was PROMOTED to reference since it was approved", () => {
    // The case that made shipping the first test alone impossible: `cash`
    // granted before as `bid` (a store's payout), now claiming the baseline
    // role. Both this and the first test show a kind already in
    // `approvedKinds` with a CURRENT role of `reference` — indistinguishable
    // without `approvedKindRoles`, which is exactly why that field exists
    // (see its own doc comment, packages/shared/src/index.ts).
    const wasBuyStoreNowReference: PluginSourceDto = {
      ...ebayUk,
      id: "shop_gb",
      kindRoles: { cash: "reference" },
      approvedKinds: ["cash"],
      approvedKindRoles: { cash: "bid" },
    };
    expect(defaultCheckedKinds(wasBuyStoreNowReference)).toEqual([]);
  });
});

describe("the list", () => {
  it("one row per plugin with one action", async () => {
    stubApi({ plugins: [approvedPlugin(), approvedPlugin({ id: 2, name: "other" })] });
    render(<PluginsPanel />);
    expect(await screen.findByRole("button", { name: "Configure shop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Configure other" })).toBeInTheDocument();
    // nothing of a plugin's record is on the list itself
    expect(screen.queryByRole("button", { name: "Edit grants" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("a pending plugin's row action is Review, and it opens on the record", async () => {
    stubApi({ plugins: [pendingPlugin(), approvedPlugin({ id: 2, name: "other" })] });
    render(<PluginsPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "Review shop" }));
    expect(screen.queryByRole("button", { name: "Configure shop" })).not.toBeInTheDocument();
    expect(within(sheet()).getByText("No prices are read until you approve it.")).toBeInTheDocument();
    expect(within(sheet()).getByRole("button", { name: "Review and approve…" })).toBeInTheDocument();
  });
});

describe("adding a plugin", () => {
  it("asks the API for the URL the user typed and shows the sources it proposes", async () => {
    const server = stubApi();
    render(<PluginsPanel />);
    await screen.findByText("No plugins added.");
    await addPluginAt("http://shop:8000");

    expect(server.added).toEqual(["http://shop:8000"]);
    // a new plugin waits on a decision: its row's one action is Review
    await openPlugin("shop", "Review");
    // The RECORD of a pending row names what it offers and stops: nothing is
    // granted, so there is nothing to describe a grant with.
    expect(await screen.findByText(/Offers 1 market: Shop GB\./)).toBeInTheDocument();
    expect(screen.getByText(/They keep their own API keys/i)).toBeInTheDocument();
    // and nothing is granted: it is pending until someone approves it. The
    // exact string, because the panel's own help text above says the same
    // thing about adding — two true sentences, one per audience.
    expect(
      screen.getByText("No prices are read until you approve it."),
    ).toBeInTheDocument();

    // The plugin's own caveat is part of the DECISION, not the record: it
    // describes what you would be granting, so it appears where the granting
    // happens.
    await openEditor("Review and approve…");
    expect(screen.getByText(/community plugin, not an official feed/)).toBeInTheDocument();
    // the names of what it holds, disclosed but not as an instruction: this
    // fixture answered and says it is configured
    expect(screen.getByText("Uses SHOP_TOKEN.")).toBeInTheDocument();
  });

  it("shows the API's rejection verbatim and adds nothing", async () => {
    // The API's reason names the field of the manifest it refused, and a
    // rejected import stores nothing — so this sentence is the only account
    // of it the user will ever get.
    stubApi({
      addRejection: 'sources[0].country "PT" is not a country this app has a market in',
    });
    render(<PluginsPanel />);
    await screen.findByText("No plugins added.");
    await addPluginAt("http://shop:8000");

    expect(
      await screen.findByText(
        'sources[0].country "PT" is not a country this app has a market in',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByText("No plugins added.")).toBeInTheDocument();
  });
});

describe("the approval screen", () => {
  it("pre-checks every kind EXCEPT the one whose role is reference, and says why on screen", async () => {
    // The one role that changes what every OTHER source is judged against is
    // never granted by default: the user has to mean it. And the reason has
    // to be readable on the screen, not only in a comment beside the default.
    stubApi({ plugins: [pendingPlugin()] });
    render(<PluginsPanel />);
    await openEditor("Review and approve…");

    expect(await screen.findByLabelText(/sells for/i)).toBeChecked();
    expect(screen.getByLabelText(/pays cash/i)).toBeChecked();
    expect(screen.getByLabelText(/median/i)).not.toBeChecked();
    expect(
      screen.getByText("Baselines are not ticked by default."),
    ).toBeInTheDocument();
    // and the legend that says what that role DOES is open here, not behind a
    // disclosure: this is the moment it is being granted
    expect(
      screen.getByText(/the price every other price is compared to/i),
    ).toBeInTheDocument();
  });

  it("sends exactly the kinds left checked, and the fingerprint it was served", async () => {
    const server = stubApi({ plugins: [pendingPlugin()] });
    render(<PluginsPanel />);
    await openEditor("Review and approve…");
    await userEvent.click(await screen.findByLabelText(/pays cash/i));
    await userEvent.click(screen.getByRole("checkbox", { name: /read the source.s terms/i }));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(server.approvals).toHaveLength(1));
    expect(server.approvals[0]).toEqual({
      id: 1,
      body: { approvedKinds: { shop_gb: ["sell"] }, reviewedFingerprint: "fp-1" },
    });
  });

  it("refuses an approval of a manifest the plugin replaced while it was on screen", async () => {
    // THE GUARD THIS SCREEN EXISTS FOR. The panel sends back the fingerprint
    // it was SERVED with the manifest it rendered — never one it recomputed,
    // and never one from a fetch made after the user read the screen. So when
    // the plugin republishes between the render and the click, the API can
    // tell, and the user is sent back to review instead of having approved a
    // document they never saw.
    const server = stubApi({ plugins: [pendingPlugin()] });
    render(<PluginsPanel />);
    await openEditor("Review and approve…");
    await screen.findByLabelText(/sells for/i);

    // the plugin republishes under the open panel: same row, new manifest
    server.fingerprintNow = "fp-2";
    server.plugins = [
      {
        ...pendingPlugin(),
        manifestFingerprint: "fp-2",
        seenFingerprint: "fp-2",
        sources: pendingPlugin().sources.map((s) => ({
          ...s,
          kindRoles: { sell: "reference", cash: "bid", active_median: "reference" },
        })),
      },
    ];
    await userEvent.click(screen.getByRole("checkbox", { name: /read the source.s terms/i }));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(
      await screen.findByText(
        "this plugin changed its manifest while you were reviewing it; review it again",
      ),
    ).toBeInTheDocument();
    // it sent the fingerprint of what the user actually read, which is what
    // let the API refuse it
    expect(server.approvals).toEqual([
      { id: 1, body: { approvedKinds: { shop_gb: ["sell", "cash"] }, reviewedFingerprint: "fp-1" } },
    ]);
    // and nothing was granted
    expect(server.plugins[0].status).toBe("pending");
  });

  it("re-seeds the ticks and the fingerprint together when the manifest changes under the panel", async () => {
    // The other half of the same guard. The panel refetches after any
    // mutation, and a refresh that took the new fingerprint while leaving the
    // old ticks on screen would send consent for a document nobody read —
    // this time WITHOUT a 409, because the fingerprint would be current. The
    // review is keyed on the fingerprint, so both halves move or neither does.
    // With the plugin in a modal sheet, the re-read that can happen under an
    // open review is the one a refused approval triggers.
    const server = stubApi({ plugins: [pendingPlugin(), approvedPlugin({ id: 2, name: "other" })] });
    render(<PluginsPanel />);
    await openEditor("Review and approve…");
    // Scoped to the sheet: the OTHER plugin's record is not on screen, and
    // the box under test is the review's own.
    expect(await within(sheet()).findByLabelText(/sells for/i)).toBeChecked();

    // the plugin republishes: `sell` is now the baseline role
    const republished = pendingPlugin();
    republished.manifestFingerprint = "fp-2";
    republished.seenFingerprint = "fp-2";
    republished.sources[0].kindRoles = { sell: "reference", cash: "bid" };
    server.fingerprintNow = "fp-2";
    server.plugins = [republished, server.plugins[1]];

    // the refused approval offers the re-read; that is what reaches the
    // list under an open review
    await userEvent.click(screen.getByRole("checkbox", { name: /read the source.s terms/i }));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(server.approvals).toHaveLength(1));
    await userEvent.click(await screen.findByRole("button", { name: "↻ Reload plugin" }));

    await waitFor(() => expect(within(sheet()).getByLabelText(/sells for/i)).not.toBeChecked());
    await userEvent.click(screen.getByRole("checkbox", { name: /read the source.s terms/i }));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(server.approvals).toHaveLength(2));
    expect(server.approvals[1]).toEqual({
      id: 1,
      body: { approvedKinds: { shop_gb: ["cash"] }, reviewedFingerprint: "fp-2" },
    });
  });

  it("proposes a source nobody has reviewed as a first review, whatever the plugin's status", async () => {
    // "Reviewed before" is a question about the SOURCE, and asking it of the
    // PLUGIN was the bug. A re-review of a plugin that has since published a
    // NEW source intersected that source's kinds with its `approvedKinds`,
    // which is `[]` for a source nobody ever approved — so every box arrived
    // unchecked, directly under this panel's own promise that a source new
    // here "appears in Markets below, switched off". Approving then granted
    // it nothing, and a source approved for nothing is in NO market list at
    // all, switched off or otherwise.
    const server = stubApi({ plugins: [driftedPlugin()], fingerprintNow: "fp-2" });
    render(<PluginsPanel />);
    await openEditor("Review the update…");

    // the promise this default has to keep, on screen beside Approve
    expect(
      await screen.findByText("Markets already on stay on. New markets start off."),
    ).toBeInTheDocument();
    // shop_ie is new in this document: first-review default, so it is ticked
    expect(screen.getByLabelText(/Shop IE sells for/i)).toBeChecked();
    // shop_gb is not new: the intersection with what was granted last time
    // still applies, and `reference` is still filtered out ahead of it
    expect(screen.getByLabelText(/Shop GB pays cash/i)).toBeChecked();
    expect(screen.getByLabelText(/Shop GB sells for/i)).not.toBeChecked();

    await userEvent.click(screen.getByRole("checkbox", { name: /read the source.s terms/i }));

    await userEvent.click(screen.getByRole("button", { name: "Approve the update" }));
    await waitFor(() => expect(server.approvals).toHaveLength(1));
    // the grant is what makes the promise true: a role, so the source exists
    expect(server.approvals[0].body.approvedKinds.shop_ie).toEqual(["sell"]);
    // and the record then says so, in the app's own wording for the kind and
    // the role it was granted under
    expect(
      await screen.findByLabelText("Shop IE: sells for granted as shop price"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Shop IE: nothing granted/),
    ).not.toBeInTheDocument();
  });

  it("gives the 'review it again' refusal something to review it WITH", async () => {
    // The 409 this screen exists to produce used to be a dead end: the only
    // Retry on the panel lives in the load-error branch, which an approval
    // failure never reaches, so the user was told to review the plugin again
    // while looking at the stale document — same fingerprint, same ticks — and
    // pressing Approve again could only fail identically.
    const server = stubApi({ plugins: [pendingPlugin()] });
    render(<PluginsPanel />);
    await openEditor("Review and approve…");
    expect(await screen.findByLabelText(/Shop GB pays cash/i)).toBeInTheDocument();

    // the plugin republishes under the open panel: it pays in vouchers now
    const republished = pendingPlugin();
    republished.manifestFingerprint = "fp-2";
    republished.seenFingerprint = "fp-2";
    republished.sources[0].kindRoles = { sell: "buy_store", voucher: "bid" };
    republished.sources[0].kindLabels = {
      sell: "Shop GB sells for",
      voucher: "Shop GB pays voucher",
    };
    server.fingerprintNow = "fp-2";
    server.plugins = [republished];

    await userEvent.click(screen.getByRole("checkbox", { name: /read the source.s terms/i }));

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(
      await screen.findByText(
        "this plugin changed its manifest while you were reviewing it; review it again",
      ),
    ).toBeInTheDocument();
    // and the document on screen is still the stale one, which is why an
    // unaided second press of Approve could only earn the same 409
    expect(screen.queryByLabelText(/pays voucher/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Reload plugin/ }));

    // what the plugin publishes NOW is what is being consented to: new kinds,
    // new ticks, and the refusal gone with the document it was about
    expect(await screen.findByLabelText(/Shop GB pays voucher/i)).toBeChecked();
    expect(screen.queryByLabelText(/pays cash/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/changed its manifest while you were reviewing it/)).not.toBeInTheDocument();

    // and the approval now carries the fingerprint of what the user just read
    await userEvent.click(screen.getByRole("checkbox", { name: /read the source.s terms/i }));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(server.approvals).toHaveLength(2));
    expect(server.approvals[1]).toEqual({
      id: 1,
      body: { approvedKinds: { shop_gb: ["sell", "voucher"] }, reviewedFingerprint: "fp-2" },
    });
    expect(server.plugins[0].status).toBe("approved");
  });

  it("says that approving is not enabling", async () => {
    stubApi({ plugins: [pendingPlugin()] });
    render(<PluginsPanel />);
    await openEditor("Review and approve…");
    expect(
      await screen.findByText("Only markets switched on are queried."),
    ).toBeInTheDocument();
  });

  it("shows every field the app ACTS on, in words, before the checkboxes", async () => {
    // The card used to render only prose: label, country, reach, caveat and
    // the kinds. What it left out was not trivia — `expectedCurrencies`
    // decides which prices exist at all, `defaultRegion` classifies every
    // row, `sellFeeRate` changes a number on the screen, and `schedule`
    // decides whether a whole catalog is swept and its unseen rows deleted.
    // A consent screen that hides a field the app acts on is not one.
    //
    // They are one line per source now rather than four paragraphs, and the
    // three sentences that generalise (what a foreign currency costs, what a
    // fee does, what an assumed region means) are said once for the whole
    // document instead of once per source.
    stubApi({ plugins: [pendingPlugin()] });
    render(<PluginsPanel />);
    await openEditor("Review and approve…");

    expect(
      await screen.findByText("United Kingdom · GBP · region PAL · 12.5% fee"),
    ).toBeInTheDocument();
  });

  it("says what a catalog source would sweep, and what an undeclared fee means", async () => {
    // The other side of the same four: a `sync` source is the one that can
    // DELETE stored rows, so its cron and its cadence are on the consent
    // screen; and an absent fee is reported as absent rather than as a 0 the
    // plugin never wrote.
    const plugin = pendingPlugin();
    plugin.sources[0] = {
      ...plugin.sources[0],
      kind: "sync",
      schedule: { catalogCron: "0 3 * * *", trackedRefreshHours: 24 },
      sellFeeRate: undefined,
      defaultRegion: null,
    };
    stubApi({ plugins: [plugin] });
    render(<PluginsPanel />);
    await openEditor("Review and approve…");

    expect(
      await screen.findByText(/Syncs the full catalog on "0 3 \* \* \*" and refreshes tracked games every 24 h/),
    ).toBeInTheDocument();
    expect(screen.getByText(/A sync deletes stored rows no longer in the catalog/)).toBeInTheDocument();
    // no fee and no region declared: both are left out of the facts line
    expect(screen.getByText("United Kingdom · GBP")).toBeInTheDocument();
  });

  it("says where a source links its prices, when it declares a template", async () => {
    // The review screen is where a person approves what a source is allowed to be, and this is
    // one of those things — so it gets a sentence of its own, beside the
    // sweep sentence rather than folded into the `·` facts line.
    //
    // The fixture's source stays `live` — the kind `productUrl` carries no
    // restriction against in the validator, and the one the fixture ships
    // with today — so `linkSentence` rendering for a live source has real
    // coverage rather than being an accident of a sync fixture that happens
    // to also carry a template. The sync case, where a `productUrl` and a
    // `categoryPlatforms` ride the same source together, is the next test.
    const plugin = pendingPlugin();
    plugin.sources[0] = {
      ...plugin.sources[0],
      productUrl: "https://uk.webuy.com/product-detail?id={id}",
    };
    stubApi({ plugins: [plugin] });
    render(<PluginsPanel />);
    await openEditor("Review and approve…");

    expect(
      await screen.findByText(
        "Product links: https://uk.webuy.com/product-detail?id={id}",
      ),
    ).toBeInTheDocument();
  });

  it("says where a sync source links its prices and how many of its own categories it maps to platforms", async () => {
    // The review screen is where a person approves what a source is allowed to be, and both are
    // one of those things — so each gets a sentence of its own, beside the
    // sweep sentence rather than folded into the `·` facts line.
    //
    // `categoryPlatforms` is sync only, so this fixture needs a `sync`
    // source (with a schedule, so the card does not also print the
    // schedule-less warning) to say anything at all; `productUrl` carries no
    // such restriction and rides along on the same source to cover the case
    // where a sync source declares both.
    const plugin = pendingPlugin();
    plugin.sources[0] = {
      ...plugin.sources[0],
      kind: "sync",
      schedule: { catalogCron: "0 3 * * *", trackedRefreshHours: 24 },
      productUrl: "https://uk.webuy.com/product-detail?id={id}",
      categoryPlatforms: { "Nintendo NES Software": "nes" },
    };
    stubApi({ plugins: [plugin] });
    render(<PluginsPanel />);
    await openEditor("Review and approve…");

    expect(
      await screen.findByText(
        "Product links: https://uk.webuy.com/product-detail?id={id}",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Maps 1 category to platforms.")).toBeInTheDocument();
  });

  it("shows a declared short word beside the checkbox it belongs to", async () => {
    // `kindLabelsShort` is one of the three fields this batch added, and the
    // other two (`linkSentence`, `categorySentence` above) each have their
    // own coverage of the approval screen; this one had none, so a refactor
    // of the checkbox row could drop it silently.
    const plugin = pendingPlugin();
    plugin.sources[0] = {
      ...plugin.sources[0],
      kindLabelsShort: { sell: "asks" },
    };
    stubApi({ plugins: [plugin] });
    render(<PluginsPanel />);
    await openEditor("Review and approve…");

    expect(screen.getByLabelText(/Shop GB sells for \(asks\)/i)).toBeInTheDocument();
  });

  it("says what checking each box lets the app do, not just its role token", async () => {
    // Every role but `reference` used to render as a bare enum in
    // parentheses. `(bid)` is not a thing a person can consent to.
    //
    // The meaning now comes from a legend printed ONCE, open, beside the
    // boxes — rather than repeated in full after every box, which on the
    // five-market eBay row was the same two sentences five times.
    stubApi({ plugins: [pendingPlugin()] });
    render(<PluginsPanel />);
    await openEditor("Review and approve…");

    // the short role name is on the box itself
    expect(await screen.findByLabelText(/sells for — shop price/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/pays cash — pays you/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/median \(active\) — baseline/i)).toBeInTheDocument();
    // and what each one LETS THE APP DO is said once, in the legend
    expect(
      screen.getByText(/a shop's sale price\. Can trigger bargain and overpriced barks \(signals\)/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/what a shop pays you\. Used for flip barks \(signals\) and profit/i)).toBeInTheDocument();
    expect(
      screen.getByText(/the price every other price is compared to/i),
    ).toBeInTheDocument();
  });

  it("tells a disabled plugin's user what approving actually does to their markets", async () => {
    // The promise written for a PENDING row was printed under a disabled one,
    // where it is false twice over: approving a disabled plugin switches it
    // back on, and because disabling does not prune the enabled list, a market
    // that was on before comes back ON — live again for the next caller that
    // asks for prices, which is a game view or a worker tick.
    stubApi({ plugins: [approvedPlugin({ status: "disabled" })] });
    render(<PluginsPanel />);
    await openEditor("Turn on…");

    expect(await screen.findByText("Turn on shop")).toBeInTheDocument();
    expect(
      screen.getByText("Only markets switched on are queried."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Markets already on stay on/)).not.toBeInTheDocument();
  });

  it("re-proposes what the user chose last time, never more", async () => {
    // A re-review must not quietly re-offer a kind the user deliberately
    // refused: that would turn "the user decides" into "the user decides
    // until the plugin asks again". The last decision is the proposal, and
    // `reference` is still filtered out of it first.
    const disabled = approvedPlugin({ status: "disabled" });
    // the user granted `cash` and deliberately left `sell` alone last time
    disabled.sources = disabled.sources.map((s) => ({ ...s, approvedKinds: ["cash"] }));
    const server = stubApi({ plugins: [disabled], fingerprintNow: "fp-1" });
    render(<PluginsPanel />);
    await openEditor("Turn on…");

    expect(await screen.findByLabelText(/pays cash/i)).toBeChecked();
    // refused last time, and re-offering it would undo that decision silently
    expect(screen.getByLabelText(/sells for/i)).not.toBeChecked();
    // never approved, and it claims the baseline role: unchecked
    expect(screen.getByLabelText(/median/i)).not.toBeChecked();

    // turning a source back on is a grant too: the terms box comes first
    await userEvent.click(screen.getByRole("checkbox", { name: /read the source.s terms/i }));
    await userEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(server.approvals).toHaveLength(1));
    expect(server.approvals[0].body.approvedKinds).toEqual({ shop_gb: ["cash"] });
  });

  it("still offers a never-reviewed source of a DISABLED row as a first review", async () => {
    // `enable` keeps `defaultCheckedKinds`' first-review branch, and `edit`
    // does not — the one place the two modes disagree, and the reason is the
    // question each answers. A disabled row is described by `manifest_seen`,
    // which can have gained a source since the row was approved: that
    // source's `approvedKinds` is `[]`, and without the branch its boxes
    // would arrive empty, Turn on would grant it nothing, and it would vanish
    // from every market list — the bug `defaultCheckedKinds` documents as
    // fixed. In `edit` the same empty set means the user granted it nothing
    // on purpose, so re-offering it would GRANT it without anyone deciding to.
    const disabled = approvedPlugin({ status: "disabled" });
    disabled.sources = [
      ...disabled.sources,
      {
        ...disabled.sources[0],
        id: "shop_ie",
        label: "Shop IE",
        kindRoles: { sell: "buy_store" },
        kindLabels: { sell: "Shop IE sells for" },
        approvedKinds: [],
        approvedKindRoles: {},
      },
    ];
    stubApi({ plugins: [disabled], fingerprintNow: "fp-1" });
    render(<PluginsPanel />);
    await openEditor("Turn on…");

    expect(await screen.findByLabelText(/Shop IE sells for/i)).toBeChecked();
  });
});

describe("an approved plugin", () => {
  it("shows its sources, its health and when it was last checked", async () => {
    stubApi({ plugins: [approvedPlugin()] });
    render(<PluginsPanel />);
    expect(await screen.findByText("shop")).toBeInTheDocument();
    // the row's one fact is the state
    expect(screen.getByText("on")).toBeInTheDocument();
    await openPlugin("shop");
    expect(within(sheet()).getByText(/^v1\.2\.0/)).toBeInTheDocument();
    // one word for the state, and the address with when it last answered
    expect(within(sheet()).getByText("on")).toBeInTheDocument();
    expect(screen.getByText(/^http:\/\/shop:8000 · last reply /)).toBeInTheDocument();
    // What it actually got, per source and per kind: the record of consent,
    // and the ROLE each kind carries, because the role is what the app acts on
    // and the plugin's own wording says nothing about it. It is a table now,
    // so the role is stated once per column instead of once per source — but
    // every granted cell still names it, which is what a screen reader and a
    // person coming back in six months both need.
    expect(screen.getByLabelText("Shop GB: sells for granted as shop price")).toBeInTheDocument();
    expect(screen.getByLabelText("Shop GB: pays cash granted as pays you")).toBeInTheDocument();
    // offered and refused is not the same as never offered, and the record
    // distinguishes them
    expect(
      screen.getByLabelText("Shop GB: median (active) offered, not granted"),
    ).toBeInTheDocument();
    // an approved plugin is not under review: no boxes on the record
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("shows the pace in force on its section's label, and where it came from", async () => {
    // The setting that took four of five eBay markets dark lived only in a
    // gitignored .env. The label carries the number so it is never a click
    // away from being seen, and the row says which source decided it. The
    // environment override is gone entirely now — its value was backfilled
    // into this very column first — so the two remaining answers are this
    // plugin's own row and the deployment default.
    stubApi({
      plugins: [
        approvedPlugin({
          rateLimitMs: 250,
          effectiveRateLimitMs: 250,
          rateLimitSource: "plugin",
        }),
      ],
    });
    render(<PluginsPanel />);
    await openPlugin("shop");
    await userEvent.click(await screen.findByRole("button", { name: "Pace & address · 250 ms" }));

    expect(screen.getByText("In use: 250 ms (manual).")).toBeInTheDocument();
  });

  it("warns that a pace would starve the last markets, before it is saved", async () => {
    // The arithmetic that matters is not the pace, it is the pace times the
    // number of markets sharing the queue. The panel does it from the same
    // shared function the API refuses with, so the sentence before the click
    // and the refusal after it can never disagree.
    const fiveMarkets = approvedPlugin();
    fiveMarkets.sources = ["gb", "de", "es", "fr", "us"].map((cc) => ({
      ...fiveMarkets.sources[0],
      id: `shop_${cc}`,
      label: `Shop ${cc.toUpperCase()}`,
    }));
    const server = stubApi({ plugins: [fiveMarkets] });
    render(<PluginsPanel />);
    await openPlugin("shop");
    await openSection("Pace & address");

    // 3000 ms is the value that was live during the incident
    expect(
      screen.getByText(/Too slow: the last request starts at 12\.0 s, past the 8\.0 s limit/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Use 1500 ms or less/)).toBeInTheDocument();

    const field = screen.getByLabelText(/Pace for shop, in milliseconds/);
    await userEvent.clear(field);
    await userEvent.type(field, "250");
    expect(screen.getByText("OK: the last request starts at 1.0 s, within the 8.0 s limit.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save pace" }));
    await waitFor(() => expect(server.paces).toEqual([{ id: 1, rateLimitMs: 250 }]));
    expect(
      await screen.findByText("Saved. The background worker applies it within 5 minutes."),
    ).toBeInTheDocument();
  });

  it("refuses to send a pace that is not a whole number above zero", async () => {
    const server = stubApi({ plugins: [approvedPlugin()] });
    render(<PluginsPanel />);
    await openPlugin("shop");
    await openSection("Pace & address");

    const field = screen.getByLabelText(/Pace for shop, in milliseconds/);
    await userEvent.clear(field);
    await userEvent.type(field, "0");
    await userEvent.click(screen.getByRole("button", { name: "Save pace" }));

    expect(screen.getByText("Enter a whole number above 0.")).toBeInTheDocument();
    expect(server.paces).toEqual([]);
  });

  it("moves a plugin to a new address, keeping what it was granted", async () => {
    // A container gets a different port. Without this the only way to follow it
    // is Remove and Add again — which spends the grant, drops its markets out
    // of the enabled list, and for the adopted eBay row spends an offer that
    // cannot be made twice. None of that is a decision anybody made.
    const server = stubApi({ plugins: [approvedPlugin()] });
    render(<PluginsPanel />);
    await openPlugin("shop");
    await openSection("Pace & address");

    // the consequence, before the click: the app looks first, and a different
    // document comes back for review rather than inheriting the old consent
    expect(
      screen.getByText(/If the new address offers something different, you must review it/),
    ).toBeInTheDocument();

    const field = screen.getByLabelText(/Address for shop/);
    await userEvent.clear(field);
    await userEvent.type(field, "http://shop:9000");
    await userEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() =>
      expect(server.moved).toEqual([{ id: 1, baseUrl: "http://shop:9000" }]),
    );
    expect(await screen.findByText(/^http:\/\/shop:9000 · last reply /)).toBeInTheDocument();
    // and the grant came with it
    await openSection("Markets");
    expect(screen.getByLabelText("Shop GB: sells for granted as shop price")).toBeInTheDocument();
  });

  it("shows the refusal when the new address does not answer, and moves nothing", async () => {
    const server = stubApi({
      plugins: [approvedPlugin()],
      addressRejection: "http://shop:9001 GET /health failed: fetch failed: other side closed",
    });
    render(<PluginsPanel />);
    await openPlugin("shop");
    await openSection("Pace & address");

    const field = screen.getByLabelText(/Address for shop/);
    await userEvent.clear(field);
    await userEvent.type(field, "http://shop:9001");
    await userEvent.click(screen.getByRole("button", { name: "Move" }));

    expect(
      await screen.findByText(
        "http://shop:9001 GET /health failed: fetch failed: other side closed",
      ),
    ).toBeInTheDocument();
    expect(server.moved).toEqual([]);
    expect(screen.getByText(/^http:\/\/shop:8000 · last reply /)).toBeInTheDocument();
  });

  it("brings a moved plugin's different document back for review", async () => {
    // The consent hole this endpoint is shaped to avoid: whoever answers at
    // the new address must not inherit the old one's approval. The app writes
    // what the new address publishes into the column it has NOT approved, so
    // anything different arrives as drift.
    stubApi({
      plugins: [approvedPlugin()],
      moveResult: {
        drift: ["shop_gb.kindRoles"],
        seenFingerprint: "fp-2",
        proposed: {
          name: "shop",
          version: "1.3.0",
          requiredSecrets: ["SHOP_TOKEN"],
          manifestFingerprint: "fp-2",
          sources: approvedPlugin().sources.map((s) => ({
            ...s,
            kindRoles: { sell: "reference", cash: "bid" },
          })),
        },
      },
    });
    render(<PluginsPanel />);
    await openPlugin("shop");
    await openSection("Pace & address");
    const field = screen.getByLabelText(/Address for shop/);
    await userEvent.clear(field);
    await userEvent.type(field, "http://shop:9000");
    await userEvent.click(screen.getByRole("button", { name: "Move" }));

    expect(
      await screen.findByText(/Changed: Shop GB price roles\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The current approval stays in use until you approve the update/),
    ).toBeInTheDocument();
    // and the edit door is closed while there is an update to review
    await openSection("Markets");
    expect(screen.queryByRole("button", { name: "Edit grants" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review the update…" })).toBeInTheDocument();
  });

  it("checks the plugin on demand instead of waiting for the worker", async () => {
    // The sequence this button exists for: a plugin is missing its key, the
    // user sets it where the plugin runs and restarts that container, and the
    // Settings screen goes on saying the markets cannot be switched on — for
    // up to five minutes, with nothing to press.
    const server = stubApi({
      plugins: [approvedPlugin({ configured: false, lastError: "no token" })],
    });
    render(<PluginsPanel />);
    expect(await screen.findByText("needs its keys")).toBeInTheDocument();

    await openPlugin("shop");
    await openSection("Advanced");
    await userEvent.click(screen.getByRole("button", { name: "↻ Check now" }));

    await waitFor(() => expect(server.rechecked).toEqual([1]));
    expect(await within(sheet()).findByText("on")).toBeInTheDocument();
    expect(screen.queryByText(/^Missing /)).not.toBeInTheDocument();
    expect(screen.queryByText(/Last error/)).not.toBeInTheDocument();
  });

  it("does not offer a check on a plugin that is off", async () => {
    // The endpoint refuses it, and for the same reason: disabled means the app
    // has stopped querying it.
    stubApi({ plugins: [approvedPlugin({ status: "disabled" })] });
    render(<PluginsPanel />);
    await screen.findByText("shop");
    await openPlugin("shop");
    await openSection("Advanced");
    expect(screen.getByRole("button", { name: "Remove…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "↻ Check now" })).not.toBeInTheDocument();
  });

  it("prints a refused check verbatim, like every other call here", async () => {
    const server = stubApi({ plugins: [approvedPlugin()] });
    render(<PluginsPanel />);
    await screen.findByText("shop");
    await openPlugin("shop");
    await openSection("Advanced");
    server.plugins = [approvedPlugin({ status: "disabled" })];

    await userEvent.click(screen.getByRole("button", { name: "↻ Check now" }));
    expect(
      await screen.findByText("this plugin is off; turn it on first"),
    ).toBeInTheDocument();
  });

  it("offers Edit grants, and only where an edit could succeed", async () => {
    // Three rows, three answers. An approved, non-drifted row can be edited
    // through the existing approve endpoint, because the fingerprint it was
    // served IS the one the guard compares. A drifted row cannot — its served
    // digest is of the OLD document, so an edit could only earn a 409 — and it
    // is offered the update instead. And a row whose `manifest_seen` the API
    // cannot read earns a 400 however careful the client is, which is what
    // `seenFingerprint: null` says before the click.
    stubApi({
      plugins: [
        approvedPlugin(),
        { ...driftedPlugin(), id: 2, name: "drifted" },
        approvedPlugin({ id: 3, name: "unreadable", seenFingerprint: null }),
      ],
    });
    render(<PluginsPanel />);
    await screen.findByText("shop");

    await openPlugin("shop");
    expect(within(sheet()).getByRole("button", { name: "Edit grants" })).toBeEnabled();
    await userEvent.keyboard("{Escape}");

    // the drifted row's one action is its review
    expect(screen.queryByRole("button", { name: "Configure drifted" })).not.toBeInTheDocument();
    await openPlugin("drifted", "Review");
    expect(within(sheet()).queryByRole("button", { name: "Edit grants" })).not.toBeInTheDocument();
    expect(within(sheet()).getByRole("button", { name: "Review the update…" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    await openPlugin("unreadable");
    expect(within(sheet()).getByRole("button", { name: "Edit grants" })).toBeDisabled();
    expect(
      within(sheet()).getByText(
        "Nothing to edit yet: no manifest received.",
      ),
    ).toBeInTheDocument();
  });

  it("edits a served grant through the approve endpoint, carrying every source", async () => {
    // `approved_kinds` is replaced wholesale by the API, so an edit that sent
    // only the source it touched would silently revoke the rest — the failure
    // that would take four eBay markets off the Markets list in one click.
    const twoSources = approvedPlugin();
    twoSources.sources = [
      ...twoSources.sources,
      {
        ...twoSources.sources[0],
        id: "shop_ie",
        label: "Shop IE",
        kindLabels: { sell: "Shop IE sells for", cash: "Shop IE pays cash" },
        approvedKinds: ["sell"],
        approvedKindRoles: twoSources.sources[0].kindRoles,
      },
    ];
    const server = stubApi({ plugins: [twoSources] });
    render(<PluginsPanel />);
    await openEditor("Edit grants");

    // seeded from the standing grant, never from defaultCheckedKinds: a
    // source granted nothing would open empty rather than being re-offered
    expect(await screen.findByLabelText(/Shop GB sells for/i)).toBeChecked();
    expect(screen.getByLabelText(/Shop IE pays cash/i)).not.toBeChecked();

    await userEvent.click(screen.getByLabelText(/Shop GB pays cash/i));
    await userEvent.click(screen.getByRole("button", { name: "Save grants" }));

    await waitFor(() => expect(server.approvals).toHaveLength(1));
    expect(server.approvals[0]).toEqual({
      id: 1,
      body: {
        // the untouched source keeps exactly what it had
        approvedKinds: { shop_gb: ["sell"], shop_ie: ["sell"] },
        reviewedFingerprint: "fp-1",
      },
    });
  });

  it("switches a market on from the editor, after the grant that makes it possible", async () => {
    // The two halves of "is this market live" in one place: the boxes say what
    // it may be used for, the switch says whether the app queries it at all.
    // ORDER MATTERS — `PUT /api/settings/markets` refuses to switch on an id
    // the registry has none for, and a market granted by this very save only
    // enters the registry when the approval lands. So the approval goes first.
    const server = stubApi({ plugins: [pendingPlugin()], markets: { enabled: ["cex"], available: [] } });
    render(<PluginsPanel />);
    await openEditor("Review and approve…");

    const toggle = await screen.findByRole("switch", { name: "Query Shop GB" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("checkbox", { name: /read the source.s terms/i }));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(server.marketSaves).toHaveLength(1));
    expect(server.approvals).toHaveLength(1);
    expect(server.marketSaves[0]).toContain("shop_gb");
    // and the list it sent is the COMPLETE one, not a delta: the endpoint
    // replaces the stored list wholesale, so anything left out is switched off
    expect(server.marketSaves[0]).toContain("cex");
  });

  it("does not offer the switch for a market the save would grant nothing", async () => {
    // A source approved for nothing leaves the registry entirely, and the app
    // refuses to switch on an id it has no source for. Offering the switch
    // there would be offering a click that can only be refused.
    stubApi({ plugins: [pendingPlugin()] });
    render(<PluginsPanel />);
    await openEditor("Review and approve…");
    await screen.findByRole("switch", { name: "Query Shop GB" });

    await userEvent.click(screen.getByLabelText(/Shop GB sells for/i));
    await userEvent.click(screen.getByLabelText(/Shop GB pays cash/i));

    expect(screen.getByRole("switch", { name: "Query Shop GB" })).toBeDisabled();
    expect(
      screen.getByText("Nothing ticked: Shop GB is removed from Markets."),
    ).toBeInTheDocument();
  });

  it("says the grants were saved when only the market switch is refused", async () => {
    // Two calls means one can fail alone. Reporting that as a failed save
    // would be false — the grants really were stored — so it gets its own
    // sentence.
    const server = stubApi({
      plugins: [pendingPlugin()],
      marketsRejection: "not configured, cannot be enabled: shop_gb",
    });
    render(<PluginsPanel />);
    await openEditor("Review and approve…");
    await userEvent.click(await screen.findByRole("switch", { name: "Query Shop GB" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /read the source.s terms/i }));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(
      await screen.findByText(
        "Grants saved. Market switches not saved: not configured, cannot be enabled: shop_gb",
      ),
    ).toBeInTheDocument();
    expect(server.approvals).toHaveLength(1);
  });

  it("reads the switches when the editor opens, never from a stale copy", async () => {
    // The reason this was left out of the first cut: two copies of one setting
    // on one screen. A panel-level cache would go stale the moment somebody
    // used the Markets block below, and the switch would then show the
    // opposite of the truth. Read at the moment of the decision instead.
    const server = stubApi({
      plugins: [approvedPlugin()],
      markets: { enabled: ["cex"], available: [] },
    });
    render(<PluginsPanel />);
    await screen.findByText("shop");

    // something else switches this market on after the panel first loaded
    server.markets = { ...server.markets, enabled: ["cex", "shop_gb"] };

    await openEditor("Edit grants");
    expect(await screen.findByRole("switch", { name: "Query Shop GB" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("sends nothing when Save is pressed with no change", async () => {
    // Every approval restamps `approved_at`, which is the registry's tie-break
    // when two rows claim one id — so a no-op Save must not reorder anything.
    const server = stubApi({ plugins: [approvedPlugin()] });
    render(<PluginsPanel />);
    await openEditor("Edit grants");
    await userEvent.click(await screen.findByRole("button", { name: "Save grants" }));

    expect(server.approvals).toEqual([]);
    // and it closed back to the record
    expect(await screen.findByRole("button", { name: "Edit grants" })).toBeInTheDocument();
  });

  it("warns before saving away the last baseline in the deployment", async () => {
    // Two clicks, once Edit grants exists, and the collection has no value and
    // no bargain or flip bark fires. Every other warning on this screen speaks
    // about one market; this one is only true of the set, so it is computed
    // across the panel and shown beside Save.
    const withBaseline = approvedPlugin();
    withBaseline.sources = withBaseline.sources.map((s) => ({
      ...s,
      approvedKinds: ["sell", "active_median"],
    }));
    stubApi({ plugins: [withBaseline] });
    render(<PluginsPanel />);
    await openEditor("Edit grants");

    expect(await screen.findByLabelText(/median/i)).toBeChecked();
    expect(screen.queryByText(/No baseline left/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText(/median/i));
    expect(
      screen.getByText(/No baseline left: collection values, bargain and flip barks \(signals\) will stop/),
    ).toBeInTheDocument();
    // and the per-box sentence too, because it names what unticking hides
    expect(
      screen.getByText("Unticked: Shop GB stops being a baseline and its stored prices are hidden."),
    ).toBeInTheDocument();
  });

  it("stays quiet about the baseline when another plugin still holds one", async () => {
    const withBaseline = approvedPlugin();
    withBaseline.sources = withBaseline.sources.map((s) => ({
      ...s,
      approvedKinds: ["sell", "active_median"],
    }));
    const other = approvedPlugin({ id: 2, name: "other" });
    other.sources = other.sources.map((s) => ({
      ...s,
      id: "other_gb",
      label: "Other GB",
      approvedKinds: ["active_median"],
    }));
    stubApi({ plugins: [withBaseline, other] });
    render(<PluginsPanel />);
    await screen.findByText("other");
    await openPlugin("shop");
    await userEvent.click(within(sheet()).getByRole("button", { name: "Edit grants" }));

    await userEvent.click(await within(sheet()).findByLabelText(/median/i));
    expect(screen.queryByText(/No baseline left/)).not.toBeInTheDocument();
  });

  it("says so when a source was approved for nothing", async () => {
    stubApi({
      plugins: [
        approvedPlugin({
          sources: pendingPlugin().sources.map((s) => ({ ...s, approvedKinds: [] })),
        }),
      ],
    });
    render(<PluginsPanel />);
    await openPlugin("shop");
    expect(
      await screen.findByText("Shop GB: nothing granted, not in Markets."),
    ).toBeInTheDocument();
  });

  it("warns when the manifest has changed, names the fields, and renders the new document for review", async () => {
    // Spec Part C: "shows manifest changed — review", with the user approving
    // the NEW document from this card. That needs the drifted document on
    // screen and its own fingerprint sent back, both of which the API now
    // serves as `proposed`. Until the user approves it the app goes on
    // serving what was approved, which is what stops a plugin promoting
    // itself — so the card says both things and offers the review.
    stubApi({ plugins: [driftedPlugin()], fingerprintNow: "fp-2" });
    render(<PluginsPanel />);
    await openPlugin("shop", "Review");

    // The drift list is what the app ACTS on, said in words. `driftFields`
    // answers in identifiers — `shop_gb.kindRoles`, `+shop_ie` — which is the
    // right answer for a diff and the wrong one for the person deciding
    // whether to approve it. This banner is the only diff they are shown.
    expect(
      await screen.findByText(
        /Changed: Shop GB price roles and Shop IE added\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The current approval stays in use until you approve the update/i),
    ).toBeInTheDocument();
    // what the row still SERVES is on the record, unchanged, while the new
    // document waits behind the button
    expect(screen.getByLabelText("Shop GB: sells for granted as shop price")).toBeInTheDocument();

    // the new document, not the approved one: the source it has gained, and
    // the role it now claims for `sell`
    await openEditor("Review the update…");
    expect(screen.getByText("Review shop update")).toBeInTheDocument();
    expect(screen.getByText("Shop IE")).toBeInTheDocument();
    expect(await screen.findByLabelText(/Shop GB sells for/i)).not.toBeChecked();
  });

  it("approves a drifted plugin with the fingerprint of the document it showed", async () => {
    // The whole point of serving the drifted document: the panel can send
    // back a fingerprint the API will ACCEPT. Sending the approved one — all
    // the panel used to have — could earn nothing but a 409, which is why the
    // card used to tell the user to remove the plugin and add it again.
    const server = stubApi({ plugins: [driftedPlugin()], fingerprintNow: "fp-2" });
    render(<PluginsPanel />);
    await openEditor("Review the update…");

    // `sell` now claims the baseline role, so it arrives unchecked however it
    // was granted before; `cash` was granted last time and stays ticked.
    expect(await screen.findByLabelText(/Shop GB sells for/i)).not.toBeChecked();
    expect(screen.getByLabelText(/Shop GB pays cash/i)).toBeChecked();
    // and the sentence beside it names the PROMOTION rather than a
    // withdrawal: nothing was ever stored under a baseline for this kind, so
    // the warning written for revoking one would be false here.
    expect(
      screen.getByText("Previously granted as shop price, now asks to be a baseline. Not ticked by default."),
    ).toBeInTheDocument();
    // Shop IE is NEW in this document — nobody has ever reviewed it — so it
    // gets a first review's default, not the empty intersection of its kinds
    // with an approval that never happened. See defaultCheckedKinds.
    expect(screen.getByLabelText(/Shop IE sells for/i)).toBeChecked();

    await userEvent.click(screen.getByRole("checkbox", { name: /read the source.s terms/i }));

    await userEvent.click(screen.getByRole("button", { name: "Approve the update" }));
    await waitFor(() => expect(server.approvals).toHaveLength(1));
    expect(server.approvals[0]).toEqual({
      id: 1,
      body: {
        approvedKinds: { shop_gb: ["cash"], shop_ie: ["sell"] },
        reviewedFingerprint: "fp-2",
      },
    });
    // it was admitted, and the card now describes the document just approved
    expect(
      await screen.findByLabelText("Shop IE: sells for granted as shop price"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Changed:/)).not.toBeInTheDocument();
  });

  it("has something to say when a document differs but nothing drifted", async () => {
    // Approved, documents differ, `drift` empty. It happens on any republish
    // outside `DRIFT_FIELDS` — a version string here, or the protocol number —
    // and must not render "Changed since you approved it: ." with nothing
    // after the colon. `proposed` is still offered (it is the only fingerprint
    // the approve guard accepts), so the editor opens on the update exactly
    // as a real drift would; only the sentence differs.
    stubApi({ plugins: [republishedWithoutDrift()], fingerprintNow: "fp-2" });
    render(<PluginsPanel />);
    await openEditor("Review the update…");

    expect(
      await screen.findByText(
        "New version with no changes that affect prices.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Changed:/)).not.toBeInTheDocument();
  });

  it("says the same thing on the RECORD, before the editor is ever opened", async () => {
    // `protocol` is in `manifestFingerprint` but not in `DRIFT_FIELDS`, so a
    // protocol bump gives every approved plugin exactly this state — empty
    // `drift`, non-null `proposed` — the moment its container redeploys. The
    // editor's empty-drift sentence (proven above) is reached only after
    // "Review the update…" is clicked; before that click the card used to
    // show the amber "update to review" chip with no sentence beside it,
    // because its badge was gated on `drift.length > 0` alone.
    stubApi({ plugins: [republishedWithoutDrift()], fingerprintNow: "fp-2" });
    render(<PluginsPanel />);

    // the row says it before anything is opened
    expect(await screen.findByText("update to review")).toBeInTheDocument();
    await openPlugin("shop", "Review");
    expect(within(sheet()).getByText("update to review")).toBeInTheDocument();
    expect(
      await screen.findByText(
        "New version with no changes that affect prices.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The current approval stays in use until you approve the update/i),
    ).toBeInTheDocument();
    // No drift entries to name, and no "It publishes something else now:"
    // banner with nothing after the colon.
    expect(screen.queryByText(/^Changed:/)).not.toBeInTheDocument();
    // Edit grants is unavailable while a proposal is pending, same as a real
    // drift — the review button is the only door in.
    expect(screen.queryByRole("button", { name: "Edit grants" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review the update…" })).toBeInTheDocument();
  });

  it("says what turning off and removing actually do before doing them", async () => {
    // Both keep every stored price; only removal touches the enabled list.
    // That is what apps/api/src/routes/plugins.ts does, and it is what the
    // controls say — no more, and no less. Remove's warning moved to the
    // confirm, which is the last place it can still change the decision.
    // Declined, so the row survives for the rest of this test — and what
    // Remove was ABOUT to do is still asserted, which is the point.
    const server = stubApi({ plugins: [approvedPlugin()] });
    render(<PluginsPanel />);
    await openPlugin("shop");
    await openSection("Advanced");

    expect(await screen.findByRole("button", { name: "Turn off" })).toBeInTheDocument();
    expect(
      screen.getByText("Turn off stops all requests. Stored prices are kept."),
    ).toBeInTheDocument();

    expect(await removeViaDialog(false)).toContain(
      'Remove "shop" and its market? Stored prices are kept. This cannot be undone.',
    );
    expect(server.removed).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(server.disabled).toEqual([1]));
    expect(await screen.findByText("No requests. Stored prices are kept.")).toBeInTheDocument();
  });

  it("removes it on request and stops listing it", async () => {
    const server = stubApi({ plugins: [approvedPlugin()] });
    render(<PluginsPanel />);
    await openPlugin("shop");
    await removeViaDialog();
    await waitFor(() => expect(server.removed).toEqual([1]));
    expect(await screen.findByText("No plugins added.")).toBeInTheDocument();
    // and its sheet closed with it, leaving the keyboard somewhere useful
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/plugin url/i)).toHaveFocus();
  });

  it("sends no DELETE when the confirm is declined", async () => {
    // The dialog is the whole warning now, so a decline has to be a decline.
    const server = stubApi({ plugins: [approvedPlugin()] });
    render(<PluginsPanel />);
    await openPlugin("shop");
    await removeViaDialog(false);
    expect(server.removed).toEqual([]);
    expect(screen.getByRole("button", { name: "Configure shop" })).toBeInTheDocument();
  });

  it("shows a plugin that has never answered as never having answered, with its last error", async () => {
    // One of the two health failures, and they are NOT the same situation: no
    // reply at all is an address or a container to check.
    stubApi({
      plugins: [
        approvedPlugin({
          configured: false,
          lastHealthAt: null,
          lastError: "connect ECONNREFUSED 172.19.0.4:8000",
        }),
      ],
    });
    render(<PluginsPanel />);
    // the row's fact, before anything is opened
    expect(await screen.findByText("no reply")).toBeInTheDocument();
    await openPlugin("shop");
    expect(
      await screen.findByText("No reply. Check the address and that the plugin is running."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Last error: connect ECONNREFUSED 172\.19\.0\.4:8000/)).toBeInTheDocument();
    // the chip agrees with the badge: `configured` is false for a plugin that
    // has never answered, so a chip that tested it first would say "needs its
    // keys" about a container nothing has ever reached
    expect(within(sheet()).getByText("no reply")).toBeInTheDocument();
    expect(screen.queryByText(/^Missing /)).not.toBeInTheDocument();
  });

  it("distinguishes a plugin that answered saying it lacks its secrets", async () => {
    // The other failure, printed identically before this: it ANSWERED, so the
    // address and the container are fine and the fix is a variable in the
    // plugin's own environment. Same words for both left the user checking
    // the wrong thing.
    stubApi({ plugins: [approvedPlugin({ configured: false })] });
    render(<PluginsPanel />);
    await openPlugin("shop");

    const line = await screen.findByText(/^Missing SHOP_TOKEN\./);
    expect(line).toHaveTextContent(/Set them where the plugin runs and restart it/);
    expect(within(sheet()).getByText("needs its keys")).toBeInTheDocument();
    expect(screen.queryByText(/^No reply\./)).not.toBeInTheDocument();
  });
});

describe("an adopted plugin", () => {
  it("discloses that it was approved automatically, and why", async () => {
    // Spec decision 5's own condition for adopting without asking: the
    // fact has to be visible in the app, or it is not disclosure.
    stubApi({ plugins: [approvedPlugin({ adoptedAt: "2026-09-05T00:00:00.000Z" })] });
    render(<PluginsPanel />);
    await openPlugin("shop");
    expect(await screen.findByText("Approved automatically.")).toBeInTheDocument();
  });

  it("warns that removing it will not bring it back on its own", async () => {
    // Turn off and Remove are not equally reversible for an adopted row, and
    // the control itself has to say so — not only this plan's document. The
    // flag is permanent on the card; the detail is in the confirm, at the
    // click, which is the last moment it can change the decision.
    stubApi({ plugins: [approvedPlugin({ adoptedAt: "2026-09-05T00:00:00.000Z" })] });
    render(<PluginsPanel />);
    await openPlugin("shop");
    await screen.findByText("Approved automatically.");

    expect(await removeViaDialog(false)).toContain(
      "If you add it again, you must approve it and turn its markets on yourself.",
    );
  });

  it("says nothing about adoption for a plugin a person approved themselves", async () => {
    stubApi({ plugins: [approvedPlugin()] }); // adoptedAt: null — an ordinary approval
    render(<PluginsPanel />);
    await openPlugin("shop");
    await openSection("Advanced");
    await userEvent.click(screen.getByRole("button", { name: "Remove…" }));
    expect(screen.getByRole("alertdialog", { name: "Remove plugin" })).toBeInTheDocument();
    expect(screen.queryByText(/Approved automatically/)).not.toBeInTheDocument();
    expect(screen.queryByText(/If you add it again/)).not.toBeInTheDocument();
  });
});

describe("when the panel cannot read its own list", () => {
  it("keeps the API's sentence and offers a retry, like every other call here", async () => {
    // "Could not load plugins" threw away the one thing the user could act
    // on. Every other call on this screen prints the API's own sentence, and
    // the sources banner offers a retry; this one did neither.
    const server = stubApi({ plugins: [approvedPlugin()], pluginsFailures: 1 });
    render(<PluginsPanel />);

    expect(await screen.findByText(/the database is not answering/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("shop")).toBeInTheDocument();
    expect(screen.queryByText(/the database is not answering/)).not.toBeInTheDocument();
    expect(server.plugins).toHaveLength(1);
  });

  it("says the list it is still showing may be out of date", async () => {
    // A failed refresh KEEPS the previous array, so the panel goes on
    // rendering a plugin the API may have just deleted. That is the right
    // trade — an error must not blank a working screen — but it has to say so.
    const server = stubApi({ plugins: [approvedPlugin()] });
    render(<PluginsPanel />);
    await screen.findByText("shop");
    await openPlugin("shop");

    // the refresh that follows the removal fails
    server.pluginsFailures = 1;
    await removeViaDialog();
    await userEvent.keyboard("{Escape}");

    expect(await screen.findByText(/the database is not answering/)).toBeInTheDocument();
    expect(
      screen.getByText(/Showing the last list loaded/),
    ).toBeInTheDocument();
    // the removed plugin is still on screen, which is exactly what the
    // sentence above is there to admit
    expect(screen.getByText("shop")).toBeInTheDocument();
    expect(server.removed).toEqual([1]);
  });

  it("names this app's own API when the browser cannot reach it", async () => {
    // A transport failure is the browser's own words — "Failed to fetch",
    // naming nothing. Printed raw on a screen about fetching a URL the user
    // typed, it reads as "your plugin is unreachable" when what is
    // unreachable is RetroWatchdog's API, and the two have different fixes.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url) === "/api/plugins") throw new TypeError("Failed to fetch");
        throw new Error(`unexpected fetch ${String(url)}`);
      }),
    );
    render(<PluginsPanel />);
    const banner = await screen.findByText(/Could not reach the app's API/i);
    expect(banner).toHaveTextContent("/api/plugins");
    expect(banner).toHaveTextContent("Failed to fetch");
  });
});

describe("Settings after an approval", () => {
  it("shows the approved plugin's markets in Markets below, switched off", async () => {
    // The promise the approval screen makes, kept: the markets are there to
    // switch on, and not one of them is on. `available` comes from
    // /api/settings/markets rather than from the registry, so this only works
    // because the panel tells the screen to re-read it.
    stubApi({ plugins: [pendingPlugin()] });
    render(<SettingsScreen />);
    await openEditor("Review and approve…");
    await screen.findByRole("button", { name: "Approve" });
    await userEvent.click(screen.getByRole("checkbox", { name: /read the source.s terms/i }));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    const box = (await screen.findByRole("checkbox", {
      name: /Shop GB/,
    })) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(false);
    // and it is grouped under the plugin's own family heading, which only the
    // reloaded registry could supply
    expect(screen.getByRole("heading", { level: 4, name: "Shop" })).toBeInTheDocument();
  });

  it("recovers the Markets block when a later load succeeds", async () => {
    // `loadError` was set and never cleared, and its branch returned before
    // rendering anything else — so one failed load left the block showing
    // "Could not load markets" for the rest of the session, including after
    // the reload that an approval triggers had succeeded.
    stubApi({ plugins: [pendingPlugin()], marketsFailures: 1 });
    render(<SettingsScreen />);
    expect(await screen.findByText("Could not load markets")).toBeInTheDocument();

    // approving bumps the Markets block's reload token
    await openEditor("Review and approve…");
    await screen.findByRole("button", { name: "Approve" });
    await userEvent.click(screen.getByRole("checkbox", { name: /read the source.s terms/i }));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByRole("checkbox", { name: /Shop GB/ })).toBeInTheDocument();
    expect(screen.queryByText(/Could not load markets/)).not.toBeInTheDocument();
  });
});

describe("approval needs an explicit reading of the source's terms", () => {
  it("Approve stays disabled until the terms box is ticked; nothing is sent before", async () => {
    const server = stubApi({ plugins: [pendingPlugin()] });
    render(<PluginsPanel />);
    await openEditor("Review and approve…");
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    const ack = screen.getByRole("checkbox", { name: /read the source.s terms/i });
    expect(ack).not.toBeChecked();
    await userEvent.click(approve);
    expect(server.approvals).toHaveLength(0);
    await userEvent.click(ack);
    expect(approve).toBeEnabled();
  });
});
