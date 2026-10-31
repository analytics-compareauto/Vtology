/**
 * The governed action service. A request builds the action's context from the database
 * (reading as the requesting user, so nobody can act on what they cannot see), evaluates the
 * rules and role with the core engine, and records the run. Approval re-checks the rules,
 * because the world may have changed since the request.
 */
import { evaluateAction, canDecide, nameSimilarity, journeyStatus, partnerScorecard, ACTION_TYPES, type ActionCode, type Evaluation, type JourneyRow } from '@vtology/core';
import { HttpError, type Ctx } from './context';
import { readJourneys, toJourneyView } from './queries';
import type { Sql } from './db';

export interface ActionRequest { type: string; objectId: string; newPartnerId?: string; reason?: string }

async function edited(sql: Sql, tenantId: string, entity: string, field: string, cond: string, param: string): Promise<boolean> {
  const r = await sql.query(`select 1 from vt.edits where tenant_id = $1 and entity = $2 and field = $3 and ${cond} limit 1`, [tenantId, entity, field, param]);
  return r.length > 0;
}

async function scoreFor(ctx: Ctx, partnerId: string): Promise<{ stalledShare: number; journeys: number }> {
  const rows = await ctx.db.admin.query<{ id: string; external_ref: string; party_id: string | null; campaign_id: string | null; current_partner_id: string | null; stage_index: number; stage_entered_at: string; last_activity_at: string; crm_converted: boolean }>(
    `select id, external_ref, party_id, campaign_id, current_partner_id, stage_index, stage_entered_at, last_activity_at, crm_converted from vt.journeys_current where tenant_id = $1 and current_partner_id = $2`, [ctx.tenantId, partnerId]);
  const js: JourneyRow[] = rows.map(j => ({ id: j.id, externalRef: j.external_ref, partyId: j.party_id, campaignId: j.campaign_id, partnerId: j.current_partner_id, stageIndex: j.stage_index, stageEnteredAt: new Date(j.stage_entered_at), lastActivityAt: new Date(j.last_activity_at), crmConverted: j.crm_converted }));
  const s = partnerScorecard(ctx.industry, js, [{ id: partnerId, name: '' }], ctx.now)[0]!;
  return { stalledShare: s.stalledShare, journeys: s.journeys };
}

/** Build the action's context, reading as the user so visibility rules apply. */
async function buildContext(ctx: Ctx, type: ActionCode, req: ActionRequest): Promise<unknown> {
  const notFound = () => new HttpError(404, `That ${ACTION_TYPES[type].objectKind.replace('_', ' ')} is not in your view.`);
  switch (type) {
    case 'reassign_journey': {
      const row = await ctx.db.asUser(ctx.userId, async sql => (await readJourneys(ctx, sql)).find(j => j.id === req.objectId));
      if (!row) throw notFound();
      const v = toJourneyView(ctx, row);
      if (!req.newPartnerId) throw new HttpError(400, 'Choose the partner to move this journey to (newPartnerId).');
      const p = (await ctx.db.admin.query<{ id: string; name: string; active: boolean }>(`select id, name, active from vt.partners where tenant_id = $1 and id = $2`, [ctx.tenantId, req.newPartnerId]))[0];
      const newPartner = p ? { ...p, stalledShare: (await scoreFor(ctx, p.id)).stalledShare } : null;
      return { journey: { id: v.id, externalRef: v.externalRef, stage: v.stage, converted: v.converted, daysIdle: v.daysIdle, slaDays: v.slaDays, currentPartnerId: v.partnerId, partyLabel: v.party ?? v.externalRef }, newPartner };
    }
    case 'escalate_partner': {
      const p = (await ctx.db.asUser(ctx.userId, sql => sql.query<{ id: string; name: string }>(`select id, name from vt.partners where tenant_id = $1 and id = $2`, [ctx.tenantId, req.objectId])))[0];
      if (!p) throw notFound();
      const s = await scoreFor(ctx, p.id);
      return { partner: { ...p, ...s }, alreadyEscalated: await edited(ctx.db.admin, ctx.tenantId, 'partner', 'escalated', 'entity_id = $4::uuid', p.id) };
    }
    case 'merge_records': case 'keep_separate': {
      const [kind, hash] = req.objectId.split(':');
      const col = kind === 'phone' ? 'phone_hash' : kind === 'email' ? 'email_hash' : null;
      if (!col || !hash) throw new HttpError(400, 'objectId must look like "phone:<hash>" or "email:<hash>".');
      const recs = await ctx.db.asUser(ctx.userId, sql => sql.query<{ id: string; raw_name: string | null; gov_id_hash: string | null }>(
        `select id, raw_name, gov_id_hash from vt.source_records where tenant_id = $1 and ${col} = $2 order by loaded_at`, [ctx.tenantId, hash]));
      if (!recs.length) throw notFound();
      const names: string[] = [];
      recs.forEach(r => { if (!names.some(n => nameSimilarity(n, r.raw_name ?? '') >= 0.85)) names.push(r.raw_name ?? ''); });
      const gov = new Set(recs.map(r => r.gov_id_hash).filter(Boolean));
      return { identifier: req.objectId, recordIds: recs.map(r => r.id), distinctNames: names.length, govIdConflict: gov.size > 1,
        alreadyDecided: await edited(ctx.db.admin, ctx.tenantId, 'identity_cluster', 'decision', `new_value->>'identifier' = $4`, req.objectId) };
    }
    case 'hold_payout': {
      const v = (await ctx.db.asUser(ctx.userId, sql => sql.query<{ id: string; rule: string; entity_ref: string; value_inr: string | null }>(
        `select id, rule, entity_ref, value_inr from vt.violations_v where tenant_id = $1 and id = $2`, [ctx.tenantId, req.objectId])))[0];
      if (!v) throw notFound();
      return { violation: { id: v.id, rule: v.rule, entityRef: v.entity_ref, valueInr: Number(v.value_inr ?? 0) }, alreadyHeld: await edited(ctx.db.admin, ctx.tenantId, 'violation', 'payout_hold', 'entity_id = $4::uuid', v.id) };
    }
    case 'withdraw_consent': {
      const p = (await ctx.db.asUser(ctx.userId, sql => sql.query<{ id: string; display_name: string }>(`select id, display_name from vt.parties_v where tenant_id = $1 and id = $2`, [ctx.tenantId, req.objectId])))[0];
      if (!p) throw notFound();
      return { party: { id: p.id, label: p.display_name } };
    }
  }
}

