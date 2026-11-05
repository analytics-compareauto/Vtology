import { describe, it, expect, beforeAll } from 'vitest';
import { handle, encrypt, type Db } from '@vtology/server';
import { findOutliers, scoreTopic, videoChecks, type SocialPost } from '@vtology/core';
import { createTestDb } from './helpers/pglite';

const LOCAL = 'local-secret-for-tests-at-least-32-chars';
const SECRET = 'vtology-test-secret-key-with-at-least-forty-chars!!';
const NOW = new Date('2026-11-05T08:00:00Z');
let db: Db;
let calls: string[] = [];
const yt = (async (input: string | URL) => {
  const u = new URL(String(input)); calls.push(u.pathname + u.search);
  if (u.pathname.endsWith('/search')) return Response.json({ items: [1, 2, 3, 4, 5, 6].map(i => ({ id: { videoId: `v${i}` } })) });
  if (u.pathname.endsWith('/videos')) return Response.json({ items: [1, 2, 3, 4, 5, 6].map(i => ({ id: `v${i}`, snippet: { title: `Video ${i}`, channelId: i === 2 ? 'UC-carwale' : i === 4 ? 'UC-own' : `UC-${i}`, channelTitle: i === 2 ? 'CarWale' : `Channel ${i}`, publishedAt: new Date(NOW.getTime() - i * 200 * 86_400_000).toISOString() }, statistics: { viewCount: String(100_000 * (7 - i)) } })) });
  if (u.pathname.endsWith('/channels')) return Response.json({ items: u.searchParams.get('id')!.split(',').map(id => ({ id, statistics: { subscriberCount: id === 'UC-own' ? '50000' : '900000' } })) });
  return new Response('{}', { status: 404 });
}) as typeof fetch;
const deps = () => ({ db, localSecret: LOCAL, secretKey: SECRET, now: () => NOW, fetch: yt, social: { publicUrl: 'https://vtology.vercel.app', google: { clientId: 'x', clientSecret: 'y' } } });
async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await handle(new Request(`http://localhost/api${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }), deps() as any);
  return { status: res.status, body: await res.json() as any };
}
let token = '';
beforeAll(async () => {
  ({ db } = await createTestDb());
  const r = await handle(new Request('http://localhost/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sarvesh@vanaya.test', password: 'demo' }) }), deps() as any);
  token = ((await r.json()) as any).accessToken;
});

const post = (i: number, account: string, views: number, days: number, caption = 'Car review'): SocialPost => ({ id: `p${account}${i}`, accountId: account, platform: 'youtube', postedAt: new Date(NOW.getTime() - days * 86_400_000), format: 'video', caption, views });

describe('content analysis', () => {
  it('finds posts far above their own account, judging competitors on public numbers', () => {
    const posts = [...Array.from({ length: 12 }, (_, i) => post(i, 'a', 1000 + i * 10, 10 + i)), post(99, 'a', 9000, 5, 'Creta vs Seltos comparison'), post(98, 'a', 50000, 1)];
    const o = findOutliers(posts, [{ id: 'a', platform: 'youtube', name: 'Brand', isCompetitor: false }], 'Automotive', NOW, { from: new Date(NOW.getTime() - 90 * 86_400_000), to: NOW });
    expect(o.map(x => x.post.id)).toEqual(['pa99']); // the 1-day-old video hasn't settled yet
    expect(o[0]!.score).toBeGreaterThan(8);
    expect(o[0]!.themes).toContain('comparison');
  });
  it('scores search topics on demand, stale results and bigger channels', () => {
    const v = (i: number, views: number, days: number, subs: number) => ({ id: `${i}`, title: 't', channelId: `c${i}`, channel: 'x', publishedAt: new Date(NOW.getTime() - days * 86_400_000).toISOString(), views, channelSubscribers: subs });
    const old = scoreTopic(Array.from({ length: 10 }, (_, i) => v(i, 2_000_000, 800, 30_000)), NOW, { channelIds: [], subscribers: 50_000 }, []);
    expect(old.nearSize).toBe(1);
    const crowded = scoreTopic(Array.from({ length: 10 }, (_, i) => v(i, 2_000_000, 60, 5_000_000)), NOW, { channelIds: [], subscribers: 50_000 }, []);
    expect(old.opportunity).toBeGreaterThan(crowded.opportunity);
    expect(crowded.biggerChannels).toBe(1);
  });
  it('checks a video and says how to fix it', () => {
    const c = videoChecks({ title: 'Our new SUV is here and you will absolutely love everything about it, watch till the end', description: 'Book now https://compareauto.in/hyryder #suv #cars #india #new #car #auto #drive\n0:00 Intro\n1:10 Design\n4:00 Price', durationS: 600, avgViewPct: 20, format: 'video', views: 5000 },
      { topics: ['best suv under 15 lakh'], usualViewPct: 40, brandDomains: ['compareauto.in'] });
    const by = Object.fromEntries(c.map(x => [x.id, x.pass]));
    expect(by).toMatchObject({ title_length: false, topic: false, link: true, utm: false, hashtags: false, chapters: true, retention: false });
  });
});

describe('content tab', () => {
  it('works on a sample workspace end to end', async () => {
    const ws = (await call(token, 'POST', '/workspaces', { name: 'Vegaa', industry: 'Automotive', sample: true })).body.workspace.id;
    const T = `/tenants/${ws}`;
    const c = await call(token, 'GET', `${T}/content?from=2026-08-08&to=2026-11-05`);
    expect(c.status).toBe(200);
    expect(c.body.outliers.length).toBeGreaterThan(0);
    expect(c.body.outliers.some((o: any) => c.body.accounts.find((a: any) => a.id === o.accountId).isCompetitor)).toBe(true);
    expect(c.body.suggestedTopics.length).toBeGreaterThan(3);
    await call(token, 'POST', `${T}/content/topics`, { phrases: c.body.suggestedTopics.slice(0, 3) });
    expect((await call(token, 'POST', `${T}/content/topics/scan`, {})).body).toMatchObject({ scanned: 3, sample: true });
    const after = (await call(token, 'GET', `${T}/content`)).body;
    expect(after.topics[0].result.opportunity).toBeGreaterThanOrEqual(0);
    const v = after.videos[0];
    expect(v.checks.length).toBeGreaterThan(3);
    expect((await call(token, 'GET', `${T}/content/videos/${v.id}/retention`)).body.curve).toHaveLength(21);
  });

  it('searches YouTube through the brand’s own channel and finds who ranks', async () => {
    const ws = (await call(token, 'POST', '/workspaces', { name: 'CompareAuto', industry: 'Automotive', sample: false })).body.workspace.id;
    const T = `/tenants/${ws}`;
    expect((await call(token, 'POST', `${T}/content/topics/scan`, {})).body.scanned).toBe(0);
    await call(token, 'POST', `${T}/content/topics`, { phrases: ['best suv under 15 lakh'] });
    const noYt = await call(token, 'POST', `${T}/content/topics/scan`, {});
    expect(noYt.body.error).toMatch(/Connect the brand’s YouTube/);
    const [conn] = await db.admin.query<{ id: string }>(`insert into vt.social_connections (tenant_id, provider, label) values ($1, 'youtube', 'YouTube: CompareAuto') returning id`, [ws]);
    await db.admin.query(`insert into vt.social_tokens (connection_id, tenant_id, access_token_enc, expires_at) values ($1, $2, $3, now() + interval '1 hour')`, [conn!.id, ws, encrypt(SECRET, 'yt-token')]);
    await db.admin.query(`insert into vt.social_accounts (tenant_id, connection_id, platform, external_id, name, followers) values ($1,$2,'youtube','UC-own','CompareAuto',50000), ($1,$2,'youtube','UC-carwale','CarWale',900000)`, [ws, conn!.id]);
    await db.admin.query(`update vt.social_accounts set is_competitor = true where external_id = 'UC-carwale' and tenant_id = $1`, [ws]);
    calls = [];
    expect((await call(token, 'POST', `${T}/content/topics/scan`, {})).body.scanned).toBe(1);
    expect(calls[0]).toMatch(/^\/youtube\/v3\/search\?.*q=best%20suv%20under%2015%20lakh/);
    const t = (await call(token, 'GET', `${T}/content`)).body.topics[0];
    expect(t.result).toMatchObject({ ownRank: 4, competitorRanks: [{ name: 'CarWale', rank: 2 }] });
    expect(t.result.biggerChannels).toBe(1);
    // scanned this week: not again unless asked
    calls = [];
    expect((await call(token, 'POST', `${T}/content/topics/scan`, {})).body.scanned).toBe(0);
    expect((await call(token, 'POST', `${T}/content/topics/scan`, { ids: [t.id] })).body.scanned).toBe(1);
  });
});
