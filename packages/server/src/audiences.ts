/**
 * Audiences: hashed lists, buckets with a fixed holdout, lift against a list of buyers, and logged
 * hashed exports for Customer Match, Meta or an SSP.
 *
 * Match keys (standard SHA-256) are read only here, in SQL: no screen and no database role sees them.
 * A list arrives in chunks (the browser hashes raw files before sending), so any size fits the
 * request limits; every list expires on a set date.
 */
import { BUCKET_PURPOSES, cleanRules, describeRules, type AttributeSummary, type BucketPurpose, type BucketRule } from '@vtology/core';
import { HttpError, requireRole, type Ctx, type Deps } from './context';
import type { Sql } from './db';

const EDITORS: Ctx['role'][] = ['marketing_head', 'data_steward'];
const KINDS = ['customers', 'buyers', 'exclude', 'other'] as const;
type ListKind = typeof KINDS[number];
export const CHUNK_MAX = 5000;
const EXPORT_PAGE = 50_000;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f-]{36}$/i;

interface ListRow { id: string; name: string; kind: ListKind; status: string; rows_received: number; rows_rejected: number; people: number; with_email: number; with_phone: number; attributes: Record<string, AttributeSummary>; expires_at: string; created_at: string; completed_at: string | null }
interface BucketRow { id: string; name: string; purpose: BucketPurpose; include_lists: string[]; exclude_lists: string[]; rules: BucketRule[]; holdout_pct: number; measure_list: string | null; stats: BucketStats; computed_at: string | null }
export interface BucketStats { candidates: number; excluded: number; people: number; holdout: number; targeted: number; withEmail: number; withPhone: number; measured?: { list: string; targetedConverted: number; holdoutConverted: number; targetedRate: number; holdoutRate: number; lift: number | null } }

export async function listAudiences(ctx: Ctx) {
  requireRole(ctx, EDITORS, 'Audiences');
  await purgeExpired(ctx.db.admin, ctx.tenantId);
  const [lists, buckets, exports] = await Promise.all([
    ctx.db.admin.query<ListRow>(`select id, name, kind, status, rows_received, rows_rejected, people, with_email, with_phone, attributes, expires_at, created_at, completed_at
       from vt.audience_lists where tenant_id = $1 order by created_at desc`, [ctx.tenantId]),
    ctx.db.admin.query<BucketRow>(`select id, name, purpose, include_lists, exclude_lists, rules, holdout_pct::float as holdout_pct, measure_list, stats, computed_at
       from vt.audience_buckets where tenant_id = $1 order by created_at desc`, [ctx.tenantId]),
    ctx.db.admin.query<{ id: string; bucket_name: string; part: string; format: string; rows: number; created_at: string }>(
      `select id, bucket_name, part, format, rows, created_at from vt.audience_exports where tenant_id = $1 order by created_at desc limit 20`, [ctx.tenantId]),
  ]);
  return {
    lists, exports, purposes: BUCKET_PURPOSES, chunkMax: CHUNK_MAX,
    buckets: buckets.map(b => ({ ...b, summary: describeRules(b.rules ?? []) })),
  };
}

// ---------------------------------------------------------------- lists
export async function createList(ctx: Ctx, body: { name?: unknown; kind?: unknown; expiresDays?: unknown }) {
  requireRole(ctx, EDITORS, 'Uploading audience lists');
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  if (!name) throw new HttpError(400, 'Give the list a name, for example "Premium subscribers, Oct".');
  const kind = (KINDS as readonly string[]).includes(String(body.kind)) ? body.kind as ListKind : 'customers';
  const days = Math.round(Number(body.expiresDays ?? 90));
  if (!(days >= 1 && days <= 365)) throw new HttpError(400, 'A list can be kept for 1 to 365 days.');
  const [row] = await ctx.db.admin.query<{ id: string; expires_at: string }>(
    `insert into vt.audience_lists (tenant_id, name, kind, expires_at, created_by) values ($1,$2,$3, now() + make_interval(days => $4), $5)
     on conflict (tenant_id, name) do nothing returning id, expires_at`, [ctx.tenantId, name, kind, days, ctx.userId]);
  if (!row) throw new HttpError(409, `A list called "${name}" already exists. Delete it first or pick another name.`);
  return { id: row.id, expiresAt: row.expires_at, chunkMax: CHUNK_MAX };
}

