# Operating guide

The long-form reference for RetroWatchdog, the manager of your retro game
collection and your price hunts: what each setting means, what each screen
promises, and what the data is. [`README.md`](../README.md) is the overview,
[`install.md`](install.md) the step-by-step setup; plugin authors want
[`sidecar-protocol.md`](sidecar-protocol.md). [`LEGAL.md`](../LEGAL.md)
says what the sources' terms allow, that nothing here is financial advice,
and that the operator of a deployment is responsible for it.

## Appearance

The app has two layouts: a sidebar with Dashboard, Search, Watchlist,
Collection and Settings at 1024 px and wider, and a bottom tab bar (without
the dashboard) below that. Crossing the width keeps the screen and its state.
The theme control in the top bar, next to the currency, offers Light, Auto
and Dark; Auto follows the system's setting live, and the choice is kept in
the browser (`localStorage.theme`). Colours are the Slate & Amber tokens at
the top of `apps/web/src/styles.css`.

On desktop the top bar also carries a game search: type a title, pick a
result, and the game opens over the page you were on. `/` focuses it from
anywhere except a text field.

### The dashboard

The desktop opens on the dashboard. It reads the same endpoints as the pages
it summarises, so it can never disagree with them:

- four figures: the collection's value (with its change over 30 days, once
  the value history reaches that far back), paid, realized, and how many
  watches have a high-confidence signal;
- **Recommended actions**: up to ten high-confidence recommendations (sell,
  buy, target changes; see "Recommendations"), then today's good prices — every
  watch and owned copy whose best signal is high confidence that no
  recommendation already covers, best first, at most 20 — each opening its
  game; possible recommendations, clean-ups and best sources folded below;
- **Needs you**: plugins waiting for a review, copies whose match needs a
  check, and exchange rates that could not be fetched, each opening the
  section that fixes it;
- the collection's value history over 90 days.

A block whose request fails says so on its own; the rest still render.

### Settings sections

Settings is split into Appearance, Signals, Valuation, Markets, Exchange rates
and Plugins: a list on the left on desktop, one section at a time (the last
one opened is remembered in `localStorage.settingsSection`); folds on the
phone.

## Currency model

USD is the single internal base currency: price points, medians, signals,
collection totals and estimated values are all stored and computed in USD. The
source's original amount and currency are kept beside every stored price
(`price_original`, `currency_original`).

Each acquisition, sale and return leg on a copy stores its original amount and
currency plus a USD conversion made at write time with that day's cached rate,
then frozen and never re-derived. You can buy in EUR and sell in GBP; profit
and loss compare through the frozen USD values. If FX is down at write time and
no manual override covers the currency, the API answers 503 instead of storing
a guess.

### Which currencies the menus offer

Every currency the rate provider quotes (30) can be used, but the menus offer
only the enabled ones: USD, GBP, EUR, JPY, CHF, CAD and AUD on a new
deployment. Settings → Currencies lists them with a remove button each and an
"Add currency" picker for the rest; USD and the display currency cannot be
removed. The list is stored on the server (`GET`/`PUT
/api/settings/currencies`), so every device sees the same menus. Removing a
currency changes no saved amount: a copy or target already in it keeps it, and
its editor still offers it.

### Choosing a display currency

