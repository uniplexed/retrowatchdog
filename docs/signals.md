# Barks (Signals)

The app calls them barks (signals): the watchdog barks when a price is worth
acting on. This document says "signal" for short. A signal is a sentence RetroWatchdog derives from the prices it stores, for
the games you hunt and the copies you own: "this store sells under the
market", "buy here and trade in there", "you paid less than this copy now
fetches". This document explains what the engine computes, from
which prices, under which rules and thresholds, and how to read what the
screens show. The engine lives in `apps/api/src/signals/computeSignals.ts`;
its tests in `apps/api/test/signals/computeSignals.test.ts` are the worked
examples the numbers below come from.

A signal is an automatic calculation over the prices the app happened to
store, from asking prices and shop postings at the moment they were fetched.
It is not an appraisal and not financial, investment or trading advice; check
the price on the source before you act, and decide for yourself
([LEGAL.md](../LEGAL.md)).

## What a signal is computed over

The engine judges one game at a time, inside one region at a time. Every
stored price point carries a source, a price kind and the role that kind was
approved under. The engine reads roles only; it never keys on a source's
name, so a new plugin lights up the same rules by declaring roles in its
manifest.

| Role | What the price is | How the engine uses it |
|---|---|---|
| `reference` | a market baseline with a sample size, such as a median of active listings | the yardstick every "vs market" rule compares against |
| `buy_listing` | one purchasable offer with its own URL and title | a bargain candidate |
| `buy_store` | a store's posted buy-now price | a store to be judged against the market |
| `bid` | what the source pays you (cash, store credit) | the sell side of a flip or a profit |
| `guide` | informational only | inert; never fires a signal |

A kind with no declared role is inert. Among the RetroWatchdog plugins, eBay
declares `active_median` as `reference` and `active_listing` as
`buy_listing`; CeX declares `sell` as `buy_store` and `cash` and `voucher`
as `bid`.

Before the rules run, the points of a region are reduced to the ones that
matter: the lowest `buy_store` price per source and condition (the price you
would pay), the highest `bid` per source, kind and condition (the payout you
would take; cash and voucher stay separate), one `reference` per condition,
and every `buy_listing` that passes the gates in "Honesty gates". Regions
never mix: a PAL store price is never judged against an NTSC-J median. The
one exception is the labelled fallback described next.

The game view computes signals for the region you filter on, keeping the
undeclared-region points as fallback fuel. A watch computes over the points
matching its region and condition, where "any" matches everything. An owned
copy computes over the points admitted for that copy (see `reach` below).

## The reference and its ladder

A reference is a price point of role `reference` with a sample size. The
eBay plugin builds one per region and condition from the cheapest
fixed-price listings of a query: listings graded fair or poor are dropped,
the values outside the sample's P10–P90 band are trimmed (no trim under 5
values), and the median of what remains is stored with the untrimmed count
as its sample size. A 50-listing sample yields a median over 40 values and
reports "(50 listings)".

A reference counts only when its sample reaches `SIGNAL_MIN_SAMPLE` (default
5). For a comparison at a given condition the engine climbs a ladder and
takes the first rung whose sample meets the floor, not the first rung that
exists:

1. the exact region and condition;
2. the exact region, undeclared condition;
3. undeclared region, the exact condition;
4. undeclared region, undeclared condition.

There is no other cross-region or cross-condition borrowing. Any rung past
the first adds a caveat, "market median from listings with undeclared
condition" or "... undeclared region", and the signal's confidence drops
from `high` to `potential`. The reasoning names the rung: "£32 (8 listings,
undeclared condition)".

Worked example, a PAL Game Gear title. A shop quotes £28 for the cib copy. The
PAL-labelled marketplace medians are too thin to be a market (1 and 2 listings);
the undeclared-region medians are real (£4.19 over 18 listings, £4.35 over
12). Rung 2 exists but holds 1 listing, so the cib comparison descends to
rung 4 and fires OVERPRICED_STORE as `potential` with both caveats; the
loose comparison settles on rung 3 with the region caveat only. Had the
engine stopped at the first present rung, the game would have reported
INSUFFICIENT_DATA with a £28 price sitting against a £4 market.

## The signal types

Every threshold lives in Settings → Barks (Signals) (see "Tuning the thresholds"). A
factor rule fires only on a strict inequality: a bid at exactly
`reference × 1.15` is silent.

