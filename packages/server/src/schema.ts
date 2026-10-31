/**
 * Keeps the database schema up to date. On the first request after a deploy, pending migrations
 * are applied in one transaction under an advisory lock, so two instances never race.
 * Databases set up by pasting setup_all.sql before this existed are recognised and not re-run.
 */
import type { Db } from './db';
import { MIGRATIONS } from './migrations.generated';

/** Migrations that the original setup_all.sql (v0.1) contained. */
const V01 = ['20261031000001_core', '20261031000002_security', '20261031000003_reference_data', '20261031000004_person_links'];

export async function ensureSchema(db: Db): Promise<{ applied: string[] }> {
  return db.transaction(async sql => {
    await sql.query(`select pg_advisory_xact_lock(hashtext('vtology_schema'))`);
    await sql.query(`create schema if not exists vt_meta`);
    await sql.query(`create table if not exists vt_meta.schema_migrations (id text primary key, applied_at timestamptz not null default now())`);
    await sql.query(`revoke all on schema vt_meta from public`);
    let done = new Set((await sql.query<{ id: string }>(`select id from vt_meta.schema_migrations`)).map(r => r.id));
    if (done.size === 0) {
      const [t] = await sql.query<{ exists: boolean }>(`select to_regclass('vt.tenants') is not null as exists`);
      if (t?.exists) {
        for (const id of V01) await sql.query(`insert into vt_meta.schema_migrations (id) values ($1) on conflict do nothing`, [id]);
        done = new Set(V01);
      }
    }
    const applied: string[] = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await sql.exec(m.sql);
      await sql.query(`insert into vt_meta.schema_migrations (id) values ($1)`, [m.id]);
      applied.push(m.id);
    }
    return { applied };
  });
}

const ready = new WeakMap<Db, Promise<unknown>>();
/** Run ensureSchema once per database per server instance; retry on the next request if it failed. */
export function schemaReady(db: Db): Promise<unknown> {
  let p = ready.get(db);
  if (!p) { p = ensureSchema(db).catch(e => { ready.delete(db); throw e; }); ready.set(db, p); }
  return p;
}
