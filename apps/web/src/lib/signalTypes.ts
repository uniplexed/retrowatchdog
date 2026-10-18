import type { SignalType } from "@retrowatchdog/shared";

/** What each signal type means to a person, with one concrete case: shared by Settings and Insights. */
export const SIGNAL_TYPE_INFO: Record<SignalType, { label: string; help: string; example: string }> = {
  TARGET_HIT: {
    label: "Target hit",
    help: "A price at or under a watch's target.",
    example: "you set £25 for Mario Kart and a copy is listed for £22.",
  },
  UNDERPRICED: {
    label: "Underpriced",
    help: "A price well under the market median.",
    example: "Shenmue listed at £12 when the median of its listings is £30.",
  },
  FLIP: {
    label: "Flip",
    help: "Buy in one place, sell to a shop for more.",
    example: "buy a copy for £15 and a shop gives £22 in voucher for it.",
  },
  PROFIT: {
    label: "Profit",
    help: "A copy you own is worth more than you paid.",
    example: "you paid £18 and a shop now pays £38 cash.",
  },
  PRICE_DROP: {
    label: "Price drop",
    help: "A price fell against the same price days ago.",
    example: "£40 a week ago, £32 today.",
  },
  NEW_LOW: {
    label: "New low",
    help: "The cheapest price in the history window.",
    example: "£19 today, the lowest in 90 days.",
  },
  BACK_IN_STOCK: {
    label: "Back in stock",
    help: "A shop has a box it had sold out.",
    example: "a shop had none last week and has one at £30 now.",
  },
  RISING: {
    label: "Rising",
    help: "The market for a copy you own went up.",
    example: "its median was £30 a month ago and is £38 now.",
  },
  OVERPRICED_STORE: {
    label: "Overpriced",
    help: "A shop asks well over the market.",
    example: "a shop sells it for £45 while the market median is £30.",
  },
  INSUFFICIENT_DATA: {
    label: "Not enough data",
    help: "Too few listings to judge the price.",
    example: "only 3 listings when at least 5 are needed for a median.",
  },
};
