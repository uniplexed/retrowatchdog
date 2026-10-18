# Source plugin protocol, version 3

A sidecar is a plugin. The older name survives in paths (this file, the app's
client in `apps/api/src/adapters/sidecar/`) and
means the same thing.

A plugin is a small HTTP service that fetches from one or more price sources
and hands RetroWatchdog raw rows. It runs as its own process, in its own
language, maintained by whoever cares about that source. The app imports it by
URL at runtime and a person approves it; nothing about it is compiled into the
app. Three implementations are maintained alongside it, each in its own
repository: `retrowatchdog-cex-plugin` (sync, TypeScript),
`retrowatchdog-ebay-plugin` (live, TypeScript) and
`retrowatchdog-vinted-sidecar-plugin` (live, Python).

This document is the whole contract. If your service answers the endpoints
below as described, RetroWatchdog can read your sources.

---

## Naming

A plugin's repository and image are named `retrowatchdog-<source>-plugin`. A
plugin that wraps a scraper or a community package rather than an API of the
source's own, a sidecar, is named `retrowatchdog-<source>-sidecar-plugin`.
The compose service and the env vars follow the same stem
(`vinted-sidecar-plugin`, `VINTED_SIDECAR_PLUGIN_URL`).

## 1. The one rule: a plugin fetches, the app interprets

A plugin does the part only it can do: talk to its source. Logging in,
cookies, pagination, HTML scraping, the source's own rate limits and its
failures are yours. An endpoint change at the source is a release of your
plugin, not of the app.

Everything after the fetch belongs to the app. It cleans the title, guesses
the platform, region, completeness tier and cosmetic grade, matches the
listing against its game catalog and converts the money to USD. One piece of
code reads one vocabulary for every source
(`apps/api/src/adapters/classifyListing.ts`), which is what makes a
cross-source comparison mean anything.

Your plugin must not classify. Do not send a platform, a region, a
completeness tier or a grade. Send the source's own words: the title, and the
category and condition strings the source prints. This is enforced: every row
the app accepts is rebuilt field by field from the fields named here
(`parseSidecarListing` and `parseSyncRow` in
`apps/api/src/adapters/sidecar/protocol.ts`), never spread, so a `platform`,
`region`, `condition` or `grade` key has no way through. The same holds for a
manifest (`validateManifest` in `packages/shared/src/pluginManifest.ts`).

Do not pre-filter results to "only the real games" either. Send every listing
your source returned for the query. On the live path the app drops the rows
it reads as not being the game (a manual, an empty box, a poster) with
`apps/api/src/adapters/nonGameListing.ts`, before matching. That reading is
tuned for marketplace prose and is not applied to a synced shop catalogue,
whose structured SKU titles it misreads.

---

## 2. The declaring surface: `GET /health` and `GET /manifest`

These two calls are about the plugin itself, not about a source. The reader
is `apps/api/src/plugins/client.ts`. Both are asked, in this order, at every
point listed in section 8: import, recheck, address change and health poll.

- `POST /api/plugins`, the import. If either call fails, nothing is stored.
- The worker's health tick (`apps/api/src/worker/pluginHealth.ts`) polls
  every plugin except a `disabled` one, once per `PLUGIN_HEALTH_INTERVAL_MS`.

Each call is bounded at 1 MB (`DECLARATION_MAX_BYTES` in `client.ts`, the one
bound not in `config.ts`) and at `ADAPTER_TIMEOUT_MS`. Neither has a circuit
breaker: the tick keeps polling a dead plugin once per interval.

### `GET /health`

Report that the process is up and holds what it needs. Do not call the source
from here; whether the source answers is what a real search finds out, and
the breaker reacts to that.

```json
{ "status": "ok", "protocol": 3, "configured": true }
```

| field | type | required | what the app does with it |
|---|---|---|---|
| `status` | string | yes | must be exactly `"ok"`. Anything else is a failure, and the value is quoted back (cut at 80 characters) into the import's error and `plugins.last_error`. |
| `protocol` | number | yes | must be a number. It is not compared against 3; the version gate is on the manifest (section 8). |
| `configured` | boolean | no, silence means no | read as `configured === true`; anything else, including absence, reads as false. It means "I hold the credentials, keys or cookies my source needs". |

The reply is rebuilt as `{ status, protocol, configured }`; any other key you
publish (package version, cookie age, site) is ignored, and useful to a human
reading it.

`configured` has teeth. `pluginConfigured` in
`apps/api/src/sources/registry.ts` offers a plugin's sources as configured
only when the last health reading said so, and `PUT /api/settings/markets`
refuses to enable a source that is not configured. A plugin that has never
answered `/health` keeps a null reading, which reads as not configured. A
failed poll leaves the last good reading standing with the error beside it,
so one bad tick cannot report every plugin unconfigured at once.

### `GET /manifest`

What you claim to serve. A manifest is a proposal, not a registration
(section 6). Its only reader is `validateManifest` in
`packages/shared/src/pluginManifest.ts`, run wherever the API fetches one.
Every rejection names the field. Nothing is trimmed, coerced or repaired.

```json
{
  "protocol": 3,
  "plugin": { "name": "vinted", "version": "1.0.0" },
  "requiredSecrets": [],
  "sources": [
    {
      "id": "vinted_uk",
      "kind": "live",
      "label": "Vinted UK",
      "family": "vinted",
      "familyLabel": "Vinted",
      "country": "GB",
      "reach": "global",
      "defaultRegion": null,
      "expectedCurrencies": ["GBP"],
      "kindRoles": { "active_listing": "buy_listing" },
      "kindLabels": { "active_listing": "Vinted UK asking price" },
      "caveat": "Vinted UK is read by an unofficial community scraper: asking prices from private sellers, best-effort, and it may stop working at any time."
    }
  ]
}
```

