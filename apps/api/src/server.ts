import { buildApp } from "./app.js";
import { config } from "./config.js";
import { seedPluginsFromEnv } from "./plugins/seed.js";
import { warmInsights } from "./routes/insights.js";

const app = await buildApp();

// Seeding is a deployment concern, so it runs here, not in buildApp (tests
// would get a row they never created). Order does not matter: a seeded row is
// pending, and only approved plugins contribute sources. A "could not seed"
// warning usually means a second API process won the unique `base_url` insert.
const shipped = {
  vinted: config.VINTED_SIDECAR_PLUGIN_URL,
  cex: config.CEX_PLUGIN_URL,
  ebay: config.EBAY_PLUGIN_URL,
  wallapop: config.WALLAPOP_SIDECAR_PLUGIN_URL,
};
for (const [name, url] of Object.entries(shipped)) {
  try {
    await seedPluginsFromEnv(app.deps.db, url, name);
  } catch (err) {
    app.log.warn({ err, plugin: name }, "could not seed the plugin row");
  }
}

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: "0.0.0.0" });
// the first Insights read should not pay for the cold computation
warmInsights(app.deps, app.log);
