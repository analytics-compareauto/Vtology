import { describe, it, expect, beforeAll } from 'vitest';
import { handle, encrypt, decrypt, type Db } from '@vtology/server';
import { analyzeSocial, themesOf, languageOf, timeBandOf } from '@vtology/core';
import { createTestDb } from './helpers/pglite';

const LOCAL = 'local-secret-for-tests-at-least-32-chars';
const SECRET = 'vtology-test-secret-key-with-at-least-forty-chars!!';
const NOW = new Date('2026-11-02T06:00:00Z');
let db: Db;
let fetchLog: string[] = [];

// minimal stand-ins for the Meta Graph API and Google APIs, shaped like their real responses
function fakePlatforms(): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    fetchLog.push(url.split('?')[0]!);
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    const G = 'https://graph.facebook.com/v23.0';
    if (url.startsWith(`${G}/oauth/access_token`)) return ok({ access_token: url.includes('fb_exchange_token') ? 'META-LONG-TOKEN' : 'META-SHORT', expires_in: 5184000 });
    if (url.startsWith(`${G}/me?`)) return ok({ name: 'Sarvesh' });
    if (url.startsWith(`${G}/me/permissions`)) return ok({ data: [{ permission: 'instagram_basic', status: 'granted' }, { permission: 'ads_read', status: 'declined' }] });
    if (url.startsWith(`${G}/me/accounts`)) return ok({ data: [{ id: 'PAGE1', name: 'CompareAuto', username: 'compareauto', followers_count: 52000, access_token: 'PAGE-TOKEN',
      instagram_business_account: { id: 'IG1', username: 'compareauto.in', name: 'CompareAuto', followers_count: 31000, media_count: 410 } }] });
    if (url.startsWith(`${G}/PAGE1/posts`)) return ok({ data: [
      { id: 'PAGE1_1', message: 'Creta vs Seltos: which one should you buy?', created_time: '2026-10-20T13:30:00+0000', permalink_url: 'https://facebook.com/1', attachments: { data: [{ media_type: 'video' }] }, reactions: { summary: { total_count: 900 } }, comments: { summary: { total_count: 120 } }, shares: { count: 80 } },
      { id: 'PAGE1_2', message: 'Best price on Nexon this week', created_time: '2026-10-21T04:00:00+0000', attachments: { data: [{ media_type: 'photo' }] }, reactions: { summary: { total_count: 60 } }, comments: { summary: { total_count: 3 } } },
    ] });
    if (url.startsWith(`${G}/IG1/media`)) return ok({ data: [
      { id: 'M1', caption: 'Thar vs Jimny face-off', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://instagram.com/p/1', timestamp: '2026-10-25T14:00:00+0000', like_count: 4200, comments_count: 310 },
      { id: 'M2', caption: 'On-road price list for Swift', media_type: 'IMAGE', media_product_type: 'FEED', permalink: 'https://instagram.com/p/2', timestamp: '2026-10-26T05:00:00+0000', like_count: 300, comments_count: 12 },
    ] });
    if (url.startsWith(`${G}/M1/insights`)) return url.includes('views') ? new Response(JSON.stringify({ error: { message: 'metric views not supported', code: 100 } }), { status: 400 })
      : ok({ data: [{ name: 'reach', values: [{ value: 60000 }] }, { name: 'saved', values: [{ value: 900 }] }, { name: 'shares', values: [{ value: 700 }] }] });
    if (url.startsWith(`${G}/M2/insights`)) return ok({ data: [{ name: 'reach', total_value: { value: 9000 } }, { name: 'saved', total_value: { value: 20 } }, { name: 'shares', total_value: { value: 5 } }, { name: 'views', total_value: { value: 11000 } }] });
    if (url.startsWith(`${G}/PAGE1/leadgen_forms`)) return ok({ data: [{ id: 'FORM1', name: 'Test drive booking' }] });
    if (url.startsWith(`${G}/FORM1/leads`)) return ok({ data: [
      { id: 'L1', created_time: '2026-10-28T10:00:00+0000', campaign_id: '777', campaign_name: 'SUV comparison leads', field_data: [{ name: 'full_name', values: ['Ravi Kumar'] }, { name: 'phone_number', values: ['+919812345670'] }, { name: 'city', values: ['Pune'] }] },
      { id: 'L2', created_time: '2026-10-29T10:00:00+0000', campaign_id: '777', campaign_name: 'SUV comparison leads', field_data: [{ name: 'first_name', values: ['Anita'] }, { name: 'last_name', values: ['Desai'] }, { name: 'phone_number', values: ['09812345671'] }] },
    ] });
    if (url.startsWith(`${G}/me/adaccounts`)) return ok({ data: [{ id: 'act_9', name: 'CompareAuto ads', currency: 'INR' }] });
    if (url.startsWith(`${G}/act_9/insights`)) return ok({ data: [{ campaign_id: '777', campaign_name: 'SUV comparison leads', spend: '45000.50', date_start: '2026-08-04', date_stop: '2026-11-01', actions: [{ action_type: 'lead', value: '138' }] }] });
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = String(init?.body ?? '');
      return ok(body.includes('refresh_token') && !body.includes('authorization_code') ? { access_token: 'YT-REFRESHED', expires_in: 3600 } : { access_token: 'YT-ACCESS', refresh_token: 'YT-REFRESH', expires_in: 3600, scope: 'youtube.readonly yt-analytics.readonly' });
    }
    if (url.startsWith('https://www.googleapis.com/youtube/v3/channels')) return ok({ items: [{ id: 'UC1', snippet: { title: 'CompareAuto', customUrl: '@compareauto' }, statistics: { subscriberCount: '88000', videoCount: '240' }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] });
    if (url.startsWith('https://www.googleapis.com/youtube/v3/playlistItems')) return ok({ items: [{ contentDetails: { videoId: 'V1', videoPublishedAt: '2026-10-10T12:00:00Z' } }, { contentDetails: { videoId: 'V2', videoPublishedAt: '2026-10-12T12:00:00Z' } }] });
    if (url.startsWith('https://www.googleapis.com/youtube/v3/videos')) return ok({ items: [
      { id: 'V1', snippet: { publishedAt: '2026-10-10T12:00:00Z', title: 'Creta vs Seltos detailed comparison', description: '' }, statistics: { viewCount: '150000', likeCount: '6000', commentCount: '800' }, contentDetails: { duration: 'PT14M10S' } },
      { id: 'V2', snippet: { publishedAt: '2026-10-12T12:00:00Z', title: 'Price drop alert #shorts', description: '' }, statistics: { viewCount: '20000', likeCount: '400', commentCount: '10' }, contentDetails: { duration: 'PT45S' } },
    ] });
    if (url.startsWith('https://youtubeanalytics.googleapis.com/v2/reports')) return ok({ rows: [['V1', 150000, 900000, 41.5, 1200], ['V2', 20000, 9000, 72, 30]] });
    return new Response(JSON.stringify({ error: { message: `unexpected ${url}` } }), { status: 404 });
  }) as unknown as typeof fetch;
}

