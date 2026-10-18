# RetroWatchdog Roadmap

What is deferred, each item with the trigger that makes it worth doing, and
what has been decided against. Shipped work is in `../CHANGELOG.md` and the
git history. The decisions recorded here are binding starting points for
their design phases, not final specs.

## Open

1. **Plugin authentication (app ↔ plugin).** A per-plugin bearer token
   generated at import, shown once, its hash stored in `plugins`, sent by the
   app on every request; `auth: "none" | "bearer"` in the manifest. The
   protocol reserves the header (`sidecar-protocol.md` §9) and nothing sends
   it. Trigger: the first plugin that runs outside the private compose
   network.
2. **Per-plugin egress control.** A proxy per plugin so one holding a key can
   only reach its own source's hosts. Trigger: running a plugin this
   repository does not author.
3. **Protocol additions.** NDJSON streaming for sync pages and a
   `GET /catalog/changes?since=` delta endpoint so a nightly full sweep
   becomes incremental. Trigger: a catalogue whose full sweep does not fit
   the night.
4. **eBay sold prices.** Only Marketplace Insights reports what sold; access
   needs an application to eBay with some traction to show. A "sold" proxy
   from listings that vanish between refreshes was examined and not built:
   the plugin reads the 50 cheapest fixed-price listings per query, so a
   listing leaves that window when a cheaper one arrives or its price moves,
   not only when it sells, and even a complete window cannot tell a sale from
   a seller ending the listing. A proxy would need the plugin to report
   whether its window was complete and a per-listing end check, a protocol
   change in two repositories for a figure that stays ambiguous.
5. **User-defined currencies.** Add a currency the built-in list lacks (for
   example CLP) with its code, symbol, decimals and a manual rate to USD, and
   use it for display, targets, paid and sold prices. Every currency the rate
   provider (Frankfurter) quotes is already selectable; the list is a fixed
   constant (`SUPPORTED_CURRENCIES`) validated by enum in the API, the CSV
   import and the web forms, so a user currency needs a
   `currencies` table read wherever that constant is, and a manual rate that
   is required rather than an override. Stored USD amounts stay frozen as
   today. Trigger: someone who prices or reports in a currency outside the
   list.

## Discarded

- **Visual (drag-and-drop) rule builder for source and signal rules.** The
  engine's value is its honesty machinery (reference ladder, confidence
  caveats, grade honesty, availability gate, currency quoting, dedupe,
  connector reach), all pinned by tests and compiler exhaustiveness that a
  data-driven rule DSL would lose; estimated at 8–12 batches with high
  regression risk. If revisited, in this order: a rule explainer, then a DSL
  with the current rules as regression fixtures, then a form-based condition
  builder. Never the UI first.
- **PriceCharting price guide adapter.** There is none. A paid key would make
  it a small live plugin. The collection-link import is a separate, live
  module and stays.
