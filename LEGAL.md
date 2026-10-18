# Legal notes

Read this before you install RetroWatchdog or switch a source on. It is
written by the project's author, who is not a lawyer; none of it is legal
advice. The sources' terms were last read on 2026-10-18 and change without
notice: when you install, read them again at the links below.

## What RetroWatchdog is, legally

- **Free software, as is.** RetroWatchdog is licensed under the
  [GNU Affero General Public License v3.0](LICENSE), and the author also
  offers a [commercial license](COMMERCIAL-LICENSE.md) for the application
  alone; the plugins are AGPL-3.0 only. Under either licence it comes
  with **no warranty** of any kind, as sections 15 and 16 of the licence say:
  no promise that it works, that its prices are right, or that it fits any
  purpose. If you offer a changed version to others, including over a
  network, the licence requires you to offer them its source.
- **Self-hosted and personal.** It is built and documented for one person
  running it for their own collection. Whoever deploys it is the operator of
  that deployment and is responsible for how it is used, for the data it
  stores, and for complying with the terms of every source it is pointed at.
- **Not affiliated.** RetroWatchdog is not affiliated with, endorsed by or
  sponsored by eBay, CeX (Webuy), Vinted, Wallapop, IGDB, Twitch,
  PriceCharting or any other company named here. Their names and logos are
  their owners' trademarks and are used only to say which source a price
  came from.

## Not financial advice

Barks (signals), recommendations, estimated values, "buy now", "sell now",
target prices and every other number the app shows are automatic
calculations over the prices it happened to store, from the sources you
switched on, at the moment they were fetched. They are not an appraisal, not
a valuation for insurance or sale, and not investment, trading or financial
advice. Prices move, listings vanish, sellers mislabel, and the app's
matching is heuristic. Check a price on the source itself before you buy or
sell, and decide for yourself.

## The prices are not sold prices

eBay, Vinted and Wallapop figures are **asking prices** of listings that were
active when fetched, never what anything sold for. CeX figures are the
shop's posted prices. A median of asking prices is a market indication, not
a market value.

## Your responsibility for the sources

Each source plugin reads a third party's service. Whether that is allowed is
governed by that third party's terms, which you accept or breach, not the
project. The project documents what each source says and ships the risky
plugins **off by default**; you choose to switch them on.

| Source | What its terms say (read 2026-10-18) | What that means for you |
| --- | --- | --- |
| **eBay** — [API License Agreement](https://developer.ebay.com/join/api-license-agreement) | Official API. You register your own keys and accept the agreement as the "Developer". It requires eBay listings shown no older than six hours or labelled with their age, eBay content shown apart from other sources in a public display, no use of eBay content to model prices for items listed on eBay or for seller arbitrage, no derived site-wide statistics, and deletion of content eBay removed. | Keep the default TTL, consider Settings → Appearance → "eBay prices in their own block", and read the agreement yourself; the [eBay plugin's README](https://github.com/uniplexed/retrowatchdog-ebay-plugin#terms-of-use-ebays-api-license-agreement-binds-you) lists the clauses. |
| **CeX** — [terms and conditions](https://uk.webuy.com/site/terms) | No clause on automated access (UK, ES, IE). The content of the site is CeX's property. The search key the plugin needs is CeX's own, handed to every visitor's browser. | A nightly sweep of a whole catalogue is a systematic extraction of a database; in the UK and the EU databases have a right of their own, independent of the terms. Keep it to your own use at a slow pace, or ask CeX. |
| **Vinted** — [terms and conditions](https://www.vinted.co.uk/terms_and_conditions) | Forbids "bots, scraping programs, crawling programs, spiders" and to "data mine, screen scrape, crawl" without Vinted's authorization or prior written consent. | The plugin does exactly that. Get Vinted's authorization before you switch it on. Each country site has its own terms. |
| **Wallapop** — [condiciones de uso](https://about.wallapop.com/condiciones-de-uso/) | Forbids search robots and systematic extraction of content without Wallapop's express written consent. | Get Wallapop's authorization before you switch it on. |
| **IGDB** (Twitch) — [API docs](https://api-docs.igdb.com/) | Free for non-commercial use under the Twitch Developer Services Agreement; commercial use needs IGDB's partnership and visible attribution. | Your own collection is non-commercial. A commercial deployment is not. |
| **PriceCharting** — [terms of service](https://www.pricecharting.com/page/terms-of-service) | Price data is for personal use or, with a subscription, internal business use; never in software accessible to third parties without written permission. | The collection import reads your own public collection page and notes each copy's value at import. Keep that deployment yours. |
| **Frankfurter** (exchange rates), **ntfy** (alerts) | Free, commercial use allowed. | Nothing to do. |

A plugin written by someone else is that author's responsibility to
document; the [plugin protocol](docs/sidecar-protocol.md) asks every manifest
to state its source's legal conditions in the `caveat` the app shows under
its prices.

## The data you store

The app stores listing titles, prices and links from public marketplace
pages, your collection, your watches and what you paid. Seller names are not
stored. You are the controller of whatever your deployment holds; keep the
instance private (the installer sets a password) and delete the data when
you stop using it. Phone alerts through ntfy travel through a public relay
under a topic name only you know; do not put personal data in alert text.

## Questions and problems

Legal questions about this project: open an issue. A take-down request from
a source named here: open an issue or use GitHub's contact for the
repository, and the plugin concerned will be disabled by default or removed.
Security problems: see [SECURITY.md](SECURITY.md).
