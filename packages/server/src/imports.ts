/**
 * Import a client's CSV export through a field mapping. Identifiers are hashed with the tenant's
 * salt on the way in; raw phones, emails and IDs are never stored.
 */
import { applyMapping, parseCsv, hashValue, normalizePhone, normalizeEmail, normalizeGovId, stageIndexByName, type Mapping } from '@vtology/core';
import { HttpError, requireRole, type Ctx } from './context';
import type { Sql } from './db';

export interface ImportRequest { mapping: Mapping; csv: string; fileName?: string }
export interface ImportResult { batchId: string; entity: string; rowCount: number; imported: number; errors: { row: number; field: string; message: string }[] }

const str = (v: unknown) => (v === undefined || v === null ? null : String(v));

export async function importCsv(ctx: Ctx, req: ImportRequest): Promise<ImportResult> {
  requireRole(ctx, ['data_steward', 'marketing_head'], 'Importing data');
  let mapped;
  try { mapped = applyMapping(parseCsv(req.csv), req.mapping); }
  catch (e) { throw new HttpError(400, (e as Error).message); }
  const errors = [...mapped.errors];
  const h = (kind: string, v: string | null) => (v ? hashValue(ctx.salt, kind, v) : Promise.resolve(null));
  const entity = req.mapping.entity;

  return ctx.db.transaction(async sql => {
    const [batch] = await sql.query<{ id: string }>(
      `insert into vt.import_batches (tenant_id, source_system, entity, file_name, row_count, created_by)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [ctx.tenantId, req.mapping.sourceSystem, entity, req.fileName ?? null, mapped.rowCount, ctx.userId]);
    const batchId = batch!.id;
    let imported = 0;

    for (const [i, r] of mapped.records.entries()) {
      const rowNo = i + 2;
      try {
        if (entity === 'lead') {
          const rawPhone = str(r.phone);
          const phone = normalizePhone(rawPhone);
          if (rawPhone && !phone) errors.push({ row: rowNo, field: 'phone', message: `"${rawPhone}" is not a valid Indian mobile number; kept without a phone` });
          await sql.query(
            `insert into vt.source_records (tenant_id, batch_id, source_system, external_id, raw_name, phone_hash, email_hash, gov_id_hash, pincode, city, payload)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [ctx.tenantId, batchId, req.mapping.sourceSystem, str(r.external_id), str(r.name), await h('phone', phone), await h('email', normalizeEmail(str(r.email))),
             await h('gov', normalizeGovId(str(r.gov_id))), str(r.pincode), str(r.city),
             JSON.stringify({ created_at: r.created_at ?? null, book_code: r.book_code ?? null, is_existing_customer: r.is_existing_customer ?? false })]);
        } else if (entity === 'partner') {
          await sql.query(
            `insert into vt.partners (tenant_id, external_code, name, partner_type, city) values ($1,$2,$3,$4,$5)
             on conflict (tenant_id, external_code) do update set name = excluded.name, partner_type = excluded.partner_type, city = excluded.city`,
            [ctx.tenantId, str(r.external_code), str(r.name), str(r.partner_type), str(r.city)]);
        } else if (entity === 'campaign') {
          await sql.query(
            `insert into vt.campaigns (tenant_id, external_code, name, channel, start_date, end_date, spend_inr, platform_reported_conversions)
             values ($1,$2,$3,$4,$5,$6,$7,$8)
             on conflict (tenant_id, external_code) do update set name = excluded.name, channel = excluded.channel, start_date = excluded.start_date,
               end_date = excluded.end_date, spend_inr = excluded.spend_inr, platform_reported_conversions = excluded.platform_reported_conversions`,
            [ctx.tenantId, str(r.external_code), str(r.name), str(r.channel), str(r.start_date)?.slice(0, 10) ?? null, str(r.end_date)?.slice(0, 10) ?? null,
             Number(r.spend_inr ?? 0), Number(r.platform_reported_conversions ?? 0)]);
        } else if (entity === 'journey_event') {
          const stage = stageIndexByName(ctx.industry, str(r.stage)!);
          if (stage === null) throw new Error(`"${r.stage}" is not a ${ctx.industry} stage`);
          const partnerId = await lookup(sql, 'partners', ctx.tenantId, str(r.partner_code));
          const campaignId = await lookup(sql, 'campaigns', ctx.tenantId, str(r.campaign_code));
          if (r.partner_code && !partnerId) throw new Error(`unknown partner code "${r.partner_code}"; import partners first`);
          // a later or further event moves the journey on; activity time is always the latest event
          await sql.query(
            `insert into vt.journeys (tenant_id, external_ref, person_ref, person_phone_hash, campaign_id, partner_id, stage_index, stage_entered_at, last_activity_at, crm_converted, value_inr)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10)
             on conflict (tenant_id, external_ref) do update set
               stage_entered_at = case when excluded.stage_index > vt.journeys.stage_index then excluded.stage_entered_at else vt.journeys.stage_entered_at end,
               stage_index = greatest(vt.journeys.stage_index, excluded.stage_index),
               last_activity_at = greatest(vt.journeys.last_activity_at, excluded.last_activity_at),
               partner_id = coalesce(excluded.partner_id, vt.journeys.partner_id),
               campaign_id = coalesce(vt.journeys.campaign_id, excluded.campaign_id),
               person_ref = coalesce(vt.journeys.person_ref, excluded.person_ref),
               person_phone_hash = coalesce(vt.journeys.person_phone_hash, excluded.person_phone_hash),
               crm_converted = vt.journeys.crm_converted or excluded.crm_converted,
               value_inr = coalesce(excluded.value_inr, vt.journeys.value_inr)`,
            [ctx.tenantId, str(r.journey_ref), str(r.person_ref), await h('phone', normalizePhone(str(r.phone))), campaignId, partnerId, stage,
             str(r.occurred_at), r.crm_converted === true, r.value_inr ?? null]);
        } else if (entity === 'transaction') {
          const partnerId = await lookup(sql, 'partners', ctx.tenantId, str(r.partner_code));
          const journey = r.journey_ref ? (await sql.query<{ id: string }>(`select id from vt.journeys where tenant_id = $1 and external_ref = $2`, [ctx.tenantId, str(r.journey_ref)]))[0] : undefined;
          await sql.query(
            `insert into vt.transactions (tenant_id, external_ref, journey_ref, journey_id, person_ref, person_phone_hash, partner_id, occurred_at, value_inr, evidence)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (tenant_id, external_ref) do nothing`,
            [ctx.tenantId, str(r.external_ref), str(r.journey_ref), journey?.id ?? null, str(r.person_ref), await h('phone', normalizePhone(str(r.phone))), partnerId,
             str(r.occurred_at), Number(r.value_inr), str(r.evidence) ?? 'observed']);
        } else if (entity === 'consent') {
          await sql.query(
            `insert into vt.consents (tenant_id, person_ref, person_phone_hash, purpose, channel, granted, recorded_at, expires_at)
             values ($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz, now()),$8)`,
            [ctx.tenantId, str(r.person_ref), await h('phone', normalizePhone(str(r.phone))), str(r.purpose), str(r.channel), r.granted === true, str(r.recorded_at), str(r.expires_at)]);
        }
        imported++;
      } catch (e) {
        errors.push({ row: rowNo, field: '-', message: (e as Error).message });
      }
    }
    await sql.query(`update vt.import_batches set error_count = $2, errors = $3 where id = $1`, [batchId, errors.length, JSON.stringify(errors.slice(0, 200))]);
    return { batchId, entity, rowCount: mapped.rowCount, imported, errors };
  });
}

async function lookup(sql: Sql, table: 'partners' | 'campaigns', tenantId: string, code: string | null): Promise<string | null> {
  if (!code) return null;
  const rows = await sql.query<{ id: string }>(`select id from vt.${table} where tenant_id = $1 and external_code = $2`, [tenantId, code]);
  return rows[0]?.id ?? null;
}