The header selector offers USD, GBP, EUR, JPY, CHF, CAD and AUD, kept in the
browser as `displayCurrency`. Rates come from Frankfurter, cached 24 hours; a
rate older than 48 hours shows its date, and an FX outage falls back to USD
display with a visible note. Copies always show their original ("paid
€25.00").

An amount is shown as quoted whenever the display currency is its own: CeX
quotes £177, storing it freezes $232.62, and converting that back would print
£176.37. Price tables, the cheapest-listing strip, the ownership panel's shop
comparable and the watchlist's shop prices print the verbatim quote when the
currencies match and convert otherwise. Totals, market medians and computed
gains are always converted, since none of them is an amount anyone quoted. A
matching quote needs no rate and stays exact while FX is down, which is why
the outage note reads "converted prices shown in USD".

The price history chart plots the quoted amount too: each series is
re-expressed with one factor (the newest point's USD over its quote), so only
the quote moves the line.

### Overriding a rate by hand

Goal: pin one currency's rate to USD instead of Frankfurter's.

1. Open Settings and find the currency's row in the FX section.
2. Switch it from automatic to manual and enter the rate (`PUT
   /api/settings/fx/:currency`, stored in `fx_overrides`).
3. To check, `GET /api/settings/fx` lists the override, and a converted price
   on any screen uses it.

A manual rate is used for display and for write-time conversions until you
switch the row back to automatic. USD amounts already frozen are not
recalculated.

### Reading a signal's reasoning

Reasoning strings keep the currency the comparison happened in: two UK sources
both quote GBP, so the reasoning cites £ amounts while stored values, badges
and deltas use USD or the display currency.

## Security

The app has no user accounts, so what protects it is where it can be reached
and the password in front of it (Settings have no login of their own):

- **Password.** `APP_PASSWORD_HASH` in `.env` puts HTTP basic auth in front of
  every request but `/root.crt`; see the README. Set it before anyone else
  can reach the ports.
- **Host names.** The API answers only to IP addresses, `localhost`, names
  without a dot (the compose service names) and the names in `PUBLIC_HOST`.
  Any other name gets `421`. This stops a DNS-rebinding page under an
  attacker's domain from reaching the API through a browser on your network.
  Opening the app by a new domain name means adding it to `PUBLIC_HOST`.
- **Writes from other sites.** A `POST`, `PUT`, `PATCH` or `DELETE` whose
  browser says it came from another site (`Sec-Fetch-Site`, or an `Origin`
  that is not this host) gets `403`. The worker and scripts send neither
  header and pass.
- **The plugins' network.** Plugins are untrusted code that share a network
  with the API. The API refuses every request from that network
  (`API_DENY_SUBNETS`, set by compose to `SIDECAR_SUBNET`), so a plugin cannot
  read your collection, approve itself or register another plugin.
- **Containers.** The API and the worker run as the image's unprivileged
  user; Postgres and Redis are reachable only inside the compose networks.
- **CSV export.** A field that a spreadsheet would run as a formula is
  written as text; the import takes the guard back off.

Known limitations: the password is one shared basic-auth credential, sent in
clear over plain `http://` if you open the app that way (use the `https://`
name); alerts through public ntfy.sh are readable by anyone who guesses the
topic name.

## Collection

Copies enter the collection from a game's record ("I own this"), from the
PriceCharting collection-link import (`POST
/api/collection/import/pricecharting`) or from a CSV import (`POST
/api/collection/import/csv`; `GET /api/collection/export` writes one). The
importers need no price source.

The collection screen is one dense row per copy: the console, region,
condition, grade, status and paid amount on the left; the value with the
reading behind it, and the copy's verdict line, on the right. Tapping a row
opens the game's record. Each row has three actions, Edit, Re-link and Remove:
swipe the row left on a phone, hover it on a desktop. The value and paid
figures sit above the list (realized and returns only when non-zero); status
chips filter by status; imports, the CSV export and "Delete entire
collection…" are in the ⋯ menu.

### Editing a copy

A row's Edit, and ✎ edit on each copy in the game record's "Your copies"
panel, opens the editor in a sheet (a side panel on desktop, a bottom sheet on
the phone) for the paid leg, acquisition date and source,
region, condition, grade, status and notes. "clear paid" removes the whole
paid leg and "clear grade" makes the copy ungraded. Marking a copy sold or
returned prompts for the sale amount, then its currency; the pending sale is
spelled out next to Status ("sold £40.00 — press Save to record") and travels
with the save, and its currency becomes the next default only once written.
Working state and authenticity are shown but have no control; the acquisition
URL and lot id come from the importers. A copy from the PriceCharting importer
shows its `pricecharting_import` source read-only. Cancel, or closing the
sheet, discards unsaved edits.

Save sends one `PATCH /api/collection/:id` with only the changed fields.
Amounts go out as the verbatim originals; the server freezes the USD twin only
when the amount or its currency changed, and an FX outage at save time is
reported inline with nothing stored.

### How a copy is valued

Values come from stored data only, never a live fetch, under the basis you pick
in Settings → Collection value (browser key `valuationBasis`, sent as `GET
/api/collection?valuation=`):

| basis | reading order |
| --- | --- |
| market (default) | the eBay active median for the copy's region and condition, through the signal engine's reference ladder and the `SIGNAL_MIN_SAMPLE` floor; then trade-in; then replacement |
| trade-in | the highest CeX bid (voucher or cash) the copy qualifies for; then market; then replacement |
| replacement | the cheapest in-stock CeX sell price the copy qualifies for; then market; never a bid, since a payout is not a rebuy cost |

Grades are matched whatever the reading's role: a CeX Mint SKU values only a
mint copy, an ungraded SKU values any copy, and a point of another grade never
values the copy. A graded copy tries its own grade's pool first and reads the
ungraded pool only when the grade pool has nothing for that reading. So a mint
copy's replacement value is the Mint SKU's in-stock sell even when a cheaper
ungraded SKU is in stock, while a good or ungraded copy ignores Mint SKUs.

Each row names the reading it used, fallbacks included ("market (undeclared
condition)", "voucher" under the market basis). The totals bar names the basis
you requested ("Estimated (market)"), so a market total can include trade-in
or replacement fallbacks, each visible on its own row. A copy with no usable
reading shows "—" and adds nothing to the total.

A boxed game missing its manual is its own tier, `boxed_no_manual` (CeX's
"w/o Manual, Boxed", PriceCharting's "Item and Box"). It is never compared
against, valued as or grouped with complete-in-box prices; with no same-tier
price the copy shows "—".

Which markets may value a copy is a separate setting; see
[Markets](#choosing-which-markets-may-value-a-copy).

### Totals and value history

The totals bar sums active copies only (not sold, not returned):

- **Estimated**: each active copy's value under the chosen basis.
- **Paid**: each active copy's own price, plus the total of every lot that
  still has an active copy, counted once.
- **Realized**: for each sold copy, the sale minus its fees minus its own
  price. A copy bought in a lot has no price of its own; the lot's total is
  subtracted once, when none of its copies is active any more, and until then
  it stays in Paid.
- **Returns**, shown when not zero: a sale the buyer sent back nets the sale
  minus fees, refund and return costs; a purchase returned unsold nets the
  refund minus return costs minus its price.

Every amount is the USD twin frozen when it was written. With a filter active
the bar recomputes over the visible copies and cannot include lot totals.

Value history charts Estimated and Paid per day under the basis and markets
the screen shows. `GET /api/collection` records the day's totals
(`collection_value_daily`, the last computation of the day wins) and the
worker requests them for every basis after each tracked refresh. A day
nothing computed stays a gap. The line starts on the first recorded day;
there is no backfill.

### CSV export and import

`GET /api/collection/export` writes one row per copy, sold and returned ones
included, with the sale and return details: `sold_at`, `sold_venue`,
`sold_currency`, `sold_original`, `sold_fees_original`, `sold_usd`,
`sold_fees_usd`, `returned_at`, `refund_original`, `return_costs_original`,
`refund_usd`, `return_costs_usd`. Importing the file restores them verbatim,
USD twins included; an empty twin beside an amount is converted at import.
`sold_currency` covers the sale, the fees and the return leg; a purchase
returned unsold has none, and its return leg is in `paid_currency`. The
columns are optional on import, so an older export still loads. The full
format is documented beside `COLLECTION_CSV_COLUMNS` in
`packages/shared/src/index.ts`.

A PriceCharting offer lands once: a partial unique index on
`owned_copies.acquired_url` for `pricecharting_import` rows turns a second
insert (two imports confirmed together, or a restore selected over the
existing copy) into a skip, and the response counts only what landed.

### Profit alerts on owned copies

`PROFIT` ("💰 sell @ source") fires only on owned copies with a declared
purchase price: one signal per source and instrument (`sellSource` +
`sellKind`) whose net sell-side reading beats the paid price by
`SIGNAL_PROFIT_FACTOR` (default 1.15). A shop's voucher gain and its cash gain
are separate alerts, and a marketplace reading is one more, never folded into
"the best shop number".

Shop bids are compared gross, since a payout is already net. A marketplace's
active median is netted by the source's declared `sellFeeRate` (an estimate
the plugin declares) and, being a listing price rather than a sale, always
carries the caveat "listing price, not a sale; fees estimated" and is always
`potential`.

The pill names the instrument for a bid ("💰 sell @ CeX voucher (+£30)", "💰
sell @ CeX cash (+£16)") and only the source for a fee-netted listing reading
("💰 sell @ eBay UK (+…)"), gain in the display currency; the word comes from
the source's declared role for that kind. The ownership panel shows the copy's
highest gain the same way, a potential reading marked ❓ with its caveats. The
alert never appears on the watchlist or in a game's barks, where there is no
paid price. `INSUFFICIENT_DATA` may sit next to a `PROFIT` on the same copy,
since PROFIT compares with what you paid, not the market; a fired market alert
(UNDERPRICED, OVERPRICED_STORE, FLIP) still rules it out, and the collection
renders no pill for INSUFFICIENT_DATA.

### Which stored points may raise a copy's alerts

FLIP, OVERPRICED_STORE and PROFIT on an owned copy follow the source's declared
`reach`, never its name. CeX is `local`: a shelf price is for the exact region
and completeness it lists, so only the copy's exact points count. eBay is
`global`: its undeclared-region and undeclared-condition medians stand in for
the copy through the same labelled reference ladder the value uses, as
`potential`, with the rung caveat ("market median from listings with
undeclared region"). Never another concrete region or tier, whatever the
reach: a `boxed_no_manual` copy never borrows CIB prices.

So a copy valued as "market (undeclared region)" above its paid price carries a
dashed 💰 on that rung, while a CeX row stored under another region stays
silent. Graded points obey the valuation's grade rule, but a lower ungraded
offer still counts for a mint copy.

## Markets

A market is one (service, country) pair and is its own price source, with its
own catalogue, currency and stock. CeX Spain is a different shop from CeX UK
(measured 2026-09-03: the ES Algolia index held 392,975 records against the
UK's 996,907, and its PS2 category was nearly twice the UK's). Each market has
its own `SourceId`, stored price points and row in the game view. The UK ids
keep their short spelling (`cex`, `ebay_uk`).

| market | id | service | country | currency | notes |
| --- | --- | --- | --- | --- | --- |
| CeX UK | `cex` | CeX | GB | GBP | sell / cash / voucher; region defaults to PAL |
| CeX ES | `cex_es` | CeX | ES | EUR | own index `prod_cex_es`, own category names |
| CeX IE | `cex_ie` | CeX | IE | EUR | own index `prod_cex_ie`, own category names |
| eBay UK | `ebay_uk` | eBay | GB | GBP | active listings + median |
| eBay DE | `ebay_de` | eBay | DE | EUR | active listings + median |
| eBay ES | `ebay_es` | eBay | ES | EUR | active listings + median |
| eBay FR | `ebay_fr` | eBay | FR | EUR | active listings + median |
| eBay US | `ebay_us` | eBay | US | USD | active listings + median |
| Vinted UK | `vinted_uk` | Vinted | GB | GBP | asking prices, one row per listing |
| Vinted France | `vinted_fr` | Vinted | FR | EUR | asking prices, one row per listing |
| Vinted Deutschland | `vinted_de` | Vinted | DE | EUR | asking prices, one row per listing |
| Vinted España | `vinted_es` | Vinted | ES | EUR | asking prices, one row per listing |
| Vinted Ireland | `vinted_ie` | Vinted | IE | EUR | asking prices, one row per listing |
| Wallapop España | `wallapop_es` | Wallapop | ES | EUR | asking prices, one row per listing |
| Wallapop Italia | `wallapop_it` | Wallapop | IT | EUR | asking prices, one row per listing |
| Wallapop Portugal | `wallapop_pt` | Wallapop | PT | EUR | asking prices, one row per listing |

No source is compiled into the app. Every market is served by an approved
[source plugin](#source-plugins), which adds its sources to the registry at
runtime. A market's label, country, currency, region rule and what its prices
mean come only from the manifest the plugin serves and the roles you approved.

### What differs per market

CeX: one Algolia application serves all three countries, so one pace and one
breaker cover all three and a 429 earned by Spain slows Ireland too. Each shop
queries its own index, stores its own currency and links to its own
storefront; a tracked refresh is one query filtered by `objectID` per hundred
boxes. The per-country category lists are verbatim copies of the live facet
strings in `retrowatchdog-cex-plugin/fixtures/country-categories-2026-09-03.md`:
Spain appends "Juegos" and writes "Gamecube" and "GBA"; Ireland is English but
does not copy the UK's names (Game Gear, Saturn, Dreamcast and PS1 are
"Software" in IE, "Games" in the UK); Virtual Boy, Neo Geo Pocket Color and
Atari Lynx were measured absent in ES and IE. Game & Watch is synced in the UK
from the 2026-09-01 facet check and is not in that table, so whether ES or IE
has it is unknown. PC is swept everywhere since 2026-10-18 (UK "PC Games" and
"PC CD-ROM", Spain "PC Juegos", Ireland "PC Games"; see the fixture's
addendum). A guessed category name matches nothing, silently, so no list is
derived from the UK string.

eBay: one client-credentials token, fetched once, authorises all five
marketplaces. Only the `x-ebay-c-marketplace-id` header and the
`itemLocationCountry` filter differ per market; category id 139973 serves all
five (verified live in
`retrowatchdog-ebay-plugin/fixtures/marketplace-probes-2026-09-03.md`). The
currency is read off the response, never assumed from the marketplace.

### Choosing which markets are queried

Opening a game queries only the enabled markets: the `enabled_sources` row of
`app_settings`, served and edited by `GET` and `PUT /api/settings/markets`,
which the worker reads too.

- The stored row wins whenever it exists. `ENABLED_SOURCES` (default
  `cex,ebay_uk`) is only the seed, applied while no row has been saved, so a
  container recreation never reverts a saved list. Reading never writes.
- Every adapter the deployment has is built (`buildSourceRuntime` in
  `apps/api/src/sources/registry.ts`, one per approved plugin source); the
  list is applied where the work happens. The pricing service makes no call
  and emits no block for a disabled market, the collection and watchlist
  screens do not read its stored points, and the worker syncs neither its
  catalogue nor its tracked refresh. A change takes effect on the next request
  and worker tick. There is no "disabled" block.
- A market that cannot run cannot be turned on: `GET` reports `configured:
  false` when the plugin has never answered a health call or last said it
  lacks what it needs, and `PUT` rejects adding such an id, or an unknown id,
  with a 400 naming it. A market already in the stored list can always be
  carried and switched off, because the client sends the complete list.
- Signals are gated by neither this setting nor the valuation setting: a
  cross-country flip is the arbitrage this app hunts, and the engine keys on
  declared price roles, never on a source id or family.

#### Turning a market on

Goal: have a game view query one more market. Prerequisite: the plugin that
serves it is approved and its last health reading says `configured`.

1. Open Settings → Markets. Markets are grouped by service, each row named
   with its country; one the app cannot run is shown disabled with the
   reason.
2. Tick the market. The screen saves immediately and then shows the list the
   server stored, so a refusal is surfaced inline.
3. To check, open any game: the market's block appears on the next request,
   and `GET /api/settings/markets` lists the id as enabled.

### Choosing which markets may value a copy

A copy is valued by the markets of the country the collection lives in,
default United Kingdom, and by foreign markets only if you opt in.

- Settings → Valuation markets has a country picker (GB, ES, IE, DE, FR, US)
  and an "also count other countries' markets" checkbox, default off. Both
  are browser preferences (`valuationCountry`, `valuationIncludeForeign`) sent
  as `?country=&includeForeign=` on every collection load, so another client
  can ask for another country without changing anything stored.
- `valuesCopies(source, markets, sources)` filters which stored points
  `estimateCopyValue` may read: with `includeForeign` off, only sources whose
  `SourceInfo.country` matches the picked country; with it on, every enabled
  market. The basis, reference ladder, `SIGNAL_MIN_SAMPLE` floor and grade
  rule are unchanged.
- Every row names the market it used ("sell · <shop>", "market ·
  <marketplace>", "voucher · <shop>"), with the fallback rung in parentheses when one was
  used. The response echoes `valuationBasis` and `valuationMarkets`, and the
  totals line reads "Estimated (market, United Kingdom)", or "all countries"
  with the foreign opt-in.
- A copy whose every stored price comes from an excluded country reads
  "priced, but outside your valuation markets — change them in Settings →
  Valuation markets" (`valueBasis: {readAs: "excluded", reason:
  "outside_valuation_markets"}`), never "no price data yet".
- Enabling eBay DE lets German medians value copies only if this setting
  admits them; switching the valuation country moves the total without
  querying anything new. Query wide, value narrow.

## Filters and sort

Watchlist, Collection and Insights each have **Filters & sort**. Every list
filters by its standard fields, with the options built from the values its
rows hold (a filter with a single value is not offered):

- Watchlist: region, condition, console, source (behind the row's price),
  signal type, confidence, target set or not; sorted by actionability, title,
  or price either way.
- Collection: region, condition, grade, status, console, the source that
  values the copy, working state, authenticity, where it was bought, the
  currency it was paid in; sorted by title, value or paid either way, newest,
  or grade.
- Insights: console and confidence; sorted in the recommended order, by gain
  or by title. The reliability table sorts by any column header.

The choices are remembered per list in the browser.

## Watchlist

☆ Watch on a game's record adds a watch for the region and condition its
filters show ("☆ Watch · any · cib"); with a watch already on that state the
button reads ★ Watching and removes that one. A game can have one watch per
state.

**Barks (Signals) for** on a game's record chooses what its signals are judged for:
any state, a watch's fixed state, or one of your copies. It starts on the
first watch with a fixed state, then the first copy, and remembers the choice
per title in the browser. It changes only the signals (`signalRegion`,
`signalCondition` on `GET /api/games/:id/prices`); the price table keeps its
own region and condition filters.
The watchlist is one row per watch with its verdict line on the right, or the
shop's own offer when there is no verdict. The Signals chip, on by default,
shows only the watches with a high-confidence signal; turn it off to see them
all. A row's Edit (swipe left on a phone, hover on a desktop) narrows the
watch to one region or condition and sets a buy target, an amount and its currency (`PATCH
/api/watchlist/:id`; null sets a dimension back to any or clears the target).
Narrowing onto a combination already watched is refused.

With a target set, the buy signals, UNDERPRICED and FLIP, whose price is above
the target are left out of the watch, and so out of its alerts. The row says
how many were left out. The comparison uses the quoted amounts when the signal
and the target share a currency, and the USD twins otherwise. Signals that are
not a price to pay (OVERPRICED_STORE, PROFIT, INSUFFICIENT_DATA) are never
filtered.

## Alerts

A push notification when a new buying signal, something underpriced or a flip
between two markets, appears on your watchlist. It goes through
[ntfy](https://ntfy.sh) to every device subscribed to your topic. Alerts are
off while `NTFY_TOPIC` is unset.

### Setting up alerts

Goal: receive a notification for each new watchlist signal. Prerequisite: a
device with an ntfy client (the ntfy app on a phone, for example).

1. Pick a topic name. On public ntfy.sh anyone who guesses it can read it, so
   make it long and random; to use your own server, also set `NTFY_URL`
   (default `https://ntfy.sh`).
2. Subscribe the device to that topic in its ntfy client.
3. Put the same name in the root `.env` and recreate the worker
   (`docker compose up -d worker`):

   ```
   NTFY_TOPIC=retrowatchdog-<something long and random>
   ```

4. To check, wait for the next tracked refresh: the worker logs "watchlist
   alerts checked", and every standing signal arrives as at most five
   notifications and one "N more" summary.

- Alerts run right after the worker's tracked price refresh (every
  `trackedRefreshHours` of the approved CeX manifest, 24 by default), the only
  moment a new signal can appear.
- A standing signal is announced once, not every refresh. Its key is the
  watch, signal type, sources, instrument and listing URL, not the price; sent
  keys live in `alerts_sent`. A signal that goes away and comes back is
  announced again.
- The worker reads `GET /api/watchlist`, so an alert never says something the
  Watchlist screen does not show.

Browser push is not used: it needs a push service and a subscription per
browser and only fires while that browser is installed and allowed. ntfy is
one POST from the worker and reaches every subscribed device.

## Source plugins

The app has no price source of its own. Every market it reads is served by a
**source plugin**: a small HTTP service in its own process, written in any
language, that knows how to fetch one shop or marketplace and nothing else.
The word "sidecar" appears in code and configuration names and means the same
thing.

The architecture splits the work in two. The plugin does the part only it can
do: authenticate, hold cookies, paginate, scrape, survive its source's next
change, and hand back rows in the source's own words. The app does the part
that has to be done once for every source: decide what a row means (platform,
region, completeness, grade, whether it is a game at all), convert the money,
store the price, and compute signals. Because that judgement lives in one
place, two sources are always compared on the same terms, and a careless
plugin cannot skew a comparison by classifying its own rows generously.

Trust follows the same line. A plugin declares itself through a manifest; the
app validates that document, shows it to a person, and stores nothing from the
plugin until that person has approved, kind by kind, what its prices may be
used for. Approval is per role, and the `reference` role, the baseline every
other price is judged against, is never granted by default. The plugin runs
isolated from the app's data stores, is paced and circuit-broken by the app on
terms no manifest can loosen, and every row it returns is validated before it
is stored. Adding a plugin is a URL and a review; nothing is compiled in.

The wire contract is [`sidecar-protocol.md`](sidecar-protocol.md); the
manifest's fields and gate are `packages/shared/src/pluginManifest.ts`
(`PLUGIN_PROTOCOL_VERSION` is 3). The rest of this section describes the
system; the four plugins the project maintains follow as
[instances of it](#the-retrowatchdog-plugins).

### What a plugin does and what it may not do

A plugin logs in, holds cookies, paginates and scrapes. It answers `GET
/health`, `GET /manifest` and `GET
/search?source=&q=&platform=&alt=&spelling=&budgetMs=` (`source=` is required,
since one plugin may serve several sources; the rest are optional and may be
ignored; `sidecar-protocol.md` has the full list) with the source's own words:
listing id, unedited title, prices and currency as quoted, a URL, and whatever
category or condition string the source prints. A catalogue plugin answers
`GET /catalog/units`, `GET /catalog/units/<unit>` and `POST /catalog/refresh`
instead of `/search` and gets a scheduled sweep instead of a live query.

A plugin must not classify: no platform, region, completeness tier or grade.
That judgement, and the non-game reading (manuals, empty boxes, posters, mugs,
repro carts), stays in `apps/api/src/adapters/classifyListing.ts` and
`nonGameListing.ts`, so every source is read through one vocabulary.

### What a manifest declares

The manifest states the plugin's name and version, the names of the
environment variables it needs, and one to twenty sources, each with a label,
a family, a country, a `reach`, a `defaultRegion`, the currencies it may quote
in, and the role each price kind carries:

| role | meaning |
| --- | --- |
| `buy_listing` | a price you could pay a private seller |
| `buy_store` | a price you could pay a shop |
| `bid` | what a shop pays you |
| `guide` | shown and nothing more |
| `reference` | the market baseline every other source is judged against |

The `plugins` table (migration `0009_plugins.sql`) keeps two manifest columns.
`manifest_seen` is what the plugin last said, rewritten by every health poll.
`manifest` is what you approved and the only one the registry is built from,
so a plugin's `sell` cannot quietly become a `reference`. Settings → Plugins
shows the drift field by field ("`shop_gb.kindRoles`") until a person reviews
it.

Every manifest field is validated and the accepted document is rebuilt, not
copied, so a key the app does not name has no way through. An approval carries
the fingerprint of the document the browser rendered; if the row no longer
hashes to it, the approval is refused with "this plugin changed its manifest
while you were reviewing it".

### Approving a plugin

Goal: let a pending plugin's sources exist in the registry. Prerequisite:
the plugin's row in Settings → Plugins shows a manifest, which the health poll
fills in within one `PLUGIN_HEALTH_INTERVAL_MS` of the row being added.

1. Press the row's Review. Its sheet shows what the plugin is granted now
   and what changed, then "Review and approve…" opens the decision: each
   declared source lists one checkbox per price kind, labelled with the role
   it would grant and what that role lets the app do with the number.
2. Tick the kinds you accept and press Approve (`POST
   /api/plugins/:id/approve`). The approval carries the manifest's
   fingerprint, so a manifest that changed during the review is refused with
   a 409, "this plugin changed its manifest while you were reviewing it;
   review it again".
3. To check, the row reads approved with its granted kinds and roles, and the
   sources appear in Settings → Markets, switched off. Turn them on there.

- `reference` is unchecked by default, always, with the reason on screen: it is
  the baseline UNDERPRICED, FLIP, PROFIT and every copy's estimated value are
  measured against; every other role affects only that source's own rows. A
  re-review proposes what you chose last time, but the `reference` filter
  still applies first, so a kind approved as `buy_store` that now claims
  `reference` arrives unchecked.
- Approving is not enabling: an approved source appears in Settings → Markets
  switched off. One exception, stated on the row: re-approving a disabled
  plugin brings back any of its markets still in your enabled list, switched
  on.
- A source you tick nothing for is left out of the registry entirely.
- The panel prints what a plugin already got, per source, in kinds and roles.

### Where secrets live

A manifest lists the environment variables a plugin needs by name, and that is
all the app learns. It never asks for, stores or sends a secret; the panel
says "set it there, not here". The plugin's `/health` answers `configured` to
say whether it holds what it needs; a plugin that says no cannot be switched
on in Markets, and the panel names the variable to set and asks you to
restart the plugin.

### What isolates a plugin

- A separate process. In the compose stack a plugin is a container with no
  published port, reachable only over the internal network.
- No app credentials: no `DATABASE_URL`, no IGDB secret, no root `.env`. A
  plugin that needs a secret of its own reads it from its own environment.
- No route to the database or the queue, enforced by the network layout: data
  stores on `backend`, plugins on `sidecars`, only `api` and `worker` on both.
  Compose states the Postgres password in clear and Redis has none, so a
  plugin that could resolve `postgres` by name would need nothing else. The
  stores publish no port at all: on Docker Desktop even a loopback-bound port
  is reachable from a container through the host gateway. Development uses
  `docker-compose.dev.yml` to publish them.
  Pinned by `apps/api/test/deploy/composeIsolation.test.ts`.
- No volume: it writes nothing and keeps nothing.
- Everything it returns is validated field by field before it reaches a stored
  price. A malformed row is dropped with its reason logged; a body that is not
  a JSON array fails the whole fetch and counts against the breaker.
- Every call carries a `User-Agent` of `RetroWatchdog/<protocol>` and an
  `x-retrowatchdog-protocol` header, for the plugin's access log.
- Redirects are refused: following one would let the least-trusted process
  pick a URL for the API container to fetch.

Pacing, breaking, timeouts and size bounds live in the app, never in the
plugin, and no manifest field sets any of them:

| env var | default | bounds |
| --- | --- | --- |
| `SIDECAR_RATE_LIMIT_MS` | 3000 | ms between calls; a per-plugin pace in Settings → Plugins (`rate_limit_ms`) beats it |
| `SIDECAR_BREAKER_THRESHOLD` / `SIDECAR_BREAKER_HOLD_MS` | 5 / 1800000 | failures before the breaker opens, and how long it stays open |
| `ADAPTER_TIMEOUT_MS` | 8000 | one call, body included |
| `SIDECAR_MAX_BYTES` / `SIDECAR_MAX_LISTINGS` | 8 MB / 500 | one `/search` answer, decoded bytes and rows |
| `SIDECAR_SYNC_MAX_BYTES` / `SIDECAR_SYNC_MAX_ROWS_PER_PAGE` | 16 MB / 2000 | one catalogue page; a page over the row cap is refused, not truncated |
| `SIDECAR_SYNC_MAX_PAGES_PER_UNIT` | 100 | pages one unit may take |
| `PLUGIN_HEALTH_INTERVAL_MS` | 300000 | how often the worker polls `/health` and `/manifest` |

A `/health` or `/manifest` body is capped at 1 MB. Byte counts are of decoded
bytes, so a gzip bomb trips at its expansion. One limiter and one breaker are
held per plugin, not per source, and they outlive adapter rebuilds, so a
half-hour hold is not reset by the next health tick.

Importing makes the app fetch an address you typed from inside its own network:
it can tell an open port from a closed one and quotes a little of what
answered. There is no blocklist of private addresses, because a plugin lives
at one by design and the app has no accounts, so whoever can POST here can
already write the database; `apps/api/src/routes/plugins.ts` records what
would call for an allowlist of plugin hosts (accounts, or an API reachable by
people who should not import). A plugin URL may not name this stack's own
services, loopback or a link-local address. The API publishes no port;
clients reach it through the web container's `/api/` proxy.

The worker polls every plugin that is not disabled, approved or not, every
`PLUGIN_HEALTH_INTERVAL_MS`; polls are sequential and each can cost two
`ADAPTER_TIMEOUT_MS`, so keep the interval well above 2 × plugins × timeout.
The poll fills in a seeded row's manifest, notices drift and keeps
`configured` current; a failed poll leaves the last good reading standing.

There is no `depends_on` between the app and a plugin in either direction: a
dead plugin never keeps the API from booting. An approved source's block then
reports an error and shows what was stored before, labelled old; an unapproved
one produces no block at all.

### Adding a plugin

Goal: read a source no existing plugin serves. Prerequisites: a program implementing
`sidecar-protocol.md`, reachable from the `api` container by URL.

1. Run the program. It answers the endpoints of `sidecar-protocol.md`, returns
   raw rows, classifies nothing, and serves a `/manifest` whose sources carry
   `kindRoles`; a marketplace of private sellers declares
   `{ active_listing: "buy_listing" }` and `defaultRegion: null`. In the
   compose stack, give it the shape of the RetroWatchdog plugin services: no
   `ports`, no root `env_file`, no volume, `networks: [sidecars]` only, a
   healthcheck on `/health`.
2. Paste its base URL into Settings → Plugins and press Add (`POST
   /api/plugins`). The app calls `/health` then `/manifest` right there. It
   refuses a URL with a username, password, query, fragment or a scheme other
   than http or https, refuses a source id another source already answers to,
   and stores nothing if either call or the manifest fails. What it stores is
   a proposal: `manifest_seen`, approved for nothing.
3. Approve it as [above](#approving-a-plugin). This creates the sources.
4. Turn its markets on in Settings → Markets.
5. To check, open a game the source should price: its block appears, and
   `GET /api/sources` lists the source with `configured: true`.

The same panel re-checks a plugin, changes its pace, moves it to a new address
(grants kept; any difference in the new manifest shows as drift), disables it
or removes it.

Disabling stops querying the plugin and takes its sources out of the registry,
so Settings → Markets stops offering them; the row and every stored price
stay. It leaves your enabled list alone, which is what makes the re-approval
rule above hold; the next save of the Markets screen while the plugin is
disabled stores the intersection with the registry and drops those ids, after
which re-approving brings the sources back switched off. Removing prunes the
enabled list, deletes the row and keeps the stored prices.

### The RetroWatchdog plugins

The project maintains four plugins, each in its own repository with its own
README, tests and image. The compose file offers them behind profiles, so a
deployment starts the ones it wants (`COMPOSE_PROFILES`) and pulls each from
the image its variable names.

| plugin | repository and image | profile | sources | env file |
| --- | --- | --- | --- | --- |
| CeX | `retrowatchdog-cex-plugin` | `cex` | `cex`, `cex_es`, `cex_ie` (sync) | `.env.cex`: the Algolia pair, required; category lists and cadence, optional |
| eBay | `retrowatchdog-ebay-plugin` | `ebay` | five markets, with a `reference` role | `.env.ebay`: `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` |
| Vinted | `retrowatchdog-vinted-sidecar-plugin` | `vinted` | `vinted_uk`, `vinted_fr`, `vinted_de`, `vinted_es`, `vinted_ie` | `.env.vinted`, optional |
| Wallapop | `retrowatchdog-wallapop-sidecar-plugin` | `wallapop` | `wallapop_es`, `wallapop_it`, `wallapop_pt` | `.env.wallapop`, optional |

`VINTED_SIDECAR_PLUGIN_URL`, `CEX_PLUGIN_URL`, `EBAY_PLUGIN_URL` and
`WALLAPOP_SIDECAR_PLUGIN_URL` each seed a
pending plugin row at that address, once per deployment ever. The compose file
sets them to the service names (`http://vinted-sidecar-plugin:8000`,
`http://cex-plugin:8000`, `http://ebay-plugin:8000`); only the `api` container
reads them, from `apps/api/src/server.ts`. Each offer is recorded in
`app_settings` (`plugin_seed_done` for Vinted, `plugin_seed_done:cex` and
`plugin_seed_done:ebay` for the others), so a plugin you delete does not come
back on the next recreation. Nothing is fetched at boot; the row starts as
"not contacted yet" and the health tick fills in the manifest within one
interval. A URL already present, imported by hand, counts as done. A URL the
app cannot parse seeds nothing, logs a warning and does not spend the offer. A
seeded plugin whose profile is off stays "not contacted yet"; remove the row
if you will not run it.

### Vinted

The plugin's manifest is `app/manifest.py` in its repository.
One process serves five sites, one source each: `vinted_uk` (`vinted.co.uk`),
`vinted_fr`, `vinted_de`, `vinted_es` and `vinted_ie`. A `SITES` table maps
each to a country, currency and label; `VINTED_SITES` in `.env.vinted` narrows
the list, and an unknown key is refused rather than guessed. Every search is
narrowed to catalogue `3002`, "Video games & consoles", the same id on every
site (checked 2026-10-18). The plugin is one row to approve; each country is
its own market to switch on in Settings → Markets.

- Vinted's [terms](https://www.vinted.co.uk/terms_and_conditions) forbid bots, scraping and data
  mining without its authorization; the manifest's caveat says so under every
  Vinted price.
- Unofficial and fragile: Vinted publishes no API, the plugin wraps a
  community scraping package, and it may stop working at any time. When it
  breaks the breaker opens and the block says `error` and shows what was
  stored before, labelled old.
- Asking prices only. Its manifest declares `active_listing: buy_listing` and
  nothing else, so no checkbox can make it a reference and it can never set a
  copy's value. Each asking price is stored as its own clickable row; a median
  needs both `buy_listing` and `reference` roles.
- Availability is unknown. The package exposes an `is_visible` flag, but
  nothing verifiable says it means "buyable right now", so the plugin sends no
  `available` and the app stores unknown. The engine only refuses a price it
  has been told is unavailable, so a Vinted asking price stays a bargain
  candidate until the price TTL retires it, and a bark can point at a sold
  listing. Mapping `is_visible` is a one-line change once its meaning is
  established.
- Most of its barks are `❓ potential`: Vinted listings usually declare no
  condition and often no region, so the comparison uses the labelled fallback
  rung.
- An unapproved Vinted shows no block on a game view; it appears only in
  Settings → Plugins, as a pending row with its own last error.

### Wallapop

One process serves Spain, Italy and Portugal, one source each: `wallapop_es`,
`wallapop_it` and `wallapop_pt`, with listings linked at `es.`, `it.` and
`pt.wallapop.com`. It reads the JSON Wallapop's website uses (one search per
request, standard library only) narrowed to the "Video games" and "PC games"
subcategories. Wallapop ranks by distance from a point, so each site searches
from its capital unless `WALLAPOP_LOCATION_<KEY>=lat,lon` in `.env.wallapop`
moves it; the point, not the site, decides whose listings come back.
`WALLAPOP_SITES` narrows the sites.

- Wallapop's [terms of use](https://about.wallapop.com/condiciones-de-uso/) require its express
  authorization for this access; the manifest's caveat says so under every
  Wallapop price.
- Unofficial: Wallapop publishes no API for this, and the JSON may change. A
  changed answer is a 502 the breaker counts, never an empty result.
- Asking prices only (`active_listing: buy_listing`), like Vinted: it can never
  set a copy's value. Reserved listings are skipped.
- One page per search, about 40 listings: the plugin does not follow
  `next_page`.

### eBay

Its README has the full contract. One
process serves all five marketplaces behind one OAuth token and one shared
limiter and breaker.

- eBay's [API License Agreement](https://developer.ebay.com/join/api-license-agreement)
  binds whoever registers the keys: listings shown no older than six hours or
  labelled, eBay content shown apart from other sources, no price modelling
  and no seller arbitrage with it. The plugin's README lists the clauses; the
  price table shows eBay rows beside other shops' by default; Settings →
  Appearance → "eBay prices in their own block" draws them apart, a view
  choice that changes no bark (signal).
- It is the app's reference: its manifest declares `active_median: reference`
  on every market. Approving it is a real grant, and the panel says so.
- Active fixed-price listings, never sold prices: the Browse API answers what
  is for sale at the seller's asking price, and `buyingOptions:{FIXED_PRICE}`
  excludes live auctions.
- `available: true` on every row, since a Browse item summary is a live
  listing by definition; the shared classifier does not add this.
- A row shown as "Approved automatically" in Settings → Plugins is a carry-over
  from an earlier deployment; there is no adoption mechanism, and a fresh
  deployment approves it by hand.
- Its marketplace probes (`fixtures/marketplace-probes-2026-09-03.md`) were
  trusted as measured, and its query builder's rules were only probed live
  against one of its five markets; see "What could not be verified without a
  live call" in its README.

### CeX

CeX's terms say nothing about automated access, but the catalogue is CeX's
property and a nightly sweep of all of it is a systematic extraction of a
database, which UK and EU database rights protect; the plugin's README has
the note. Keep the pace slow and the use personal.

The only sync plugin: the worker sweeps it on the cadence its approved
manifest declares (`catalogCron` `0 3 * * 1`, a weekly sweep, and
`trackedRefreshHours` 24), and a
game view never calls it; that search reads the app's own `catalog_items`. It
ships without CeX's Algolia application id and search key: `.env.cex` must
carry both, read off CeX's own site as its README describes, or `/health`
reports `configured: false` and the shops cannot be enabled. The same file
can change a category list, an index, the proposed cadence or the ids per
refresh query; a cadence change needs a re-approval, since the app schedules
from what was approved.
The plugin sends no `observedAt`, so a CeX block is dated by the sweep that
stored it. See [CeX catalogue sync](#cex-catalogue-sync).

## Recommendations

`GET /api/insights` turns stored prices into a short list of things to do,
money first. Each recommendation has a title with the verb and the figure, a
reason that quotes the compared amounts, a confidence (`high` or `potential`)
and, for the money actions, the gain in USD. A copy or a watch gets one
recommendation at most: the first by the order below.

| Action | When | Confidence |
|---|---|---|
| Sell now | the best bid for an owned copy is the highest in `sellHighDays` (90) and covers the paid price × profit margin, or the market rose and has been falling over `trendDays` (30) | high; potential on a fallback slice |
| Buy now | a watch's cheapest purchasable price is the lowest in `buyLowDays` (90), or `buyBelowAvgPct` (15) % under that window's average | high; potential when the market is falling or there are under 30 days of prices |
| Raise target | the target was never met in `targetWindowDays` (180) and the low came within `targetNearPct` (20) % of it | potential |
| Lower target | the price sat under the target on more than `targetOftenPct` (50) % of the days | potential |
| Stop watching | no signal and no price move over `quietPct` (5) % in `quietDays` (120) | potential |
| Check a copy | no source has priced it, or none has in `quietDays` (a copy valued from listings of any condition or region is not flagged: most listings name neither) | potential |
| Prefer a source | on a console with at least `minGamesPerConsole` (5) games, one source had the lowest price (or paid the most) in at least `sourceDominancePct` (60) % of them | high |
| Review thresholds | a signal type held under `reliabilityMinPct` (40) % of at least 10 judged signals (see `docs/signals.md`) | potential |

Every threshold lives in Settings → Barks (Signals) next to the signal factors and is
saved with them. The preview line adds what the draft would recommend ("3 sell
now, 5 buy now, 2 target changes, 7 clean-ups"). `GET
/api/settings/signals/suggested` offers values derived from this deployment's
own prices (`quietDays`, `buyBelowAvgPct`, `targetNearPct`,
`minGamesPerConsole`) once there are 30 days of prices and 10 watched slices;
they are offered, never applied.

Where they show: the dashboard's **Recommended actions** panel leads with up to ten
high-confidence money actions (sell, buy, target changes), then today's good
prices, and folds the possible ones, **Clean up** and **Best sources** below; **Insights** (desktop)
lists every recommendation by action with the reliability table and both
price histories; on the phone, **Recommended actions: N** under the Today line opens the
money actions in a sheet; a game's page shows its own recommendation under
the verdict. With alerts on, each new high-confidence sell-now or buy-now
recommendation is sent once per copy or watch, and again only after it has
gone away and come back.

Watchlist and Collection rows carry a sparkline of the last `historyDays`
(90) with the change as a percent: the watch's cheapest purchasable price,
the copy's value on its valuation basis. A copy with no value shows none.

The response is cached for 10 minutes per process (prices only move when the
worker refreshes); any write through the API clears it and recomputes it in
the background, and the API computes it once at boot. `GET /api/watchlist/history` sums the cheapest price of every
watch per day with its coverage ("21 of 23 watches"), and `GET
/api/watchlist/sparklines` / `GET /api/collection/sparklines` give each row
its daily series, all read from `price_points`.

## Honest-data notes

- eBay prices are active listings, not sold prices (Marketplace Insights is
  gated); the UI labels this.
- `signal_log` is written only by the worker, after each tracked refresh; it
  starts empty on upgrade, so the reliability table and the "review
  thresholds" recommendation need `evalDays` plus 10 judged signals before
  they say anything.
- eBay never guesses a region, in any market: sellers everywhere list imports,
  so a title that declares no region stays `unknown` and reaches a copy only
  through the reference ladder's labelled rung, as `potential`. No eBay market
  has a `defaultRegion`; only CeX has one (PAL in all three shops), because a
  shelf sits in a country.
- The non-game filter (`apps/api/src/adapters/nonGameListing.ts`) reads
  English, German, Spanish and French only, on titles folded to unaccented
  form ("Schlüsselanhänger" and "schlusselanhanger" both match). The
  2026-09-03 probe found the cheapest listing in three of five markets was not
  a game: a magazine in GB, a "Miniatur Spielmodul Schlüsselanhänger" in DE, a
  "Notice" (manual) in FR. A market in another language needs its own entries
  before its medians can be trusted the same way.
- A thin market reports `INSUFFICIENT_DATA` more often: sizes differ by an
  order of magnitude for the same query (21 hits on eBay ES against 575 on
  eBay US, 2026-09-03). `SIGNAL_MIN_SAMPLE` (default 5) is one floor for every
  market, so a small market says "not enough listings to judge this" instead
  of a median from four rows.
- The CeX search index is unofficial. `GET /api/games/:id/prices` reads CeX
  prices from the synced catalogue, not live. Sweep and refresh calls are
  paced and circuit-broken and report failures instead of showing wrong data;
  if it breaks, the rest keeps working.
- The matcher caps a candidate whose listing names another game
  (`apps/api/src/matching/foreignWords.ts`): a word inserted inside the name's
  span ("mario party 64" against "mario 64"), or one swapped for an unrelated
  one ("super mario lego" against "super mario land"). Like a numeral
  mismatch, it can be reviewed but never confirmed on its own.

### How the eBay query is built

The keyword query is built from the catalogue:

- A title with no usable subtitle member (no colon, or a subtitle of one word
  after its own article) keeps the plain shape `<title without its leading
  "The"> <console spelling>`, the spelling being the first entry of the
  platform's `sellerSpellings`, never the UI label: eBay ANDs every word of a
  plain query, and "NG Pocket Color" is a name no listing carries.
- A title with a usable subtitle member becomes one OR group of contiguous
  phrases (title, subtitle, alternative names) followed by a group of the
  platform's spellings, `(…) (Game Boy, Gameboy)`. After a group eBay stops
  matching a bare platform word, and the extra spellings add real listings
  ("Nintendo 64"-only titles, Super Famicom carts).
- `(`, `)` and `,` are removed from every part of every query.
- Only a title with no usable subtitle member but with alternative names costs
  a second request: the plain query is kept and the names are asked for
  separately, because folding them into one group loses listings. That second
  query is a group with two or more names and the plain shape with one, since
  a lone name in front of a group measured 0 on both probed rows. It runs on
  what is left of the fetch's time budget; a failure leaves the primary window
  untouched. The plugin merges both 50-listing windows by item id (first seen
  wins) and sends the deduped union untrimmed, up to 100 rows; the second
  window is a second pass through the matcher, so those games accumulate
  `source_mappings` rows, `needs_review` ones included, about twice as fast.
- One-word phrases are never members: "(Castlevania: The Adventure,
  Adventure)" returned 446 hits with no Castlevania in the window. A query
  broad enough to match other games fills the 50 with their cheapest listings
  and the target's sample is gone; the matcher rejects them but nothing
  replaces them. Evidence: `retrowatchdog-ebay-plugin/fixtures/query-probes-2026-09-02.md`.

### What the sample size means

Each query reads at most 50 listings sorted by price; after the app's non-game
reading the app keeps the cheapest `SIDECAR_MEDIAN_WINDOW` (default 50) of
what survived, merged across both windows when there were two. The sample size
next to an active median ("(37 listings)") is how many active listings were
in the (region, condition) sample, out of those cheapest 50. Prices outside
the sample's [P10, P90] band are trimmed before the median (no trim under 5
values), so a 50-listing sample yields a median over 40. Capping after the
non-game reading keeps merchandise from occupying slots a real listing needed;
capping in the app rather than the plugin keeps one price cutoff and one
sample size.

## Adding a console

Goal: make the app recognise, price and match games for one more platform.
Prerequisites: a checkout of the repository with `pnpm install` done, the
platform's IGDB id, and, if CeX sells it, its category name in each CeX shop.
Platforms live in `packages/shared/src/platforms.ts`; its "HOW TO ADD A
CONSOLE" doc-comment carries a complete commented-out example (an imaginary
Atari Lynx) showing every field and file to touch. Four steps, then verify;
the worked example is Neo Geo Pocket Color.

1. Add one entry to `PLATFORMS`: `igdbId` from IGDB's platform list,
   `cexCategoryHints` as lowercase substrings of CeX's live
   `categoryFriendlyName` (only if CeX sells it), `titleKeywords` for
   free-text detection, `sellerSpellings` for the eBay query. `PLATFORMS` is a
   `Record` over the `Platform` union, so a member without an entry is a
   compile error.

   ```ts
   export type Platform = | "nes" | /* … */ | "neogeo_aes" | "neogeo_pocket_color";

   export const PLATFORMS: Record<Platform, PlatformInfo> = {
     // …
     neogeo_pocket_color: {
       igdbId: 120,
       label: "NG Pocket Color",
       cexCategoryHints: ["neo geo pocket color"],
       titleKeywords: ["neo geo pocket color", "neo geo pocket colour", "ngpc"],
       sellerSpellings: [
         "Neo Geo Pocket Color", "Neo Geo Pocket Colour",
         "NeoGeo Pocket Color", "NeoGeo Pocket Colour", "NGPC",
       ],
     },
   };
   ```

   `titleKeywords` is what the classifier reads a title with;
   `sellerSpellings` is what the eBay query asks for. Asking wide is free
   (the matcher re-checks every returned title) while reading wide hands the
   platform filter a wrong answer: `gbc` asks for "Gameboy Color" but does not
   detect on it. Ship the closed-up spelling next to the spaced one ("Game
   Boy" and "Gameboy"), because a group member is matched as a phrase;
   `packages/shared/test/platforms.test.ts` enforces it for the pairs in
   `CLOSED_UP_CONSOLE_NAMES`, so add the new name there.

2. If CeX sells it, add the exact category name once per country in
   `retrowatchdog-cex-plugin/src/config.ts`. Names differ per country in ways no
   transform produces, so run the facet query against each index and copy
   what it returns:

   ```ts
   const UK_CATEGORIES = [           // prod_cex_uk
     "Neo Geo Pocket Color Software", // verified live facet name, 156 records
   ];
   const ES_CATEGORIES = [ … ];      // prod_cex_es
   const IE_CATEGORIES = [ … ];      // prod_cex_ie
   ```

   `CEX_UK_CATEGORIES`, `CEX_ES_CATEGORIES` and `CEX_IE_CATEGORIES` in
   `.env.cex` each replace their list wholesale, so a shorter
   value narrows the sync. A country with no category for the console (ES and
   IE for Virtual Boy, Neo Geo Pocket Color and Atari Lynx) keeps a shorter
   list, with a comment saying the absence was measured. The worker's boot
   catch-up picks up a new category on its next start. Neo Geo AES has no CeX
   category anywhere and skips this step.

3. Append the platform to both detection-order lists, most specific first:

   ```ts
   // apps/api/src/adapters/familyReading.ts: reads synced rows' categories
   const DETECTION_ORDER: Platform[] = [
     "neogeo_pocket_color", // must precede gbc
     "gbc", "gba", "gb", "n64", "snes", "nes", "megadrive",
     "master_system", "game_gear", "saturn", "dreamcast",
     "ps1", "ps2", "gamecube", "neogeo_aes",
     "3ds", "ds", "virtual_boy", "game_and_watch", // 3ds before ds
   ];

   // apps/api/src/adapters/classifyListing.ts: reads live rows' titles
   const TITLE_DETECTION_ORDER: Platform[] = [
     "gbc", "gba", "gb", "n64", "snes", "nes", "megadrive",
     "master_system", "game_gear", "saturn", "dreamcast",
     "ps1", "ps2", "gamecube",
     "neogeo_aes", "neogeo_pocket_color", // safe to append: no collision
     "3ds", "ds", "virtual_boy", "game_and_watch", // 3ds before ds
   ];
   ```

   The CeX category "Neo Geo Pocket Color Software" contains the word
   "color", gbc's generic `cexCategoryHint`, so appending `neogeo_pocket_color`
   last would let gbc win; the `categoryHints` golden table catches it. The
   title-keyword list has no such collision. `3ds` must precede `ds` (matching
   is word-boundary based, so a bare `ds` never matches inside "3ds", "kids"
   or "cards"), and `game_and_watch` stays after the gb family because "Game &
   Watch Gallery" titles are Game Boy cartridges.

4. Update the tests that pin the platform set: the platform count and
   `igdbId` assertions in `packages/shared/test/platforms.test.ts`; one golden
   row per new CeX category per country in
   `apps/api/test/adapters/familyReading.test.ts`; the category-list table in
   `retrowatchdog-cex-plugin/test/categories.test.ts`, which asserts each shop's
   sync list equals the fixture table, so a category from step 2 fails it
   until the console is in `FIXTURE_CATEGORIES`, or in
   `OUTSIDE_THE_FIXTURE_TABLE` with the evidence that established it when the
   2026-09-03 facet fixture never measured that console; and a title-keyword
   detection case, plus a both-directions disambiguation test if the keywords
   overlap another platform's, in
   `apps/api/test/adapters/classifyListing.test.ts`.

To check: `pnpm -r typecheck` and `pnpm -r test` pass in the app and in the
CeX plugin's repository; after rebuilding the app images (`docker compose up
-d --build`) and the plugin's image, the worker logs one `"unit synced"` line
per new CeX category and a search for a game on the platform finds it.

## Tests

`pnpm -r test` and `pnpm -r typecheck`. API integration tests need a reachable
postgres (`docker compose up -d postgres`), default to
`postgres://retrowatchdog:retrowatchdog@localhost:5432` and create a
`retrowatchdog_test` database; `TEST_ADMIN_DATABASE_URL` and
`TEST_DATABASE_URL` point them elsewhere. Each plugin's tests run in its own
repository.

## CeX catalogue sync

CeX prices are served from the synced `catalog_items` table; the worker keeps
it fresh in the background, so `GET /api/games/:id/prices` (and
`?refresh=true`) never blocks on Algolia.

### Running the first sync

Goal: a populated `catalog_items` for every enabled CeX shop. Prerequisites:
the CeX plugin approved and at least one of its shops enabled.

1. Start the worker. In containers it is the `worker` service of `docker
   compose up -d` (the `api` image running `node apps/api/dist/worker/index.js`).
   Outside containers: `docker compose up -d postgres redis`, `pnpm --filter
   @retrowatchdog/api migrate`, `pnpm --filter @retrowatchdog/api worker`.
2. On boot the worker checks every configured CeX category against
   `sync_state` and enqueues a full sync for anything stale; no separate seed
   step exists.
3. To check, watch for one `"unit synced"` log line per category. Catch-up is
   done once `sync_state` has a `catalog-sync:<source>:<category>` row for
   every configured category of every enabled shop (`SELECT count(*) FROM
   sync_state WHERE key LIKE 'catalog-sync:%'`). A `"stale rows swept"` line
   appears only from the nightly full-source sync (the plugin's
   `CEX_SYNC_CRON`, proposed in its manifest and approved in Settings), not
   from boot catch-up.

### What one cycle does

Each enabled shop syncs its own categories (`CEX_UK_CATEGORIES`,
`CEX_ES_CATEGORIES`, `CEX_IE_CATEGORIES`), so the rows to expect are the sum
over the enabled shops; a shop nobody enabled syncs nothing. All three share
one limiter and one breaker, so a second country lengthens the nightly run
rather than running in parallel.

Every catalogue market has its own `tracked-refresh:<source>` job with a
per-shop detail-refresh step, but the cross-source snapshot loop after it
re-fetches every enabled market for every tracked game. The last enabled
catalogue market owns that pass, so it runs once per cycle at that market's
`trackedRefreshHours`.

A nightly full sweep is roughly 45 to 60 Algolia queries, one per page, at the
pace set for the plugin in Settings → Plugins; the plugin's README sizes its
page walk for 10 s. One HTTP request makes exactly one Algolia call. A 429
ends that page, costs the unit its `complete` (nothing is deleted) and opens
the breaker for 30 minutes.

### Rotating the Algolia key

Goal: restore the CeX sync after the worker logs persistent 403s from Algolia.
CeX's Algolia app id and key are the public credentials `uk.webuy.com` ships
in its bundle, rotated occasionally; until they are replaced the catalogue
keeps serving its last-synced prices, dated by their real sync time.

1. Open `https://uk.webuy.com` in a browser, search anything, and in the
   browser's network inspector find the
   `search.webuy.io/1/indexes/*/queries` request. Copy
   `x-algolia-application-id` and `x-algolia-api-key` from its query string
   or headers. Without a browser, grep the site's built script: `curl -s
   https://uk.webuy.com/_nuxt/<entry>.js | grep -o 'x-algolia[^"]*"[^"]*"'`.
2. Set `CEX_ALGOLIA_APP_ID` and `CEX_ALGOLIA_API_KEY` in `.env.cex` and
   recreate the container (`docker compose up -d cex-plugin`).
3. To check, the 403s stop and the next sweep logs `"unit synced"` lines.
