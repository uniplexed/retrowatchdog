import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./index.js";
import { config } from "../config.js";

const url = process.argv[2] ?? config.DATABASE_URL;
const { db, pool } = createDb(url);
// fileURLToPath, NEVER URL.pathname: on Windows .pathname yields "/D:/..."
// which fs resolves to "D:\D:\..." (ENOENT)
await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
await pool.end();
console.log("migrations applied to", url.replace(/:[^:@/]+@/, ":***@"));
