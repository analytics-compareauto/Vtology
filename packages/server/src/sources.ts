/**
 * Connected data sources: pull leads, dealers and their progress from a brand's own systems.
 *
 * The first template is the Vtology lead feed (see @vtology/core feed.ts). Pulls are incremental:
 * everything changed since the last successful pull (with a small overlap) is fetched page by page,
 * within a time budget; whatever does not fit is picked up on the next run.
 */
import { DEFAULT_STATUS_MAP, STAGES, feedLeadToJourney, hashValue, normalizeEmail, normalizePhone, type FeedDealer, type FeedLead } from '@vtology/core';
import { HttpError, requireRole, loadContext, type Ctx, type Deps } from './context';
import { decrypt, encrypt, requireSecret } from './secrets';
import { runPipeline } from './pipeline';

const EDITORS: Ctx['role'][] = ['marketing_head', 'data_steward'];
const TEMPLATES = { lead_feed_v1: { leads: '/leads', dealers: '/dealers' } } as const;
type Template = keyof typeof TEMPLATES;

interface SourceRow { id: string; tenant_id: string; name: string; template: Template; base_url: string; key_enc: string | null; status_map: Record<string, string>; seen_statuses: Record<string, number>; synced_until: string | null; created_by: string | null }

/** Only public https addresses: the server must never be pointed at itself or a private network. */
export function checkSourceUrl(raw: string, allowLocal = false): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new HttpError(400, 'Enter the full address, starting with https://'); }
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i.test(u.hostname);
  if (!allowLocal && (u.protocol !== 'https:' || local)) throw new HttpError(400, 'The address must be a public https:// address.');
  return u.toString().replace(/\/+$/, '');
}

const sourceKey = (s: { id: string }) => `src${s.id.slice(0, 8)}`;

export async function listSources(ctx: Ctx) {
  requireRole(ctx, [...EDITORS, 'sales_ops'], 'Viewing data sources');
  const rows = await ctx.db.admin.query<Omit<SourceRow, 'key_enc'> & { has_key: boolean; status: string; last_sync_at: string | null; last_error: string | null; stats: Record<string, unknown> }>(
    `select id, name, template, base_url, key_enc is not null as has_key, status_map, seen_statuses, status, last_sync_at, last_error, synced_until, stats
       from vt.data_sources where tenant_id = $1 order by created_at`, [ctx.tenantId]);
  return { canEdit: EDITORS.includes(ctx.role), stages: STAGES[ctx.industry].map(s => s.name), defaultMap: DEFAULT_STATUS_MAP[ctx.industry], sources: rows };
}

async function fetchJson<T>(deps: Deps, url: string, key: string | null): Promise<T> {
  const f = deps.fetch ?? fetch;
  let r: Response;
  try { r = await f(url, { headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, signal: AbortSignal.timeout(20_000) }); }
  catch (e) { throw new Error(`Could not reach ${new URL(url).host}: ${(e as Error).message}`); }
  if (r.status === 401 || r.status === 403) throw new Error('The source refused the key. Check that the key in Vtology matches the one set on the source.');
  if (r.status === 503) throw new Error('The source says its feed is switched off (its key is not set yet).');
  if (!r.ok) throw new Error(`The source answered ${r.status}.`);
  try { return await r.json() as T; } catch { throw new Error('The source did not return JSON.'); }
}

export async function createSource(deps: Deps, ctx: Ctx, body: { name?: unknown; template?: unknown; baseUrl?: unknown; key?: unknown }) {
  requireRole(ctx, EDITORS, 'Connecting data sources');
  const secret = requireSecret(deps.secretKey);
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  if (!name) throw new HttpError(400, 'Give the source a name, for example "Dealer dashboard".');
  const template = (typeof body.template === 'string' ? body.template : 'lead_feed_v1') as Template;
  if (!(template in TEMPLATES)) throw new HttpError(400, 'Unknown source type.');
  const baseUrl = checkSourceUrl(String(body.baseUrl ?? ''), !!deps.localSecret);
  const key = typeof body.key === 'string' && body.key.trim() ? body.key.trim() : null;
  // try it before saving, so a wrong address or key is caught now, not overnight
  await fetchJson(deps, `${baseUrl}${TEMPLATES[template].dealers}`, key).catch(e => { throw new HttpError(400, (e as Error).message); });
  const [row] = await ctx.db.admin.query<{ id: string }>(
    `insert into vt.data_sources (tenant_id, name, template, base_url, key_enc, status_map, created_by) values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (tenant_id, name) do nothing returning id`,
    [ctx.tenantId, name, template, baseUrl, key ? encrypt(secret, key) : null, JSON.stringify(DEFAULT_STATUS_MAP[ctx.industry]), ctx.userId]);
  if (!row) throw new HttpError(409, `A source called "${name}" already exists.`);
  const result = await syncSource(deps, ctx.tenantId, row.id);
  return { id: row.id, ...result };
}

