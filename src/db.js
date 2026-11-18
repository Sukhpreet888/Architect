'use strict';
/**
 * Database access (PostgreSQL). In production this is Supabase Postgres via DATABASE_URL.
 * Without DATABASE_URL (local development / tests) an embedded Postgres (PGlite) is used instead,
 * stored in DATA_DIR/pgdata — the SQL is identical.
 *
 * All helpers are async. SQL uses `?` placeholders, converted to $1..$n.
 * db.tx(fn) runs fn in a transaction; every db.* call made inside it (even in nested functions)
 * uses the transaction's connection (AsyncLocalStorage).
 */
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { config } = require('./config');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const txStore = new AsyncLocalStorage();

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}
function norm(params) {
  return params.map((v) => (v === undefined || v === '' ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
}

// ---------------------------------------------------------------- drivers
let driver;
if (config.databaseUrl) {
  const pg = require('pg');
  pg.types.setTypeParser(20, (v) => Number(v)); // bigint (COUNT/SUM) -> number
  pg.types.setTypeParser(1700, (v) => Number(v)); // numeric -> number
  const ssl = /localhost|127\.0\.0\.1/.test(config.databaseUrl) || /sslmode=disable/.test(config.databaseUrl) ? false : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString: config.databaseUrl, ssl, max: Number(process.env.DB_POOL_SIZE || 10) });
  pool.on('connect', (c) => c.query('SET search_path TO archflow, public'));
  pool.on('error', (e) => console.error('[db] idle client error', e.message));
  driver = {
    name: 'postgres',
    query: (sql, params, client) => (client || pool).query(sql, params),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await txStore.run(client, fn);
        await client.query('COMMIT');
        return r;
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    },
    exec: (sql) => pool.query(sql),
    end: () => pool.end(),
  };
} else {
  const { PGlite } = require('@electric-sql/pglite');
  const dir = process.env.PGLITE_DIR || path.join(config.dataDir, 'pgdata');
  fs.mkdirSync(dir, { recursive: true });
  const parse = (v) => Number(v);
  const lite = new PGlite(dir, { parsers: { 20: parse, 1700: parse } });
  driver = {
    name: 'pglite',
    query: (sql, params, client) => (client || lite).query(sql, params),
    tx: (fn) => lite.transaction((t) => txStore.run(t, fn)),
    exec: (sql) => lite.exec(sql),
    end: () => lite.close(),
  };
}

let readyPromise = null;
/** Create the schema if needed (idempotent). Called once at startup. */
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await driver.exec(SCHEMA);
      if (driver.name === 'pglite') await driver.exec('SET search_path TO archflow, public');
    })();
  }
  return readyPromise;
}

async function q(sql, params = []) {
  await ready();
  const client = txStore.getStore();
  if (process.env.DEBUG_SQL) console.error('[sql]', client ? 'TX' : '  ', sql.replace(/\s+/g, ' ').slice(0, 110));
  const res = await driver.query(toPg(sql), norm(params), client);
  return res;
}

const db = {
  driver: () => driver.name,
  ready,
  async get(sql, ...p) { return (await q(sql, p)).rows[0]; },
  async all(sql, ...p) { return (await q(sql, p)).rows; },
  async run(sql, ...p) {
    const r = await q(sql, p);
    return { changes: r.rowCount ?? r.affectedRows ?? 0, rows: r.rows };
  },
  async insert(table, obj) {
    const keys = Object.keys(obj);
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')}) RETURNING id`;
    return (await db.get(sql, ...keys.map((k) => obj[k]))).id;
  },
  async update(table, id, obj) {
    const keys = Object.keys(obj);
    if (!keys.length) return;
    await db.run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => obj[k]), id);
  },
  async tx(fn) {
    await ready();
    if (txStore.getStore()) return fn();
    return driver.tx(fn);
  },
  /** Run fn outside any surrounding transaction (for background work that outlives the request). */
  outsideTx: (fn) => txStore.exit(fn),
  end: () => driver.end(),
};

module.exports = db;
