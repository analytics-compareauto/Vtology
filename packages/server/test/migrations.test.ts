import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers/pglite';

describe('migrations', () => {
  it('apply cleanly and load reference data', async () => {
    const { db } = await createTestDb();
    const roles = await db.admin.query<{ code: string }>('select code from vt.roles order by code');
    expect(roles.map(r => r.code)).toContain('partner_user');
    const stages = await db.admin.query('select * from vt.stage_defs');
    expect(stages.length).toBe(18);
  });
});
