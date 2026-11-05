import { describe, it, expect } from 'vitest';
import { MIGRATIONS } from '../src/migrations.generated';
import { createTestDb } from './helpers/pglite';

describe('json repair migration', () => {
  it('turns JSON stored as text back into objects, and leaves real strings alone', async () => {
    const { db } = await createTestDb();
    const [t] = await db.admin.query<{ id: string }>(`insert into vt.tenants (name, industry) values ('x', 'Automotive') returning id`);
    await db.admin.query(`insert into vt.content_topics (tenant_id, phrase, result) values ($1, 'a', to_jsonb('{"opportunity":5,"videos":[]}'::text)), ($1, 'b', to_jsonb('plain words'::text)), ($1, 'c', '{"ok":true}'::jsonb)`, [t!.id]);
    await db.admin.exec(MIGRATIONS.find(m => m.id.endsWith('repair_json'))!.sql);
    const rows = await db.admin.query<{ phrase: string; kind: string; result: unknown }>(`select phrase, jsonb_typeof(result) as kind, result from vt.content_topics order by phrase`);
    expect(rows.map(r => r.kind)).toEqual(['object', 'string', 'object']);
    expect(rows[0]!.result).toEqual({ opportunity: 5, videos: [] });
  });
});
