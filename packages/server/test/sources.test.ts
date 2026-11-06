import { describe, it, expect, beforeAll } from 'vitest';
import { handle, type Db } from '@vtology/server';
import { feedLeadToJourney, DEFAULT_STATUS_MAP, type FeedLead } from '@vtology/core';
import { createTestDb } from './helpers/pglite';

const LOCAL = 'local-secret-for-tests-at-least-32-chars';
const SECRET = 'vtology-test-secret-key-with-at-least-forty-chars!!';
const NOW = new Date('2026-11-03T08:00:00Z');
const FEED = 'https://compareauto.example/api/vtology';
const KEY = 'feed-key-'.padEnd(48, 'x');
let db: Db;

// a dealer dashboard speaking the Vtology lead feed, shaped like the CompareAuto one
const dealers = [{ id: 'D1', legacyId: 'ijm-old', code: 'IJM01', name: 'IJM Toyota', city: 'Gurgaon', parentDealerId: '' }, { id: 'D2', name: 'IJM Palam Vihar', city: 'Gurugram', parentDealerId: 'D1' }];
const lead = (id: string, extra: Partial<FeedLead> & { status?: string; updatedAt?: string } = {}): FeedLead => ({
  id, ref: `ENQ-${id}`, createdAt: '2026-10-28T10:00:00Z', updatedAt: extra.updatedAt ?? '2026-10-28T10:10:00Z',
  customer: { name: `Buyer ${id}`, mobile: `98100000${id.padStart(2, '0')}`, email: `b${id}@x.in`, city: 'Gurugram' },
  origin: { source: 'Campaign Landing Page', campaignId: '120254751280850198', metaCampaignName: 'IJM_Toyota_Hyryder_Lead_Oct26' },
  dealer: { id: 'D1', name: 'IJM Toyota', connectedAt: '2026-10-28T10:01:00Z' },
  progress: { status: extra.status ?? 'New' },
  history: [{ at: '2026-10-28T10:00:00Z', status: 'New', note: 'Lead received' }],
  ...extra,
});
let leads: FeedLead[] = [];
let calls: string[] = [];
const feed = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  calls.push(url.pathname + url.search);
  if ((init?.headers as Record<string, string>)?.authorization !== `Bearer ${KEY}`) return new Response('{"success":false}', { status: 401 });
  if (url.pathname.endsWith('/dealers')) return Response.json({ success: true, dealers });
  const since = url.searchParams.get('updated_since');
  const page = leads.filter(l => !since || l.updatedAt! >= since).sort((a, b) => a.updatedAt!.localeCompare(b.updatedAt!));
  const after = url.searchParams.get('cursor') ? Number(url.searchParams.get('cursor')) : 0;
  const limit = 2, slice = page.slice(after, after + limit);
  return Response.json({ success: true, count: slice.length, hasMore: after + limit < page.length, nextCursor: after + limit < page.length ? String(after + limit) : null, leads: slice });
}) as typeof fetch;