This is the shipped Vinted plugin's manifest, generated into
`apps/api/src/adapters/sidecar/fixtures/vinted-manifest.json` and put through
`validateManifest` by `apps/api/test/adapters/sidecar/vintedManifest.test.ts`.

#### Top level

| field | type | required | bounds |
|---|---|---|---|
| (the document) | JSON object | yes | not an array, not null. |
| `protocol` | number | yes | exactly `3`. Any other value is refused, naming yours. |
| `plugin` | object | yes | an object with a name and a version. |
| `plugin.name` | string | yes | matches `^[a-z][a-z0-9_-]{1,31}$`: 2 to 32 characters, a lowercase letter first, then lowercase letters, digits, `_` or `-`. |
| `plugin.version` | string | yes | 1 to 32 characters, no control character. The minimum is measured after trimming, the maximum on the raw string. A person identifies the approved build by it. |
| `requiredSecrets` | array of strings | no | absent means "this plugin needs no secrets". At most 10 entries, each matching `^[A-Z][A-Z0-9_]{2,63}$` (3 to 64 characters); a name listed twice is refused. |
| `sources` | array | yes | 1 to 20 entries. A source id declared twice is refused. |

`requiredSecrets` lists names of environment variables, never values. The
shape check catches the common paste of a value and no more; the real
protection is that the app never asks a plugin for a secret and never stores
one. Your secrets live in your environment.

#### One entry of `sources`

Every rejection reads `sources[<index>].<field>`. The message names one
source; the refusal is the whole manifest. `parseManifestBody` returns on the
first source that fails, so one mistake on one source reads as no manifest at
all, conforming siblings included. This applies at import and to a document
already stored in the `plugins` table the next time anything reads it
(section 8).

| field | type | required | bounds |
|---|---|---|---|
| `id` | string | yes | matches `^[a-z][a-z0-9_]{1,31}$` (2 to 32 characters, no hyphen), and does not name a property of `Object.prototype` (`constructor` passes the regex; the check is `value in {}`). The id becomes a key in the runtime registry and in every stored mapping, so it must never change. |
| `kind` | `"live"` or `"sync"` | yes | see sections 3 and 4. |
| `label` | string | yes | 1 to 60 characters, no control character, and at least one letter or digit (`\p{L}` or `\p{N}`, any script). Punctuation-only, emoji-only and zero-width-only strings are refused; they would render as an empty heading. |
| `family` | string | yes | `^[a-z][a-z0-9_]{1,31}$`, not an `Object.prototype` name. Groups sources on the Markets screen and selects the app's reading of a shop's own category vocabulary (`apps/api/src/adapters/familyReading.ts`) and the listing-URL match in `apps/api/src/matching/reviewNumeralMismatches.ts`. The signal engine never reads it: two shops of one family still compare against each other. |
| `familyLabel` | string | yes | 1 to 40 characters, same visible-character rule as `label`. Heads the family's group on the Markets screen. |
| `country` | string | yes | one of `GB`, `ES`, `IE`, `DE`, `FR`, `IT`, `PT`, `US` (`COUNTRY_CODES` in `packages/shared/src/index.ts`). Adding a country is an app change. |
| `reach` | `"local"` or `"global"` | yes | how far this source's prices carry for a physical copy. `local`: a regional shop whose price applies only to the exact region and condition it lists. `global`: a market where sellers post from anywhere, so a reading with an undeclared region or tier may stand in for a copy through the app's ladder, at reduced confidence. Reach describes the market, not the quality of the data: a marketplace of private sellers is `global` even though its listings rarely declare a region. |
| `defaultRegion` | `null` or a region | yes | one of `PAL`, `NTSC_U`, `NTSC_J`, `unknown`, or `null`. `null` means "do not guess a region"; a missing field is refused. Applied on both transports by `applyDefaultRegion` (`apps/api/src/adapters/defaultRegion.ts`), only when the title declares no region and carries no bare "import" marker. |
| `expectedCurrencies` | array of strings | yes | 1 to 5 entries, each matching `^[A-Z]{3}$`, no repeats, and each one the app's rate provider quotes (`CONVERTIBLE_CURRENCIES`, the ECB set Frankfurter serves). A code the rate table cannot serve would make the write-time FX lookup throw and cost the source its whole block. |
| `kindRoles` | object | yes | 1 to 6 entries. Keys are price kinds: `sell`, `cash`, `voucher`, `active_median`, `active_listing`, `guide`. Values are roles: `buy_listing`, `buy_store`, `bid`, `reference`, `guide`. |
| `kindLabels` | object | yes | a label for every kind in `kindRoles`, checked both ways: a key must be a known kind and one this source gives a role, and every kind with a role must have a label. Each value is 1 to 60 characters with a visible character. The app prints it as a clause under its own voice ("CeX UK pays voucher"), so it carries the source's name. |
| `kindLabelsShort` | object | no, optional per kind | same two key checks as `kindLabels`; each value 1 to 30 characters with a visible character. The same wording with the source's name taken out, for a place that already prints the name (a price table's block heading). Absent falls back to the app's own clause ("sells for", "pays voucher"). An empty object counts as absent. |
| `caveat` | string | no | 1 to 300 characters with a visible character. Printed under this source's prices as the app's warning. |
| `productUrl` | string | no | 1 to 512 characters, no control character, `{id}` exactly once. The part before `{id}` must parse as an `https` URL with no credentials, and substituting an id must not be able to change that origin: `https://uk.webuy{id}.com/p` and `https://uk.webuy.com{id}` are refused, while an uppercase host, an explicit `:443` or a bare query are accepted. The app percent-encodes the id when it substitutes it. A sync source's points get their link from this template, since a catalog row carries no `url` (section 4); `price_points.source_url` is also what the stale-point sweep matches a point back to its mapping by, so a sync source without one stores points that sweep cannot find. |
| `categoryPlatforms` | object | no, `sync` only | 1 to 200 entries. Each key is the source's own category text (1 to 256 characters, no control character, not an `Object.prototype` name); each value is one of the app's platform ids. Refused on a `live` source. Validated, shown on the approval screen and judged for drift, but not yet consulted by classification: the app reads a shop's categories through the family reading instead. |
| `sellFeeRate` | number | no | finite, in `[0, 1]`. Your estimate of what a seller loses in fees there. PROFIT multiplies a reading by `(1 - rate)`. Absent means 0. |
| `schedule` | object | required on `sync`, refused on `live` | a `sync` source without one is refused at import, naming the source; the app never chooses a cadence. A `live` source has no catalog to sweep. |
| `schedule.catalogCron` | string | yes, if `schedule` | at most 120 characters (checked first) and matching `^[\d*/,\-A-Za-z?]+(\s+[\d*/,\-A-Za-z?]+){4}$`, five whitespace-separated fields, matched as sent. |
| `schedule.trackedRefreshHours` | number | yes, if `schedule` | a whole number of hours in 1..168. It becomes a repeat interval. |