async function ownList(ctx: Ctx, id: string) {
  if (!UUID.test(id)) throw new HttpError(404, 'List not found.');
  const [l] = await ctx.db.admin.query<{ id: string; status: string }>(`select id, status from vt.audience_lists where id = $1 and tenant_id = $2`, [id, ctx.tenantId]);
  if (!l) throw new HttpError(404, 'List not found.');
  return l;
}

/**
 * One chunk of a list: up to 5,000 rows of {e: email sha256, p: phone sha256, a: attributes}.
 * Anything that isn't a SHA-256 key is refused; attributes that look like emails or phone numbers
 * refuse the whole chunk, so identifiers can never arrive in the clear.
 */
export async function appendRows(ctx: Ctx, id: string, body: { rows?: unknown; rejected?: unknown }) {
  requireRole(ctx, EDITORS, 'Uploading audience lists');
  const list = await ownList(ctx, id);
  if (list.status !== 'uploading') throw new HttpError(409, 'This list is complete. Upload a new list to add people.');
  if (!Array.isArray(body.rows)) throw new HttpError(400, 'Send rows as a list.');
  if (body.rows.length > CHUNK_MAX) throw new HttpError(413, `Send at most ${CHUNK_MAX} rows at a time.`);
  const merged = new Map<string, { e: string | null; p: string | null; a: Record<string, string> }>();
  let bad = 0;
  for (const raw of body.rows) {
    const r = (raw ?? {}) as { e?: unknown; p?: unknown; a?: unknown };
    const e = typeof r.e === 'string' && HEX64.test(r.e.toLowerCase()) ? r.e.toLowerCase() : null;
    const p = typeof r.p === 'string' && HEX64.test(r.p.toLowerCase()) ? r.p.toLowerCase() : null;
    if ((r.e !== undefined && !e) || (r.p !== undefined && !p) || (!e && !p)) { bad++; continue; }
    const a: Record<string, string> = {};
    if (r.a && typeof r.a === 'object') {
      for (const [k, v] of Object.entries(r.a as Record<string, unknown>).slice(0, 24)) {
        const key = k.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40);
        const val = String(v ?? '').trim().slice(0, 80);
        if (!key || !val) continue;
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val) || /^\+?[\d\s()-]{10,16}$/.test(val) && val.replace(/\D/g, '').length >= 10)
          throw new HttpError(400, `The attribute "${key}" holds what looks like an email or a phone number. Identifiers must be hashed in the email and phone columns, so this upload was stopped.`);
        a[key] = val;
      }
    }
    const key = e ? `e:${e}` : `p:${p}`;
    const prev = merged.get(key);
    merged.set(key, prev ? { e: prev.e ?? e, p: prev.p ?? p, a: { ...prev.a, ...a } } : { e, p, a });
  }
  const keys = [...merged.keys()], vals = [...merged.values()];
  if (keys.length) await ctx.db.admin.query(
    `insert into vt.audience_members (tenant_id, list_id, person_key, email_sha256, phone_sha256, attrs)
     select $1, $2, k, e, p, a::jsonb from unnest($3::text[], $4::text[], $5::text[], $6::text[]) as t(k, e, p, a)
     on conflict (list_id, person_key) do update set
       email_sha256 = coalesce(vt.audience_members.email_sha256, excluded.email_sha256),
       phone_sha256 = coalesce(vt.audience_members.phone_sha256, excluded.phone_sha256),
       attrs = vt.audience_members.attrs || excluded.attrs`,
    [ctx.tenantId, id, keys, vals.map(v => v.e), vals.map(v => v.p), vals.map(v => JSON.stringify(v.a))]);
  const skipped = Math.max(0, Math.round(Number(body.rejected ?? 0)) || 0);
  await ctx.db.admin.query(`update vt.audience_lists set rows_received = rows_received + $3, rows_rejected = rows_rejected + $4 where id = $1 and tenant_id = $2`,
    [id, ctx.tenantId, body.rows.length + skipped, bad + skipped]);
  return { accepted: keys.length, refused: bad };
}

