import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const { Pool } = pg;

const dbConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      database: process.env.DB_NAME ?? 'sos',
      user: process.env.DB_USER ?? 'sos',
      password: process.env.DB_PASSWORD,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    };

const pool = new Pool(dbConfig);
const root = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(root, '../migrations');

// ECS/on-prem can start multiple API replicas simultaneously. Hold a dedicated
// PostgreSQL advisory lock for the whole migration run so only one replica can
// evaluate/apply migrations at a time. Session locks are released automatically
// if the process/connection dies.
const MIGRATION_LOCK_ID = 7342042601;
const lockClient = await pool.connect();

try {
  await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
  await lockClient.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  for (const filename of files) {
    const exists = await lockClient.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [filename]);
    if (exists.rowCount) continue;

    const sql = await fs.readFile(path.join(dir, filename), 'utf8');
    try {
      await lockClient.query('BEGIN');
      await lockClient.query(sql);
      await lockClient.query('INSERT INTO schema_migrations(filename) VALUES($1)', [filename]);
      await lockClient.query('COMMIT');
      console.log(`applied ${filename}`);
    } catch (error) {
      await lockClient.query('ROLLBACK');
      throw error;
    }
  }

  await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
} finally {
  lockClient.release();
  await pool.end();
}

console.log('database migrated');
