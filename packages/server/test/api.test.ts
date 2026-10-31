import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { handle, type Db } from '@vtology/server';
import { createTestDb } from './helpers/pglite';

const SECRET = 'test-secret-at-least-32-characters-long!';
const NOW = new Date('2026-10-31T06:00:00Z');
let db: Db;
let tenant: string;
const users: Record<string, string> = {};
const partners: Record<string, string> = {};

async function token(userId: string) {
  return new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(SECRET));
}
async function call(user: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (user) headers.authorization = `Bearer ${await token(users[user]!)}`;
  const res = await handle(new Request(`http://localhost/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), { db, jwtSecret: SECRET, now: () => NOW });
  return { status: res.status, body: await res.json() as any };
}
const T = (p: string) => `/tenants/${tenant}${p}`;

beforeAll(async () => {
  ({ db } = await createTestDb());
  const [t] = await db.admin.query<{ id: string }>(`insert into vt.tenants (name, industry, phone_salt) values ('Vegaa Motors', 'Automotive', 'salt') returning id`);
  tenant = t!.id;
  for (const r of ['marketing_head', 'sales_ops', 'data_steward', 'finance']) {
    users[r] = randomUUID();
    await db.admin.query(`insert into vt.memberships (tenant_id, user_id, role) values ($1,$2,$3)`, [tenant, users[r], r]);
  }
});

describe('Vtology API, end to end', () => {
  it('rejects anonymous and non-member callers', async () => {
    expect((await call(null, 'GET', T('/me'))).status).toBe(401);
    users.stranger = randomUUID();
    expect((await call('stranger', 'GET', T('/me'))).status).toBe(403);
  });

  it('imports partners, campaigns, leads, journey events and sales through field mappings', async () => {
    let r = await call('data_steward', 'POST', T('/imports'), {
      mapping: { entity: 'partner', sourceSystem: 'Dealer master', fields: { external_code: 'Code', name: 'Dealer', partner_type: { default: 'Dealer' }, city: 'City' } },
      csv: 'Code,Dealer,City\nD1,Vegaa Andheri,Mumbai\nD2,Vegaa Whitefield,Bengaluru\nD3,Vegaa Pune City,Pune',
    });
    expect(r.status).toBe(201);
    expect(r.body.imported).toBe(3);
    for (const row of await db.admin.query<{ id: string; external_code: string }>(`select id, external_code from vt.partners`)) partners[row.external_code] = row.id;

    r = await call('marketing_head', 'POST', T('/imports'), {
      mapping: { entity: 'campaign', sourceSystem: 'Google Ads', fields: { external_code: 'Campaign ID', name: 'Campaign', channel: 'Channel', spend_inr: { column: 'Cost (₹)', transform: 'number' } } },
      csv: 'Campaign ID,Campaign,Channel,Cost (₹)\nC1,Festive Drive,Google Search,"5,00,000"\nC2,Ghost Campaign,Meta,"3,00,000"',
    });
    expect(r.body.imported).toBe(2);

    r = await call('data_steward', 'POST', T('/imports'), {
      mapping: { entity: 'lead', sourceSystem: 'Web configurator', fields: { external_id: 'Lead', name: 'Name', phone: 'Mobile', pincode: 'PIN', book_code: 'Book' } },
      csv: [
        'Lead,Name,Mobile,PIN,Book',
        'L1,Meera Bose,+91 98200 11111,411001,',
        'L2,Meera,09820011111,411001,',
        'L3,Rohan Shah,9820022222,400053,B1',
        'L4,Arjun K,9820099999,560001,', 'L5,Kavya N,9820099999,560001,', 'L6,Rohit P,9820099999,560001,', 'L7,Sana M,9820099999,560001,', 'L8,Tara V,9820099999,560001,',
        'L9,Amit Rao,9820033333,411014,',
        'L10,Bad Phone,12345,411014,',
      ].join('\n'),
    });
    expect(r.body).toMatchObject({ imported: 10, rowCount: 10 });
    expect(r.body.errors).toEqual([{ row: 11, field: 'phone', message: '"12345" is not a valid Indian mobile number; kept without a phone' }]);
    const raw = await db.admin.query<{ n: number }>(`select count(*)::int as n from vt.source_records where phone_hash like '%9820%'`);
    expect(raw[0]!.n).toBe(0); // only hashes are stored

    r = await call('data_steward', 'POST', T('/imports'), {
      mapping: { entity: 'journey_event', sourceSystem: 'Dealer DMS', fields: { journey_ref: 'Enquiry', person_ref: 'Lead', partner_code: 'Dealer', campaign_code: 'Campaign', stage: 'Status', occurred_at: { column: 'Date', transform: 'date' }, crm_converted: { column: 'CRM won', transform: 'bool' } } },
      csv: [
        'Enquiry,Lead,Dealer,Campaign,Status,Date,CRM won',
        'J1,L1,D2,C1,Inquiry,01/10/2026,no',
        'J1,L1,D2,C1,Dealer contacted,05/10/2026,no',
        'J2,L3,D2,C1,Test drive,10/10/2026,no',
        'J3,L9,D1,C1,Booking,01/09/2026,yes',
        'J4,L9,D9,C1,Inquiry,01/10/2026,no',
      ].join('\n'),
    });
    expect(r.body.imported).toBe(4);
    expect(r.body.errors[0]).toMatchObject({ row: 6, message: 'unknown partner code "D9"; import partners first' });

    r = await call('data_steward', 'POST', T('/imports'), {
      mapping: { entity: 'transaction', sourceSystem: 'Dealer DMS', fields: { external_ref: 'Invoice', partner_code: 'Dealer', occurred_at: { column: 'Date', transform: 'date' }, value_inr: { column: 'Amount', transform: 'number' } } },
      csv: 'Invoice,Dealer,Date,Amount\nINV-1,D1,20/10/2026,"9,00,000"',
    });
    expect(r.body.imported).toBe(1);
  });

  it('only some roles may import', async () => {
    const r = await call('finance', 'POST', T('/imports'), { mapping: { entity: 'partner', sourceSystem: 'x', fields: { external_code: 'a', name: 'b', partner_type: 'c' } }, csv: 'a,b,c\n1,2,3' });
    expect(r.status).toBe(403);
  });

  it('resolves identities, links journeys and runs the detectors', async () => {
    const r = await call('data_steward', 'POST', T('/pipeline/run'));
    expect(r.status).toBe(200);
    expect(r.body.stats).toMatchObject({ records: 10, heldForReview: 5, journeysLinked: 3 });
    // L1 and L2 became one person; the five shared-phone records stay apart
    expect(r.body.stats.parties).toBe(9);

    const v = await call('finance', 'GET', T('/violations'));
    const rules = v.body.map((x: any) => `${x.rule}:${x.entity_ref}`).sort();
    expect(rules).toContain('phantom_conversion:J3');
    expect(rules).toContain('orphan_transaction:INV-1');
    expect(rules).toContain('unattributed_spend:C2');
    expect(rules.some((x: string) => x.startsWith('shared_identifier:phone:'))).toBe(true);
    expect(v.body.find((x: any) => x.rule === 'unattributed_spend').value_inr).toBe('300000');
    // Sales ops cannot see money
    const s = await call('sales_ops', 'GET', T('/violations'));
    expect(s.body.find((x: any) => x.rule === 'unattributed_spend').value_inr).toBeNull();
  });

  it('shows each role only what it may see', async () => {
    users.partner = randomUUID(); users.rm = randomUUID();
    await db.admin.query(`insert into vt.memberships (tenant_id, user_id, role, partner_id) values ($1,$2,'partner_user',$3)`, [tenant, users.partner, partners.D2]);
    await db.admin.query(`insert into vt.memberships (tenant_id, user_id, role, book_code) values ($1,$2,'relationship_manager','B1')`, [tenant, users.rm]);

    const ops = await call('sales_ops', 'GET', T('/journeys?stalled=true'));
    expect(ops.body.map((j: any) => j.externalRef).sort()).toEqual(['J1', 'J2']);
    expect(ops.body.find((j: any) => j.externalRef === 'J1')).toMatchObject({ party: 'Meera Bose', partner: 'Vegaa Whitefield', stage: 'Dealer contacted', daysIdle: 26, slaDays: 7 });

    const mh = await call('marketing_head', 'GET', T('/journeys?stalled=true'));
    expect(mh.body.find((j: any) => j.externalRef === 'J1').party).toBe('M••• B•••');

    const partner = await call('partner', 'GET', T('/journeys'));
    expect(partner.body.map((j: any) => j.externalRef).sort()).toEqual(['J1', 'J2']);
    expect((await call('partner', 'GET', T('/partners'))).body.map((p: any) => p.name)).toEqual(['Vegaa Whitefield']);
    expect((await call('partner', 'GET', T('/violations'))).body).toEqual([]);

    const rm = await call('rm', 'GET', T('/journeys'));
    expect(rm.body.map((j: any) => j.externalRef)).toEqual(['J2']);

    expect((await call('finance', 'GET', T('/journeys'))).body).toEqual([]);
  });

  it('runs a governed action: partner requests, finance cannot approve, sales ops approves, writeback is queued', async () => {
    const j1 = (await call('partner', 'GET', T('/journeys'))).body.find((j: any) => j.externalRef === 'J1');
    const req = await call('partner', 'POST', T('/actions'), { type: 'reassign_journey', objectId: j1.id, newPartnerId: partners.D3, reason: 'We cannot reach the customer' });
    expect(req.status).toBe(201);
    expect(req.body).toMatchObject({ status: 'awaiting_approval', approverRole: 'sales_ops' });
    expect(req.body.rules.every((r: any) => r.pass)).toBe(true);

    expect((await call('finance', 'POST', T(`/actions/${req.body.id}/approve`))).status).toBe(403);
    const ok = await call('sales_ops', 'POST', T(`/actions/${req.body.id}/approve`));
    expect(ok.body.status).toBe('done');
    expect((await call('sales_ops', 'POST', T(`/actions/${req.body.id}/approve`))).status).toBe(409);

    // the partner no longer sees the journey; everyone else sees it at the new dealer, marked as edited
    expect((await call('partner', 'GET', T('/journeys'))).body.map((j: any) => j.externalRef)).toEqual(['J2']);
    const moved = (await call('sales_ops', 'GET', T('/journeys'))).body.find((j: any) => j.externalRef === 'J1');
    expect(moved).toMatchObject({ partner: 'Vegaa Pune City', edited: true });
    // the source data is untouched; the edit and the outbox carry the change
    const src = await db.admin.query<{ partner_id: string }>(`select partner_id from vt.journeys where external_ref = 'J1'`);
    expect(src[0]!.partner_id).toBe(partners.D2);
    const outbox = await db.admin.query<{ target: string }>(`select target from vt.outbox order by target`);
    expect(outbox.map(o => o.target)).toEqual(['crm', 'partner_system']);
    const audit = await db.admin.query(`select 1 from vt.audit_log where table_name = 'action_runs'`);
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('blocks an action whose rules fail, and hides objects outside the requester’s view', async () => {
    const v = (await call('finance', 'GET', T('/violations'))).body.find((x: any) => x.rule === 'shared_identifier');
    const merge = await call('data_steward', 'POST', T('/actions'), { type: 'merge_records', objectId: v.entity_ref });
    expect(merge.body.status).toBe('blocked');
    expect(merge.body.rules.find((r: any) => !r.pass).label).toBe('Names in the cluster are plausibly one person');

    const j3 = (await call('sales_ops', 'GET', T('/journeys'))).body.find((j: any) => j.externalRef === 'J3');
    const sneaky = await call('partner', 'POST', T('/actions'), { type: 'reassign_journey', objectId: j3.id, newPartnerId: partners.D2 });
    expect(sneaky.status).toBe(404);

    const log = await call('sales_ops', 'GET', T('/actions'));
    expect(log.body.map((a: any) => a.status).sort()).toEqual(['blocked', 'done']);
  });
});
