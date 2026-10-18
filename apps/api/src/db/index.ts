import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

export function createDb(url: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: url });
  return { db: drizzle(pool, { schema }), pool };
}

let defaultDb: { db: Db; pool: pg.Pool } | null = null;

export function getDb(): { db: Db; pool: pg.Pool } {
  defaultDb ??= createDb(config.DATABASE_URL);
  return defaultDb;
}
