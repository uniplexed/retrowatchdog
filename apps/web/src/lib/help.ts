import type { RecommendationAction, SignalType } from "@retrowatchdog/shared";
import { SIGNAL_TYPE_INFO } from "./signalTypes.js";

/** One title's explanation: what it shows or does, and one concrete case. */
export interface HelpEntry {
  /** the title as the screen shows it, for the button's accessible name */
  name: string;
  what: string;
  example: string;
}

const ACTION_HELP: Record<RecommendationAction, HelpEntry> = {
  sell_now: {
    name: "Sell now",
    what: "A shop pays the most it has in months for a copy you own, and it covers what you paid with margin.",
    example: "CeX UK pays £38, the most in 90 days; you paid £18.",
  },
  buy_now: {
    name: "Buy now",
    what: "A watched game is at its lowest price in months, or well under its average.",
    example: "OutRun on eBay UK for £21.50, the lowest in 90 days.",
  },
  raise_target: {
    name: "Raise target",
    what: "Your target price was never met, but the market came close: a little more would catch it.",
    example: "your £25 target was never met in 180 days; the low was £28.",
  },
  lower_target: {
    name: "Lower target",
    what: "The price sits under your target most days, so the target filters nothing.",
    example: "the price was under your £25 target on 66% of 100 days.",
  },
  unwatch: {
    name: "Stop watching",
    what: "A watch with no bark (signal) and no real price move for months.",
    example: "no bark (signal) and no move over 5% in 120 days.",
  },
  review_copy: {
    name: "Check a copy",
    what: "A copy no source can price: its match or its region and condition may be wrong.",
    example: "no source has a price for your NTSC-J loose copy.",
  },
  prefer_source: {
    name: "Best source",
    what: "On one console, one shop is usually the cheapest, or the one that pays the most.",
    example: "on Game Boy, CeX UK paid the most in 9 of 12 games.",
  },
  review_thresholds: {
    name: "Review thresholds",
    what: "A bark (signal) type that is often wrong: its thresholds may be too loose.",
    example: "only 30% of 10 underpriced barks (signals) held their price.",
  },
};

