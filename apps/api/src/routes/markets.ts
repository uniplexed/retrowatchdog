import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MarketDto, MarketSettingsResponse, SourceId } from "@retrowatchdog/shared";
import { loadEnabledSources, saveEnabledSources } from "../settings/markets.js";
import type { SourceRegistry } from "../sources/registry.js";

/**
 * Every source in registry order, with whether it can answer (the plugin's
 * approval and last health reading). The family's heading comes from
 * GET /api/sources (`familyHeading` in SettingsScreen.tsx), not from here.
 */
function availableMarkets(sources: SourceRegistry): MarketDto[] {
  return sources.sources.map((info) => ({
    source: info.id,
    label: info.label,
    family: info.family,
    country: info.country,
    configured: info.configured,
  }));
}

const bodySchema = z.object({ enabled: z.array(z.string()) }).strict();

export async function marketRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings/markets", async (): Promise<MarketSettingsResponse> => {
    // Rebuilt before answering: `configured` comes from plugins.last_health,
    // which the WORKER writes, so a cached registry would keep refusing a
    // plugin the user just fixed. Cheap (one SELECT, no network); pacing
    // state lives in `PluginPacingStore` and survives the rebuild.
    await app.deps.reloadSources();
    // Destructured AFTER the rebuild: `reloadSources` REPLACES `deps.sources`.
    const { db, sources } = app.deps;
    return {
      // Served as stored, including ids no source answers to (settings/markets.ts).
      enabled: [...(await loadEnabledSources(db))],
      available: availableMarkets(sources),
    };
  });

  app.put("/api/settings/markets", async (req, reply) => {
    const body = bodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid body" });
    // No rebuild: the screen was painted from the registry the GET just rebuilt.
    const { db, sources } = app.deps;

    const requested = new Set(body.data.enabled);
    const stored = await loadEnabledSources(db);
    // Only ids being ADDED are checked. A dead id already stored (a deleted
    // plugin) is accepted and kept: rejecting it would lock the screen, and
    // dropping it would turn "we cannot see it now" into "you turned it off".
    const unknown = [...requested].filter((id) => !sources.has(id) && !stored.has(id));
    if (unknown.length > 0) {
      return reply.code(400).send({ error: `unknown source: ${unknown.join(", ")}` });
    }
    const markets = availableMarkets(sources);
    // Same rule: a stored market that lost its configuration may be carried
    // or removed; only turning an unconfigured one on is refused.
    const unconfigured = markets.filter(
      (m) => requested.has(m.source) && !m.configured && !stored.has(m.source),
    );
    if (unconfigured.length > 0) {
      return reply.code(400).send({
        error: `not configured, cannot be enabled: ${unconfigured.map((m) => m.source).join(", ")}`,
      });
    }
    // Registry order first (stable however the client sent it), then carried
    // unknown ids in stored order; both halves are duplicate-free by construction.
    const enabled: SourceId[] = markets.filter((m) => requested.has(m.source)).map((m) => m.source);
    const carried = [...stored].filter((id) => requested.has(id) && !sources.has(id));
    const saved = [...enabled, ...carried];
    await saveEnabledSources(db, saved);
    const body2: MarketSettingsResponse = { enabled: saved, available: markets };
    return body2;
  });
}
