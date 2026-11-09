import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
// Drizzle requires the complete schema object at runtime for typed queries.
// biome-ignore lint/performance/noNamespaceImport: The namespace is passed as Drizzle's schema map.
import * as schema from "./schema";

let instance: ReturnType<typeof drizzle<typeof schema>> | undefined;

// Lazy so `next build` doesn't need DATABASE_URL.
// prepare: false because Supabase's transaction pooler (port 6543) has no prepared statements.
export function db() {
  if (instance) {
    return instance;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  instance = drizzle(postgres(databaseUrl, { prepare: false }), { schema });
  return instance;
}

// Deliberate public database schema surface: callers import table definitions from this module.
// biome-ignore lint/performance/noBarrelFile: This is the single database module boundary.
export * from "./schema";