export async function updateSource(deps: Deps, ctx: Ctx, id: string, body: { statusMap?: unknown; key?: unknown; baseUrl?: unknown; status?: unknown }) {
  requireRole(ctx, EDITORS, 'Changing data sources');
  const sets: string[] = [], vals: unknown[] = [id, ctx.tenantId];
  if (body.statusMap && typeof body.statusMap === 'object') {
    const stages = new Set(STAGES[ctx.industry].map(s => s.name));
    const map = Object.fromEntries(Object.entries(body.statusMap as Record<string, unknown>).filter(([k, v]) => k.trim() && typeof v === 'string' && (v === '' || stages.has(v))).map(([k, v]) => [k.trim().slice(0, 80), v as string]).filter(([, v]) => v));
    vals.push(JSON.stringify(map)); sets.push(`status_map = $${vals.length}`);
    // a changed mapping re-reads everything, so earlier leads move to their right stage
    sets.push('synced_until = null');
  }
  if (typeof body.key === 'string' && body.key.trim()) { vals.push(encrypt(requireSecret(deps.secretKey), body.key.trim())); sets.push(`key_enc = $${vals.length}`); }
  if (typeof body.baseUrl === 'string') { vals.push(checkSourceUrl(body.baseUrl, !!deps.localSecret)); sets.push(`base_url = $${vals.length}`); }
  if (body.status === 'paused' || body.status === 'active') { vals.push(body.status); sets.push(`status = $${vals.length}`); }
  if (!sets.length) throw new HttpError(400, 'Nothing to change.');
  const r = await ctx.db.admin.query(`update vt.data_sources set ${sets.join(', ')} where id = $1 and tenant_id = $2 returning id`, vals);
  if (!r.length) throw new HttpError(404, 'Source not found.');
  return { updated: true };
}

export async function deleteSource(ctx: Ctx, id: string) {
  requireRole(ctx, EDITORS, 'Removing data sources');
  const r = await ctx.db.admin.query(`delete from vt.data_sources where id = $1 and tenant_id = $2 returning id`, [id, ctx.tenantId]);
  if (!r.length) throw new HttpError(404, 'Source not found.');
  return { removed: true, note: 'Leads already pulled stay in Vtology.' };
}

export interface SourceSyncResult { dealers: number; leads: number; newLeads: number; moved: number; unmapped: string[]; more: boolean }

