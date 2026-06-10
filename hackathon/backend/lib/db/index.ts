import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

// Lazy singleton — initialized on first use so module load never crashes
let _db: ReturnType<typeof drizzle> | null = null;
let _rawSql: ReturnType<typeof neon> | null = null;

function init() {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    _rawSql = neon(url);
    _db = drizzle(_rawSql, { schema });
  }
}

export function getDb() {
  init();
  return _db!;
}

export function getRawSql() {
  init();
  return _rawSql!;
}

// Proxy so `import { db }` still works without calling getDb() at module load
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_t, prop) {
    return (getDb() as any)[prop];
  }
});

export * from "./schema";
