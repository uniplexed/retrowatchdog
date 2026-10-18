import { fetch } from "undici"; // MockAgent-interceptable fetch
import { ALL_IGDB_PLATFORM_IDS } from "@retrowatchdog/shared";
import { RateLimiter } from "../lib/rateLimiter.js";
import { config } from "../config.js";

export interface IgdbGame {
  id: number;
  name: string;
  platforms?: number[];
  first_release_date?: number;
  alternative_names?: { name: string }[];
  cover?: { image_id: string };
}

// IGDB game_type enum values kept (main, bundle, standalone expansion, remake,
// remaster, expanded, port); shared with scripts/cleanup-igdb-mods.ts.
export const ALLOWED_GAME_TYPES = [0, 3, 4, 8, 9, 10, 11] as const;

export class IgdbClient {
  private token: { value: string; expiresAt: number } | null = null;
  // stay under IGDB's official 4 req/s
  private readonly limiter = new RateLimiter(250);

  constructor(
    private readonly creds: { clientId: string | undefined; secret: string | undefined },
  ) {}

  isConfigured(): boolean {
    return Boolean(this.creds.clientId && this.creds.secret);
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const params = new URLSearchParams({
      client_id: this.creds.clientId ?? "",
      client_secret: this.creds.secret ?? "",
      grant_type: "client_credentials",
    });
    // in the body, not the URL: a URL ends up in proxy logs and error messages
    const res = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: AbortSignal.timeout(config.ADAPTER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Twitch token HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in - 60) * 1000,
    };
    return this.token.value;
  }

  async searchGames(query: string): Promise<IgdbGame[]> {
    if (!this.isConfigured()) return [];
    const token = await this.getToken();
    // quotes and backslashes would close or escape the Apicalypse string
    const safeQuery = query.replace(/["\\]/g, " ").trim().slice(0, 200);
    const platformIds = ALL_IGDB_PLATFORM_IDS.join(",");
    // Filter on `game_type`, not the documented `category`: verified live,
    // `category` is null on effectively every row. `| game_type = null` keeps
    // unclassified titles.
    const allowedGameTypes = ALLOWED_GAME_TYPES.join(",");
    const body =
      `search "${safeQuery}"; ` +
      `fields name,platforms,first_release_date,alternative_names.name,cover.image_id; ` +
      `where platforms = (${platformIds}) & (game_type = (${allowedGameTypes}) | game_type = null); limit 20;`;
    const res = await this.limiter.schedule(() =>
      fetch("https://api.igdb.com/v4/games", {
        method: "POST",
        headers: {
          "Client-ID": this.creds.clientId ?? "",
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        body,
        // same adapter-timeout convention as the price source adapters (finding 5)
        signal: AbortSignal.timeout(config.ADAPTER_TIMEOUT_MS),
      }),
    );
    if (!res.ok) throw new Error(`IGDB HTTP ${res.status}`);
    return (await res.json()) as IgdbGame[];
  }

  /**
   * id -> game_type, batched at IGDB's 500-id cap. An id IGDB no longer knows
   * is absent from the map: treat "missing" as "unknown", not "excluded".
   */
  async getGameTypes(ids: number[]): Promise<Map<number, number | null>> {
    const result = new Map<number, number | null>();
    if (!this.isConfigured() || ids.length === 0) return result;
    const token = await this.getToken();
    const BATCH_SIZE = 500;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const body = `fields id,game_type; where id = (${batch.join(",")}); limit ${batch.length};`;
      const res = await this.limiter.schedule(() =>
        fetch("https://api.igdb.com/v4/games", {
          method: "POST",
          headers: {
            "Client-ID": this.creds.clientId ?? "",
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          body,
          signal: AbortSignal.timeout(config.ADAPTER_TIMEOUT_MS),
        }),
      );
      if (!res.ok) throw new Error(`IGDB HTTP ${res.status}`);
      const rows = (await res.json()) as Array<{ id: number; game_type?: number }>;
      for (const row of rows) result.set(row.id, row.game_type ?? null);
    }
    return result;
  }
}