async function apply(sql: Sql, ctx: Ctx, runId: string, ev: Evaluation): Promise<void> {
  for (const e of ev.edits) {
    await sql.query(`insert into vt.edits (tenant_id, action_run_id, entity, entity_id, field, old_value, new_value) values ($1,$2,$3,$4,$5,$6,$7)`,
      [ctx.tenantId, runId, e.entity, e.entityId, e.field, JSON.stringify(e.oldValue ?? null), JSON.stringify(e.newValue ?? null)]);
  }
  for (const o of ev.outbox) {
    await sql.query(`insert into vt.outbox (tenant_id, action_run_id, target, payload) values ($1,$2,$3,$4)`, [ctx.tenantId, runId, o.target, JSON.stringify(o.payload)]);
  }
}

function asCode(type: string): ActionCode {
  if (!(type in ACTION_TYPES)) throw new HttpError(400, `Unknown action type "${type}". Known types: ${Object.keys(ACTION_TYPES).join(', ')}.`);
  return type as ActionCode;
}

export async function requestAction(ctx: Ctx, req: ActionRequest) {
  const type = asCode(req.type);
  const c = await buildContext(ctx, type, req);
  const ev = evaluateAction(type, c as never, ctx.role);
  return ctx.db.transaction(async sql => {
    const [run] = await sql.query<{ id: string }>(
      `insert into vt.action_runs (tenant_id, type_code, object_kind, object_id, object_label, requested_by, requested_role, reason, rules, effects, payload, status, approver_role, decided_by, decided_role, decided_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
      [ctx.tenantId, type, ev.objectKind, ev.objectId, ev.objectLabel, ctx.userId, ctx.role, req.reason ?? null, JSON.stringify(ev.rules), JSON.stringify(ev.effects),
       JSON.stringify({ request: req }), ev.status, ev.approverRole,
       ev.status === 'done' ? ctx.userId : null, ev.status === 'done' ? ctx.role : null, ev.status === 'done' ? ctx.now.toISOString() : null]);
    if (ev.status === 'done') await apply(sql, ctx, run!.id, ev);
    return { id: run!.id, status: ev.status, rules: ev.rules, effects: ev.effects, approverRole: ev.approverRole };
  });
}

export async function decideAction(ctx: Ctx, runId: string, approve: boolean) {
  const run = (await ctx.db.admin.query<{ id: string; type_code: ActionCode; status: string; payload: { request: ActionRequest } }>(
    `select id, type_code, status, payload from vt.action_runs where tenant_id = $1 and id = $2`, [ctx.tenantId, runId]))[0];
  if (!run) throw new HttpError(404, 'That action is not in your view.');
  if (run.status !== 'awaiting_approval') throw new HttpError(409, `This action is already ${run.status.replace('_', ' ')}.`);
  if (!canDecide(run.type_code, ctx.role)) throw new HttpError(403, `Only ${ACTION_TYPES[run.type_code].roles.join(', ')} can decide this action.`);
  if (!approve) {
    await ctx.db.admin.query(`update vt.action_runs set status = 'rejected', decided_by = $2, decided_role = $3, decided_at = $4 where id = $1`, [runId, ctx.userId, ctx.role, ctx.now.toISOString()]);
    return { id: runId, status: 'rejected' as const };
  }
  // re-check the rules now, as the approver
  const c = await buildContext(ctx, run.type_code, run.payload.request);
  const ev = evaluateAction(run.type_code, c as never, ctx.role);
  const status = ev.status === 'done' ? 'done' : 'blocked';
  await ctx.db.transaction(async sql => {
    await sql.query(`update vt.action_runs set status = $2, rules = $3, decided_by = $4, decided_role = $5, decided_at = $6 where id = $1`,
      [runId, status, JSON.stringify(ev.rules), ctx.userId, ctx.role, ctx.now.toISOString()]);
    if (status === 'done') await apply(sql, ctx, runId, ev);
  });
  return { id: runId, status, rules: ev.rules };
}

export { journeyStatus };
