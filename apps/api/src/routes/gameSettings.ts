import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { games } from "../db/schema.js";

const bodySchema = z.object({ priceMode: z.enum(["live", "cached_only"]).nullable() });
const paramsSchema = z.object({ id: z.coerce.number().int().positive() });

export async function gameSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.patch("/api/games/:id/settings", async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    const body = bodySchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid input" });
    const { db } = app.deps;
    const updated = await db
      .update(games)
      .set({ priceMode: body.data.priceMode })
      .where(eq(games.id, params.data.id))
      .returning({ id: games.id });
    if (updated.length === 0) return reply.code(404).send({ error: "game not found" });
    return reply.code(204).send();
  });
}
