# Commercial license

RetroWatchdog, the application in this repository, is published under the GNU
Affero General Public License v3.0 (see `LICENSE`). The AGPL lets anyone use,
study, modify and share it, and asks that anyone who distributes it, or offers
a modified version as a network service, publishes their changes under the
same license.

If that does not fit your use, for example embedding RetroWatchdog in a
product or a service without publishing your changes, the author offers a
separate commercial license for this application. Open an issue on this
repository, or contact the author through GitHub, to discuss terms.

What a commercial license does not cover:

- **The source plugins.** Each plugin (`retrowatchdog-cex-plugin`,
  `retrowatchdog-ebay-plugin`, `retrowatchdog-vinted-sidecar-plugin`,
  `retrowatchdog-wallapop-sidecar-plugin`) is a separate program under the
  AGPL-3.0 only. They run as their own processes and talk to the app over
  HTTP, so a commercial deployment of the app may still run them under the
  AGPL, or write its own.
- **Third-party services.** A license from the author grants nothing from
  eBay, CeX, Vinted, Wallapop, IGDB or PriceCharting; their terms bind you
  directly, and IGDB in particular is free for non-commercial use only. See
  [LEGAL.md](LEGAL.md).

Contributions to this repository are accepted under the agreement in
`CONTRIBUTING.md`, which is what keeps both licenses possible.
