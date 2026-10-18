import type { FastifyInstance } from "fastify";
import type { SourcesResponse } from "@retrowatchdog/shared";

export async function sourceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Every approved plugin source, in registry order. The web holds no copy of
   * any manifest and reads labels and roles only from here; without
   * `kindRoles` the game view hides its price tables and shows a retry.
   *
   * Rebuilt before answering because `configured` comes from
   * `plugins.last_health`, which the worker writes on its own tick. Read
   * `app.deps` only after the rebuild: `deps.sources` is replaced, not mutated.
   */
  app.get("/api/sources", async (): Promise<SourcesResponse> => {
    await app.deps.reloadSources();
    return { sources: app.deps.sources.sources };
  });
}
