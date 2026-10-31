/**
 * In-memory Postgres (PGlite) with the parts of Supabase that Vtology relies on, for tests and the
 * local demo mode. Never used on Vercel: the module is only loaded when explicitly asked for.
 */
import { USER_CONTEXT_SQL, type Db, type Sql } from './db';
import { ensureSchema } from './schema';

// What Supabase provides out of the box, recreated locally.
export const SUPABASE_SHIM = `
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

type PgLike = { query: (q: string, p?: unknown[]) => Promise<{ rows: unknown[] }>; exec: (q: string) => Promise<unknown> };

export async function createPgliteDb(opts: { migrate?: boolean } = {}): Promise<{ db: Db; pg: unknown }> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.exec(SUPABASE_SHIM);
  const wrap = (q: PgLike): Sql => ({
    query: async (text, params = []) => (await q.query(text, params)).rows as never,
    exec: async text => { await q.exec(text); },
  });
  const db: Db = {
    admin: wrap(pg as never),
    transaction: fn => pg.transaction(tx => fn(wrap(tx as never))),
    asUser: (userId, fn) =>
      pg.transaction(async tx => {
        const [q, p] = USER_CONTEXT_SQL(userId);
        await tx.query(q, [...p]);
        await tx.query('set local role authenticated');
        return fn(wrap(tx as never));
      }),
  };
  if (opts.migrate !== false) await ensureSchema(db);
  return { db, pg };
}