const social = { publicUrl: 'https://vtology.vercel.app', meta: { appId: 'APP1', appSecret: 'APPSECRET' }, google: { clientId: 'GID', clientSecret: 'GSECRET' } };
const deps = () => ({ db, localSecret: LOCAL, now: () => NOW, secretKey: SECRET, social, fetch: fakePlatforms(), cronSecret: 'cron-test' });
async function call(token: string | null, method: string, path: string, body?: unknown, extra: Record<string, unknown> = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await handle(new Request(`http://localhost/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), { ...deps(), ...extra });
  return { status: res.status, location: res.headers.get('location'), body: res.status === 302 ? null : await res.json() as any };
}

beforeAll(async () => { ({ db } = await createTestDb()); });

describe('social analysis', () => {
  it('tags themes, language and IST time bands', () => {
    expect(themesOf('Automotive', 'Creta vs Seltos: which is better?')).toContain('comparison');
    expect(themesOf('Automotive', 'Festive offer, EMI from ₹9,999')).toEqual(expect.arrayContaining(['price', 'festive']));
    expect(languageOf('आपके परिवार के लिए कौन सी कार सही है?')).toBe('Hindi or Marathi');
    expect(languageOf('Plain English caption')).toBe('English');
    expect(timeBandOf(new Date('2026-10-20T13:30:00Z'))).toBe('evening'); // 7 pm IST
  });

  it('ignores tiny groups instead of over-reading them', () => {
    const a = analyzeSocial('Automotive', [{ id: 'a', platform: 'instagram', name: 'x', followers: 1000 }],
      [{ id: 'p', accountId: 'a', platform: 'instagram', postedAt: NOW, format: 'reel', caption: 'Creta vs Seltos', reach: 100, likes: 50 }], NOW);
    expect(a.segments).toEqual([]);
  });
});

describe('social footprint end to end', () => {
  let s: any, ws: string;

  it('sample workspaces come with a sample social footprint and findings', async () => {
    s = (await call(null, 'POST', '/auth/login', { email: 'sarvesh@vanaya.test', password: 'demo' })).body;
    ws = (await call(s.accessToken, 'POST', '/workspaces', { name: 'Vegaa Motors (sample)', industry: 'Automotive', sample: true })).body.workspace.id;
    const r = await call(s.accessToken, 'GET', `/tenants/${ws}/social`);
    expect(r.status).toBe(200);
    expect(r.body.accounts.map((a: any) => a.platform).sort()).toEqual(['facebook', 'instagram', 'youtube']);
    const ins = r.body.analysis.insights;
    const working = ins.filter((i: any) => i.kind === 'working').map((i: any) => i.key);
    const weak = ins.filter((i: any) => i.kind === 'not_working').map((i: any) => i.key);
    expect(working).toContain('comparison');
    expect(weak).toContain('price');
    expect(ins.some((i: any) => i.kind === 'try' && i.key === 'Hindi or Marathi')).toBe(true);
    expect(ins.some((i: any) => i.kind === 'try' && i.dimension === 'time' && i.key === 'evening')).toBe(true);
    console.log(ins.map((i: any) => `${i.kind}: ${i.title}`).join('\n'));
  });

  it('keeps social away from partner users and relationship managers', async () => {
    await call(s.accessToken, 'POST', `/tenants/${ws}/sample/role`, { role: 'partner_user' });
    expect((await call(s.accessToken, 'GET', `/tenants/${ws}/social`)).status).toBe(403);
    await call(s.accessToken, 'POST', `/tenants/${ws}/sample/role`, { role: 'finance' });
    expect((await call(s.accessToken, 'POST', `/tenants/${ws}/social/connect/meta`)).status).toBe(403);
    await call(s.accessToken, 'POST', `/tenants/${ws}/sample/role`, { role: 'marketing_head' });
  });

  it('connects Meta: consent URL, callback, encrypted keys, posts, insights and ad campaigns', async () => {
    const real = (await call(s.accessToken, 'POST', '/workspaces', { name: 'CompareAuto', industry: 'Automotive' })).body.workspace.id;
    const start = await call(s.accessToken, 'POST', `/tenants/${real}/social/connect/meta`);
    const u = new URL(start.body.url);
    expect(u.origin + u.pathname).toBe('https://www.facebook.com/v23.0/dialog/oauth');
    expect(u.searchParams.get('client_id')).toBe('APP1');
    expect(u.searchParams.get('redirect_uri')).toBe('https://vtology.vercel.app/api/social/callback/meta');
    expect(u.searchParams.get('scope')).toContain('instagram_manage_insights');

    // a forged or reused state is refused
    const forged = await call(null, 'GET', `/social/callback/meta?code=x&state=nonsense`);
    expect(forged.location).toContain('social=error');

    const cb = await call(null, 'GET', `/social/callback/meta?code=CODE&state=${encodeURIComponent(u.searchParams.get('state')!)}`);
    expect(cb.status).toBe(302);
    expect(cb.location).toContain('social=connected');
    expect(cb.location).toContain('sync=1');            // the redirect never waits for the first sync
    expect((await call(s.accessToken, 'POST', `/tenants/${real}/social/sync`)).status).toBe(200);

    const tok = await db.admin.query<{ access_token_enc: string }>(`select access_token_enc from vt.social_tokens`);
    expect(tok[0]!.access_token_enc).not.toContain('META-LONG-TOKEN');
    expect(decrypt(SECRET, tok[0]!.access_token_enc)).toBe('META-LONG-TOKEN');

    const r = await call(s.accessToken, 'GET', `/tenants/${real}/social`);
    expect(r.body.accounts.map((a: any) => `${a.platform}:${a.handle}`).sort()).toEqual(['facebook:compareauto', 'instagram:compareauto.in']);
    expect(r.body.connections[0]).toMatchObject({ provider: 'meta', label: 'Facebook: Sarvesh', status: 'active' });
    const posts = await db.admin.query<{ external_id: string; format: string; reach: string | null; saves: string | null; views: string | null }>(`select external_id, format, reach::text as reach, saves::text as saves, views::text as views from vt.social_posts where external_id in ('M1','M2') order by external_id`);
    expect(posts).toEqual([
      { external_id: 'M1', format: 'reel', reach: '60000', saves: '900', views: null },   // fell back when "views" was refused
      { external_id: 'M2', format: 'image', reach: '9000', saves: '20', views: '11000' },
    ]);
    const camp = r.body.campaigns.find((c: any) => c.code === 'meta:777');
    expect(camp).toMatchObject({ name: 'SUV comparison leads', channel: 'Meta ads', spend: null, platform_conversions: 138, journeys: 2, progressed: 0 }); // data stewards don't see money
    // lead-ad leads became customers (hashed phone) and inquiry journeys, matched by the pipeline
    const leadRows = await db.admin.query<{ raw_name: string; phone_hash: string; party_id: string | null }>(`select raw_name, phone_hash, party_id from vt.source_records where source_system = 'Meta lead ads' order by raw_name`);
    expect(leadRows.map(l => l.raw_name)).toEqual(['Anita Desai', 'Ravi Kumar']);
    expect(leadRows.every(l => l.phone_hash.startsWith('phone_') && l.party_id)).toBe(true);
    const js = (await call(s.accessToken, 'GET', `/tenants/${real}/journeys`)).body;
    expect(js.map((j: any) => j.stage)).toEqual(['Inquiry', 'Inquiry']);
    const [stored] = await db.admin.query<{ spend: string }>(`select spend_inr::text as spend from vt.campaigns where external_code = 'meta:777'`);
    expect(stored!.spend).toBe('45000.5');
  });

  it('connects YouTube with offline access and per-video analytics', async () => {
    const [t] = await db.admin.query<{ id: string }>(`select id from vt.tenants where name = 'CompareAuto'`);
    const start = await call(s.accessToken, 'POST', `/tenants/${t!.id}/social/connect/youtube`);
    const u = new URL(start.body.url);
    expect(u.searchParams.get('access_type')).toBe('offline');
    const cb = await call(null, 'GET', `/social/callback/youtube?code=G&state=${encodeURIComponent(u.searchParams.get('state')!)}`);
    expect(cb.location).toContain('social=connected');
    await call(s.accessToken, 'POST', `/tenants/${t!.id}/social/sync`);
    const v = await db.admin.query<{ external_id: string; format: string; views: string; avg_view_pct: string; watch_minutes: string }>(`select external_id, format, views::text as views, avg_view_pct::text as avg_view_pct, watch_minutes::text as watch_minutes from vt.social_posts where external_id like 'V%' order by external_id`);
    expect(v).toEqual([
      { external_id: 'V1', format: 'video', views: '150000', avg_view_pct: '41.5', watch_minutes: '900000' },
      { external_id: 'V2', format: 'short', views: '20000', avg_view_pct: '72', watch_minutes: '9000' },
    ]);
    // sync again: the YouTube key is refreshed when expired, and metrics update in place
    await db.admin.query(`update vt.social_tokens set expires_at = now() - interval '1 hour'`);
    const sync = await call(s.accessToken, 'POST', `/tenants/${t!.id}/social/sync`);
    expect(sync.body.youtube.posts).toBe(2);
    expect(fetchLog).toContain('https://oauth2.googleapis.com/token');
  });

  it('keeps stored insights when a sync runs out of time, and fills them in later', async () => {
    const [t] = await db.admin.query<{ id: string }>(`select id from vt.tenants where name = 'CompareAuto'`);
    await db.admin.query(`update vt.social_posts set metrics_at = now() - interval '2 days' where external_id in ('M1','M2')`);
    const r = await call(s.accessToken, 'POST', `/tenants/${t!.id}/social/sync`, undefined, { syncBudgetMs: -1 }); // no time for insights
    expect(r.body.meta.warnings.join(' ')).toContain('filled in on the next sync');
    const [m1] = await db.admin.query<{ reach: string }>(`select reach::text as reach from vt.social_posts where external_id = 'M1'`);
    expect(m1!.reach).toBe('60000'); // not wiped
  });

  it('protects the daily job and explains missing setup', async () => {
    expect((await call(null, 'GET', '/cron/social-sync')).status).toBe(401);
    const ok = await handle(new Request('http://localhost/api/cron/social-sync', { headers: { authorization: 'Bearer cron-test' } }), deps());
    expect((await ok.json() as any).ok).toBeGreaterThanOrEqual(2);
    const noApp = await call(s.accessToken, 'POST', `/tenants/${ws}/social/connect/meta`, undefined, { social: { publicUrl: 'https://x' } });
    expect(noApp.body.error).toContain('META_APP_ID');
    const noKey = await call(s.accessToken, 'POST', `/tenants/${ws}/social/connect/meta`, undefined, { secretKey: undefined });
    expect(noKey.body.error).toContain('VTOLOGY_SECRET_KEY');
  });

  it('encrypts with authentication: tampering is detected', () => {
    const sealed = encrypt(SECRET, 'hello');
    expect(decrypt(SECRET, sealed)).toBe('hello');
    expect(() => decrypt('another-secret-another-secret-another', sealed)).toThrow();
  });
});
