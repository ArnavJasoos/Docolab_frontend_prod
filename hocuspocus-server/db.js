// hocuspocus-server/db.js
// Thin PostgreSQL connection pool. Reads DATABASE_URL from .env (same as FastAPI).
//
// The pool is created lazily and can be replaced via setPool() so tests can
// inject an in-memory engine (pg-mem) without a live database. Production
// behaviour is unchanged: the first query() builds the real pg Pool.

import pg from "pg";

const { Pool } = pg;

let pool = null;

// Managed Postgres (Supabase/Neon/RDS) requires TLS; local Postgres does not.
// Enable SSL only for a remote host so local behaviour is unchanged.
function needsSsl(connectionString) {
  try {
    const host = new URL(connectionString).hostname;
    return !["localhost", "127.0.0.1", "::1", ""].includes(host);
  } catch {
    return false; // unparseable → treat as local (no SSL)
  }
}

function getPool() {
  if (!pool) {
    const connectionString =
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/docplatform";
    pool = new Pool({
      connectionString,
      // rejectUnauthorized:false = encrypt without CA verification (demo-grade,
      // mirrors the backend). Swap for a CA bundle to verify certs in prod.
      ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : false,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on("error", (err) => {
      console.error("[db] Unexpected pool error:", err.message);
    });
  }
  return pool;
}

/** Replace the pool (tests inject pg-mem here). Pass null to reset. */
export function setPool(injected) {
  pool = injected;
}

export async function query(sql, params = []) {
  const client = await getPool().connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

export default { getPool, setPool, query };