/** Close the upload: count people and summarise attributes for the bucket builder. */
export async function finishList(ctx: Ctx, id: string) {
  requireRole(ctx, EDITORS, 'Uploading audience lists');
  await ownList(ctx, id);
  const sql = ctx.db.admin;
  const [c] = await sql.query<{ people: number; with_email: number; with_phone: number }>(
    `select count(*)::int as people, count(email_sha256)::int as with_email, count(phone_sha256)::int as with_phone from vt.audience_members where list_id = $1`, [id]);
  const fields = await sql.query<{ k: string; filled: number; distinct: number; numeric: boolean; min: number | null; max: number | null }>(
    `select k, count(*)::int as filled, count(distinct v)::int as distinct, bool_and(v ~ '^-?[0-9]+(\\.[0-9]+)?$') as numeric,
            min(case when v ~ '^-?[0-9]+(\\.[0-9]+)?$' then v::numeric end)::float as min, max(case when v ~ '^-?[0-9]+(\\.[0-9]+)?$' then v::numeric end)::float as max
       from vt.audience_members m, jsonb_each_text(m.attrs) as t(k, v) where m.list_id = $1 group by k order by k limit 24`, [id]);
  const tops = await sql.query<{ k: string; v: string; n: number }>(
    `select k, v, n from (select k, v, count(*)::int as n, row_number() over (partition by k order by count(*) desc, v) as rn
       from vt.audience_members m, jsonb_each_text(m.attrs) as t(k, v) where m.list_id = $1 group by k, v) s where rn <= 20 order by k, n desc`, [id]);
  const attributes: Record<string, AttributeSummary> = {};
  for (const f of fields) attributes[f.k] = { filled: f.filled, distinct: f.distinct, numeric: !!f.numeric, ...(f.numeric ? { min: f.min ?? undefined, max: f.max ?? undefined } : {}), top: tops.filter(t => t.k === f.k).map(t => [t.v, t.n]) };
  await sql.query(`update vt.audience_lists set status = 'ready', people = $3, with_email = $4, with_phone = $5, attributes = $6, completed_at = now() where id = $1 and tenant_id = $2`,
    [id, ctx.tenantId, c!.people, c!.with_email, c!.with_phone, JSON.stringify(attributes)]);
  // buckets using this list are out of date now
  const touched = await sql.query<{ id: string }>(`select id from vt.audience_buckets where tenant_id = $1 and ($2 = any(include_lists) or $2 = any(exclude_lists) or measure_list = $2)`, [ctx.tenantId, id]);
  for (const b of touched) await computeBucket(sql, ctx.tenantId, b.id);
  return { people: c!.people, withEmail: c!.with_email, withPhone: c!.with_phone, attributes: Object.keys(attributes) };
}

export async function deleteList(ctx: Ctx, id: string) {
  requireRole(ctx, EDITORS, 'Deleting audience lists');
  await ownList(ctx, id);
  await ctx.db.admin.query(`delete from vt.audience_lists where id = $1 and tenant_id = $2`, [id, ctx.tenantId]);
  // drop the list from any bucket that used it
  await ctx.db.admin.query(`update vt.audience_buckets set include_lists = array_remove(include_lists, $2::uuid), exclude_lists = array_remove(exclude_lists, $2::uuid) where tenant_id = $1`, [ctx.tenantId, id]);
  return { removed: true };
}

/** Lists past their date are deleted with every member (the daily job, and each visit to Audiences). */
export async function purgeExpired(sql: Sql, tenantId?: string) {
  const r = await sql.query<{ id: string }>(`delete from vt.audience_lists where expires_at < now() ${tenantId ? 'and tenant_id = $1' : ''} returning id`, tenantId ? [tenantId] : []);
  return r.length;
}