| Type | Rule | Setting (default) | Appears on |
|---|---|---|---|
| UNDERPRICED | listing or store price `< reference × factor`; or listing `< another source's store price × factor` | underpriced factor (0.7), cheaper-than-a-shop factor (0.85) | game view, watchlist |
| FLIP | bid `> acquisition proxy × factor` | flip margin (1.15) | game view, watchlist, collection |
| OVERPRICED_STORE | store price `> reference × factor` | overpriced factor (1.3) | game view, watchlist, collection |
| PROFIT | net sell-side reading `> paid price × factor` | profit margin (1.15) | collection |
| TARGET_HIT | a listing or store price at or under the watch's target | the watch's target | game view, watchlist |
| PRICE_DROP | a store price, or a median, fell by the percentage against the same source, condition (and grade) N days ago | 15 % over 7 days | game view, watchlist |
| NEW_LOW | the cheapest purchasable price per source and condition is under the lowest of the window | 90 days | game view, watchlist |
| BACK_IN_STOCK | a store box out of stock in the previous batch is on offer now | — | game view, watchlist |
| RISING | an owned copy's market reference rose by the percentage over N days, on the same ladder rung at both ends | 20 % over 30 days | collection |
| INSUFFICIENT_DATA | a store price or bid wanted a comparison, none could run, no market signal fired | minimum listings for a median (5) | game view, watchlist, collection |

Comparisons over time (PRICE_DROP, NEW_LOW, RISING) use the quoted amounts
when both ends share a currency and the frozen USD twins otherwise, so an FX
move on an unchanged price is never read as a change. TARGET_HIT is always
high confidence: the user set the bar. NEW_LOW is potential with less than
30 days of history; RISING inherits the reference ladder's caveats.

Each positive signal carries `edgePct`, its relative advantage in percent:
the discount under the reference or the shop, the flip or profit margin, the
drop, the rise.

### UNDERPRICED

Two rules, both meaning "this is cheaper than it should be".

