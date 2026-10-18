# Changelog

All notable changes to RetroWatchdog. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [1.0.0] — 2026-10-18

The first public release: a self-hosted manager for your retro game
collection and your price hunts.

### Collection and watchlist

- A collection of the copies you own: region, condition, grade, what you
  paid, status (incoming, owned, listed, sold, returned), lots, notes, and a
  value today on the basis you choose (market, trade-in or replacement) from
  the markets you allow. Value history, realized profit, CSV import and
  export, and import from a PriceCharting collection link.
- A watchlist of the games you hunt, each for one region and condition or
  any, with an optional target price in its own currency.
- Filters on every standard field of each list, sorting both ways, grouping,
  and a sparkline of the last 90 days on every row.

### Prices and signals

- Prices from source plugins, each a separate service you approve in
  Settings: CeX (UK, Spain, Ireland), eBay (UK, DE, ES, FR, US) and Vinted
  (UK, France, Germany, Spain, Ireland, one container for all five, searched
  in "Video games & consoles" only) and Wallapop (Spain, Italy, Portugal,
  searched from a city you choose). Every amount is kept as the shop quoted it and converted once, at
  write time, to USD; the display currency is yours to pick among the 30 the
  rate provider quotes, with manual overrides.
- Barks (signals) computed from stored prices within one region and condition:
  underpriced, flip, overpriced store, profit on a copy you own, target hit,
  price drop, new low, back in stock, rising. Each shows the two prices it
  compared and a confidence; thin data is folded as "possible", never led
  with. Thresholds and types are tunable, with a live preview.
- PC games, DOS and Windows alike, beside the consoles: IGDB search, CeX's
  PC categories, and listings that say "PC CD-ROM", "PC big box" or "MS-DOS".
- A game page with its own "Barks (Signals) for" scope (any state, a watch's or a
  copy's), a sortable, filterable price table, and its price history in an open panel.

### Recommendations and insights

- Recommended actions judged on months of prices and what you paid: sell now,
  buy now, raise or lower a target, stop watching, check a copy, prefer a
  source, review a signal type's thresholds. Shown first on the dashboard,
  grouped on the Insights page, as a sheet on the phone, and on a game's page.
- Recommendation thresholds with a recommended value, a value derived from
  your own prices where the history allows, and a "Use" button for each.
- A signal log: every signal is judged 14 days later as held, beaten or
  unknown, and the Insights page shows how often each type held.
- Price history of the collection and the watchlist.

### Alerts, phone and help

- Alerts on your phone through ntfy for new signals and for new sell-now and
  buy-now recommendations, once each.
- A progressive web app that works on a phone and a desktop, with light and
  dark themes.
- An ⓘ beside every title explaining what it does, with a concrete example.

### Running it

- One `docker compose` stack: Postgres, Redis, the API, the worker, Caddy
  (HTTPS with its own authority or Let's Encrypt, optional password) and the
  plugins behind profiles. A one-command installer and a step-by-step guide, including what each
  plugin brings and how to get every key.
- The API refuses requests from the plugins' network, host names it does not
  answer to, and changes sent from other sites; it runs unprivileged, and the
  CSV export is safe to open in a spreadsheet.