No control character (C0 below U+0020, or DEL) is allowed in
`plugin.version`, `label`, `familyLabel`, `caveat` or any `kindLabels` or
`kindLabelsShort` value. The manifest is stored in a `jsonb` column and
Postgres refuses a NUL in one. The row rule in section 4 is looser (tab,
newline and carriage return pass), because a shop's product title is the
shop's fact; everything here is a heading the app prints on one line.

**What the roles mean.** Ticking one is what a person consents to:

- `buy_listing`: a concrete purchasable offer with a title and a URL. The app
  may call it a bargain, against a baseline or another shop's price.
- `buy_store`: a shop's own posted buy-now price. The app may call it a
  bargain, or call the shop overpriced against a baseline.
- `bid`: what this source pays you. The app may call a flip and works out the
  profit on a copy you own from it.
- `reference`: the market baseline other sources are judged against and
  profit is worked out from, but only when the point carries a sample size.
  The signal engine drops a `reference` point without one
  (`apps/api/src/signals/computeSignals.ts`). A sample reaches a point two
  ways: the app's median builder writes one for a `median_of_listings` source
  (section 5), or the plugin sends its own (`prices[].sampleSize` in section
  3, `sampleSizes` in section 4). A `reference` kind that never gets one is
  stored and shown like any other point and fires nothing. This is the role
  the approval screen leaves unchecked by default (section 6).
- `guide`: shown beside the other prices and nothing more. The signal engine
  ignores it.

A kind you declare no role for is refused at row validation (sections 3, 6).

#### A plugin serving several sources

`sources` allows 1 to 20 entries. The eBay plugin declares five (`ebay_uk`,
`ebay_de`, `ebay_es`, `ebay_fr`, `ebay_us`), one per marketplace, and the
`source=` parameter on `GET /search` names which one a request is about. The
process holds one OAuth token for all five, and it is paced and broken as one
plugin (section 5): one `RateLimiter` and one `CircuitBreaker` shared by
every source it serves.

#### Two checks the API adds

`validateManifest` lives in `packages/shared` and cannot import an API
dependency, so `apps/api/src/routes/plugins.ts` adds two checks at import
and again at approval:

- The cron is really parsed, with `cron-parser`. A five-field shape no parser
  reads would otherwise become a job never scheduled.
- The source ids are free. An id already served by another plugin is refused,
  naming the id and its current owner.

---

## 3. The live surface: `GET /search`

A `live` source is asked this, one request, when the app needs fresh prices
for a game and the stored ones have aged past `PRICE_TTL_HOURS` (6 by
default). A fresh block is served from the database without calling you. A
`sync` source is never asked it.

```
GET /search?source=<id>&q=<text>[&platform=<id>][&alt=<name>&alt=<name>…][&spelling=<text>&spelling=<text>…][&budgetMs=<int>]
```

| parameter | required | meaning |
|---|---|---|
| `source` | yes | which of your declared sources this request is about. Always sent, first. The shipped plugins answer 400 when it is missing and 404 when it names a source the process does not serve. |
| `q` | yes | the search text, a game title. |
| `platform` | no | a RetroWatchdog platform id (`snes`, `n64`, `gb`, …). A hint: narrow the search if your source can, ignore it if not. Never require it. |
| `alt` | no | repeated once per name: the catalog's other names for this game. |
| `spelling` | no | repeated once per entry: how sellers write the console named by `platform`, from the app's console table. Sent only when `platform` is. |
| `budgetMs` | no | how many milliseconds remain of the app's fetch budget (`ADAPTER_TIMEOUT_MS` minus what its own pacing already spent) when the request goes out. Sent on every request. A plugin making more than one call can reserve time for the second; a single-call plugin ignores it. |

A plugin must ignore query parameters it does not know: later protocol
versions add parameters, and an unknown one is never a reason to fail. The
app does not bound the URL length; measured on 2026-09-04 the longest request
it built was 773 characters, plus at most 146 for spellings and `budgetMs`.

On success: HTTP 200 and a JSON array of raw listings. An empty array means
"this source has nothing for that query" (section 7).

### The raw listing

```json
{
  "sourceProductId": "1234567890",
  "title": "Legend of Zelda Ocarina of Time N64 boxed with manual PAL",
  "prices": [
    { "kind": "cash", "amount": 42.5, "currency": "GBP" },
    { "kind": "guide", "amount": 39.99, "currency": "GBP", "sampleSize": 17 }
  ],
  "url": "https://www.example.com/items/1234567890",
  "categoryText": "Video games & consoles",
  "conditionText": "Very good",
  "observedAt": "2026-09-03T09:15:00Z",
  "available": true
}
```

