import { describe, it, expect } from 'vitest';
import {
  normalizePhone, hashValue, parseCsv, applyMapping, resolveIdentities, nameSimilarity,
  journeyStatus, detectViolations, partnerScorecard, evaluateAction, canDecide, stageIndexByName,
  type JourneyRow,
} from '@vtology/core';

describe('hashing', () => {
  it('normalises Indian mobile numbers in common formats', () => {
    expect(normalizePhone('+91 98200 12345')).toBe('9820012345');
    expect(normalizePhone('09820012345')).toBe('9820012345');
    expect(normalizePhone('919820012345')).toBe('9820012345');
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('5820012345')).toBeNull();
  });
  it('hashes deterministically per tenant salt', async () => {
    const a = await hashValue('salt1', 'phone', '9820012345');
    expect(a).toBe(await hashValue('salt1', 'phone', '9820012345'));
    expect(a).not.toBe(await hashValue('salt2', 'phone', '9820012345'));
    expect(a).toMatch(/^phone_[0-9a-f]{32}$/);
  });
});

describe('mapping', () => {
  const csv = `Lead ID,Customer Name,Mobile,Pin,Created\nL1,Meera Bose,+91 98200 12345,411001,05/10/2026\nL2,,9820012345,411001,06/10/2026\nL3,Rohan Shah,9820099999,400053,not a date`;
  const mapping = { entity: 'lead' as const, sourceSystem: 'Web forms', fields: { external_id: 'Lead ID', name: 'Customer Name', phone: 'Mobile', pincode: 'Pin', created_at: { column: 'Created', transform: 'date' as const } } };
  it('maps rows and reports row-level errors with spreadsheet row numbers', () => {
    const r = applyMapping(parseCsv(csv), mapping);
    expect(r.rowCount).toBe(3);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ external_id: 'L1', name: 'Meera Bose', created_at: '2026-10-05T00:00:00.000Z', source_system: 'Web forms' });
    expect(r.errors).toEqual([
      { row: 3, field: 'name', message: 'missing value in column "Customer Name"' },
      { row: 4, field: 'created_at', message: '"not a date" is not a date' },
    ]);
  });
  it('rejects mappings with unknown or missing required fields', () => {
    expect(() => applyMapping([], { entity: 'lead', sourceSystem: 'x', fields: { external_id: 'a', name: 'b', shoe_size: 'c' } })).toThrow(/Unknown field/);
    expect(() => applyMapping([], { entity: 'lead', sourceSystem: 'x', fields: { external_id: 'a' } })).toThrow(/missing required/);
  });
});

describe('identity resolution', () => {
  it('scores name variants', () => {
    expect(nameSimilarity('Meera Bose', 'MEERA BOSE')).toBe(1);
    expect(nameSimilarity('Meera', 'Meera Bose')).toBeGreaterThanOrEqual(0.9);
    expect(nameSimilarity('Meera Bose', 'Rahul Shah')).toBeLessThan(0.7);
  });
  it('links on shared phone, stops at conflicting government IDs, and holds shared identifiers', () => {
    const r = resolveIdentities([
      { id: 'a', name: 'Meera Bose', phoneHash: 'p1', pincode: '411001' },
      { id: 'b', name: 'Meera', phoneHash: 'p1', pincode: '411001' },
      { id: 'c', name: 'MEERA BOSE', emailHash: 'e1', pincode: '411001' },
      // same phone as d, different PAN: must never merge
      { id: 'd', name: 'Amit Rao', phoneHash: 'p2', govIdHash: 'g1' },
      { id: 'e', name: 'Amit Rao', phoneHash: 'p2', govIdHash: 'g2' },
      // one phone under five different names: shared identifier
      ...['Arjun K', 'Kavya N', 'Rohit P', 'Sana M', 'Tara V'].map((n, i) => ({ id: `s${i}`, name: n, phoneHash: 'shared' })),
    ]);
    const cluster = (id: string) => r.assignments.find(a => a.recordId === id)!.clusterId;
    expect(cluster('a')).toBe(cluster('b'));
    expect(cluster('a')).toBe(cluster('c')); // probabilistic: same pin code, same name
    expect(cluster('d')).not.toBe(cluster('e'));
    expect(r.review.some(x => x.kind === 'gov_id_conflict')).toBe(true);
    expect(r.sharedIdentifiers).toEqual([{ identifier: 'phone:shared', names: 5, records: 5 }]);
    expect(r.assignments.filter(a => a.method === 'held_for_review')).toHaveLength(5);
    expect(r.assignments.find(a => a.recordId === 'c')!.method).toBe('probabilistic');
  });
});

