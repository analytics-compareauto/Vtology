/**
 * Reads. Every query runs as the signed-in user, so row-level security decides what each role sees:
 * partner users only their own leads, relationship managers only their book, masked names for
 * roles without personal-data access, money hidden from roles without it.
 */
import { journeyStatus, partnerScorecard, type JourneyRow } from '@vtology/core';
import type { Ctx } from './context';
import type { Sql } from './db';

export interface JourneyView {
  id: string; externalRef: string; party: string | null; partyId: string | null; partner: string | null; partnerId: string | null;
  stage: string; stageIndex: number; daysIdle: number; slaDays: number; stalled: boolean; converted: boolean; edited: boolean;
}

type JRow = { id: string; external_ref: string; party_id: string | null; party_name: string | null; current_partner_id: string | null; partner_name: string | null; campaign_id: string | null; stage_index: number; stage_entered_at: string; last_activity_at: string; crm_converted: boolean; edited: boolean };

export async function readJourneys(ctx: Ctx, sql: Sql): Promise<JRow[]> {
  return sql.query<JRow>(
    `select j.id, j.external_ref, j.party_id, p.display_name as party_name, j.current_partner_id, pt.name as partner_name, j.campaign_id,
            j.stage_index, j.stage_entered_at, j.last_activity_at, j.crm_converted, j.edited
       from vt.journeys_current j
       left join vt.parties_v p on p.id = j.party_id
       left join vt.partners pt on pt.id = j.current_partner_id
      where j.tenant_id = $1
      order by j.stage_index desc, j.last_activity_at asc`, [ctx.tenantId]);
}

const toJourneyRow = (j: JRow): JourneyRow => ({ id: j.id, externalRef: j.external_ref, partyId: j.party_id, campaignId: j.campaign_id, partnerId: j.current_partner_id, stageIndex: j.stage_index, stageEnteredAt: new Date(j.stage_entered_at), lastActivityAt: new Date(j.last_activity_at), crmConverted: j.crm_converted });

export function toJourneyView(ctx: Ctx, j: JRow): JourneyView {
  const s = journeyStatus(ctx.industry, toJourneyRow(j), ctx.now);
  return { id: j.id, externalRef: j.external_ref, party: j.party_name, partyId: j.party_id, partner: j.partner_name, partnerId: j.current_partner_id, stage: s.stage, stageIndex: j.stage_index, daysIdle: s.daysIdle, slaDays: s.slaDays, stalled: s.stalled, converted: s.converted, edited: j.edited };
}

export async function listJourneys(ctx: Ctx, opts: { stalledOnly?: boolean } = {}): Promise<JourneyView[]> {
  const rows = await ctx.db.asUser(ctx.userId, sql => readJourneys(ctx, sql));
  const views = rows.map(j => toJourneyView(ctx, j));
  return opts.stalledOnly ? views.filter(v => v.stalled) : views;
}

export async function listPartners(ctx: Ctx) {
  return ctx.db.asUser(ctx.userId, async sql => {
    const partners = await sql.query<{ id: string; name: string }>(`select id, name from vt.partners where tenant_id = $1`, [ctx.tenantId]);
    const journeys = (await readJourneys(ctx, sql)).map(toJourneyRow);
    return partnerScorecard(ctx.industry, journeys, partners, ctx.now);
  });
}

export async function listViolations(ctx: Ctx) {
  return ctx.db.asUser(ctx.userId, sql => sql.query(
    `select v.id, v.rule, v.severity, v.entity_kind, v.entity_ref, v.partner_id, v.detail, v.value_inr, v.status, v.detected_at
       from vt.violations_v v
      where v.tenant_id = $1 and v.run_id = (select id from vt.pipeline_runs where tenant_id = $1 and finished_at is not null order by started_at desc limit 1)
      order by case v.severity when 'high' then 0 when 'medium' then 1 else 2 end, v.value_inr desc nulls last`, [ctx.tenantId]));
}

export async function listActions(ctx: Ctx) {
  return ctx.db.asUser(ctx.userId, sql => sql.query(
    `select id, type_code, object_kind, object_id, object_label, requested_role, reason, rules, effects, status, approver_role, decided_role, decided_at, created_at
       from vt.action_runs where tenant_id = $1 order by created_at desc limit 200`, [ctx.tenantId]));
}

export async function me(ctx: Ctx) {
  const partner = ctx.partnerId ? (await ctx.db.admin.query<{ name: string }>(`select name from vt.partners where id = $1`, [ctx.partnerId]))[0]?.name ?? null : null;
  const [run] = await ctx.db.admin.query<{ finished_at: string; stats: unknown }>(`select finished_at, stats from vt.pipeline_runs where tenant_id = $1 and finished_at is not null order by started_at desc limit 1`, [ctx.tenantId]);
  return { userId: ctx.userId, tenantId: ctx.tenantId, tenantName: ctx.tenantName, isDemo: ctx.isDemo, industry: ctx.industry, role: ctx.role, partnerId: ctx.partnerId, partner, bookCode: ctx.bookCode,
    lastRun: run ? { finishedAt: run.finished_at, stats: run.stats } : null };
}
