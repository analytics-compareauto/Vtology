import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from './helpers/pglite';
import { createPgliteDb } from '../src/devdb';
import { ensureSchema } from '../src/schema';
import { MIGRATIONS } from '../src/migrations.generated';

const DIR = join(__dirname, '../../../supabase/migrations');

describe('migrations', () => {
  it('apply cleanly and load reference data', async () => {
    const { db } = await createTestDb();
    const roles = await db.admin.query<{ code: string }>('select code from vt.roles order by code');
    expect(roles.map(r => r.code)).toContain('partner_user');
    const stages = await db.admin.query('select * from vt.stage_defs');
    expect(stages.length).toBe(18);
    expect((await ensureSchema(db)).applied).toEqual([]); // idempotent
  });

  it('embedded copies match supabase/migrations (run npm run migrations:embed)', () => {
    const files = readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
    expect(MIGRATIONS.map(m => m.id)).toEqual(files.map(f => f.replace(/\.sql$/, '')));
    for (const m of MIGRATIONS) expect(m.sql).toBe(readFileSync(join(DIR, `${m.id}.sql`), 'utf8'));
  });

  it('upgrades a database that was set up by pasting the v0.1 setup_all.sql', async () => {
    const { db, pg } = await createPgliteDb({ migrate: false });
    for (const m of MIGRATIONS.slice(0, 4)) await (pg as { exec: (s: string) => Promise<unknown> }).exec(m.sql);
    const r = await ensureSchema(db);
    expect(r.applied).toEqual(['20261031000005_workspaces', '20261102000006_social']);
    const cols = await db.admin.query<{ column_name: string }>(`select column_name from information_schema.columns where table_schema = 'vt' and table_name = 'tenants'`);
    expect(cols.map(c => c.column_name)).toContain('is_demo');
  });
});