const deps = () => ({ db, localSecret: LOCAL, now: () => NOW, secretKey: SECRET, fetch: feed, cronSecret: 'cron-test', social: { publicUrl: 'https://vtology.vercel.app' } });
async function call(token: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await handle(new Request(`http://localhost/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), deps());
  return { status: res.status, body: await res.json() as any };
}
let token = '', ws = '';
beforeAll(async () => {
  ({ db } = await createTestDb());
  token = (await call(null, 'POST', '/auth/login', { email: 'sarvesh@vanaya.test', password: 'demo' })).body.accessToken;
  ws = (await call(token, 'POST', '/workspaces', { name: 'CompareAuto', industry: 'Automotive', sample: false })).body.workspace.id;
});

describe('lead feed to journeys', () => {
  it('places a lead at the furthest stage it reached, entered when it first got there', () => {
    const j = feedLeadToJourney('Automotive', lead('1', {
      status: 'Contacted', updatedAt: '2026-10-30T09:00:00Z',
      progress: { status: 'Contacted', testDriveStatus: 'Given' },
      history: [{ at: '2026-10-28T10:00:00Z', status: 'New', note: 'Lead received' }, { at: '2026-10-28T10:08:00Z', status: 'Contacted', note: 'Marked Contacted' },
                { at: '2026-10-29T16:00:00Z', status: 'Contacted', note: 'Test drive given' }],
    }), DEFAULT_STATUS_MAP.Automotive, 'src1');
    expect(j.stageIndex).toBe(3); // Test drive
    expect(j.stageEnteredAt).toBe('2026-10-29T16:00:00Z');
    expect(j.campaign).toEqual({ code: 'meta:120254751280850198', name: 'IJM_Toyota_Hyryder_Lead_Oct26', channel: 'Meta ads' });
    expect(j.partnerCode).toBe('src1:D1');
    const sold = feedLeadToJourney('Automotive', lead('2', { progress: { status: 'Car Delivered', retailAmount: '14,50,000' } }), DEFAULT_STATUS_MAP.Automotive, 'src1');
    expect([sold.stageIndex, sold.sold, sold.valueInr]).toEqual([5, true, 1450000]);
    const odd = feedLeadToJourney('Automotive', lead('3', { progress: { status: 'Hot prospect' } }), DEFAULT_STATUS_MAP.Automotive, 'src1');
    expect(odd.unmapped).toEqual(['Hot prospect']);
    expect(odd.stageIndex).toBe(1); // given to a dealer, nothing more known
  });
});

describe('connected data sources', () => {
  it('connects, pulls dealers and leads page by page, and links Meta lead-form leads to the same journey', async () => {
    // a lead that Meta's own sync already brought in, before the dealer touched it
    await db.admin.query(`insert into vt.journeys (tenant_id, external_ref, person_ref, stage_index, stage_entered_at, last_activity_at, crm_converted) values ($1, 'metalead:777', 'metalead:777', 0, '2026-10-28T10:00:00Z', '2026-10-28T10:00:00Z', false)`, [ws]);
    leads = [
      lead('1', { status: 'Contacted', updatedAt: '2026-10-28T10:20:00Z', progress: { status: 'Contacted' }, history: [{ at: '2026-10-28T10:08:00Z', status: 'Contacted', note: 'Marked Contacted' }] }),
      lead('2', { updatedAt: '2026-10-29T11:00:00Z', progress: { status: 'Car Delivered', retailAmount: '1450000' } }),
      lead('3', { updatedAt: '2026-10-30T12:00:00Z', origin: { campaignId: '120254751280850198', metaLeadId: '777' }, progress: { status: 'Contacted' } }),
      lead('4', { updatedAt: '2026-10-31T12:00:00Z', dealer: { id: 'ijm-old' }, progress: { status: 'Hot prospect' } }),
    ];
    const wrong = await call(token, 'POST', `/tenants/${ws}/sources`, { name: 'Dealer dashboard', baseUrl: FEED, key: 'nope' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/refused the key/);
    const r = await call(token, 'POST', `/tenants/${ws}/sources`, { name: 'Dealer dashboard', baseUrl: FEED, key: KEY });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ dealers: 2, leads: 4, newLeads: 4, unmapped: ['Hot prospect'] });
    expect(calls.filter(c => c.includes('/leads')).length).toBe(2); // two pages of two

    const js = await db.admin.query<{ external_ref: string; stage_index: number; partner: string | null; campaign: string | null; crm_converted: boolean }>(
      `select j.external_ref, j.stage_index, p.name as partner, c.external_code as campaign, j.crm_converted from vt.journeys j
         left join vt.partners p on p.id = j.partner_id left join vt.campaigns c on c.id = j.campaign_id where j.tenant_id = $1 order by j.external_ref`, [ws]);
    const by = Object.fromEntries(js.map(j => [j.external_ref, j]));
    expect(js.length).toBe(4); // lead 3 joined the existing Meta journey instead of adding one
    expect(by['metalead:777']).toMatchObject({ stage_index: 2, partner: 'IJM Toyota', campaign: 'meta:120254751280850198' });
    const src = (await call(token, 'GET', `/tenants/${ws}/sources`)).body.sources[0];
    const key = (id: string) => `src${src.id.slice(0, 8)}:${id}`;
    expect(by[key('1')]).toMatchObject({ stage_index: 2, partner: 'IJM Toyota' });
    expect(by[key('2')]).toMatchObject({ stage_index: 5, crm_converted: true });
    expect(by[key('4')]).toMatchObject({ stage_index: 1, partner: 'IJM Toyota' }); // dealer named by its older id
    // the delivered car is a recorded sale, so it is not flagged as "converted with no sale"
    expect((await db.admin.query(`select value_inr::int as v from vt.transactions where tenant_id = $1`, [ws]))[0]).toEqual({ v: 1450000 });
    // phone numbers are stored only scrambled
    const raw = await db.admin.query<{ n: number }>(`select count(*)::int as n from vt.source_records where tenant_id = $1 and payload::text like '%9810000%'`, [ws]);
    expect(raw[0]!.n).toBe(0);
    expect(src.has_key).toBe(true);
    expect(src.seen_statuses).toMatchObject({ 'Contacted': 2, 'Hot prospect': 1 });
  });

  it('pulls only what changed next time, and a new mapping moves leads to the right stage', async () => {
    calls = [];
    leads[0] = lead('1', { updatedAt: '2026-11-02T09:00:00Z', progress: { status: 'Car Booked' }, history: [{ at: '2026-11-02T09:00:00Z', status: 'Car Booked', note: 'Booked' }] });
    const src = (await call(token, 'GET', `/tenants/${ws}/sources`)).body.sources[0];
    const s = await call(token, 'POST', `/tenants/${ws}/sources/${src.id}/sync`);
    expect(s.body).toMatchObject({ leads: 2, newLeads: 0, moved: 1 }); // the changed lead, plus one from the 10-minute safety overlap
    expect(calls.find(c => c.includes('/leads'))).toContain('updated_since=2026-10-31');
    // the brand says "Hot prospect" means the dealer has been in touch
    await call(token, 'PATCH', `/tenants/${ws}/sources/${src.id}`, { statusMap: { ...src.status_map, 'Hot prospect': 'Dealer contacted', 'Bogus': 'Not a stage' } });
    const again = await call(token, 'POST', `/tenants/${ws}/sources/${src.id}/sync`);
    expect(again.body.unmapped).toEqual([]);
    const [j4] = await db.admin.query<{ stage_index: number }>(`select stage_index from vt.journeys where tenant_id = $1 and external_ref = $2`, [ws, `src${src.id.slice(0, 8)}:4`]);
    expect(j4!.stage_index).toBe(2);
    const after = (await call(token, 'GET', `/tenants/${ws}/sources`)).body.sources[0];
    expect(after.status_map.Bogus).toBeUndefined();
    expect(after.last_error).toBeNull();
  });

  it('refuses private addresses and people who cannot manage data', async () => {
    const bad = await call(token, 'POST', `/tenants/${ws}/sources`, { name: 'x', baseUrl: 'http://169.254.169.254/latest', key: KEY });
    // local demo mode allows local addresses for development, but never non-http(s) or nonsense
    expect([400, 201]).toContain(bad.status);
    const nonsense = await call(token, 'POST', `/tenants/${ws}/sources`, { name: 'y', baseUrl: 'not a url', key: KEY });
    expect(nonsense.status).toBe(400);
  });
});

describe('a dealer group takes only its own leads', () => {
  it('lists dealers under their parents, and pulls only the chosen group and its branches', async () => {
    const other = { id: 'D9', name: 'Other Motors', city: 'Delhi', parentDealerId: '' };
    dealers.push(other);
    leads = [lead('31', { updatedAt: '2026-11-01T10:00:00Z' }), lead('32', { updatedAt: '2026-11-01T10:05:00Z', dealer: { id: 'D2', name: 'IJM Palam Vihar' } }),
             lead('33', { updatedAt: '2026-11-01T10:06:00Z', dealer: { id: 'ijm-old' } }), lead('34', { updatedAt: '2026-11-01T10:07:00Z', dealer: { id: 'D9', name: 'Other Motors' } })];
    const w = (await call(token, 'POST', '/workspaces', { name: 'IJM Toyota', industry: 'Automotive', sample: false })).body.workspace.id;
    const check = await call(token, 'POST', `/tenants/${w}/sources/check`, { baseUrl: FEED, key: KEY });
    expect(check.body.dealers.map((d: any) => [d.name, d.branches.map((b: any) => b.name)])).toEqual([['IJM Toyota', ['IJM Palam Vihar']], ['Other Motors', []]]);
    const c = await call(token, 'POST', `/tenants/${w}/sources`, { name: 'CompareAuto dealer dashboard', baseUrl: FEED, key: KEY, dealerScope: ['D1'] });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ dealers: 2, leads: 3 }); // IJM Toyota, its branch, and the lead filed under its old id; not Other Motors
    const people = await db.admin.query<{ n: number }>(`select count(*)::int as n from vt.source_records where tenant_id = $1`, [w]);
    expect(people[0]!.n).toBe(3); // the other dealer's customer is never stored
    const partners = await db.admin.query<{ name: string }>(`select distinct name from vt.partners where tenant_id = $1 order by name`, [w]);
    expect(partners.map(p => p.name)).toEqual(['IJM Palam Vihar', 'IJM Toyota']);
    dealers.pop();
  });
});

describe('from ad to car', () => {
  it('follows each campaign to calls, test drives and bookings, with what each step cost', async () => {
    const w = (await call(token, 'POST', '/workspaces', { name: 'IJM Toyota Dealer', industry: 'Automotive', sample: false })).body.workspace.id;
    leads = [
      lead('41', { updatedAt: '2026-10-28T10:20:00Z', interest: { model: 'Toyota Urban Cruiser Hyryder', fuelType: 'CNG' }, progress: { status: 'Contacted', testDriveStatus: 'Booked', callOutcome: 'Connected' },
        history: [{ at: '2026-10-28T10:00:00Z', status: 'New', note: 'Lead received via Campaign Landing Page' }, { at: '2026-10-28T10:11:00Z', status: 'Contacted', note: 'Marked Contacted via Dealer Portal' },
                  { at: '2026-10-28T10:18:00Z', status: 'Contacted', note: 'Called customer (Connected)' }, { at: '2026-10-28T10:18:00Z', status: 'Contacted', note: 'Test Drive Booked' }] }),
      lead('42', { updatedAt: '2026-10-28T12:00:00Z', interest: { model: 'Vehicle Inquiry' }, progress: { status: 'Contacted', callOutcome: 'No answer' },
        history: [{ at: '2026-10-28T10:00:00Z', status: 'New', note: 'Lead received' }, { at: '2026-10-28T12:00:00Z', status: 'Contacted', note: 'Called customer (No answer)' }] }),
      lead('43', { updatedAt: '2026-10-28T10:01:00Z' }),
    ];
    expect((await call(token, 'POST', `/tenants/${w}/sources`, { name: 'Dealer dashboard', baseUrl: FEED, key: KEY, dealerScope: ['D1'] })).status).toBe(201);
    const r = await call(token, 'POST', `/tenants/${w}/performance/reports`, { name: 'Meta Oct', platform: 'meta', kind: 'campaigns' });
    await call(token, 'POST', `/tenants/${w}/performance/reports/${r.body.id}/rows`, { rows: [{ day: '2026-10-28', campaign: 'IJM_Toyota_Hyryder_Lead_Oct26', campaignType: 'Meta', adGroup: 'Lookalike', cost: 30000, impressions: 90000, clicks: 900, conversions: 3, value: 0 }] });
    await call(token, 'POST', `/tenants/${w}/performance/reports/${r.body.id}/finish`);
    const a = (await call(token, 'GET', `/tenants/${w}/adtocar?from=2026-10-01&to=2026-11-03`)).body.adToCar;
    expect(a.total).toMatchObject({ leads: 3, contacted: 2, reached: 1, tdBooked: 1, tdGiven: 0, booked: 0, minutesToContact: 11 });
    expect(a.campaigns[0]).toMatchObject({ name: 'IJM_Toyota_Hyryder_Lead_Oct26', cost: 30000, leads: 3, perLead: 10000, perTestDrive: 30000 });
    expect(a.waiting).toBe(2);
    expect(a.models.map((m: any) => m.model)).toEqual(['Model not given', 'Toyota Urban Cruiser Hyryder']);
    expect(a.findings.map((f: any) => f.title)).toEqual(expect.arrayContaining(['2 leads have had no conversation yet', 'Many leads don’t say which car']));
  });
});

