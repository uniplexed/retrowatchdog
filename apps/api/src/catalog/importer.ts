import { sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { games, gameNames } from "../db/schema.js";
import { igdbIdToPlatform } from "./platforms.js";
import type { IgdbClient, IgdbGame } from "./igdb.js";

function coverUrl(game: IgdbGame): string | null {
  return game.cover
    ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${game.cover.image_id}.jpg`
    : null;
}

function releaseYear(game: IgdbGame): number | null {
  return game.first_release_date
    ? new Date(game.first_release_date * 1000).getUTCFullYear()
    : null;
}

/** Upserts IGDB search results into games/game_names. Returns rows upserted. */
export async function importFromIgdb(
  db: Db,
  client: IgdbClient,
  query: string,
): Promise<number> {
  if (!client.isConfigured()) return 0;
  const results = await client.searchGames(query);
  let upserted = 0;
  for (const igdbGame of results) {
    // a Set: DOS and Windows both read as "pc", one row
    const platforms = new Set(
      (igdbGame.platforms ?? []).map(igdbIdToPlatform).filter((p): p is NonNullable<typeof p> => p !== null),
    );
    for (const platform of platforms) {
      const [row] = await db
        .insert(games)
        .values({
          igdbId: igdbGame.id,
          title: igdbGame.name,
          platform,
          year: releaseYear(igdbGame),
          coverUrl: coverUrl(igdbGame),
        })
        .onConflictDoUpdate({
          target: [games.igdbId, games.platform],
          set: { coverUrl: coverUrl(igdbGame), year: releaseYear(igdbGame) },
        })
        .returning({ id: games.id });
      upserted += 1;
      const nameRows = [
        { gameId: row.id, name: igdbGame.name },
        ...(igdbGame.alternative_names ?? []).map((alt) => ({
          gameId: row.id,
          name: alt.name.trim(),
        })),
      ].filter((n) => n.name.length > 0);
      await db.insert(gameNames).values(nameRows).onConflictDoNothing();
    }
  }
  return upserted;
}
