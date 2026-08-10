import { Global, Module } from '@nestjs/common';
import { Pool, PoolConfig } from 'pg';

export const PG_POOL = Symbol('PG_POOL');

export function databaseConfigFromEnv(): PoolConfig {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };

  const ssl = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined;
  return {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME ?? 'sos',
    user: process.env.DB_USER ?? 'sos',
    password: process.env.DB_PASSWORD,
    ssl,
  };
}

@Global()
@Module({
  providers: [{ provide: PG_POOL, useFactory: () => new Pool(databaseConfigFromEnv()) }],
  exports: [PG_POOL],
})
export class DatabaseModule {}