// ---------------------------------------------------------------- buckets
function ruleSql(rules: BucketRule[], params: unknown[]): string {
  const at = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const num = (f: string) => `(case when m.attrs->>${f} ~ '^-?[0-9]+(\\.[0-9]+)?$' then (m.attrs->>${f})::numeric end)`;
  return rules.map(r => {
    const f = at(r.field);
    switch (r.op) {
      case 'is': return `lower(m.attrs->>${f}) = lower(${at(r.value)})`;
      case 'is_not': return `coalesce(lower(m.attrs->>${f}), '') <> lower(${at(r.value)})`;
      case 'in': return `lower(m.attrs->>${f}) = any(${at(r.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean))}::text[])`;
      case 'at_least': return `${num(f)} >= ${at(r.value)}::numeric`;
      case 'at_most': return `${num(f)} <= ${at(r.value)}::numeric`;
      case 'contains': return `m.attrs->>${f} ilike '%' || ${at(r.value.replace(/[\\%_]/g, c => `\\${c}`))} || '%'`;
    }
  }).map(s => ` and ${s}`).join('');
}

/**
 * The people in a bucket, each marked holdout or not. A person's holdout place comes from the bucket id
 * and their key alone, so it never changes between runs, exports or new uploads.
 */
function bucketSql(b: Pick<BucketRow, 'id' | 'include_lists' | 'exclude_lists' | 'rules' | 'holdout_pct'>, tenantId: string, params: unknown[]) {
  params.push(tenantId, b.include_lists, b.exclude_lists, b.id, b.holdout_pct);
  const where = ruleSql(b.rules ?? [], params);
  return `with cand as (
      select distinct on (m.person_key) m.person_key, m.email_sha256, m.phone_sha256 from vt.audience_members m
       where m.tenant_id = $1 and m.list_id = any($2::uuid[])${where} order by m.person_key),
    pick as (
      select c.*, ((('x' || substr(md5($4::text || ':' || c.person_key), 1, 8))::bit(32)::bigint % 10000) < ($5::numeric * 100)) as holdout
        from cand c where not exists (select 1 from vt.audience_members x where x.tenant_id = $1 and x.list_id = any($3::uuid[])
          and (x.person_key = c.person_key or x.email_sha256 = c.email_sha256 or x.phone_sha256 = c.phone_sha256)))`;
}

export async function computeBucket(sql: Sql, tenantId: string, id: string): Promise<BucketStats> {
  const [b] = await sql.query<BucketRow>(`select id, name, purpose, include_lists, exclude_lists, rules, holdout_pct::float as holdout_pct, measure_list from vt.audience_buckets where id = $1 and tenant_id = $2`, [id, tenantId]);
  if (!b) throw new HttpError(404, 'Bucket not found.');
  const params: unknown[] = [];
  let q = `${bucketSql(b, tenantId, params)}
    select (select count(*) from cand)::int as candidates, count(*)::int as people, count(*) filter (where holdout)::int as holdout,
           count(email_sha256)::int as with_email, count(phone_sha256)::int as with_phone`;
  if (b.measure_list) {
    params.push(b.measure_list);
    const m = `$${params.length}`;
    q += `, count(*) filter (where not holdout and exists (select 1 from vt.audience_members y where y.tenant_id = $1 and y.list_id = ${m}::uuid and (y.email_sha256 = pick.email_sha256 or y.phone_sha256 = pick.phone_sha256)))::int as t_conv,
          count(*) filter (where holdout and exists (select 1 from vt.audience_members y where y.tenant_id = $1 and y.list_id = ${m}::uuid and (y.email_sha256 = pick.email_sha256 or y.phone_sha256 = pick.phone_sha256)))::int as h_conv`;
  }
  q += ` from pick`;
  const [r] = await sql.query<{ candidates: number; people: number; holdout: number; with_email: number; with_phone: number; t_conv?: number; h_conv?: number }>(q, params);
  const targeted = r!.people - r!.holdout;
  const stats: BucketStats = { candidates: r!.candidates, excluded: r!.candidates - r!.people, people: r!.people, holdout: r!.holdout, targeted, withEmail: r!.with_email, withPhone: r!.with_phone };
  if (b.measure_list && r!.t_conv !== undefined) {
    const [ml] = await sql.query<{ name: string }>(`select name from vt.audience_lists where id = $1`, [b.measure_list]);
    const tr = targeted ? r!.t_conv / targeted : 0, hr = r!.holdout ? r!.h_conv! / r!.holdout : 0;
    // lift needs a holdout big enough to say something: at least 30 people
    stats.measured = { list: ml?.name ?? 'Buyers', targetedConverted: r!.t_conv, holdoutConverted: r!.h_conv!, targetedRate: tr, holdoutRate: hr, lift: r!.holdout >= 30 && hr > 0 ? tr / hr : null };
  }
  await sql.query(`update vt.audience_buckets set stats = $3, computed_at = now() where id = $1 and tenant_id = $2`, [id, tenantId, JSON.stringify(stats)]);
  return stats;
}