| field | type | required | notes |
|---|---|---|---|
| `sourceProductId` | non-empty string | yes | the source's own stable id for this listing; mappings are stored under it, so it must identify the same listing tomorrow. At most 128 characters, no control character. |
| `title` | non-empty string | yes | the source's own title, unedited. The title cleaner and matcher are tuned on real seller text. At most 512 characters, no control character. |
| `prices` | array of price objects | yes | may be empty (a listing with no price). |
| `url` | string or null | no | the listing's page as an absolute `http` or `https` URL of at most 2048 characters. Absent reads as `null`; present and anything else (a relative path, another scheme, over the bound) makes the row malformed. The app renders it as "the listing" in the price table, the cheapest strip and the bark. |
| `categoryText` | string or null | no | the source's own category label. At most 256 characters, no control character. A hint for platform detection through the family reading; a category it does not recognise falls through to the title guess. |
| `conditionText` | string or null | no | the source's own structured condition field, if it has one (eBay's "New" / "Pre-owned"). Its words, not your reading of them. Omit it rather than derive one from the title. At most 256 characters, no control character. |
| `observedAt` | ISO-8601 string or null | no | when the source reported these prices. Absent or `null` means now. Must match `YYYY-MM-DDThh:mm`, optional `:ss`, optional fraction of 1 to 9 digits, and an explicit zone (`Z` or `±hh:mm`); a real date; at most 60 000 ms ahead of the app's clock; not before `2000-01-01T00:00:00Z`. The app shows the earliest `observedAt` of a source's points as its "updated" time. Send it only for the moment the price was read: a source that reports when a price last changed must leave it out, or its block reads as older than the fetch that produced it. |
| `available` | boolean or null | no | whether the source says this is buyable now. Absent or `null` is unknown, which the engine treats as buyable; `false` is refused by the engine. Say `false` if your source tells you, or a bargain alert can point at a sold listing until the price TTL retires it. |

A price object:

| field | type | required | notes |
|---|---|---|---|
| `kind` | string | yes | one of `sell`, `cash`, `voucher`, `active_median`, `active_listing`, `guide`, and one this source has an approved role for (section 6). A known kind without an approved role, or a kind outside the six, costs only that price, reported once per answer. A row that arrived with prices and lost every one is dropped whole; a row whose `prices` was empty on arrival is kept. |
| `amount` | number | yes | finite, not negative, at most 99999999.99. The amount as the source quotes it: not converted, not rounded, not a "from" price. `0` is accepted and shown, but the engine never compares against it. If the source did not quote a kind, leave that price object out rather than send a zero. |
| `currency` | string | yes | exactly three uppercase letters, and one of the source's `expectedCurrencies`. |
| `sampleSize` | integer | no | how many observations this amount stands on, for an amount your source aggregated (a median, a guide price). A whole number from 1 to 1 000 000; `null`, `0`, a fraction or a string condemns the row. Leave it out for one listing's own asking price. Send it on every price whose kind holds a `reference` role, unless you also declare `buy_listing` (the app then derives the reference itself, section 5). A `reference` price without one is stored and shown but never used as a baseline, and the app logs a warning naming the kind once per fetch. |

### Money is never converted

Send what the source printed, in the currency it printed. The app keeps that
amount forever and freezes a USD twin beside it at the rate of the day it was
written. A currency the rate table cannot serve makes the lookup throw and
costs the source its entire block; a wrong but quotable code (`GPB` for
`GBP`) freezes the twin at another country's rate, permanently.

### Fields the app ignores

Extra keys are allowed and dropped. A `platform`, `region`, `condition`,
`grade`, `image` or `seller` key is not an error; it never reaches the app.

---

## 4. The sync surface: three catalog endpoints

A `sync` source does not answer `/search`. Its catalogue is swept into the
app's `catalog_items` table on the cadence its manifest declares, and a game
view searches the app's own tables with trigram similarity, costing
the plugin nothing per game. The reader is
`apps/api/src/adapters/sidecar/sync.ts`; the local search that replaces
`/search` is `apps/api/src/adapters/sidecar/catalogAdapter.ts`.

### `GET /catalog/units?source=<id>`

The units your catalogue is swept in: one category, one sweep. Answer a JSON
array of 1 to 200 strings. Each is non-empty, at most 128 characters, with no
control character (it reaches `catalog_items.sync_unit`). `.` and `..` are
refused: the unit goes in a URL path, and the URL parser removes a dot
segment however it is encoded. A unit listed twice is refused: each unit gets
its own sweep timestamp, so a second pass would judge the first pass's rows
unseen and delete them. Any of these fails the whole call.

### `GET /catalog/units/<unit>?source=<id>[&cursor=<c>]`

One page of one unit. The app percent-encodes the unit into the path; decode
it back, so `Toys/Games`, `50% off` or `Jeux vidéo` reach you as named.

```json
{ "rows": [ … ], "next": "eyJwYWdlIjoyfQ", "complete": false }
```

| field | type | required | bounds |
|---|---|---|---|
| `rows` | array | yes | at most `SIDECAR_SYNC_MAX_ROWS_PER_PAGE` (2000). A page over the cap is refused, not truncated: a partial page could be reported complete, and complete authorises a deletion. |
| `next` | string or null | yes | `null` ends the unit. A cursor is 1 to 512 characters. A cursor the app was already served ends the unit as incomplete. |
| `complete` | boolean | yes | not defaulted. See below. |
| `notes` | string | no | at most 500 characters. Omit it or send a string; `null` is not accepted. It reaches a log line and the unit's report, nothing stores it. |

**What `complete` authorises.** The worker deletes every stored row of a
unit that a run reporting `complete` did not write. It must mean "this sweep
saw the whole unit", and the app withholds it whenever:

- it is claimed on a page other than the last one (the one whose `next` is
  `null`); only the last page's value is read;
- a page fails mid-unit (the rows that arrived are kept, the rest of the
  catalogue is left alone);
