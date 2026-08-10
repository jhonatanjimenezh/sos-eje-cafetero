import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const root = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(root, '../migrations');
await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`);
const files = (await fs.readdir(dir)).filter(f => f.endsWith('.sql')).sort();
for (const filename of files) {
  const exists = await pool.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [filename]);
  if (exists.rowCount) continue;
  const sql = await fs.readFile(path.join(dir, filename), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations(filename) VALUES($1)', [filename]);
    await client.query('COMMIT');
    console.log(`applied ${filename}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
await pool.end();
console.log('database migrated');
