import { describe, it, expect, beforeAll } from 'vitest';
import { handle, type Db } from '@vtology/server';
import { guessMedium, detectOfflineColumns, parseAmount, parseDay, toOfflineRows, tidyRegion, mediaLift } from '@vtology/core';
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
  T = `/tenants/${(await call(token, 'POST', '/workspaces', { name: 'Motors', industry: 'Automotive', sample: false })).body.workspace.id}`;
});

// 12 weeks from Mon 3 Aug 2026; TV runs weeks 3-7 (Mumbai and national), print weeks 1-12 in Pune
const monday = (w: number) => new Date(Date.UTC(2026, 7, 3) + w * 7 * 86_400_000);
const dmy = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;

describe('reading agency files', () => {
  it('finds the columns of TV, print and results sheets', () => {
    expect(detectOfflineColumns(['Telecast Date', 'Channel Name', 'Market', 'No. of Spots', 'GRP', 'Duration (sec)', 'Net Cost (₹)'], 'tv'))
      .toEqual({ day: 'Telecast Date', vehicle: 'Channel Name', region: 'Market', units: 'No. of Spots', reach: 'GRP', seconds: 'Duration (sec)', spend: 'Net Cost (₹)' });
    expect(detectOfflineColumns(['Insertion Date', 'Publication', 'Edition', 'Size (sq cm)', 'Readership', 'Amount'], 'print')).toMatchObject({ day: 'Insertion Date', vehicle: 'Publication', region: 'Edition', seconds: 'Size (sq cm)', reach: 'Readership', spend: 'Amount' });
    expect(detectOfflineColumns(['Week', 'City', 'Enquiries', 'Bookings', 'Value'], 'results')).toEqual({ day: 'Week', region: 'City', leads: 'Enquiries', sales: 'Bookings', value: 'Value' });
  });
  it('tells what a file holds from its columns', () => {
    expect(guessMedium(['Telecast Date', 'Channel Name', 'Market', 'No. of Spots', 'GRP', 'Net Cost (₹)'])).toBe('tv');
    expect(guessMedium(['Insertion Date', 'Publication', 'Edition', 'Amount'])).toBe('print');
    expect(guessMedium(['Date', 'Station', 'City', 'Cost'])).toBe('radio');
    expect(guessMedium(['Week', 'City', 'Enquiries', 'Bookings'])).toBe('results');
    expect(guessMedium(['Date', 'Cost'], 'outdoor-oct.xlsx')).toBe('ooh');
    expect(guessMedium(['Date', 'Insertion Order', 'Line Item', 'Impressions', 'Total Media Cost (Advertiser Currency)'])).toBe('digital');
    expect(guessMedium(['Date', 'Cost'])).toBe(null);
  });
  it('reads Indian dates, amounts and place names', () => {
    expect(['06/11/2026', '6-Nov-26', '6 November 2026', 'Nov 6, 2026', '2026-11-06', '46332'].map(parseDay)).toEqual(Array(6).fill('2026-11-06'));
    expect(parseDay('Nov 2026')).toBe('2026-11-01');
    expect(parseDay('31/02/2026')).toBe(null);
    expect(['₹1,25,000', '1.5 lakh', '2cr', '-', '12k'].map(parseAmount)).toEqual([125000, 150000, 2e7, 0, 12000]);
    expect(['BANGALORE', 'bombay', '', 'navi mumbai'].map(tidyRegion)).toEqual(['Bengaluru', 'Mumbai', 'All India', 'Navi Mumbai']);
    const { rows, skipped } = toOfflineRows([{ D: '01/08/2026', C: '₹ 50,000', R: 'Pune' }, { D: 'total', C: '9', R: '' }], { day: 'D', spend: 'C', region: 'R' });
    expect(rows).toEqual([expect.objectContaining({ day: '2026-08-01', spend: 50000, region: 'Pune' })]);
    expect(skipped).toBe(1);
  });
  it('judges a medium only with enough weeks on and off', () => {
    const r = mediaLift([{ week: 'a', medium: 'tv', region: 'All India', spend: 1, reach: 0 }], [{ week: 'a', region: 'x', leads: 5, sales: 0, value: 0 }, { week: 'b', region: 'x', leads: 5, sales: 0, value: 0 }]);
    expect(r.lifts[0]!.verdict).toBe('too_few_weeks');
  });
});

describe('all media together', () => {
  it('imports TV, print and results, and shows lift and where media ran', async () => {
    const send = async (name: string, medium: string, rows: unknown[]) => {
      const c = await call(token, 'POST', `${T}/crossmedia/reports`, { name, medium });
      expect(c.status).toBe(201);
      expect((await call(token, 'POST', `${T}/crossmedia/reports/${c.body.id}/rows`, { rows })).body.refused).toBe(0);
      return call(token, 'POST', `${T}/crossmedia/reports/${c.body.id}/finish`);
    };
    const tvRows = [3, 4, 5, 6, 7].flatMap(w => [{ day: dmy(monday(w)), region: 'Mumbai', vehicle: 'Star Plus', spend: 400000, reach: 12, units: 20 }, { day: dmy(monday(w)), region: '', vehicle: 'Aaj Tak', spend: 200000, reach: 6, units: 10 }])
      .map(r => ({ ...r, day: parseDay(r.day)!, region: tidyRegion(r.region) }));
    expect((await send('TV Aug-Sep', 'tv', [...tvRows, tvRows[0]])).body.rows).toBe(10); // the repeated row adds up, not a new row
    const printRows = Array.from({ length: 12 }, (_, w) => ({ day: monday(w).toISOString().slice(0, 10), region: 'Pune', vehicle: 'Times of India', spend: 150000, reach: 300000, units: 1 }));
    await send('Print Pune', 'print', printRows);
    // leads: higher in TV weeks; Delhi brings leads with no local media; Pune gets print but few leads
    const results = Array.from({ length: 12 }, (_, w) => [
      { day: monday(w).toISOString().slice(0, 10), region: 'Mumbai', leads: w >= 3 && w <= 7 ? 150 : 100 },
      { day: monday(w).toISOString().slice(0, 10), region: 'Delhi', leads: 60 },
      { day: monday(w).toISOString().slice(0, 10), region: 'Pune', leads: 5 },
    ]).flat();
    await send('Leads by city', 'results', results);
    const o = (await call(token, 'GET', `${T}/crossmedia?from=2026-08-01&to=2026-10-31`)).body;
    expect(o.currency).toBe('INR');
    expect(o.measure).toBe('leads');
    expect(o.totals.map((t: any) => t.label)).toEqual(['TV', 'Print']);
    expect(o.totals[0]).toMatchObject({ spend: 3_400_000, weeks: 5 }); // the repeated row counted twice: 2 × 4L in week 3
    const tv = o.lifts.find((l: any) => l.medium === 'tv');
    expect(tv).toMatchObject({ verdict: 'lift', weeksOn: 5, weeksOff: 7, on: 215, off: 165 });
    expect(o.lifts.find((l: any) => l.medium === 'print').verdict).toBe('too_few_weeks'); // it ran every week
    expect(o.findings.map((f: any) => f.title)).toEqual(expect.arrayContaining(['TV weeks brought more leads', 'A region brings leads with no local media', 'Spend is heavy where leads are light']));
    expect(o.regions[0]).toMatchObject({ region: 'Mumbai' });
    expect(o.weeks).toHaveLength(12);
    expect(o.results[3]).toBe(215);
  });
});
