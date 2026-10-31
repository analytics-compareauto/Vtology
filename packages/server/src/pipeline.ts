/**
 * The pipeline run: resolve identities into parties, link imported journeys, sales and consents to
 * those parties, then run the lying-data detectors and store the findings for this run.
 * Party ids stay stable between runs: a cluster keeps the party its records already point to.
 */
import { resolveIdentities, detectViolations, type JourneyRow } from '@vtology/core';
import { requireRole, type Ctx } from './context';

export interface PipelineStats { records: number; parties: number; newParties: number; heldForReview: number; reviewItems: number; journeysLinked: number; journeysWithCustomer: number; journeys: number; findings: number }

export async function runPipeline(ctx: Ctx): Promise<{ runId: string; stats: PipelineStats }> {
  requireRole(ctx, ['data_steward', 'marketing_head', 'sales_ops'], 'Running the pipeline');
  return ctx.db.transaction(async sql => {
    const [run] = await sql.query<{ id: string }>(`insert into vt.pipeline_runs (tenant_id) values ($1) returning id`, [ctx.tenantId]);
    const runId = run!.id;

    // ---- 1. identity resolution
    const recs = await sql.query<{ id: string; raw_name: string | null; phone_hash: string | null; email_hash: string | null; gov_id_hash: string | null; pincode: string | null; city: string | null; party_id: string | null; payload: Record<string, unknown> }>(
      `select id, raw_name, phone_hash, email_hash, gov_id_hash, pincode, city, party_id, payload from vt.source_records where tenant_id = $1 order by loaded_at, id`, [ctx.tenantId]);
    const byId = new Map(recs.map(r => [r.id, r]));
    const res = resolveIdentities(recs.map(r => ({ id: r.id, name: r.raw_name ?? '', phoneHash: r.phone_hash, emailHash: r.email_hash, govIdHash: r.gov_id_hash, pincode: r.pincode })));
    const shared = new Set(res.sharedIdentifiers.map(s => s.identifier));
    let newParties = 0;
    const assignBy = new Map(res.assignments.map(a => [a.recordId, a]));

    for (const ids of res.clusters.values()) {
      const members = ids.map(id => byId.get(id)!);
      const anchor = members[0]!;
      // survivorship: the most complete name wins (more words, then longer), so "Meera Bose" beats "Meera"
      const bestName = members.map(m => (m.raw_name ?? '').trim()).filter(Boolean)
        .sort((x, y) => y.split(/\s+/).length - x.split(/\s+/).length || y.length - x.length)[0] ?? 'Unknown';
      let partyId = members.map(m => m.party_id).find(Boolean) ?? null;
      const existing = members.some(m => (m.payload as { is_existing_customer?: boolean }).is_existing_customer === true);
      const book = members.map(m => (m.payload as { book_code?: string | null }).book_code).find(Boolean) ?? null;
      if (!partyId) {
        const [p] = await sql.query<{ id: string }>(
          `insert into vt.parties (tenant_id, display_name, city, pincode, book_code, is_existing_customer) values ($1,$2,$3,$4,$5,$6) returning id`,
          [ctx.tenantId, bestName, anchor.city, anchor.pincode, book, existing]);
        partyId = p!.id; newParties++;
      } else {
        await sql.query(`update vt.parties set display_name = $4, book_code = coalesce(book_code, $2), is_existing_customer = is_existing_customer or $3 where id = $1`, [partyId, book, existing, bestName]);
      }
      for (const m of members) {
        const a = assignBy.get(m.id)!;
        await sql.query(`update vt.source_records set party_id = $2, match_method = $3, match_confidence = $4 where id = $1`, [m.id, partyId, a.method, a.confidence]);
        for (const [kind, v, key] of [['phone', m.phone_hash, `phone:${m.phone_hash}`], ['email', m.email_hash, `email:${m.email_hash}`], ['gov_id', m.gov_id_hash, `gov:${m.gov_id_hash}`]] as const) {
          if (!v || shared.has(key)) continue;
          await sql.query(`insert into vt.identifiers (tenant_id, party_id, kind, value_hash) values ($1,$2,$3,$4) on conflict do nothing`, [ctx.tenantId, partyId, kind, v]);
        }
      }
    }

    // ---- 2. link journeys, sales and consents to parties (by external person ref, else by phone)
    const linkSql = (table: string) => `
      update vt.${table} t set party_id = coalesce(
        (select s.party_id from vt.source_records s where s.tenant_id = t.tenant_id and s.external_id = t.person_ref and s.party_id is not null limit 1),
        (select i.party_id from vt.identifiers i where i.tenant_id = t.tenant_id and i.kind = 'phone' and i.value_hash = t.person_phone_hash limit 1))
      where t.tenant_id = $1 and t.party_id is null and (t.person_ref is not null or t.person_phone_hash is not null)`;
    const before = await sql.query<{ n: number }>(`select count(*)::int as n from vt.journeys where tenant_id = $1 and party_id is not null`, [ctx.tenantId]);
    await sql.query(linkSql('journeys'), [ctx.tenantId]);
    await sql.query(linkSql('transactions'), [ctx.tenantId]);
    await sql.query(linkSql('consents'), [ctx.tenantId]);
    await sql.query(`update vt.transactions t set journey_id = j.id from vt.journeys j where t.tenant_id = $1 and t.journey_id is null and j.tenant_id = t.tenant_id and j.external_ref = t.journey_ref`, [ctx.tenantId]);
    const after = await sql.query<{ n: number; total: number }>(`select count(*) filter (where party_id is not null)::int as n, count(*)::int as total from vt.journeys where tenant_id = $1`, [ctx.tenantId]);

    // ---- 3. detectors
    const journeys = (await sql.query<{ id: string; external_ref: string; party_id: string | null; campaign_id: string | null; current_partner_id: string | null; stage_index: number; stage_entered_at: string; last_activity_at: string; crm_converted: boolean }>(
      `select id, external_ref, party_id, campaign_id, current_partner_id, stage_index, stage_entered_at, last_activity_at, crm_converted from vt.journeys_current where tenant_id = $1`, [ctx.tenantId]))
      .map<JourneyRow>(j => ({ id: j.id, externalRef: j.external_ref, partyId: j.party_id, campaignId: j.campaign_id, partnerId: j.current_partner_id, stageIndex: j.stage_index, stageEnteredAt: new Date(j.stage_entered_at), lastActivityAt: new Date(j.last_activity_at), crmConverted: j.crm_converted }));
    const transactions = (await sql.query<{ id: string; external_ref: string; journey_id: string | null; partner_id: string | null; occurred_at: string; value_inr: string }>(
      `select id, external_ref, journey_id, partner_id, occurred_at, value_inr from vt.transactions where tenant_id = $1`, [ctx.tenantId]))
      .map(t => ({ id: t.id, externalRef: t.external_ref, journeyId: t.journey_id, partnerId: t.partner_id, occurredAt: new Date(t.occurred_at), valueInr: Number(t.value_inr) }));
    const campaigns = (await sql.query<{ id: string; external_code: string; name: string; spend_inr: string }>(`select id, external_code, name, spend_inr from vt.campaigns where tenant_id = $1`, [ctx.tenantId]))
      .map(c => ({ id: c.id, externalCode: c.external_code, name: c.name, spendInr: Number(c.spend_inr) }));
    const partners = await sql.query<{ id: string; name: string }>(`select id, name from vt.partners where tenant_id = $1`, [ctx.tenantId]);
    const avg = transactions.length ? transactions.reduce((s, t) => s + t.valueInr, 0) / transactions.length : 0;
    const findings = detectViolations({ industry: ctx.industry, now: ctx.now, journeys, transactions, campaigns, partners, sharedIdentifiers: res.sharedIdentifiers, avgConversionValueInr: avg });
    for (const f of findings) {
      await sql.query(`insert into vt.violations (tenant_id, run_id, rule, severity, entity_kind, entity_ref, partner_id, detail, value_inr) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [ctx.tenantId, runId, f.rule, f.severity, f.entityKind, f.entityRef, f.partnerId ?? null, f.detail, Math.round(f.valueInr)]);
    }

    const stats: PipelineStats = {
      records: recs.length, parties: res.clusters.size, newParties,
      heldForReview: res.assignments.filter(a => a.method === 'held_for_review').length,
      reviewItems: res.review.length, journeysLinked: after[0]!.n - before[0]!.n, journeysWithCustomer: after[0]!.n, journeys: after[0]!.total, findings: findings.length,
    };
    await sql.query(`update vt.pipeline_runs set finished_at = now(), stats = $2 where id = $1`, [runId, JSON.stringify(stats)]);
    return { runId, stats };
  });
}
