import pg from "pg";
import { getConfig } from "../config.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const cfg = getConfig();
    pool = new Pool({
      connectionString: cfg.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000
    });
    pool.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("Unexpected PostgreSQL pool error", err);
    });
  }
  return pool;
}

/** Executor abstraction so services can run inside a transaction client. */
export type DbExecutor = <T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
) => Promise<pg.QueryResult<T>>;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

/** Wrap a PoolClient so it satisfies DbExecutor. */
export function clientExecutor(client: pg.PoolClient): DbExecutor {
  return (async (text: string, params?: unknown[]) =>
    (await client.query(text, params)) as pg.QueryResult<pg.QueryResultRow>) as DbExecutor;
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
