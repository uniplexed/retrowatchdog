// Global FX stub for the whole api suite. With USD as the internal base,
// EVERY live price snapshot converts its source currency to USD, so any test
// driving a live fetch with GBP-priced listings hits Frankfurter. The stub
// answers GBP->USD with rate 1 so all legacy money assertions keep their
// values; conversion CORRECTNESS (non-1 rates, originals preserved) is pinned
// by dedicated tests that install their own MockAgent (and reset the fx
// cache). Tests that need FX to fail also install their own bare agent.
import { MockAgent, setGlobalDispatcher } from "undici";

const agent = new MockAgent();
// real network stays allowed (the gated live-API suites depend on it, same as
// before this stub existed); the frankfurter intercept below still wins for
// the one path it declares. Files that must block the network keep installing
// their own agents with disableNetConnect.
agent.enableNetConnect();
setGlobalDispatcher(agent);
agent
  .get("https://api.frankfurter.app")
  .intercept({ path: "/latest?from=GBP&to=USD", method: "GET" })
  .reply(200, { rates: { USD: 1 } })
  .persist();