The reference rule compares any purchasable price, a listing or a store
price, with the reference for its condition: a £19 loose listing against a
£30 median (9 listings) fires, since 19 < 30 × 0.7 = 21, and a £28 listing
in the same set does not. A store selling under the market fires the same
way: a shop at £18 against a £30 median reads "<shop> sells £18 vs
<marketplace> median (active) £30 (8 listings) — below market, buy at <shop>". A store does not
fire while a listing from another source, of the same condition (and of the
store's grade, when the store price is graded), costs less: then the store is
not below the market, the median is above it. That happens with a thin median
of inflated asks, such as a shop at £42 against a three-listing £99.99 median
beside a complete copy listed at £31.90. The signal carries the listing's URL
when the source provides one.

The pairwise rule needs no reference. A listing that undercuts another
source's store price for the same condition fires: a listing at £38 against a
shop selling at £60 fires because 38 < 60 × 0.85 = 51, with the reasoning
"cheaper than buying at <shop>". Condition matching is strict here
(an undeclared-condition listing is never compared with a cib store price),
a store never undercuts itself, and a listing that already fired against the
reference gets no second badge from the pairwise rule.

### FLIP

A bid beats the cost of acquiring the copy. The acquisition proxy is the
lower of the reference and the cheapest listing of the same condition; when
only one exists, that one. A source cannot flip into itself: a bid is never
compared with its own source's price.

A £40 voucher for a loose copy against a £30 median (8 listings) fires, 40 >
30 × 1.15 = 34.5, and reads "<shop> pays voucher £40 vs <marketplace> median
(active) £30 (8 listings) — buy at <marketplace>, sell to <shop>". A £34.50 voucher is
silent. The signal's `price` is the acquisition cost, what you would spend;
the bid is quoted in the sentence. A cash bid fires its own FLIP, separate
from the voucher one.

A comparison resolved through the listing proxy counts as resolved: a bid
under the bar is silence, not INSUFFICIENT_DATA. Only a bid with neither a
reference nor a same-condition listing leaves the comparison unresolved.

### OVERPRICED_STORE

A store's posted price sits over the market: a shop selling at £45 against a
£32 median (12 listings) fires, 45 > 32 × 1.3 = 41.6, and reads "PAL/cib:
<shop> sells £45 vs <marketplace> median (active) £32 (12 listings) — don't
buy at <shop>". The signal carries the store's price and no URL, because a store price
is an aggregate of that store's offers, not one listing.

### PROFIT

Only an owned copy with a complete paid price (amount, currency and USD
twin) can earn a PROFIT; the game view and the watchlist never carry the
acquisition context, so the rule is inert there. The engine collects the
best net sell-side reading per source and instrument for the copy's own
condition, then fires one PROFIT per reading that clears `paid × 1.15`:

- a bid is what the source pays you, already net of any fee. A £44 voucher
  against £18 paid fires with a gain of £26 and reads "<shop> pays voucher
  £44 vs paid £18 — trade in at <shop>". A £48 voucher and a £34 cash bid
  both qualifying emit two PROFITs, one per instrument, so a store-credit
  gain never hides the cash gain.
- a reference is what copies are listed for, so it is netted by the source's
  declared `sellFeeRate` before the threshold. A marketplace declaring 0.13: a £32
  median (11 listings) nets ≈£27.84, above the £20.70 bar for £18 paid, gain
  £9.84, and reads "<marketplace> median (active) £32 (11 listings) → ≈£27.84
  after fees vs paid £18 — sell on <marketplace>". A reading that clears the bar
  gross but not net stays silent. A source with no fee rate is read gross.

A reference-based PROFIT is always `potential`, with the shared caveat
`PROFIT_FEE_CAVEAT`: "listing price, not a sale; fees estimated". The web
recognises a fee-netted reading by that exact text. A bid-based PROFIT is
`high` unless a dimension or grade caveat applies. The signal carries the
net reading as its `price`, the instrument as `sellKind`, and the gain in
USD rounded to cents as `gainUsd`.

A bid for another completeness tier never speaks for the copy: a loose
payout is not a cib copy's reading, and the reference is looked up for the
copy's own condition only, through the ladder above.

### INSUFFICIENT_DATA

Only store prices and bids "want" a comparison. When one of them found no
usable reference (none at all, or every rung under the sample floor) and no
market signal fired for the region, the engine emits one INSUFFICIENT_DATA:
"PAL: not enough reference listings to compare against (need 5+ per
group)". A fired UNDERPRICED, FLIP or OVERPRICED_STORE proves the market was
comparable and silences it. Listings never want a comparison, so a region
with only listings and no reference stays quiet.

PROFIT does not silence it: a profit compares the copy with its paid price,
not with the market. A copy with a £44 voucher, £18 paid and no reference
reports both PROFIT and INSUFFICIENT_DATA. The signal carries no confidence,
no caveats, no source and no price.

## Honesty gates

Every gate refuses a point before the rules run, or adds a caveat that turns
the signal `potential`. A caveat never changes whether a rule fires.

- Availability. A buy-role point whose source reported it unavailable is
  refused: an out-of-stock store price never fires OVERPRICED_STORE or
  UNDERPRICED, and never anchors the pairwise rule. An unknown flag counts
  as available. Bids are not gated, since a store that buys an out-of-stock
  item still pays for it: the same out-of-stock SKU's cash and voucher bids
  still feed FLIP.
- Zero. A price of 0 is storable but never comparable; every rule is a
  ratio and 0 would win all of them.
- Damage. A listing graded fair or poor is never a bargain candidate. The
  cheap faulty cart is dropped; the cheap working one still fires.
