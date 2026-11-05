import { describe, it, expect, beforeAll } from 'vitest';
import { handle, type Db } from '@vtology/server';
import { channelOf, detectMediaColumns, parseCsv, sampleMediaCsv, toMediaRows, SAMPLE_MEDIA_HEADER } from '@vtology/core';
import { createTestDb } from './helpers/pglite';

const LOCAL = 'local-secret-for-tests-at-least-32-chars';
let db: Db;
const NOW = new Date('2026-11-05T08:00:00Z');
const deps = () => ({ db, localSecret: LOCAL, now: () => NOW });
async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await handle(new Request(`http://localhost/api${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }), deps());
  return { status: res.status, body: await res.json() as any };
}
let token = '', T = '';
beforeAll(async () => {
  ({ db } = await createTestDb());
  const login = await handle(new Request('http://localhost/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sarvesh@vanaya.test', password: 'demo' }) }), deps());
  token = ((await login.json()) as any).accessToken;
  T = `/tenants/${(await call(token, 'POST', '/workspaces', { name: 'Northline Canada', industry: 'Automotive', sample: false })).body.workspace.id}`;
});

describe('reading DSP reports', () => {
  it('finds DV360 columns, skips the footer and sorts lines into channels', () => {
    const cols = detectMediaColumns(SAMPLE_MEDIA_HEADER);
    expect(cols).toMatchObject({ day: ['Date'], campaign: ['Insertion Order'], lineItem: ['Line Item'], inventorySource: ['Inventory Source'], site: ['App/URL'],
      cost: ['Total Media Cost (Advertiser Currency)'], viewable: ['Active View: Viewable Impressions'], audible: ['Active View: Audible and Visible at Completion'], completes: ['Complete Views (Video)'], q2: ['Midpoint Views (Video)'] });
    const raw = parseCsv(sampleMediaCsv('2026-11-04'));
    const { rows, skipped } = toMediaRows(raw, cols);
    expect(skipped).toBeGreaterThan(0); // footer lines
    expect(new Set(rows.map(r => r.channel))).toEqual(new Set(['ctv', 'video', 'audio']));
    expect(rows.find(r => r.supply === 'TC-CTV-PREMIUM-CA')!.deal).toBe(true);
    expect(rows.find(r => r.lineItem === 'CTV | Open auction')!.supply).toBe('Open auction');
    expect(rows[0]!.currency).toBe('CAD');
    expect(channelOf({ device: 'Connected TV', lineItemType: 'Video' })).toBe('ctv');
    expect(channelOf({ lineItemType: 'Audio' })).toBe('audio');
    expect(detectMediaColumns(['Date', 'Media Cost (Advertiser Currency)', 'Total Media Cost (Advertiser Currency)']).cost).toEqual(['Total Media Cost (Advertiser Currency)']);
  });
});

describe('media reports', () => {
  it('imports a report in chunks and finds what an awareness planner should change', async () => {
    const { rows } = toMediaRows(parseCsv(sampleMediaCsv('2026-11-04')), detectMediaColumns(SAMPLE_MEDIA_HEADER));
    const r = await call(token, 'POST', `${T}/media/reports`, { name: 'Northline Q4', currency: '' });
    expect(r.status).toBe(201);
    for (let i = 0; i < rows.length; i += 2000) expect((await call(token, 'POST', `${T}/media/reports/${r.body.id}/rows`, { rows: rows.slice(i, i + 2000) })).body.refused).toBe(0);
    const bad = await call(token, 'POST', `${T}/media/reports/${r.body.id}/rows`, { rows: [{ day: 'yesterday', channel: 'ctv' }, { day: '2026-10-01', channel: 'tv' }, { day: '2026-10-01', channel: 'ctv', cost: -4 }] });
    expect(bad.body).toEqual({ accepted: 0, refused: 3 });
    const f = await call(token, 'POST', `${T}/media/reports/${r.body.id}/finish`);
    expect(f.body).toMatchObject({ rows: rows.length, from: '2026-09-17', to: '2026-11-04', overlaps: [] });

    const m = (await call(token, 'GET', `${T}/media?from=2026-09-17&to=2026-11-04`)).body;
    expect(m.currency).toBe('CAD');
    expect(Math.round(m.total.cost)).toBe(Math.round(rows.reduce((a, x) => a + x.cost, 0)));
    expect(m.channels.map((c: any) => c.channel).sort()).toEqual(['audio', 'ctv', 'video']);
    const ctv = m.channels.find((c: any) => c.channel === 'ctv');
    expect(ctv.viewability).toBeNull(); // CTV can't be measured for viewability
    expect(ctv.quartiles.map((q: any) => q.at)).toEqual(['Start', '25%', '50%', '75%', '100%']);
    const titles = m.findings.map((x: any) => x.title).join('\n');
    expect(titles).toMatch(/Online video: Open auction costs .* per completed view as TC-OLV-AUTO-CA/);
    expect(titles).toMatch(/completed views cost \d+% less on Smart Phone than on Desktop/);
    expect(titles).toMatch(/Online video: private deals beat open auction/);
    expect(titles).toMatch(/sites and apps take/);
    expect(titles).toMatch(/creative is wearing out/);
    expect(titles).toMatch(/One region costs far more/);
    const block = m.findings.find((x: any) => /Online video: .* sites and apps/.test(x.title));
    expect(block.names).toEqual(expect.arrayContaining(['quickrecipes-daily.info', 'top10-slideshow.net']));
    // a channel filter and a narrower range, compared with the same number of days before
    const c = (await call(token, 'GET', `${T}/media?from=2026-10-22&to=2026-11-04&channel=ctv`)).body;
    expect(c.channels).toHaveLength(1);
    expect(c.previousRange).toEqual({ from: '2026-10-08', to: '2026-10-21' });
    expect(c.previous.cost).toBeGreaterThan(0);
    expect(c.trend).toHaveLength(14);
    expect(m.creativeTrend.find((x: any) => x.creative === 'Nautica 30s Hero').status).toBe('wearing out');
  });

  it('refuses to add mixed currencies together and warns about overlapping reports', async () => {
    const { rows } = toMediaRows(parseCsv(sampleMediaCsv('2026-10-20', 7)), detectMediaColumns(SAMPLE_MEDIA_HEADER), 'USD');
    const r = await call(token, 'POST', `${T}/media/reports`, { name: 'US test', currency: 'USD' });
    await call(token, 'POST', `${T}/media/reports/${r.body.id}/rows`, { rows: rows.map(x => ({ ...x, currency: 'USD' })) });
    const f = await call(token, 'POST', `${T}/media/reports/${r.body.id}/finish`);
    expect(f.body.overlaps).toEqual(['Northline Q4']);
    const m = (await call(token, 'GET', `${T}/media?from=2026-09-17&to=2026-11-04`)).body;
    expect(m).toMatchObject({ empty: true, mixed: true });
    const one = (await call(token, 'GET', `${T}/media?from=2026-09-17&to=2026-11-04&report=${r.body.id}`)).body;
    expect(one.currency).toBe('USD');
    expect((await call(token, 'DELETE', `${T}/media/reports/${r.body.id}`)).body.removed).toBe(true);
  });
});

describe('reach reports', () => {
  it('reads people reached per line and day, and flags lines showing the ad too often', async () => {
    const { isReachReport, toReachRows } = await import('@vtology/core');
    const header = ['Advertiser', 'Advertiser Currency', 'Campaign', 'Insertion Order', 'Date', 'Impressions', 'Clicks', 'Total Media Cost (Advertiser Currency)', 'Unique Reach: Total Reach'];
    const cols = detectMediaColumns(header);
    expect(isReachReport(cols)).toBe(true);
    const raw = Array.from({ length: 10 }, (_, i) => ({ Date: `2026/10/${String(i + 1).padStart(2, '0')}`, 'Insertion Order': 'Navigator CTV', Impressions: '12000', 'Total Media Cost (Advertiser Currency)': '60', 'Unique Reach: Total Reach': '2000' }))
      .concat(Array.from({ length: 10 }, (_, i) => ({ Date: `2026/10/${String(i + 1).padStart(2, '0')}`, 'Insertion Order': 'Navigator YouTube', Impressions: '20000', 'Total Media Cost (Advertiser Currency)': '70', 'Unique Reach: Total Reach': '19000' })))
      .concat([{ Date: '45940', 'Insertion Order': 'Navigator YouTube', Impressions: '1', 'Total Media Cost (Advertiser Currency)': '0', 'Unique Reach: Total Reach': '-' }]) as Record<string, string>[];
    const { rows } = toReachRows(raw, cols);
    expect(rows.at(-1)!.day).toBe('2025-10-10'); // Excel date number
    const r = await call(token, 'POST', `${T}/media/reports`, { name: 'Reach Oct', kind: 'reach', currency: 'CAD' });
    expect((await call(token, 'POST', `${T}/media/reports/${r.body.id}/rows`, { rows })).body.accepted).toBe(21);
    await call(token, 'POST', `${T}/media/reports/${r.body.id}/finish`);
    const m = (await call(token, 'GET', `${T}/media?from=2026-10-01&to=2026-10-31`)).body;
    const ctv = m.frequency.find((l: any) => l.campaign === 'Navigator CTV');
    expect(ctv).toMatchObject({ channel: 'ctv', days: 10, dailyReach: 2000, dailyFrequency: 6 });
    expect(m.frequencyFindings[0].title).toMatch(/Navigator CTV: each person saw the ad 6\.0 times a day/);
    expect(m.frequencyFindings.some((f: any) => /YouTube/.test(f.title))).toBe(false);
  });
});

describe('squeezing reports', () => {
  it('merges repeated rows and groups tiny sites without changing any total', async () => {
    const { squeezeMediaRows } = await import('@vtology/core');
    const { rows } = toMediaRows(parseCsv(sampleMediaCsv('2026-11-04')), detectMediaColumns(SAMPLE_MEDIA_HEADER));
    const tiny = rows.slice(0, 50).map((r, i) => ({ ...r, site: `tiny-${i}.example`, impressions: 1, cost: 0.001, completes: 1, starts: 1 }));
    const all = [...rows, ...rows.slice(0, 500), ...tiny];
    const s = squeezeMediaRows(all);
    expect(s.rows.length).toBeLessThan(all.length);
    expect(s.tailSites).toBe(50);
    for (const k of ['impressions', 'cost', 'completes', 'viewable'] as const) expect(s.rows.reduce((a, r) => a + r[k], 0)).toBeCloseTo(all.reduce((a, r) => a + r[k], 0), 6);
  });
});