- the unit hits the page cap (`SIDECAR_SYNC_MAX_PAGES_PER_UNIT`, 100) or
  repeats a cursor;
- the sweep stored no row at all;
- a page had fewer than half its rows readable (`MIN_USABLE_SHARE`, 0.5).

A unit whose first page failed produced no evidence: that is a failed job and
it throws rather than reporting an empty catalogue. The cost of this caution
is that a category the shop emptied keeps its stale rows until the 30-day
stale sweep removes them.

### `POST /catalog/refresh`

Re-read the products the app tracks, without sweeping. Request body:
`{ "source": "<id>", "ids": ["…", "…"] }`. The app sends at most 200 ids per
call; each chunk is an ordinary call through the same limiter and breaker.

Answer `{ "rows": [ … ] }`, at most 2000 rows. A row about a product the app
did not ask for is dropped with a warning: it would land with no `sync_unit`
and no `last_seen_at`, so only the stale sweep could ever remove it. An id
you omit means "delisted or unknown" and its stored row is left as it is, for
a complete sweep to judge. A refresh deletes nothing.

### The catalog row

Rebuilt field by field, like a live listing.

| field | type | required | bounds |
|---|---|---|---|
| `sourceProductId` | string | yes | non-empty, at most 128 characters, no control character. |
| `title` | string | yes | non-empty, at most 512 characters, no control character. |
| `categoryText` | string or null | no | at most 256 characters, no control character. |
| `currency` | string | yes | three uppercase letters, one of this source's `expectedCurrencies`. |
| `prices` | object | yes | keyed by the app's kind names (`sell`, `cash`, `voucher`, `active_median`, `active_listing`, `guide`); translating your source's labels (`exchangePrice` to `voucher`) is fetching and belongs to you. At least one key. Each value is a finite number in `[0, 99999999.99]`. |
| `available` | boolean or null | no | as on a live listing. |
| `observedAt` | ISO-8601 string or null | no | same rule and bounds as the live row. Absent or null means the time the sweep started. Send it only when your source reports when it read the price; a source that reports when a price last changed (CeX's `priceLastChanged`) must leave it out, since the app shows the earliest `observedAt` as the block's time and a just-refreshed block would read as old. The CeX plugin sends none. |
| `conditionText` | string or null | no | same meaning and bounds as the live row: at most 256 characters, no control character. |
| `sampleSizes` | object or null | no | `{kind: integer}`, keyed like `prices`. Same bounds as `prices[].sampleSize`. A sample for a kind the row did not price, or whose price was dropped, is ignored; a sample that is not a whole number from 1 to 1 000 000 condemns the row. |

Keys the table does not name (`sourceMetadata`, for one) are ignored.

**A kind never quoted is a different claim from a kind quoted as zero.** Omit
the key from `prices` if your source does not buy or sell that kind; send
`0` only when it genuinely quotes zero, because a stored zero is shown as a
real quote. Your source's wire format is yours to translate: CeX sends `0`
in every price field and a separate `boxBuyAllowed` flag, and the CeX plugin
omits `cash` and `voucher` when that flag says the title is not bought.

There is no `url` field. A synced row is a catalogue entry; its link comes
from the manifest's `productUrl` template (section 2).

Inside `prices`, a kind the app does not know or that this source has no
approved role for is dropped, not fatal, and the dropped names are reported
once per page. Only a row left with no storable price is dropped whole. A
broken amount for a kind the app would store condemns the row.

The 99999999.99 ceiling is `price_points` amounts being `numeric(10, 2)`. A
larger amount would sync fine (the catalog column is jsonb) and then fail the
insert on every view of a game whose confirmed mappings include it, taking
every other price of that game for that source with it. The USD twin has the
same ceiling and is not checked at parse time, since the rate is unknown
until write time. The control-character rule exists because Postgres refuses
U+0000 and the sink writes a page in chunks of 500 rows, so one such byte
would end the whole unit; tab, newline and carriage return are allowed.

Two rows sharing a `sourceProductId` in one page: the second is dropped with
a warning, since within one 500-row chunk Postgres would refuse the whole
statement.

---

## 5. What the app enforces, and no manifest can loosen

These values live in `apps/api/src/config.ts`. No manifest field sets a
plugin's pace, breaker, timeout or caps. Each is a deployment default the
operator may change through the environment; the pace alone can also be set
per plugin, from Settings → Plugins, on the plugin's own row
(`plugins.rate_limit_ms`). The row's value beats the default. `paceFor` in
`apps/api/src/sources/registry.ts` reads the row and the config and never the
manifest.

The app refuses a pace its own arithmetic says cannot work, and shows the
same sentence before the click. A plugin's sources share one queue, so a pace
decides when the last of them starts, and it has to finish inside the same
budget. `paceBudget` (`packages/shared`) requires
`(n - 1) × pace + PLUGIN_CALL_ALLOWANCE_MS ≤ ADAPTER_TIMEOUT_MS`, with
`PLUGIN_CALL_ALLOWANCE_MS` at 2000. `n` counts the plugin's live sources only
(`pacedSourceCount`, floor of 1): a sync source answers no game view, and its
sweep has all night. A sync-only plugin therefore has no pace the app will
refuse.

| what | config key | default | applies to |
|---|---|---|---|
| pace between calls | `SIDECAR_RATE_LIMIT_MS` | 3000 ms | every call to a plugin |
| pace between calls, per plugin | Settings → Plugins → Pace | unset | one plugin, stored on its row; beats the default |
| per-request timeout | `ADAPTER_TIMEOUT_MS` | 8000 ms | every call to a plugin |
| consecutive failures before the breaker opens | `SIDECAR_BREAKER_THRESHOLD` | 5 | live and sync traffic |
| how long the breaker stays open | `SIDECAR_BREAKER_HOLD_MS` | 1 800 000 ms (30 minutes) | live and sync traffic |
| body cap, `/search` | `SIDECAR_MAX_BYTES` | 8 MB (8 × 1024 × 1024) | `GET /search` |
| row cap, `/search` | `SIDECAR_MAX_LISTINGS` | 500 | `GET /search` |
| median sample window | `SIDECAR_MEDIAN_WINDOW` | 50 | a live `median_of_listings` source with exactly one `expectedCurrencies` entry, after the non-game read |
| body cap, catalog | `SIDECAR_SYNC_MAX_BYTES` | 16 MB (16 × 1024 × 1024) | the three catalog calls |
| row cap, one catalog page | `SIDECAR_SYNC_MAX_ROWS_PER_PAGE` | 2000 | catalog pages and refresh answers |
| page cap, one unit | `SIDECAR_SYNC_MAX_PAGES_PER_UNIT` | 100 | one unit's sweep |
| health/manifest poll interval | `PLUGIN_HEALTH_INTERVAL_MS` | 300 000 ms (5 minutes) | `/health` and `/manifest` per non-disabled plugin |

The body cap for `/health` and `/manifest` is 1 MB (`DECLARATION_MAX_BYTES`
in `apps/api/src/plugins/client.ts`).

What a plugin author should know:

- **The pace is per plugin, not per source.** One `RateLimiter` and one
  `CircuitBreaker` are built per plugin identity (row id + base URL) and
  shared by every source it serves, live and sync alike. They survive
  registry rebuilds, so a 30-minute hold is 30 minutes and not one health
  tick. A catalog sweep and a game view cannot together exceed the pace.
- **The default pace is three seconds.** A source reached through a plugin
  is assumed unofficial. For a quota-metered first-party API (eBay's Browse
  API allows 5000 calls a day across all five markets) the operator sets a
  faster pace on the row; the eBay plugin runs at 250 ms. Five sources behind
  the 3000 ms default would start at 0/3/6/9/12 s against an 8-second budget,
  and the fourth and fifth would never answer.
- **The breaker opens on 5 consecutive failures, holds 30 minutes, then lets
  one probe through.** A failed probe reopens it; a successful one closes it
  and resets the count. Concurrent probes are refused.
- **Parsing runs inside the breaker.** A 200 with a body this protocol does
  not allow counts as a failure, like a 500.
- **Bytes are counted decoded**, through a streaming counter.
  `Content-Length` is not trusted, and a gzip body that expands past the cap
  trips at the expansion.
- **The two row caps behave differently.** `/search` truncates to the first
  500 rows with a log line; a catalog page over 2000 rows is refused.
- **Neither row cap is a page size to design for.** Every accepted `/search`
  row costs two catalog queries after the fetch, outside the timeout, and may
  become a stored price. Answer with one sensible page of your source's own
  size; the eBay plugin's merged two-call answer is up to 100 rows.
- **A source becomes `median_of_listings` by role, never by kind name.**
  `snapshotStrategyFor` (`apps/api/src/sources/registry.ts`) answers
  `median_of_listings` exactly when the source's approved kinds carry both a
  `buy_listing` role and a `reference` role, under whatever names. Then
  `medianPointsFrom` (`apps/api/src/pricing/service.ts`) takes the median
  over the `buy_listing`-role prices and writes it as one row under the
  source's `reference`-role kind, with the sample size, and stores the
  cheapest `CHEAPEST_KEPT` (10) `buy_listing` rows individually. A price on
  the same row carrying neither role (a `bid` or `buy_store`) is stored under
  its own kind, as a `per_listing` source stores it. A source approved for
  `buy_listing` alone stays `per_listing`: there is no kind to write an
  aggregate under. This applies on either transport.
- **A median source's sample is capped separately, after the app's own
  reading.** `SIDECAR_MEDIAN_WINDOW` keeps the cheapest 50 of the listings
  that survived the non-game filter, ranked on the `buy_listing`-role price;
  a row without one sorts last. It runs only for a `live` source that is
  `median_of_listings` and declares exactly one `expectedCurrencies` entry:
  raw amounts rank inside one currency and not across two. If you serve
  several currencies, serve them as several sources, one per currency, as
  the eBay plugin does. Do not pre-trim for the window: the cheap tail is
  where merchandise lives, and the app's filter runs first.
- **Redirects are refused, never followed** (`redirect: "error"` in
  `apps/api/src/plugins/http.ts`). Following one would let the least-trusted
  process pick a URL for the api container to fetch and hide a non-2xx.
- **An abandoned body is cancelled**, not left attached until the timeout.

---

## 6. The trust boundary and the approval model

### The legal boundary

A plugin reads a third party's service, and whether that is allowed is that
third party's terms to say, not this protocol's. A plugin author documents
what the source's terms say, when they were read, and what that means for
the operator, in the plugin's `LEGAL.md`, and states the same in each
source's `caveat`, which the app shows under the source's prices and on the
approval card. A plugin whose source forbids automated access is shipped off
by default and says so; the operator switches it on and carries the
responsibility. The app itself warrants nothing and is not financial advice
([`LEGAL.md`](../LEGAL.md)).

### How a plugin gets in

1. You deploy it and give the app its base URL: `POST /api/plugins`, from
   Settings → Plugins.
2. The app calls `GET /health`, then `GET /manifest`, and checks the
   manifest, the crons and the source ids. If anything fails, nothing is
   stored.
3. On success a row is written with status `pending`, `manifest_seen` set and
   nothing approved.
4. A person reads the sources on that card, ticks the kinds they grant and
   approves. Only then do the sources enter the runtime registry.
5. They still have to be switched on in Settings → Markets before any game
   view queries them.

The three shipped plugins are offered as pending rows on first boot, seeded
from `VINTED_SIDECAR_PLUGIN_URL`, `CEX_PLUGIN_URL` and `EBAY_PLUGIN_URL`. They still
need a person's approval.

Disabling stops the app querying a plugin and drops its sources from the
registry; stored prices and the enabled-markets list are kept
(`PUT /api/settings/markets` keeps a stored id it cannot currently see), so
re-approving brings the markets back switched on. Turning an unknown id on is
refused. Deleting prunes the enabled list and keeps every `price_points`,
`catalog_items` and `source_mappings` row as history.

An approval narrows what a source may say, and what was already written:
re-approving with a kind unticked drops that kind's role and its `kindLabels`
wording, and stored `price_points` rows of that kind stop being served on the
game, collection and watchlist screens. A stored value is always read back
under today's approval.

### A plugin is untrusted code that is useful

- It runs as its own container with no published host port: the plugin
  services in `docker-compose.yml` declare no `ports:` key, so only the
  compose network reaches them. A plugin is imported by URL, so it can live
  anywhere the api container reaches; this is the shape the repo ships.
- It gets no app credentials: not the IGDB secret, not the Postgres URL.
- It has no route to the database or the queue: `docker-compose.yml` puts
  the data stores on a `backend` network and the plugins on a `sidecars`
  one, with only the api and the worker on both. The Postgres user and
  password are literals in that file and Redis has no password, so the
  topology is the protection.
- Its own credentials never travel through the app. Its base URL may not
  carry them: a URL with a username or password is refused at import, as is
  one with a query string or a fragment. Only trailing slashes are collapsed.
- Pacing, circuit breaking, timeouts and caps live in the app (section 5).

`POST /api/plugins` makes the app fetch a URL a person typed, from inside its
private network, and no address blocklist is applied: a plugin lives at a
private address by design. The api container publishes port 3001 on
`127.0.0.1` only; clients reach the app through the web container (Caddy,
ports 80 and 443). Both decisions are explained in `apps/api/src/routes/plugins.ts`.

### A manifest is a proposal

Two columns of the `plugins` table carry the distinction:

| column | meaning |
|---|---|
| `manifest` | what the user approved. The runtime registry is built from this and nothing else. |
| `manifest_seen` | what the plugin last said. Rewritten by the health tick whenever `/manifest` answers and validates; a failed poll leaves it standing. |

An import writes no `manifest`, so it cannot grant anything. Republishing a
manifest changes only `manifest_seen`; the approved document goes on serving
until a person approves the new one. A plugin cannot promote itself.

A review is proposed on any byte difference between the two documents; a
`protocol` bump alone is such a difference. The Plugins panel then names the
drifted fields (`+shop_fr` for a source that appeared, `-shop_fr` for one
that went, `shop_gb.kindRoles` for a claim that changed). `DRIFT_FIELDS` in
`packages/shared/src/pluginManifest.ts` is the list. A rewording outside it
(a relabelled source, a bumped `plugin.version`) still offers a review with
nothing named as changed.

Both columns are re-validated on read. A row can be hand-edited, restored
from a backup or written by an older build, and a column that fails
validation reads as "no manifest" rather than half a manifest.

### The approver echoes back the fingerprint they read

`POST /api/plugins/:id/approve` requires `reviewedFingerprint`: the sha256 of
the canonical JSON of the manifest the client was served. The approval is
admitted only while the row still hashes to it, and refused with 409
`this plugin changed its manifest while you were reviewing it; review it again`
otherwise; the health tick rewrites `manifest_seen` on a schedule, so the
window between render and click is real. The transaction repeats the check on
whole documents under `SELECT … FOR UPDATE`. Approving also re-runs the cron
parse and the id collision check.

### Approval is per kind, and `reference` is unchecked by default

The Plugins panel draws a checkbox per declared kind, showing what each role
lets the app do, and sends back only the ticked kinds. The API refuses a kind
the manifest declares no role for, and a source id that is not this plugin's.

On a first review every declared kind is proposed checked except any whose
role is `reference`: that role makes a source the baseline for every
UNDERPRICED bark, every FLIP, every PROFIT and every copy's estimated value,
and granting it is a decision a person makes knowingly. On a re-review the
panel proposes what the user chose last time, so republishing cannot undo a
refusal; the `reference` filter still runs first, so a kind that was granted
as `buy_store` and now claims `reference` arrives unchecked.

"First" is asked per source, not per plugin: a market your plugin adds in a
later version arrives with the first-review default even though the plugin
was approved before.

`effectiveKindRoles` in `apps/api/src/sources/registry.ts` intersects what
the manifest declared with what was approved, and a source left with no
approved kind is dropped from the registry rather than added as a source
that can answer nothing. A `sync` source with no `schedule` fails the whole
manifest (section 2), on every path that reads one: the import refuses it,
`approvePlugin` answers `no-manifest`, and the registry rebuild reads the
stored column as no manifest, siblings included.

### An unapproved or unrecognised kind costs a price, not a source

Both `parseSidecarListing` (live) and `parseSyncRow` (sync) narrow a row's
prices twice: to a kind the app knows, and, of those, to one this source has
an approved role for. Either narrowing drops the one price and keeps the
rest, and the dropped kinds are reported once per batch (once per `/search`
answer, once per catalog page). An approval says "the app may store these
kinds", not "refuse any answer that mentions another".

The live path (`apps/api/src/adapters/sidecar/index.ts`) logs the two cases
as two lines: `sidecar sent kinds this source is not approved for; those
prices were dropped` and `sidecar sent price kinds this app does not
recognise; those prices were dropped` (most likely a newer protocol). The
sync path logs one line per page, `catalog page carried prices of kinds this
source has no approved role for`, for both. If that line names a kind you
have a role for, check your protocol version before the approval screen.

Only a row left with nothing storable is dropped whole, and on the live path
only if it arrived with prices. Everything else still condemns the row: a bad
amount, a bad currency, a URL that is not `http(s)`, a broken `observedAt`.
A broken claim beside real evidence is worse than a dropped row with a reason.

**Where narrowing stops helping.** If every row your plugin returns carries
a single price and the approved set excludes that price's kind, every row
loses everything, every row is dropped whole, and section 7's
every-row-malformed rule turns the answer into a failure: the source goes
dark on every screen. The shipped eBay plugin's rows each carry one
`active_listing` while `active_median` holds the `reference` role, so the
default approval (every non-`reference` kind ticked) is safe there, and
unticking `active_listing` empties every row. If your rows are single-priced,
say so in your README and name the kind that must stay ticked.

---

## 7. The error contract

| your plugin answers | the app does |
|---|---|
| 200 and a JSON array of valid rows | uses them |
| 200, an array, one row malformed | drops that row, logs the reason, keeps the rest |
| 200, an array, every row malformed | treats it as a failure. Left as a success it would reset the breaker, write a fetch marker and let the block report `ok` and empty. |
| 200 but the body is not a JSON array (`/search`) | failure |
| 200 but the body is not JSON | failure |
| 200 and a body over the byte cap | stops reading, cancels the body, failure |
| 200 and more rows than the `/search` row cap | reads the first 500 and logs the truncation |
| 200 and a catalog page over the row cap | failure: refused, not truncated |
| 200 and an empty array | a fact about the source: "nothing for that query", stored as such, block reports `ok`. Never return a status to say you found nothing. |
| any non-2xx status | failure |
| a redirect (3xx) | failure, not followed. Answer the request yourself. |
| nothing, before the timeout | failure |

A row is malformed when a required field is missing or has the wrong shape,
and also when an optional field is present and invalid. Absent is fine;
present and wrong is a violation, because a broken timestamp or a bogus
currency would otherwise be stored as evidence. A row that arrived with
prices and lost every one to the kind narrowing (section 6) is dropped whole
and counts under the every-row-malformed rule, so an approval, not a bug, can
take a single-priced source dark.

Failures are counted by the plugin's circuit breaker (section 5). While it is
open the source's block reports `error`: the app shows whatever it stored
before, labelled as old, and never invents a price.

A source that is not there is not an outage. The app has three ways of saying
so, and only the third is an error:

- **Not in the registry.** A plugin that is `pending`, `disabled` or deleted
  contributes no sources; nor does a source with no approved kind. Such a
  source appears on no screen.
- **In the registry but not `configured`.** A source whose plugin's last
  `/health` did not say `configured` is served with `configured: false` by
  `GET /api/sources` and `GET /api/settings/markets`, and
  `PUT /api/settings/markets` refuses to switch it on. The web hides a
  `not_configured` price block entirely.
- **Enabled and failing.** Only this reports `error`.

A market the user switched off produces no block at all.

What you say about your own failures travels. A `/health` `status` other
than `"ok"` and every `validateManifest` rejection are reported to the
importing user and stored in `plugins.last_error`, which `GET /api/plugins`
serves and the Plugins panel shows. The offending value is quoted inside the
message, cut at 80 characters with an ellipsis. Write these for a person.

---

## 8. Versioning: one constant, checked only on what a plugin publishes

There is one version number for the whole protocol:
`PLUGIN_PROTOCOL_VERSION = 3` in `packages/shared/src/pluginManifest.ts`.
`SIDECAR_PROTOCOL_VERSION` in `apps/api/src/adapters/sidecar/protocol.ts`
re-exports it.

- Additive changes keep the version: a new optional field, a new optional
  query parameter. A plugin that ignores them stays correct, which is why
  "ignore unknown query parameters" and "extra keys are dropped" are part of
  the contract.
- A change that could break a working plugin increments it: a new required
  field, a renamed or re-meaninged one, a different response envelope.

The gate is on what a plugin publishes. `validateManifest` compares
`protocol` against the constant at every point the app fetches a manifest
from a plugin: import, recheck, address change and health poll, all through
`fetchPluginManifest` (`apps/api/src/plugins/client.ts`). Any other value is
refused, naming the value you sent. There is no backward compatibility at
that gate.

A document already in the `plugins` table is read by `readStoredManifest`,
which runs every field check except the version comparison, so raising the
constant does not empty the registry. What protects the app from a stored
document is its shape: a row missing a field the app requires, or naming
a role it does not have, is refused whatever number it carries. Nothing
reaches `manifest_seen` without passing `validateManifest` first.

Publishing an old protocol number deletes nothing. The health tick refuses
the document, writes `last_error` (and `last_health`, when `/health`
answered), leaves `manifest_seen` and `manifest` untouched
(`recordPluginHealth` in `apps/api/src/plugins/repo.ts`), and the app keeps
serving the approved manifest. The plugin's card reads unhealthy until it is
redeployed at the current version.

The `protocol` in `/health` is only checked to be a number. Your manifest is
what decides whether you can be imported, or stay approved.

---

## 9. Reserved: `Authorization: Bearer`

Not implemented. The app sends these headers to a plugin
(`apps/api/src/plugins/http.ts`): `accept: application/json`,
`user-agent: RetroWatchdog/3 (+source plugin client)`,
`x-retrowatchdog-protocol: 3`, and `content-type: application/json` on the
one POST. The user agent and protocol header identify the caller for your
access log; neither is a credential. There is no token, no `auth` field in
the manifest and no column to hold one.

The header is reserved for a per-plugin token generated at import, its hash
stored on the plugin row, the token shown once in Settings and read by the
plugin from its own environment, sent as `Authorization: Bearer <token>` on
every request, with the manifest declaring `auth: "none" | "bearer"` and a
`bearer` plugin answering 401 without it (see the roadmap, "Plugin
authentication").

Until it ships, do not require an `Authorization` header. Your plugin's
protection is the network topology in section 6.