- Grade, "only value mints with mints". A graded store price compared with a
  side of no grade guarantee is `potential` ("store price is for a mint copy
  — compared side's grade unverified"). A graded bid against an acquisition
  side that cannot guarantee that grade is `potential` ("requires a mint
  copy — listing grades unverified"); a mint bid against a mint-graded
  listing stays `high`, and so does a mint bid for an owned copy recorded as
  mint. On the collection a copy of a given grade admits only points of that
  grade or no grade.
- Completeness tiers are strict. `boxed_no_manual` is its own condition,
  never merged with `cib`. A boxed-no-manual store price with only a cib
  reference reports INSUFFICIENT_DATA rather than borrowing the richer tier;
  the undeclared-condition rung still serves it, labelled.
- Undeclared dimensions. A compared point of undeclared condition, or a
  region-`unknown` slice, adds "listing condition not declared", "bid region
  not declared" and the like.
- Currency of the reasoning. The threshold math runs on the frozen USD twins,
  since ratios are currency-invariant. The sentence quotes the verbatim
  original amounts when both sides share a currency ("£45 vs £32") and
  both sides in USD when they do not (a copy paid in EUR against a GBP bid).
  An amount is never converted for the sake of the sentence.
- Reach, for owned copies. A source declares how far its prices carry.
  `local` means a shelf price for exactly the region and completeness it
  lists, so only points of the copy's exact region and condition may enter
  its slice. `global` means a marketplace that sells anywhere, so points of
  undeclared region or condition may also enter and reach the copy through
  the labelled ladder as `potential`. A source without a declaration is held
  to `local`. Reach says something about the market, not about data quality.
- Unconfirmed match. A copy linked to a game by an unconfirmed candidate
  match has every signal forced to `potential` with the caveat "match not
  confirmed — review the link".

## How the app presents a signal

Each signal carries a reasoning sentence, its confidence, its caveats, the
amount it is about (USD plus the verbatim original) and the sources involved:
`source` for a single-source finding, `buySource` and `sellSource` for a
flip, `sellSource` and `sellKind` for a profit. The screens read those
fields, never the sentence.

The reasoning sentence always starts with the region and condition, quotes
the two compared amounts in the currency the comparison happened in, names
the sample size and any fallback rung when a reference is involved, and ends
with the action:
"buy at", "sell to", "trade in at", "sell on", "don't buy at".

The confidence marker reads "✔ high confidence" or "❓ potential". A
potential badge renders dashed and lists its caveats under "why potential:".
INSUFFICIENT_DATA has no marker.

Only high-confidence signals are shown by default. Potential ones are
counted and folded: "N possible signals with incomplete data" on the game
view, "+N possible" beside a row's pills. Counters and the "only barking"
filter count high signals only.

Each game leads with one verdict, the same on every screen
(`pickVerdict` in `packages/shared`): a high TARGET_HIT first; else the high
positive signal with the largest `edgePct`; else a high OVERPRICED_STORE as
"Nothing to buy here"; else "Nothing clear today". The verdict's title quotes
the amount as the source quoted it ("Buy on <marketplace> for £31.90"), its line is
the signal's reasoning, and its action is the listing link when there is one.

The compact pill is a direction tag built from the structured fields, with the
source's own label in place of the placeholders: "🛒 buy @ <source>",
"⚠ overpriced @ <shop>", "⇄ buy <source> → sell <shop>", "💰 sell @ <shop>
voucher (+$26.00)", "🎯 target @ <source>", "↓ price drop @ <shop>", "↓ 90-day
low @ <source>", "↺ in stock @ <shop>", "↑ rising @ <source>". INSUFFICIENT_DATA has no
pill. Each list surface has its own allow-list, and the two are never merged:

| Surface | Pills shown | Why the others are absent |
|---|---|---|
| watchlist rows | UNDERPRICED, FLIP, OVERPRICED_STORE, TARGET_HIT, PRICE_DROP, NEW_LOW, BACK_IN_STOCK | a watch is not a copy: no PROFIT, no RISING |
| collection rows | FLIP, OVERPRICED_STORE, PROFIT, RISING | a cheap listing is not an alert about a copy you own |

Pills with the same label are shown once.

The game view shows the verdict under "Watchdog barks", then the other high
signals in sections by transaction direction: "Target hit", "Buy now"
(UNDERPRICED), "Buy to sell" (FLIP), "Price drops", "New lows", "Back in
stock" and "Sell now" (OVERPRICED_STORE). Sections group their findings per
source: one collapsible row per source, headed by the source name, the count
and its best amount (the cheapest buy, the highest ask). FLIP has no single
source to group by and renders as one flat list. The potential signals sit in
the same sections inside the fold. INSUFFICIENT_DATA shows only when no other
signal exists. PROFIT and RISING do not bark on the game view; they belong to
owned copies.

## Notifications

With `NTFY_TOPIC` set, the worker sends a notification through ntfy
(`NTFY_URL`, default `https://ntfy.sh`) after each scheduled refresh of the
watchlist, reading the signals from `GET /api/watchlist` itself so an alert
never says something the screen does not show. Unset, notifications are off.

Only actionable types notify: UNDERPRICED, FLIP, PROFIT, TARGET_HIT,
PRICE_DROP, NEW_LOW and BACK_IN_STOCK (the watchlist carries no owned copy,
so PROFIT and RISING never reach it). OVERPRICED_STORE and INSUFFICIENT_DATA
never notify. Only high-confidence signals notify, unless "Send
low-confidence alerts" is on in Settings → Barks (Signals).

A signal notifies once. Its identity is the watch, the type, the sources
(`source`, `buySource`, `sellSource`), the instrument (`sellKind`) and the
listing URL; the price is excluded, so a penny move is not news, while a new
cheaper listing is a new URL and does notify. The title is the game's title
plus the type in lowercase, the message is the reasoning sentence, and a tap
opens the listing URL when the signal has one.

Each run sends at most 5 new signals, then one summary, "N more new signals
on your watchlist", and records all of them as sent. The first run after
enabling finds every standing signal new, so expect that summary once. A
signal that disappears is forgotten; if it comes back, it notifies again.
The worker sends before it records, so a crash between the two duplicates an
alert rather than losing it.

## Tuning the thresholds

Goal: change when a signal fires without touching code. Settings → Barks (Signals)
holds every threshold, the switches for each signal type, the sources allowed
to raise signals, a minimum gain for FLIP and PROFIT, and whether
low-confidence signals notify. It is stored in `app_settings` under
`signal_config` (`GET`/`PUT /api/settings/signals`, `POST …/reset`).

The six factors start from the `SIGNAL_*` variables in `.env`, so an existing
deployment keeps its behaviour until someone saves the page; after that the
stored values win and the variables only matter again after a reset.

| Setting | Default | Raising it | Lowering it |
|---|---|---|---|
| Underpriced below × median | 0.7 | more listings and store prices count as bargains | only steeper discounts fire |
| Cheaper than a shop × | 0.85 | a listing needs less of a gap under a store price | pairwise bargains need a bigger gap |
| Overpriced above × median | 1.3 | a store must be further over the market to be flagged | more stores are flagged |
| Flip margin × | 1.15 | a flip needs a wider spread | thinner spreads flip; fees eat more of them |
| Profit margin × | 1.15 | a copy must fetch more over its paid price | smaller gains count |
| Minimum listings for a median | 5 | thin references are ignored; more INSUFFICIENT_DATA, more ladder fallbacks | thin medians pass as a market |
| Price drop % / over days | 15 / 7 | only sharper or slower drops fire | smaller moves fire |
| New low window (days) | 90 | a low must hold over a longer history | lows come easier |
| Rising % / over days | 20 / 30 | only stronger rises fire | smaller rises fire |

1. Open Settings → Barks (Signals) and change a value. The line under the form
   previews what the draft would do to the watchlist ("With these values, 4 of
   23 watches have a signal — e.g. …") without saving anything.
2. Save. The API and the worker read the stored configuration within a
   minute; signals are recomputed from stored prices on every request.
3. Open a game whose prices you know and read the reasoning sentence: it
   quotes both compared amounts and the sample size, so the inequality can be
   checked by hand.
4. If notifications are on, expect the next refresh to report every signal
   the new values create as new, subject to the 5-per-run cap.

## How often a signal held

The worker logs every distinct signal it sees on a watch or an owned copy in
`signal_log`, one row per appearance: the same signal seen again within
`evalDays` (14) of its first sighting only moves `last_seen_at`; seen later,
it is a new row. `evalDays` after it first appeared, the signal is judged
against the newest prices fetched since then:

- **held**: the advice stood. A buy signal was not undercut by `beatenPct`
  (5) % on the same source; a PROFIT or RISING was not overtaken by 5 % on the
  same source and kind; a FLIP's bid still covers the buy price × flip
  margin; an overpriced store is still over the reference × factor.
- **beaten**: something better came along.
- **unknown**: no price for that slice and source was fetched after the
  signal, so there is nothing to judge it by.

`GET /api/insights` returns the table per signal type and per source. A held
rate is stated only from 10 judged (held or beaten) signals; unknown ones do
not count towards it. Rows older than `logRetentionDays` (365) are deleted.

eBay and Vinted prices are asking prices, not sales: held means the price was
not beaten, not that you could have bought at it.
