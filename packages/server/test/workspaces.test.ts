import { describe, it, expect, beforeAll } from 'vitest';
import { handle, generateDemo, type Db } from '@vtology/server';
import { createTestDb } from './helpers/pglite';

const LOCAL = 'local-secret-for-tests-at-least-32-chars';
const NOW = new Date('2026-10-31T06:00:00Z');
let db: Db;

async function call(token: string | null, method: string, path: string, body?: unknown, extra: Record<string, unknown> = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await handle(new Request(`http://localhost/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), { db, localSecret: LOCAL, now: () => NOW, ...extra });
  return { status: res.status, body: await res.json() as any };
}
const login = async (email: string) => (await call(null, 'POST', '/auth/login', { email, password: 'demo' })).body;

beforeAll(async () => { ({ db } = await createTestDb()); });

describe('sample data generator', () => {
  for (const industry of ['Automotive', 'BFSI', 'FMCG'] as const) {
    it(`${industry}: is deterministic and well-formed`, () => {
      const a = generateDemo(industry, NOW), b = generateDemo(industry, NOW);
      expect(a.csv.lead).toBe(b.csv.lead);
      expect(a.csv.lead.split('\n').length).toBeGreaterThan(200);
      expect(a.csv.journey_event.split('\n').length).toBeGreaterThan(400);
    });
  }
});

describe('sign-in, workspaces and sample data', () => {
  let ana: any, ben: any, ws: any;

  it('local demo mode signs in with any email and the password "demo"', async () => {
    expect((await call(null, 'POST', '/auth/login', { email: 'ana@vanaya.test', password: 'nope' })).status).toBe(401);
    ana = await login('ana@vanaya.test');
    expect(ana.accessToken).toBeTruthy();
    expect((await call(ana.refreshToken, 'GET', '/workspaces')).status).toBe(401); // refresh tokens are not access tokens
    const again = (await call(null, 'POST', '/auth/refresh', { refreshToken: ana.refreshToken })).body;
    expect(again.user.id).toBe(ana.user.id);
  });

  it('lets the first person create a workspace, loading Automotive sample data through the real pipeline', async () => {
    expect((await call(ana.accessToken, 'GET', '/workspaces')).body).toEqual({ workspaces: [], canCreate: true });
    const t0 = Date.now();
    const r = await call(ana.accessToken, 'POST', '/workspaces', { name: 'Vegaa Motors (sample)', industry: 'Automotive', sample: true });
    expect(r.status).toBe(201);
    ws = r.body.workspace;
    const p = r.body.sample.pipeline;
    expect(p.parties).toBeLessThan(p.records);          // duplicates were merged
    expect(p.heldForReview).toBeGreaterThanOrEqual(8);  // shared numbers held back
    expect(r.body.sample.imports.find((i: any) => i.entity === 'lead').warnings).toBeGreaterThan(0); // bad phones flagged
    console.log('Automotive sample loaded in', Date.now() - t0, 'ms', p);
  });

  it('produces every kind of finding', async () => {
    const v = (await call(ana.accessToken, 'GET', `/tenants/${ws.id}/violations`)).body;
    const rules = new Set(v.map((x: any) => x.rule));
    for (const rule of ['phantom_conversion', 'orphan_transaction', 'unattributed_spend', 'idle_opportunity', 'shared_identifier']) expect(rules).toContain(rule);
    const partners = (await call(ana.accessToken, 'GET', `/tenants/${ws.id}/partners`)).body;
    expect(partners[0].name).toBe('Pune City Motors');
    expect(partners[0].stalledShare).toBeGreaterThan(0.5);
  });

  it('switches roles in a sample workspace, and each role sees its own slice', async () => {
    const T = `/tenants/${ws.id}`;
    const all = (await call(ana.accessToken, 'GET', `${T}/journeys`)).body;
    let r = await call(ana.accessToken, 'POST', `${T}/sample/role`, { role: 'partner_user' });
    expect(r.body).toMatchObject({ role: 'partner_user', partner: 'Pune City Motors' });
    const mine = (await call(ana.accessToken, 'GET', `${T}/journeys`)).body;
    expect(mine.length).toBeLessThan(all.length);
    expect(new Set(mine.map((j: any) => j.partner))).toEqual(new Set(['Pune City Motors']));
    const me = (await call(ana.accessToken, 'GET', `${T}/me`)).body;
    expect(me).toMatchObject({ role: 'partner_user', partner: 'Pune City Motors', isDemo: true, tenantName: 'Vegaa Motors (sample)' });

    r = await call(ana.accessToken, 'POST', `${T}/sample/role`, { role: 'marketing_head' });
    const masked = (await call(ana.accessToken, 'GET', `${T}/journeys`)).body;
    expect(masked.every((j: any) => !j.party || j.party.includes('•'))).toBe(true);

    r = await call(ana.accessToken, 'POST', `${T}/sample/role`, { role: 'relationship_manager' });
    expect(r.body.bookCode).toMatch(/^B\d$/);
    expect((await call(ana.accessToken, 'GET', `${T}/journeys`)).body.length).toBeLessThan(all.length);
    await call(ana.accessToken, 'POST', `${T}/sample/role`, { role: 'data_steward' });
  });

  it('only admins create more workspaces; real workspaces do not allow role switching', async () => {
    ben = await login('ben@vanaya.test');
    expect((await call(ben.accessToken, 'GET', '/workspaces')).body).toEqual({ workspaces: [], canCreate: false });
    expect((await call(ben.accessToken, 'POST', '/workspaces', { name: 'Mine', industry: 'BFSI' })).status).toBe(403);
    expect((await call(ben.accessToken, 'GET', `/tenants/${ws.id}/journeys`)).status).toBe(403);
    const real = await call(ana.accessToken, 'POST', '/workspaces', { name: 'Vegaa Motors', industry: 'Automotive' });
    expect(real.status).toBe(201);
    expect((await call(ana.accessToken, 'POST', `/tenants/${real.body.workspace.id}/sample/role`, { role: 'finance' })).status).toBe(403);
    expect((await call(ana.accessToken, 'GET', '/workspaces')).body.workspaces.map((w: any) => w.name)).toEqual(['Vegaa Motors (sample)', 'Vegaa Motors']);
  });

  it('BFSI and FMCG samples load too', async () => {
    for (const industry of ['BFSI', 'FMCG']) {
      const r = await call(ana.accessToken, 'POST', '/workspaces', { name: `${industry} sample`, industry, sample: true });
      expect(r.status).toBe(201);
      const v = (await call(ana.accessToken, 'GET', `/tenants/${r.body.workspace.id}/violations`)).body;
      expect(v.length).toBeGreaterThan(5);
      console.log(industry, r.body.sample.pipeline, [...new Set(v.map((x: any) => x.rule))]);
    }
  }, 60_000);
});

describe('Supabase sign-in proxy', () => {
  const fakeFetch = (handler: (url: string, init: RequestInit) => [number, unknown]) => (async (url: string, init: RequestInit) => {
    const [status, body] = handler(String(url), init);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  const cfg = (f: typeof fetch) => ({ supabaseUrl: 'https://abc.supabase.co', supabaseKey: 'sb_publishable_x', fetch: f });

  it('forwards password sign-in with the publishable key and maps errors to plain messages', async () => {
    let seen: any;
    const ok = fakeFetch((url, init) => { seen = { url, init }; return [200, { access_token: 'a', refresh_token: 'r', expires_in: 3600, user: { id: 'u1', email: 'x@y.in' } }]; });
    const res = await handle(new Request('http://x/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'x@y.in', password: 'pw' }) }), { db, ...cfg(ok) });
    expect(res.status).toBe(200);
    expect(seen.url).toBe('https://abc.supabase.co/auth/v1/token?grant_type=password');
    expect((seen.init.headers as any).apikey).toBe('sb_publishable_x');
    const bad = fakeFetch(() => [400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' }]);
    const r2 = await handle(new Request('http://x/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'x@y.in', password: 'pw' }) }), { db, ...cfg(bad) });
    expect(r2.status).toBe(401);
    expect((await r2.json() as any).error).toBe('Wrong email or password.');
    const nokey = await handle(new Request('http://x/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'x@y.in', password: 'pw' }) }), { db, supabaseUrl: 'https://abc.supabase.co' });
    expect(nokey.status).toBe(503);
  });

  it('verifies HS256 tokens with Supabase Auth when the JWT secret is not configured', async () => {
    const { SignJWT } = await import('jose');
    const tok = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject('11111111-1111-4111-a111-111111111111').setExpirationTime('1h').sign(new TextEncoder().encode('unknown-secret-unknown-secret-123'));
    const f = fakeFetch(url => url.endsWith('/auth/v1/user') ? [200, { id: '11111111-1111-4111-a111-111111111111' }] : [404, {}]);
    const res = await handle(new Request('http://x/api/workspaces', { headers: { authorization: `Bearer ${tok}` } }), { db, ...cfg(f) });
    expect(res.status).toBe(200);
    const deny = fakeFetch(() => [401, {}]);
    const tok2 = tok.slice(0, -2) + 'xx';
    expect((await handle(new Request('http://x/api/workspaces', { headers: { authorization: `Bearer ${tok2}` } }), { db, ...cfg(deny) })).status).toBe(401);
  });
});