async function cleanBucketBody(ctx: Ctx, body: Record<string, unknown>) {
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && UUID.test(x)).slice(0, 20) : []);
  const include = ids(body.includeLists), exclude = ids(body.excludeLists);
  const measure = typeof body.measureList === 'string' && UUID.test(body.measureList) ? body.measureList : null;
  const all = [...new Set([...include, ...exclude, ...(measure ? [measure] : [])])];
  const found = all.length ? await ctx.db.admin.query<{ id: string; status: string }>(`select id, status from vt.audience_lists where tenant_id = $1 and id = any($2::uuid[])`, [ctx.tenantId, all]) : [];
  if (found.length !== all.length) throw new HttpError(400, 'One of the chosen lists no longer exists.');
  if (found.some(f => f.status !== 'ready')) throw new HttpError(400, 'A chosen list is still uploading. Wait for it to finish.');
  if (!include.length) throw new HttpError(400, 'Choose at least one list to build the bucket from.');
  const pct = body.holdoutPct === undefined ? 10 : Number(body.holdoutPct);
  if (!(pct >= 0 && pct <= 50)) throw new HttpError(400, 'Keep between 0% and 50% aside as the holdout.');
  const purpose = typeof body.purpose === 'string' && body.purpose in BUCKET_PURPOSES ? body.purpose : 'target';
  return { include, exclude, measure, pct, purpose, rules: cleanRules(body.rules) };
}

export async function createBucket(ctx: Ctx, body: Record<string, unknown>) {
  requireRole(ctx, EDITORS, 'Building buckets');
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  if (!name) throw new HttpError(400, 'Give the bucket a name, for example "Likely to upgrade".');
  const c = await cleanBucketBody(ctx, body);
  const [row] = await ctx.db.admin.query<{ id: string }>(
    `insert into vt.audience_buckets (tenant_id, name, purpose, include_lists, exclude_lists, rules, holdout_pct, measure_list, created_by)
     values ($1,$2,$3,$4::uuid[],$5::uuid[],$6,$7,$8,$9) on conflict (tenant_id, name) do nothing returning id`,
    [ctx.tenantId, name, c.purpose, c.include, c.exclude, JSON.stringify(c.rules), c.pct, c.measure, ctx.userId]);
  if (!row) throw new HttpError(409, `A bucket called "${name}" already exists.`);
  return { id: row.id, stats: await computeBucket(ctx.db.admin, ctx.tenantId, row.id) };
}

export async function updateBucket(ctx: Ctx, id: string, body: Record<string, unknown>) {
  requireRole(ctx, EDITORS, 'Changing buckets');
  if (!UUID.test(id)) throw new HttpError(404, 'Bucket not found.');
  const c = await cleanBucketBody(ctx, body);
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : null;
  const r = await ctx.db.admin.query(
    `update vt.audience_buckets set name = coalesce($3, name), purpose = $4, include_lists = $5::uuid[], exclude_lists = $6::uuid[], rules = $7, holdout_pct = $8, measure_list = $9
      where id = $1 and tenant_id = $2 returning id`, [id, ctx.tenantId, name, c.purpose, c.include, c.exclude, JSON.stringify(c.rules), c.pct, c.measure]);
  if (!r.length) throw new HttpError(404, 'Bucket not found.');
  return { stats: await computeBucket(ctx.db.admin, ctx.tenantId, id) };
}

