import {resolve} from 'node:path';
import {drizzle} from 'drizzle-orm/node-postgres';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import type {Pool} from 'pg';
import * as schema from './schema';

export function postgresOrm(pool: Pool) {
  return drizzle(pool, {schema});
}

/**
 * Run migrations on one dedicated connection. The session lock also covers
 * creation of Drizzle's migration journal during concurrent server starts.
 */
export async function migratePostgres(pool: Pool) {
  const client = await pool.connect();
  let locked = false;
  let discard = false;
  try {
    await client.query('SELECT pg_advisory_lock(731042025)');
    locked = true;
    await migrate(drizzle(client), {
      migrationsFolder: resolve('lib/db/migrations'),
      migrationsSchema: 'h3_studio_migrations',
    });
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock(731042025)');
      } catch {
        discard = true;
      }
    }
    client.release(discard);
  }
}
