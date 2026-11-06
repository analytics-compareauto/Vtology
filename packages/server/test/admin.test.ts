import { describe, it, expect, beforeAll } from 'vitest';
import { handle, type Db } from '@vtology/server';
import { createTestDb } from './helpers/pglite';

const LOCAL = 'local-secret-for-tests-at-least-32-chars';
let db: Db;
const deps = () => ({ db, localSecret: LOCAL, secretKey: 'vtology-test-secret-key-with-at-least-forty-chars!!', now: () => new Date('2026-11-06T08:00:00Z') });
async function call(token: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await handle(new Request(`http://localhost/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), deps());
  return { status: res.status, body: await res.json() as any };
}
let owner = '', brand = '', ws = '';
beforeAll(async () => {
  ({ db } = await createTestDb());
  owner = (await call(null, 'POST', '/auth/login', { email: 'sarvesh@vanaya.test', password: 'demo' })).body.accessToken;
  brand = (await call(null, 'POST', '/auth/login', { email: 'head@ijmtoyota.test', password: 'demo' })).body.accessToken;
  ws = (await call(owner, 'POST', '/workspaces', { name: 'IJM Toyota', industry: 'Automotive', sample: false })).body.workspace.id;
  // the brand's marketing head is a member of its own workspace only
  const [u] = await db.admin.query<{ sub: string }>(`select $1::text as sub`, [JSON.parse(Buffer.from(brand.split('.')[1]!, 'base64url').toString()).sub]);
  await db.admin.query(`insert into vt.memberships (tenant_id, user_id, role) values ($1, $2, 'marketing_head')`, [ws, u!.sub]);
});

describe('admin panel', () => {
  it('is open to Vanaya’s owners only, and invisible to brands', async () => {
    expect((await call(owner, 'GET', '/workspaces')).body.isOwner).toBe(true);
    expect((await call(brand, 'GET', '/workspaces')).body.isOwner).toBe(false);
    expect((await call(brand, 'GET', '/admin')).status).toBe(404);
    const a = await call(owner, 'GET', '/admin');
    expect(a.status).toBe(200);
    expect(a.body.clients.find((c: any) => c.id === ws)).toMatchObject({ name: 'IJM Toyota', plan: 'enterprise', members: 2, leads: 0 });
    expect((await call(brand, 'PATCH', `/admin/tenants/${ws}`, { plan: 'enterprise' })).status).toBe(404);
  });
  it('changes a plan, switches parts off for the brand, and records who did it', async () => {
    expect((await call(brand, 'GET', `/tenants/${ws}/crossmedia`)).status).toBe(200);
    const r = await call(owner, 'PATCH', `/admin/tenants/${ws}`, { plan: 'starter', marginPct: 12.5 });
    expect(r.body).toMatchObject({ plan: 'starter', features: { social: true, media: false, audiences: false, journeys: false }, marginPct: 12.5 });
    const blocked = await call(brand, 'GET', `/tenants/${ws}/crossmedia`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatch(/isn’t in your plan/);
    expect((await call(brand, 'GET', `/tenants/${ws}/me`)).body.features).toMatchObject({ media: false, social: true });
    // switching one part back by hand makes the plan custom
    expect((await call(owner, 'PATCH', `/admin/tenants/${ws}`, { features: { media: true } })).body.plan).toBe('custom');
    expect((await call(brand, 'GET', `/tenants/${ws}/crossmedia`)).status).toBe(200);
    const audit = (await call(owner, 'GET', '/admin')).body.audit;
    expect(audit[0]).toMatchObject({ admin_email: 'sarvesh@vanaya.test', tenant_name: 'IJM Toyota', action: 'Changed plan' });
    // the margin is never in anything the brand can read
    expect(JSON.stringify((await call(brand, 'GET', `/tenants/${ws}/me`)).body)).not.toMatch(/margin|12\.5/);
  });
});
