import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getPool } from "./pool.js";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/** Apply pending SQL migrations in filename order, each inside a transaction. */
export async function runMigrations(): Promise<string[]> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    const { rows } = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
    if (rows.length > 0) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration failed: ${file}`, { cause: err });
    } finally {
      client.release();
    }
    applied.push(file);
    // eslint-disable-next-line no-console
    console.log(`[migrate] applied ${file}`);
  }
  return applied;
}

// Allow direct execution: pnpm db:migrate
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then((applied) => {
      // eslint-disable-next-line no-console
      console.log(`[migrate] done (${applied.length} new)`);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[migrate] failed", err);
      process.exit(1);
    });
}
