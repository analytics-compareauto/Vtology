import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { USER_CONTEXT_SQL, type Db, type Sql } from '../../src/db';

const MIGRATIONS = join(__dirname, '../../../../supabase/migrations');

// What Supabase provides out of the box, recreated for local tests.
const SUPABASE_SHIM = `
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
  $$;
  grant usage on schema auth to authenticated;
  grant execute on function auth.uid() to authenticated;
`;

export async function createTestDb(): Promise<{ db: Db; pg: PGlite }> {
  const pg = new PGlite();
  await pg.exec(SUPABASE_SHIM);
  for (const file of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  const wrap = (q: { query: PGlite['query'] }): Sql => ({
    query: async (text, params = []) => (await q.query(text, params)).rows as never,
  });
  const db: Db = {
    admin: wrap(pg),
    transaction: fn => pg.transaction(tx => fn(wrap(tx as never))),
    asUser: (userId, fn) =>
      pg.transaction(async tx => {
        const [q, p] = USER_CONTEXT_SQL(userId);
        await tx.query(q, [...p]);
        await tx.query('set local role authenticated');
        return fn(wrap(tx as never));
      }),
  };
  return { db, pg };
}