/** Count a bucket before saving it. Uses a throwaway id, so holdout counts are close to, not exactly, the saved ones. */
export async function previewBucket(ctx: Ctx, body: Record<string, unknown>) {
  requireRole(ctx, EDITORS, 'Building buckets');
  const c = await cleanBucketBody(ctx, body);
  const params: unknown[] = [];
  const q = `${bucketSql({ id: 'preview', include_lists: c.include, exclude_lists: c.exclude, rules: c.rules, holdout_pct: c.pct }, ctx.tenantId, params)}
    select (select count(*) from cand)::int as candidates, count(*)::int as people from pick`;
  const [r] = await ctx.db.admin.query<{ candidates: number; people: number }>(q, params);
  return { candidates: r!.candidates, excluded: r!.candidates - r!.people, people: r!.people, holdout: Math.round(r!.people * c.pct / 100), summary: describeRules(c.rules) };
}

export async function deleteBucket(ctx: Ctx, id: string) {
  requireRole(ctx, EDITORS, 'Deleting buckets');
  if (!UUID.test(id)) throw new HttpError(404, 'Bucket not found.');
  const r = await ctx.db.admin.query(`delete from vt.audience_buckets where id = $1 and tenant_id = $2 returning id`, [id, ctx.tenantId]);
  if (!r.length) throw new HttpError(404, 'Bucket not found.');
  return { removed: true };
}

// ---------------------------------------------------------------- exports
export const EXPORT_FORMATS = {
  google: { label: 'Google Customer Match (DV360, Google Ads, YouTube)', header: ['Email', 'Phone'] },
  meta: { label: 'Meta custom audience', header: ['email', 'phone'] },
  plain: { label: 'Plain hashed list (SSP, identity partner, clean room)', header: ['email_sha256', 'phone_sha256'] },
} as const;
type ExportFormat = keyof typeof EXPORT_FORMATS;

/**
 * A bucket's people as hashed keys, page by page (50,000 rows each). The targeted part goes to media;
 * the holdout part goes only to a clean room or measurement partner, never to activation. Every export
 * is logged with who, what and how many.
 */
export async function exportBucket(ctx: Ctx, id: string, url: URL) {
  requireRole(ctx, EDITORS, 'Exporting audiences');
  if (!UUID.test(id)) throw new HttpError(404, 'Bucket not found.');
  const part = url.searchParams.get('part') === 'holdout' ? 'holdout' : 'target';
  const format = (url.searchParams.get('format') ?? 'google') as ExportFormat;
  if (!(format in EXPORT_FORMATS)) throw new HttpError(400, 'Unknown export format.');
  if (part === 'holdout' && format !== 'plain') throw new HttpError(400, 'The holdout is exported only as a plain hashed list, for a clean room or measurement partner. It must never be targeted.');
  const page = Math.max(0, Math.floor(Number(url.searchParams.get('page') ?? 0)) || 0);
  const [b] = await ctx.db.admin.query<BucketRow>(`select id, name, include_lists, exclude_lists, rules, holdout_pct::float as holdout_pct from vt.audience_buckets where id = $1 and tenant_id = $2`, [id, ctx.tenantId]);
  if (!b) throw new HttpError(404, 'Bucket not found.');
  const params: unknown[] = [];
  const base = bucketSql(b, ctx.tenantId, params);
  const [{ total }] = await ctx.db.admin.query<{ total: number }>(`${base} select count(*)::int as total from pick where holdout = ${part === 'holdout'}`, [...params]) as [{ total: number }];
  params.push(EXPORT_PAGE, page * EXPORT_PAGE);
  const rows = await ctx.db.admin.query<{ e: string | null; p: string | null }>(
    `${base} select email_sha256 as e, phone_sha256 as p from pick where holdout = ${part === 'holdout'} order by person_key limit $${params.length - 1} offset $${params.length}`, params);
  if (page === 0) await ctx.db.admin.query(`insert into vt.audience_exports (tenant_id, bucket_id, bucket_name, part, format, rows, created_by) values ($1,$2,$3,$4,$5,$6,$7)`,
    [ctx.tenantId, id, b.name, part, format, total, ctx.userId]);
  const lines = rows.map(r => `${r.e ?? ''},${r.p ?? ''}`);
  return { total, page, pages: Math.max(1, Math.ceil(total / EXPORT_PAGE)), header: EXPORT_FORMATS[format].header.join(','), csv: lines.join('\n'), fileName: `${b.name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${part}-${format}.csv` };
}

export async function purgeAllExpired(deps: Deps) { return purgeExpired(deps.db.admin); }
