import { describe, it, expect, beforeAll } from 'vitest';
import { handle, type Db } from '@vtology/server';
import { detectPerfColumns, headerLineIndex, perfPlatform, toPerfRows, campaignKind } from '@vtology/core';
import { createTestDb } from './helpers/pglite';

const LOCAL = 'local-secret-for-tests-at-least-32-chars';
const SECRET = 'vtology-test-secret-key-with-at-least-forty-chars!!';
let db: Db;
const deps = () => ({ db, localSecret: LOCAL, secretKey: SECRET, now: () => new Date('2026-11-06T08:00:00Z') });
async function call(token: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await handle(new Request(`http://localhost/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), deps());
  return { status: res.status, body: await res.json() as any };
}
let token = '', T = '';
beforeAll(async () => {
  ({ db } = await createTestDb());
  token = (await call(null, 'POST', '/auth/login', { email: 'sarvesh@vanaya.test', password: 'demo' })).body.accessToken;
  T = `/tenants/${(await call(token, 'POST', '/workspaces', { name: 'CompareAuto', industry: 'Automotive', sample: false })).body.workspace.id}`;
});

describe('reading Google Ads and Meta exports', () => {
  it('finds the header under the title lines and the columns', () => {
    const lines = ['Campaign report', '"1 October 2026 - 31 October 2026"', 'Day,Campaign,Campaign type,Ad group,Currency code,Cost,Impr.,Clicks,Conversions,Conv. value,Search lost IS (budget)'];
    expect(headerLineIndex(lines)).toBe(2);
    const h = lines[2]!.split(',');
    expect(perfPlatform(h)).toBe('google');
    const c = detectPerfColumns(h);
    expect(c).toMatchObject({ day: 'Day', campaign: 'Campaign', campaignType: 'Campaign type', adGroup: 'Ad group', cost: 'Cost', impressions: 'Impr.', clicks: 'Clicks', conversions: 'Conversions', value: 'Conv. value', lostBudget: 'Search lost IS (budget)' });
    const { rows, skipped } = toPerfRows([
      { Day: '2026-10-01', Campaign: 'Brand - Exact', 'Campaign type': 'Search', 'Ad group': 'Brand', Cost: '1,200.50', 'Impr.': '900', Clicks: '300', Conversions: '30', 'Conv. value': '0', 'Search lost IS (budget)': '--' },
      { Day: '2026-10-01', Campaign: 'SUV - Generic', 'Campaign type': 'Search', 'Ad group': 'SUV', Cost: '5000', 'Impr.': '9000', Clicks: '200', Conversions: '5', 'Conv. value': '0', 'Search lost IS (budget)': '35.2%' },
      { Day: 'Total: Account', Campaign: '', 'Campaign type': '', 'Ad group': '', Cost: '6200', 'Impr.': '', Clicks: '', Conversions: '', 'Conv. value': '', 'Search lost IS (budget)': '' },
    ], c, 'google');
    expect(skipped).toBe(1);
    expect(rows[0]).toMatchObject({ day: '2026-10-01', cost: 1200.5, conversions: 30, lostBudget: null, campaignType: 'Search' });
    expect(rows[1]!.lostBudget).toBeCloseTo(0.352);
    expect(perfPlatform(['Reporting starts', 'Campaign name', 'Ad set name', 'Amount spent (INR)', 'Impressions', 'Link clicks', 'Results'])).toBe('meta');
    expect(detectPerfColumns(['Reporting starts', 'Campaign name', 'Ad set name', 'Amount spent (INR)', 'Link clicks', 'Results'])).toMatchObject({ day: 'Reporting starts', campaign: 'Campaign name', adGroup: 'Ad set name', cost: 'Amount spent (INR)', clicks: 'Link clicks', conversions: 'Results' });
    expect(campaignKind('google', '', 'PMax - All cars')).toBe('Performance Max');
    expect(campaignKind('google', '', 'YT_Awareness_Oct')).toBe('YouTube');
  });
});

describe('performance report', () => {
  it('finds waste, the real cost of a lead, and a plan that gets more for the same budget', async () => {
    const day = (i: number) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10);
    const camp = (name: string, type: string, cost: number, conv: number, lost: number | null) => Array.from({ length: 28 }, (_, i) => ({ day: day(i), campaign: name, campaignType: type, adGroup: 'All', cost, impressions: cost * 3, clicks: cost / 20, conversions: conv, value: 0, lostBudget: lost }));
    const rows = [...camp('CompareAuto Brand', 'Search', 1000, 10, null), ...camp('SUV Generic', 'Search', 4000, 4, 0.3), ...camp('PMax All Cars', 'Performance Max', 3000, 6, null), ...camp('GDN Remarketing', 'Display', 600, 0, null), ...camp('Sedan Generic', 'Search', 2000, 0.6, null)];
    const c = await call(token, 'POST', `${T}/performance/reports`, { name: 'Google Ads Oct', platform: 'google', kind: 'campaigns' });
    expect(c.status).toBe(201);
    expect((await call(token, 'POST', `${T}/performance/reports/${c.body.id}/rows`, { rows })).body.refused).toBe(0);
    expect((await call(token, 'POST', `${T}/performance/reports/${c.body.id}/finish`)).body.rows).toBe(140);
    const t = await call(token, 'POST', `${T}/performance/reports`, { name: 'Search terms Oct', platform: 'google', kind: 'terms' });
    await call(token, 'POST', `${T}/performance/reports/${t.body.id}/rows`, { rows: [{ term: 'suv under 15 lakh', campaign: 'SUV Generic', cost: 20000, clicks: 900, conversions: 30 }, { term: 'free car games', campaign: 'SUV Generic', cost: 9000, clicks: 700, conversions: 0 }, { term: 'compareauto', campaign: 'CompareAuto Brand', cost: 3000, clicks: 500, conversions: 0 }] });
    await call(token, 'POST', `${T}/performance/reports/${t.body.id}/finish`);
    const o = (await call(token, 'GET', `${T}/performance?from=2026-10-01&to=2026-10-28`)).body;
    expect(o.totals).toMatchObject({ cost: 296_800, conversions: expect.closeTo(576.8, 1) });
    const titles = o.findings.map((f: any) => f.title);
    expect(titles).toEqual(expect.arrayContaining(['Brand searches make leads look cheaper than they are', '1 campaign spent with nothing to show', 'Searches that cost money and never convert']));
    expect(o.findings.find((f: any) => f.title.startsWith('Searches')).names).toEqual(['free car games']); // brand searches are never suggested as negatives
    const plan = o.plan;
    expect(plan.plan.find((p: any) => p.name === 'GDN Remarketing').change).toBe('pause');
    expect(plan.plan.find((p: any) => p.name === 'Sedan Generic').change).toBe('cut');
    expect(plan.plan.find((p: any) => p.name === 'CompareAuto Brand').change).toBe('raise');
    expect(Math.round(plan.plan.reduce((a: number, p: any) => a + p.next - p.now, 0))).toBe(0); // the same budget
    expect(plan.convNext).toBeGreaterThan(plan.convNow);
  });
});