export const HELP = {
  // pages
  "page.dashboard": {
    name: "Dashboard",
    what: "Your collection's numbers and what to act on first.",
    example: "collection value $607.69 and 'Buy OutRun on eBay UK for £21.50' at the top.",
  },
  "page.insights": {
    name: "Insights",
    what: "Every recommendation by kind, how often barks (signals) were right, and the price histories.",
    example: "'Buy now (6)' and 'Underpriced: 72% of 40 held'.",
  },
  "page.search": {
    name: "Search",
    what: "Find a game to see its prices, barks (signals) and your copies.",
    example: "type 'outrun' and open OutRun for the Master System.",
  },
  "page.watchlist": {
    name: "Watchlist",
    what: "The games you follow, each for one region and condition or any.",
    example: "OutRun · any · cib only looks at boxed, complete copies.",
  },
  "page.collection": {
    name: "Collection",
    what: "The copies you own, what each is worth now and what you made selling.",
    example: "Shenmue PAL cib, paid £18, valued £38 today.",
  },
  "page.settings": {
    name: "Settings",
    what: "How prices are read, judged and shown.",
    example: "switch eBay US off, or show every price in EUR.",
  },
  // dashboard
  "kpi.value": {
    name: "Collection value",
    what: "What your copies still in hand are worth today, on the valuation basis you chose.",
    example: "58 copies valued from marketplace medians and shop prices: $607.69.",
  },
  "kpi.paid": {
    name: "Paid",
    what: "What you paid for the copies you still have.",
    example: "£18 for Shenmue plus every other copy in hand.",
  },
  "kpi.realized": {
    name: "Realized",
    what: "Profit or loss on the copies you sold, after fees.",
    example: "paid £20, sold for £40 with £4 fees: +£16.",
  },
  "kpi.signals": {
    name: "Barks (Signals)",
    what: "Watches with at least one high-confidence bark (signal) right now.",
    example: "3 of 23 watches have a good price today.",
  },
  "panel.recommended": {
    name: "Recommended actions",
    what: "What to do, judged on months of prices and what you paid; then today's good prices not already covered.",
    example: "'Buy OutRun on eBay UK for £21.50 — the lowest in 90 days'.",
  },
  "fold.possible": {
    name: "possible",
    what: "Recommendations built on thin or fallback data: worth a look, not a sure thing.",
    example: "a 'lowest in 90 days' backed by only 13 days of prices.",
  },
  "fold.cleanUp": {
    name: "Clean up",
    what: "Watches that never move and copies no source can price.",
    example: "'Stop watching Tetris? No bark (signal) and no move over 5% in 120 days'.",
  },
  "fold.sources": {
    name: "Best sources",
    what: "Which shop is usually cheapest, or pays the most, on each console.",
    example: "'On Game Boy, CeX UK paid the most in 9 of 12 games'.",
  },
  "panel.needsYou": {
    name: "Needs you",
    what: "Things only you can fix, each opening the place that fixes it.",
    example: "'7 copies need a match check' opens the review list.",
  },
  "game.history": {
    name: "Price history",
    what: "This game's prices over the period chosen above it, one line per source, for one region and condition. Drag on the chart or its slider to zoom; the corner icon saves it as an image.",
    example: "a shop sells PAL cib at £38, +6% since 18 September.",
  },
  "history.value": {
    name: "Value history",
    what: "Your collection's estimated value and what you paid, day by day.",
    example: "$480 on 10 September, $517 today.",
  },
  "history.watchlist": {
    name: "Watchlist price history",
    what: "The cheapest price of every watch added up, per day, with how many watches had a price.",
    example: "$310 on 18 October, 21 of 23 watches priced.",
  },
  // insights
  "panel.reliability": {
    name: "Barks (Signals) reliability",
    what: "How often a bark's (signal's) advice still stood 14 days after it appeared.",
    example: "Underpriced: 30 of 40 held — no cheaper price turned up.",
  },
  // game page
  "game.signalsFor": {
    name: "Barks (Signals) for",
    what: "What this page's barks (signals) are judged for: any state, one of your watches, or one of your copies.",
    example: "'Watch · any · cib' judges only boxed, complete prices.",
  },
  "game.barks": {
    name: "Watchdog barks",
    what: "This game's barks (signals), the best one first, each with the prices it compared.",
    example: "'Buy at Marketplace A for £21.50' — £21.50 vs Shop B selling it for £32.",
  },
  "game.possibleSignals": {
    name: "with incomplete data",
    what: "Barks (signals) built on listings that leave something out, such as the condition.",
    example: "a £9 listing whose title never says boxed or loose.",
  },
  "game.copies": {
    name: "Your copies",
    what: "Your copies of this game and what each is worth now.",
    example: "PAL cib, paid £18; a shop pays voucher £38.",
  },
  "price.toBuy": {
    name: "To buy",
    what: "Prices you can buy at, cheapest first.",
    example: "a marketplace listing at £21.50, a shop selling one for £32.",
  },
  "price.outOfStock": {
    name: "Out of stock",
    what: "Shop prices for boxes that are sold out right now.",
    example: "CeX UK lists it at £30 with none in stock.",
  },
  "price.shopsPay": {
    name: "Shops pay you",
    what: "What shops pay you for a copy, in cash or voucher.",
    example: "CeX UK pays £12 cash or £18 in voucher.",
  },
  "price.other": {
    name: "Other prices",
    what: "Prices that are neither something to buy nor a payout, such as price guides.",
    example: "a guide price of £25 for a loose cart.",
  },
  // search
  "search.recent": {
    name: "Recent",
    what: "Games you opened lately, with the verdict they had then.",
    example: "OutRun — Buy on eBay UK for £21.50.",
  },
  // settings
  "settings.appearance": {
    name: "Appearance",
    what: "The theme and the currency prices are shown in.",
    example: "dark theme with every price shown in GBP.",
  },
  "settings.signals": {
    name: "Barks (Signals)",
    what: "When each bark (signal) fires, how strict it is, and what reaches your phone.",
    example: "Underpriced below 0.7 × the median: £21 on a £30 median.",
  },
  "settings.valuation": {
    name: "Valuation",
    what: "How a copy's value is worked out, and which markets may value it.",
    example: "market uses a marketplace median; trade-in uses what a shop pays.",
  },
  "settings.markets": {
    name: "Markets",
    what: "Which shops and marketplaces are read for prices.",
    example: "eBay UK on, eBay US off.",
  },
  "settings.currencies": {
    name: "Currencies",
    what: "Which currencies the menus offer, and the exchange rate each uses.",
    example: "add MXN, or set GBP by hand to 0.80 per dollar.",
  },
  "settings.plugins": {
    name: "Plugins",
    what: "The price sources installed, and what each one is allowed to do.",
    example: "the CeX plugin, approved and paced at one request every 10 s.",
  },
  "settings.collectionValue": {
    name: "Collection value",
    what: "Which price sets a copy's value; a copy without that price uses the next one in the list.",
    example: "market: the eBay median of PAL cib listings, £30.",
  },
  "settings.valuationMarkets": {
    name: "Valuation markets",
    what: "Which countries' markets may set your copies' value. Barks (signals) still read every market.",
    example: "United Kingdom only: an eBay US price never values a UK copy.",
  },
  "settings.rates": {
    name: "Exchange rates",
    what: "The rate from USD to each currency: the daily one, or one you set by hand. Saved amounts never change.",
    example: "GBP at 0.7499 from the daily rate, or 0.80 set by hand.",
  },
  "signals.types": {
    name: "Types",
    what: "Switch each kind of bark (signal) on or off.",
    example: "turn Rising off to stop hearing about copies whose market went up.",
  },
  "signals.thresholds": {
    name: "Thresholds",
    what: "How far a price must be from the market to count as a bark (signal).",
    example: "Underpriced below 0.7 × the median: £21 or less on a £30 median.",
  },
  "signals.scope": {
    name: "Scope",
    what: "A minimum gain, which sources may raise barks (signals), and which alerts reach your phone.",
    example: "ignore flips worth less than £5.",
  },
  "signals.recommendations": {
    name: "Recommendations",
    what: "When each recommendation fires. Recommended is the default; From your data is worked out from your own prices.",
    example: "Buy: lowest price in 90 days.",
  },
  ...Object.fromEntries(Object.entries(ACTION_HELP).map(([k, v]) => [`action.${k}`, v])),
  ...Object.fromEntries(
    Object.entries(SIGNAL_TYPE_INFO).map(([k, v]) => [`signal.${k}`, { name: v.label, what: v.help, example: v.example }]),
  ),
} satisfies Record<string, HelpEntry>;

export type HelpTopic = keyof typeof HELP;

/** the topic for a signal type */
export const signalTopic = (type: SignalType): HelpTopic => `signal.${type}` as HelpTopic;

/** the topic for a recommendation action's group */
export const actionTopic = (action: RecommendationAction): HelpTopic => `action.${action}` as HelpTopic;
