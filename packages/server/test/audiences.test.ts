import { describe, it, expect, beforeAll } from 'vitest';
import { handle, type Db } from '@vtology/server';
import { emailMatchKey, phoneMatchKey, planColumns, sha256Hex, standardPhone, toAudienceRows } from '@vtology/core';
import { createTestDb } from './helpers/pglite';

const LOCAL = 'local-secret-for-tests-at-least-32-chars';
const SECRET = 'vtology-test-secret-key-with-at-least-forty-chars!!';
let db: Db;
const deps = () => ({ db, localSecret: LOCAL, secretKey: SECRET, now: () => new Date() });
async function call(token: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await handle(new Request(`http://localhost/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), deps());
  return { status: res.status, body: await res.json() as any };
}
let token = '', ws = '', T = '';

// 400 made-up subscribers: every 4th pays, every 5th has lapsed, the rest are free
const people = Array.from({ length: 400 }, (_, i) => ({ email: `user${i}@example.in`, phone: `98100${String(i).padStart(5, '0')}`, status: i % 4 === 0 ? 'premium' : i % 5 === 0 ? 'lapsed' : 'free', months: String(i % 30), listening: i % 3 === 0 ? 'rising' : 'steady' }));

beforeAll(async () => {
  ({ db } = await createTestDb());
  token = (await call(null, 'POST', '/auth/login', { email: 'sarvesh@vanaya.test', password: 'demo' })).body.accessToken;
  ws = (await call(token, 'POST', '/workspaces', { name: 'Streamly', industry: 'FMCG', sample: false })).body.workspace.id;
  T = `/tenants/${ws}`;
});

describe('match keys', () => {
  it('follow the industry standard, so partners can match them', async () => {
    expect(await emailMatchKey(' Priya.S@Gmail.com')).toBe('fcf1cab387e3ed55946e9ee55c4f0b0a5b097ae9d860e15fc4d3e74d0ccce527');
    expect(standardPhone('98100 00001')).toBe('+919810000001');
    expect(await phoneMatchKey('+91 98100-00001')).toBe('dd2236365933a0d8da9bb69e2663e436177d024f61be87b67fc92ef46edcc3b7');
  });
  it('reads a file: hashed columns used, raw ones hashed, MD5 and identifiers in attributes refused', async () => {
    const h = await sha256Hex('a@b.in');
    const sample = [{ em: h, ph: await sha256Hex('+919810000001'), Status: 'free', md5: '0cc175b9c0f1b6a831c399e269772661', note: 'call x@y.in' }];
    const plan = planColumns(['em', 'ph', 'Status', 'md5', 'note'], sample);
    expect(plan.map(p => p.role)).toEqual(['email_hash', 'phone_hash', 'attribute', 'ignore', 'attribute']);
    expect(plan[3]!.problem).toMatch(/MD5/);
    const raw = planColumns(['Email', 'Mobile', 'Plan'], [{ Email: 'Priya.S@Gmail.com', Mobile: '9810000001', Plan: 'free' }]);
    expect(raw.map(p => p.role)).toEqual(['email_raw', 'phone_raw', 'attribute']);
    const { rows } = await toAudienceRows([{ Email: 'Priya.S@Gmail.com', Mobile: '9810000001', Plan: 'free' }], raw);
    expect(rows[0]).toEqual({ e: 'fcf1cab387e3ed55946e9ee55c4f0b0a5b097ae9d860e15fc4d3e74d0ccce527', p: 'dd2236365933a0d8da9bb69e2663e436177d024f61be87b67fc92ef46edcc3b7', a: { plan: 'free' } });
  });
});

async function upload(name: string, kind: string, rows: { e?: string; p?: string; a?: Record<string, string> }[]) {
  const l = await call(token, 'POST', `${T}/audiences/lists`, { name, kind, expiresDays: 30 });
  expect(l.status).toBe(201);
  for (let i = 0; i < rows.length; i += 150) expect((await call(token, 'POST', `${T}/audiences/lists/${l.body.id}/rows`, { rows: rows.slice(i, i + 150) })).status).toBe(200);
  const f = await call(token, 'POST', `${T}/audiences/lists/${l.body.id}/finish`);
  expect(f.status).toBe(200);
  return { id: l.body.id as string, ...f.body };
}

describe('audience lists and buckets', () => {
  let customers = '', premium = '', buyers = '', bucket = '';
  it('takes a hashed list in chunks and refuses anything that is not hashed', async () => {
    const rows = await Promise.all(people.map(async p => ({ e: (await emailMatchKey(p.email))!, p: (await phoneMatchKey(p.phone))!, a: { status: p.status, months: p.months, listening: p.listening } })));
    const c = await upload('All users, Nov', 'customers', rows);
    customers = c.id;
    expect(c).toMatchObject({ people: 400, withEmail: 400, withPhone: 400 });
    // a raw email anywhere stops the chunk; a non-hex key is refused
    const l = await call(token, 'POST', `${T}/audiences/lists`, { name: 'Bad', kind: 'other' });
    const raw = await call(token, 'POST', `${T}/audiences/lists/${l.body.id}/rows`, { rows: [{ e: rows[0]!.e, a: { contact: 'user1@example.in' } }] });
    expect(raw.status).toBe(400);
    expect(raw.body.error).toMatch(/looks like an email/);
    const plain = await call(token, 'POST', `${T}/audiences/lists/${l.body.id}/rows`, { rows: [{ e: 'user1@example.in' }, { e: 'abc' }, { p: rows[1]!.p }] });
    expect(plain.body).toEqual({ accepted: 1, refused: 2 });
    // match keys never come back to the browser
    const all = await call(token, 'GET', `${T}/audiences`);
    expect(JSON.stringify(all.body)).not.toContain(rows[0]!.e);
    const list = all.body.lists.find((x: any) => x.id === customers);
    expect(list.attributes.status.top).toEqual([['free', 240], ['premium', 100], ['lapsed', 60]]);
    expect(list.attributes.months).toMatchObject({ numeric: true, min: 0, max: 29 });
  });

  it('builds a bucket from rules and an exclusion list, with a holdout that never moves', async () => {
    const paying = await Promise.all(people.filter(p => p.status === 'premium').map(async p => ({ e: (await emailMatchKey(p.email))! })));
    premium = (await upload('Premium now', 'exclude', paying)).id;
    // everyone rising, minus whoever already pays: the free and lapsed rising listeners
    const preview = await call(token, 'POST', `${T}/audiences/buckets/preview`, { includeLists: [customers], excludeLists: [premium], rules: [{ field: 'listening', op: 'is', value: 'Rising' }] });
    const rising = people.filter(p => p.listening === 'rising');
    expect(preview.body).toMatchObject({ candidates: rising.length, people: rising.filter(p => p.status !== 'premium').length });
    const b = await call(token, 'POST', `${T}/audiences/buckets`, { name: 'Likely to upgrade', purpose: 'upgrade', includeLists: [customers], excludeLists: [premium], holdoutPct: 20,
      rules: [{ field: 'listening', op: 'is', value: 'rising' }, { field: 'status', op: 'is', value: 'free' }, { field: 'months', op: 'at_least', value: '3' }, { field: 'x', op: 'at_least', value: 'lots' }] });
    expect(b.status).toBe(201);
    bucket = b.body.id;
    const want = rising.filter(p => p.status === 'free' && Number(p.months) >= 3).length;
    expect(b.body.stats.people).toBe(want);
    expect(b.body.stats.holdout + b.body.stats.targeted).toBe(want);
    expect(b.body.stats.holdout).toBeGreaterThan(want * 0.05);
    expect(b.body.stats.holdout).toBeLessThan(want * 0.4);
    const again = await call(token, 'POST', `${T}/audiences/buckets/${bucket}/refresh`);
    expect(again.body.holdout).toBe(b.body.stats.holdout);
    const saved = (await call(token, 'GET', `${T}/audiences`)).body.buckets[0];
    expect(saved.rules).toHaveLength(3); // the rule with a non-number was dropped
    expect(saved.summary).toBe('listening is rising, and status is free, and months is at least 3');
  });

  it('measures lift against a list of buyers', async () => {
    // a month later: every rising listener who was targeted bought; one in ten of the rest did
    const exp = await call(token, 'GET', `${T}/audiences/buckets/${bucket}/export?format=plain`);
    const targetedKeys = new Set(exp.body.csv.split('\n').map((l: string) => l.split(',')[0]));
    const bought = await Promise.all(people.map(async (p, i) => ({ p, e: (await emailMatchKey(p.email))!, i })));
    const rows = bought.filter(x => targetedKeys.has(x.e) || x.i % 10 === 0).map(x => ({ e: x.e }));
    buyers = (await upload('Paid in December', 'buyers', rows)).id;
    const r = await call(token, 'PATCH', `${T}/audiences/buckets/${bucket}`, { purpose: 'upgrade', includeLists: [customers], excludeLists: [premium], holdoutPct: 20, measureList: buyers,
      rules: [{ field: 'listening', op: 'is', value: 'rising' }, { field: 'status', op: 'is', value: 'free' }, { field: 'months', op: 'at_least', value: '3' }] });
    const m = r.body.stats.measured;
    expect(m.targetedRate).toBe(1);
    expect(m.holdoutRate).toBeLessThan(0.5);
    expect(m.targetedConverted).toBe(r.body.stats.targeted);
  });

  it('exports hashed keys for Customer Match, keeps the holdout out of activation, and logs every export', async () => {
    const g = await call(token, 'GET', `${T}/audiences/buckets/${bucket}/export?format=google`);
    expect(g.body.header).toBe('Email,Phone');
    expect(g.body.csv.split('\n')).toHaveLength(g.body.total);
    expect(g.body.csv.split('\n')[0]).toMatch(/^[0-9a-f]{64},[0-9a-f]{64}$/);
    const bad = await call(token, 'GET', `${T}/audiences/buckets/${bucket}/export?format=google&part=holdout`);
    expect(bad.status).toBe(400);
    const h = await call(token, 'GET', `${T}/audiences/buckets/${bucket}/export?format=plain&part=holdout`);
    const targeted = new Set(g.body.csv.split('\n'));
    expect(h.body.csv.split('\n').some((l: string) => targeted.has(l))).toBe(false);
    const log = (await call(token, 'GET', `${T}/audiences`)).body.exports;
    expect(log.map((x: any) => `${x.part}:${x.format}`)).toEqual(expect.arrayContaining(['target:google', 'holdout:plain', 'target:plain']));
    // no signed-in role can read match keys from the database directly
    const direct = await db.asUser((await db.admin.query<{ id: string }>(`select user_id as id from vt.memberships where tenant_id = $1 limit 1`, [ws]))[0]!.id,
      sql => sql.query(`select count(*) from vt.audience_members`).then(() => 'read').catch(() => 'refused'));
    expect(direct).toBe('refused');
  });

  it('deletes lists on their expiry date', async () => {
    await db.admin.query(`update vt.audience_lists set expires_at = now() - interval '1 day' where id = $1`, [buyers]);
    const after = await call(token, 'GET', `${T}/audiences`);
    expect(after.body.lists.some((l: any) => l.id === buyers)).toBe(false);
    const [n] = await db.admin.query<{ n: number }>(`select count(*)::int as n from vt.audience_members where list_id = $1`, [buyers]);
    expect(n!.n).toBe(0);
    expect(after.body.buckets[0].measure_list).toBeNull();
  });
});