describe('journey rules and detectors', () => {
  const now = new Date('2026-10-31T00:00:00Z');
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const j = (o: Partial<JourneyRow>): JourneyRow => ({ id: 'j', externalRef: 'J', partyId: 'p', campaignId: 'c1', partnerId: 'd1', stageIndex: 2, stageEnteredAt: daysAgo(10), lastActivityAt: daysAgo(10), crmConverted: false, ...o });

  it('flags a journey idle past its stage limit, never a converted or final one', () => {
    expect(journeyStatus('Automotive', j({}), now)).toMatchObject({ stage: 'Dealer contacted', stalled: true, daysIdle: 10, slaDays: 7 });
    expect(journeyStatus('Automotive', j({ lastActivityAt: daysAgo(3) }), now).stalled).toBe(false);
    expect(journeyStatus('Automotive', j({ stageIndex: 5, lastActivityAt: daysAgo(400) }), now).stalled).toBe(false);
    expect(journeyStatus('FMCG', j({ stageIndex: 0, lastActivityAt: daysAgo(90) }), now).stalled).toBe(false);
    expect(stageIndexByName('BFSI', 'kyc')).toBe(1);
  });

  it('detects phantom conversions, orphan sales, unattributed spend and stalled partners', () => {
    const journeys = [
      j({ id: 'j1', externalRef: 'J1', crmConverted: true, stageIndex: 4, stageEnteredAt: daysAgo(60) }),
      j({ id: 'j2', externalRef: 'J2', crmConverted: true, stageIndex: 4, stageEnteredAt: daysAgo(60) }),
      ...Array.from({ length: 12 }, (_, i) => j({ id: `s${i}`, externalRef: `S${i}`, partnerId: 'd2', lastActivityAt: daysAgo(i < 8 ? 20 : 1) })),
    ];
    const findings = detectViolations({
      industry: 'Automotive', now, journeys,
      transactions: [
        { id: 't1', externalRef: 'T1', journeyId: 'j1', partnerId: 'd1', occurredAt: daysAgo(58), valueInr: 900000 },
        { id: 't2', externalRef: 'T2', journeyId: null, partnerId: 'd1', occurredAt: daysAgo(5), valueInr: 850000 },
      ],
      campaigns: [{ id: 'c1', externalCode: 'C1', name: 'Festive', spendInr: 100 }, { id: 'c2', externalCode: 'C2', name: 'Ghost', spendInr: 500000 }],
      partners: [{ id: 'd1', name: 'Dealer One' }, { id: 'd2', name: 'Dealer Two' }],
      avgConversionValueInr: 70000,
    });
    const rules = findings.map(f => `${f.rule}:${f.entityRef}`).sort();
    expect(rules).toEqual(['idle_opportunity:Dealer Two', 'orphan_transaction:T2', 'phantom_conversion:J2', 'unattributed_spend:C2']);
    const card = partnerScorecard('Automotive', journeys, [{ id: 'd2', name: 'Dealer Two' }], now);
    expect(card[0]).toMatchObject({ journeys: 12, stalled: 8 });
  });
});

describe('governed actions', () => {
  const ctx = {
    journey: { id: 'j1', externalRef: 'J1', stage: 'Test drive', converted: false, daysIdle: 15, slaDays: 10, currentPartnerId: 'd1', partyLabel: 'Meera Bose' },
    newPartner: { id: 'd2', name: 'Dealer Two', active: true, stalledShare: 0.2 },
  };
  it('runs when rules pass and the role is allowed, with edits and outbox', () => {
    const e = evaluateAction('reassign_journey', ctx, 'sales_ops');
    expect(e.status).toBe('done');
    expect(e.edits).toEqual([{ entity: 'journey', entityId: 'j1', field: 'partner_id', oldValue: 'd1', newValue: 'd2' }]);
    expect(e.outbox.map(o => o.target)).toEqual(['partner_system', 'crm']);
  });
  it('waits for approval when the role is not allowed', () => {
    const e = evaluateAction('reassign_journey', ctx, 'partner_user');
    expect(e.status).toBe('awaiting_approval');
    expect(e.approverRole).toBe('sales_ops');
    expect(canDecide('reassign_journey', 'sales_ops')).toBe(true);
    expect(canDecide('reassign_journey', 'finance')).toBe(false);
  });
  it('blocks when a rule fails, and changes nothing', () => {
    const e = evaluateAction('reassign_journey', { ...ctx, newPartner: { ...ctx.newPartner, stalledShare: 0.6 } }, 'sales_ops');
    expect(e.status).toBe('blocked');
    expect(e.edits).toEqual([]);
    expect(e.outbox).toEqual([]);
    const m = evaluateAction('merge_records', { identifier: 'phone:x', recordIds: ['a', 'b'], distinctNames: 5, govIdConflict: false, alreadyDecided: false }, 'data_steward');
    expect(m.status).toBe('blocked');
  });
});