/** Pull everything that changed since the last pull. Safe to run again: writes are upserts. */
export async function syncSource(deps: Deps, tenantId: string, id: string, budgetMs = 40_000): Promise<SourceSyncResult> {
  const deadline = Date.now() + budgetMs;
  const [src] = await deps.db.admin.query<SourceRow & { industry: Ctx['industry']; phone_salt: string }>(
    `select s.*, t.industry, t.phone_salt from vt.data_sources s join vt.tenants t on t.id = s.tenant_id where s.id = $1 and s.tenant_id = $2`, [id, tenantId]);
  if (!src) throw new HttpError(404, 'Source not found.');
  const key = src.key_enc ? decrypt(requireSecret(deps.secretKey), src.key_enc) : null;
  const paths = TEMPLATES[src.template];
  const sk = sourceKey(src);
  const h = (kind: string, v: string | null) => (v ? hashValue(src.phone_salt, kind, v) : Promise.resolve(null));
  const out: SourceSyncResult = { dealers: 0, leads: 0, newLeads: 0, moved: 0, unmapped: [], more: false };
  const seen = { ...(src.seen_statuses ?? {}) };
  const unmapped = new Set<string>();
  try {
    // dealers and branches become partners
    const d = await fetchJson<{ dealers: FeedDealer[] }>(deps, `${src.base_url}${paths.dealers}`, key);
    await deps.db.transaction(async sql => {
      for (const x of d.dealers ?? []) {
        await sql.query(`insert into vt.partners (tenant_id, external_code, name, partner_type, city) values ($1,$2,$3,'dealer',$4)
          on conflict (tenant_id, external_code) do update set name = excluded.name, city = excluded.city`, [tenantId, `${sk}:${x.id}`, x.name || x.code || x.id, x.city || null]);
        // leads may name a dealer by its older id or code: same partner under those names too
        for (const alt of [x.legacyId, x.code]) if (alt && alt !== x.id) await sql.query(`insert into vt.partners (tenant_id, external_code, name, partner_type, city) values ($1,$2,$3,'dealer',$4)
          on conflict (tenant_id, external_code) do nothing`, [tenantId, `${sk}:${alt}`, x.name || alt, x.city || null]);
      }
    });
    out.dealers = d.dealers?.length ?? 0;

    // leads, from just before the last pull (a little overlap is harmless: writes are upserts)
    const since = src.synced_until ? new Date(Date.parse(src.synced_until) - 10 * 60_000).toISOString() : null;
    let cursor: string | null = null, maxSeen = src.synced_until;
    for (;;) {
      const q: URLSearchParams = new URLSearchParams({ limit: '500', ...(since ? { updated_since: since } : {}), ...(cursor ? { cursor } : {}) });
      type Page = { leads: FeedLead[]; hasMore?: boolean; nextCursor?: string | null };
      const page: Page = await fetchJson<{ leads: FeedLead[]; hasMore?: boolean; nextCursor?: string | null }>(deps, `${src.base_url}${paths.leads}?${q}`, key);
      await deps.db.transaction(async sql => {
        const partnerIds = new Map<string, string | null>();
        for (const lead of page.leads ?? []) {
          const status = lead.progress?.status?.trim();
          if (status) seen[status] = (seen[status] ?? 0) + 1;
          const j = feedLeadToJourney(src.industry, lead, src.status_map ?? {}, sk);
          j.unmapped.forEach(u => unmapped.add(u));
          const phoneHash = await h('phone', normalizePhone(lead.customer?.mobile ?? null));
          // the customer record (identifiers scrambled with this workspace's salt)
          const exists = await sql.query(`select 1 from vt.source_records where tenant_id = $1 and source_system = $2 and external_id = $3 limit 1`, [tenantId, src.name, j.personRef]);
          if (!exists.length) {
            await sql.query(`insert into vt.source_records (tenant_id, source_system, external_id, raw_name, phone_hash, email_hash, pincode, city, payload) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [tenantId, src.name, j.personRef, lead.customer?.name || null, phoneHash, await h('email', normalizeEmail(lead.customer?.email ?? null)), lead.customer?.pincode || null, lead.customer?.city || null,
               JSON.stringify({ created_at: lead.createdAt, ref: lead.ref ?? null, interest: lead.interest ?? null, source: lead.origin?.source ?? null })]);
            out.newLeads++;
          }
          let campaignId: string | null = null;
          if (j.campaign) {
            const [c] = await sql.query<{ id: string }>(`insert into vt.campaigns (tenant_id, external_code, name, channel) values ($1,$2,$3,$4)
              on conflict (tenant_id, external_code) do update set name = case when vt.campaigns.name like 'Meta campaign %' then excluded.name else vt.campaigns.name end returning id`,
              [tenantId, j.campaign.code, j.campaign.name, j.campaign.channel]);
            campaignId = c!.id;
          }
          let partnerId: string | null = null;
          if (j.partnerCode) {
            if (!partnerIds.has(j.partnerCode)) partnerIds.set(j.partnerCode, (await sql.query<{ id: string }>(`select id from vt.partners where tenant_id = $1 and external_code = $2`, [tenantId, j.partnerCode]))[0]?.id ?? null);
            partnerId = partnerIds.get(j.partnerCode)!;
          }
          // the journey moves forward only: a later or further stage wins, activity time is the latest
          const [before] = await sql.query<{ stage_index: number }>(`select stage_index from vt.journeys where tenant_id = $1 and external_ref = $2`, [tenantId, j.journeyRef]);
          await sql.query(
            `insert into vt.journeys (tenant_id, external_ref, person_ref, person_phone_hash, campaign_id, partner_id, stage_index, stage_entered_at, last_activity_at, crm_converted, value_inr)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             on conflict (tenant_id, external_ref) do update set
               stage_entered_at = case when excluded.stage_index > vt.journeys.stage_index then excluded.stage_entered_at else vt.journeys.stage_entered_at end,
               stage_index = greatest(vt.journeys.stage_index, excluded.stage_index),
               last_activity_at = greatest(vt.journeys.last_activity_at, excluded.last_activity_at),
               partner_id = coalesce(excluded.partner_id, vt.journeys.partner_id),
               campaign_id = coalesce(vt.journeys.campaign_id, excluded.campaign_id),
               person_phone_hash = coalesce(vt.journeys.person_phone_hash, excluded.person_phone_hash),
               crm_converted = vt.journeys.crm_converted or excluded.crm_converted,
               value_inr = coalesce(excluded.value_inr, vt.journeys.value_inr)`,
            [tenantId, j.journeyRef, j.personRef, phoneHash, campaignId, partnerId, j.stageIndex, j.stageEnteredAt, j.lastActivityAt, j.converted, j.valueInr]);
          if (before && j.stageIndex > before.stage_index) out.moved++;
          // a sale the dealer recorded is a sale: it closes the journey with evidence
          if (j.sold && j.valueInr) await sql.query(
            `insert into vt.transactions (tenant_id, external_ref, journey_ref, journey_id, person_ref, person_phone_hash, partner_id, occurred_at, value_inr, evidence)
             select $1, $2, $3, id, $4, $5, $6, $7, $8, 'observed' from vt.journeys where tenant_id = $1 and external_ref = $3 on conflict (tenant_id, external_ref) do nothing`,
            [tenantId, `${j.personRef}:sale`, j.journeyRef, j.personRef, phoneHash, partnerId, j.stageEnteredAt, j.valueInr]);
          out.leads++;
          if (lead.updatedAt && (!maxSeen || lead.updatedAt > maxSeen)) maxSeen = lead.updatedAt;
        }
      });
      cursor = page.nextCursor ?? null;
      if (!page.hasMore || !cursor) break;
      if (Date.now() > deadline) { out.more = true; break; }
    }
    out.unmapped = [...unmapped];
    await deps.db.admin.query(
      `update vt.data_sources set status = 'active', last_sync_at = now(), last_error = $3, synced_until = $4, seen_statuses = $5, stats = $6 where id = $1 and tenant_id = $2`,
      [id, tenantId, out.unmapped.length ? `Not mapped to a stage yet: ${out.unmapped.join(', ')}` : null, out.more ? src.synced_until : maxSeen, JSON.stringify(seen),
       JSON.stringify({ dealers: out.dealers, leadsLastPull: out.leads, newLeadsLastPull: out.newLeads, movedLastPull: out.moved, at: new Date().toISOString() })]);
  } catch (e) {
    await deps.db.admin.query(`update vt.data_sources set status = 'error', last_sync_at = now(), last_error = $3 where id = $1 and tenant_id = $2`, [id, tenantId, (e as Error).message.slice(0, 500)]);
    throw e;
  }
  // new or moved leads: link customers and refresh findings
  if ((out.newLeads || out.moved) && src.created_by) {
    try { await runPipeline(await loadContext(deps, src.created_by, tenantId)); } catch { /* the next run of matching picks them up */ }
  }
  return out;
}

export async function syncTenantSources(deps: Deps, ctx: Ctx) {
  requireRole(ctx, [...EDITORS, 'sales_ops'], 'Syncing data sources');
  const rows = await ctx.db.admin.query<{ id: string; name: string }>(`select id, name from vt.data_sources where tenant_id = $1 and status <> 'paused'`, [ctx.tenantId]);
  const out: Record<string, unknown> = {};
  await Promise.all(rows.map(async r => { try { out[r.name] = await syncSource(deps, ctx.tenantId, r.id); } catch (e) { out[r.name] = { error: (e as Error).message }; } }));
  return out;
}

/** Sources due for a pull (not pulled in the last hour), for the scheduled job and page visits. */
export async function dueSources(deps: Deps, tenantId?: string) {
  return deps.db.admin.query<{ id: string; tenant_id: string }>(
    `select id, tenant_id from vt.data_sources where status <> 'paused' and (last_sync_at is null or last_sync_at < now() - interval '1 hour')
       ${tenantId ? 'and tenant_id = $1' : ''} order by last_sync_at nulls first limit 50`, tenantId ? [tenantId] : []);
}
