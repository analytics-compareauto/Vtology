/**
 * All media on one grid: TV, print, radio and outdoor reports and the brand's results, stored as daily
 * totals (region × vehicle), read next to the digital media already imported. The answer: spend and
 * reach by medium and week, results by week, the lift for each medium, and where each medium ran
 * against where results came from.
 */
import { OFFLINE_LABEL, CHANNEL_LABEL, crossFindings, mediaLift, regionFit, mondayOf, type MediumWeek, type OfflineMedium, type OutcomeWeek } from '@vtology/core';
import { HttpError, requireRole, type Ctx } from './context';
import { moneyFormat } from './media';

const EDITORS: Ctx['role'][] = ['marketing_head', 'data_steward'];
const VIEWERS: Ctx['role'][] = [...EDITORS, 'finance'];
const MEDIA: OfflineMedium[] = ['tv', 'print', 'radio', 'ooh', 'results'];
const UUID = /^[0-9a-f-]{36}$/i;
export const OFFLINE_CHUNK = 5000;
const NUMS = ['spend', 'reach', 'units', 'seconds', 'leads', 'sales', 'value'] as const;

export async function listOffline(ctx: Ctx) {
  requireRole(ctx, VIEWERS, 'Media reports');
  return ctx.db.admin.query(`select id, name, medium, currency, status, rows, date_from, date_to, created_at from vt.offline_reports where tenant_id = $1 order by created_at desc`, [ctx.tenantId]);
}

export async function createOffline(ctx: Ctx, body: { name?: unknown; medium?: unknown; currency?: unknown }) {
  requireRole(ctx, EDITORS, 'Uploading media reports');
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
  if (!name) throw new HttpError(400, 'Give the report a name, for example "TV, Diwali burst".');
  if (!MEDIA.includes(body.medium as OfflineMedium)) throw new HttpError(400, 'Choose what the file holds: TV, print, radio, outdoor, or results.');
  const currency = typeof body.currency === 'string' && /^[A-Za-z]{3}$/.test(body.currency.trim()) ? body.currency.trim().toUpperCase() : 'INR';
  const [row] = await ctx.db.admin.query<{ id: string }>(`insert into vt.offline_reports (tenant_id, name, medium, currency, created_by) values ($1,$2,$3,$4,$5) on conflict (tenant_id, name) do nothing returning id`,
    [ctx.tenantId, name, body.medium, currency, ctx.userId]);
  if (!row) throw new HttpError(409, `A report called "${name}" already exists. Delete it first, or choose another name.`);
  return { id: row.id, chunkMax: OFFLINE_CHUNK };
}

/** Rows are added into daily totals as they arrive: the same day, region and vehicle twice adds up. */
export async function appendOffline(ctx: Ctx, id: string, body: { rows?: unknown }) {
  requireRole(ctx, EDITORS, 'Uploading media reports');
  if (!UUID.test(id)) throw new HttpError(404, 'Report not found.');
  const [rep] = await ctx.db.admin.query<{ status: string }>(`select status from vt.offline_reports where id = $1 and tenant_id = $2`, [id, ctx.tenantId]);
  if (!rep) throw new HttpError(404, 'Report not found.');
  if (rep.status !== 'uploading') throw new HttpError(409, 'This report is complete. Upload a new one to add rows.');
  if (!Array.isArray(body.rows) || body.rows.length > OFFLINE_CHUNK) throw new HttpError(400, `Send up to ${OFFLINE_CHUNK} rows at a time.`);
  // totals per key inside the chunk first (an insert can't touch the same key twice)
  const acc = new Map<string, { day: string; region: string; vehicle: string; n: number[] }>();
  let bad = 0;
  for (const raw of body.rows) {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (typeof r.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || Number.isNaN(Date.parse(r.day))) { bad++; continue; }
    const n = NUMS.map(k => Number(r[k] ?? 0));
    if (n.some(x => !Number.isFinite(x) || x < 0 || x > 1e13)) { bad++; continue; }
    const region = String(r.region ?? '').trim().slice(0, 80) || 'All India', vehicle = String(r.vehicle ?? '').trim().slice(0, 120);
    const k = `${r.day}|${region}|${vehicle}`;
    const e = acc.get(k);
    if (e) n.forEach((x, i) => { e.n[i]! += x; }); else acc.set(k, { day: r.day, region, vehicle, n });
  }
  const v = [...acc.values()];
  if (v.length) await ctx.db.admin.query(
    `insert into vt.offline_daily (tenant_id, report_id, day, region, vehicle, ${NUMS.join(', ')})
     select $1, $2, d::date, g, h, ${NUMS.map((_, i) => `n${i}`).join(', ')} from unnest($3::text[], $4::text[], $5::text[], ${NUMS.map((_, i) => `$${6 + i}::numeric[]`).join(', ')}) as t(d, g, h, ${NUMS.map((_, i) => `n${i}`).join(', ')})
     on conflict (report_id, day, region, vehicle) do update set ${NUMS.map(k => `${k} = offline_daily.${k} + excluded.${k}`).join(', ')}`,
    [ctx.tenantId, id, v.map(x => x.day), v.map(x => x.region), v.map(x => x.vehicle), ...NUMS.map((_, i) => v.map(x => x.n[i]))]);
  return { accepted: body.rows.length - bad, refused: bad };
}

export async function finishOffline(ctx: Ctx, id: string) {
  requireRole(ctx, EDITORS, 'Uploading media reports');
  if (!UUID.test(id)) throw new HttpError(404, 'Report not found.');
  const [r] = await ctx.db.admin.query<{ n: number; f: string | null; t: string | null }>(`select count(*)::int as n, min(day)::text as f, max(day)::text as t from vt.offline_daily where report_id = $1 and tenant_id = $2`, [id, ctx.tenantId]);
  if (!r?.n) { await ctx.db.admin.query(`delete from vt.offline_reports where id = $1 and tenant_id = $2`, [id, ctx.tenantId]); throw new HttpError(400, 'No rows could be read, so nothing was saved. Check that the file has a date column.'); }
  await ctx.db.admin.query(`update vt.offline_reports set status = 'ready', rows = $3, date_from = $4, date_to = $5 where id = $1 and tenant_id = $2`, [id, ctx.tenantId, r.n, r.f, r.t]);
  return { rows: r.n, from: r.f, to: r.t };
}

export async function deleteOffline(ctx: Ctx, id: string) {
  requireRole(ctx, EDITORS, 'Uploading media reports');
  if (!UUID.test(id)) throw new HttpError(404, 'Report not found.');
  await ctx.db.admin.query(`delete from vt.offline_reports where id = $1 and tenant_id = $2`, [id, ctx.tenantId]);
  return { deleted: true };
}

const label = (m: string) => OFFLINE_LABEL[m as OfflineMedium] ?? CHANNEL_LABEL[m as keyof typeof CHANNEL_LABEL] ?? m;

export async function crossMediaOverview(ctx: Ctx, range: { from: string; to: string }) {
  requireRole(ctx, VIEWERS, 'Media reports');
  const sql = ctx.db.admin;
  // offline media and results by week and region, digital by week (the whole country)
  const off = await sql.query<{ week: string; medium: string; region: string; currency: string; spend: string; reach: string; units: string; leads: string; sales: string; value: string }>(
    `select date_trunc('week', d.day)::date::text as week, r.medium, d.region, r.currency, sum(d.spend) as spend, sum(d.reach) as reach, sum(d.units) as units, sum(d.leads) as leads, sum(d.sales) as sales, sum(d.value) as value
       from vt.offline_daily d join vt.offline_reports r on r.id = d.report_id
      where d.tenant_id = $1 and r.status = 'ready' and d.day between $2::date and $3::date group by 1, 2, 3, 4`, [ctx.tenantId, range.from, range.to]);
  const dig = await sql.query<{ week: string; medium: string; currency: string; spend: string; reach: string }>(
    `select date_trunc('week', d.day)::date::text as week, d.channel as medium, coalesce(nullif(r.currency, ''), 'INR') as currency, sum(d.cost) as spend, sum(d.impressions) as reach
       from vt.media_daily d join vt.media_reports r on r.id = d.report_id where d.tenant_id = $1 and d.day between $2::date and $3::date group by 1, 2, 3`, [ctx.tenantId, range.from, range.to]);
  // one currency is compared; the others are named so nobody adds rupees to dollars
  const byCur = new Map<string, number>();
  for (const x of [...off.filter(o => o.medium !== 'results'), ...dig]) byCur.set(x.currency, (byCur.get(x.currency) ?? 0) + Number(x.spend));
  const currency = [...byCur.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'INR';
  const leftOut = [...byCur.keys()].filter(c => c !== currency);
  const media: (MediumWeek & { kind: 'offline' | 'digital'; units: number })[] = [
    ...off.filter(o => o.medium !== 'results' && o.currency === currency).map(o => ({ week: o.week, medium: o.medium, region: o.region, spend: Number(o.spend), reach: Number(o.reach), units: Number(o.units), kind: 'offline' as const })),
    ...dig.filter(d => d.currency === currency).map(d => ({ week: d.week, medium: d.medium, region: 'All India', spend: Number(d.spend), reach: Number(d.reach), units: 0, kind: 'digital' as const })),
  ];
  const outcomes: OutcomeWeek[] = off.filter(o => o.medium === 'results').map(o => ({ week: o.week, region: o.region, leads: Number(o.leads), sales: Number(o.sales), value: Number(o.value) }));
  const fm = moneyFormat(currency);
  const lift = mediaLift(media, outcomes);
  const regions = regionFit(media, outcomes, lift.measure);
  // headline figures short (₹5.4L, ₹1.5Cr), sentences exact
  const fshort = (v: number) => (currency === 'INR' && v >= 1e5 ? `₹${v >= 1e7 ? `${(v / 1e7).toFixed(1)}Cr` : `${(v / 1e5).toFixed(1)}L`}` : fm(v));
  const findings = outcomes.length ? crossFindings(lift.lifts, regions, lift.measure, label, fm, fshort) : [];
  // every week in the range that has anything, for the two aligned charts
  const weeks = [...new Set([...media.map(m => m.week), ...outcomes.map(o => o.week)])].sort();
  const mediums = [...new Set(media.map(m => m.medium))];
  const series = mediums.map(m => ({ medium: m, label: label(m), kind: media.find(x => x.medium === m)!.kind, values: weeks.map(w => media.filter(x => x.medium === m && x.week === w).reduce((a, x) => a + x.spend, 0)) }));
  const results = weeks.map(w => outcomes.filter(o => o.week === w).reduce((a, o) => a + o[lift.measure], 0));
  const totals = mediums.map(m => {
    const xs = media.filter(x => x.medium === m);
    return { medium: m, label: label(m), kind: xs[0]!.kind, spend: xs.reduce((a, x) => a + x.spend, 0), reach: xs.reduce((a, x) => a + x.reach, 0), units: xs.reduce((a, x) => a + x.units, 0), weeks: new Set(xs.filter(x => x.spend > 0).map(x => x.week)).size };
  }).sort((a, b) => b.spend - a.spend);
  const reports = await listOffline(ctx);
  return {
    currency, leftOut, measure: lift.measure, hasResults: outcomes.length > 0, hasDigital: dig.length > 0,
    weeks, series, results, totals, lifts: lift.lifts.map(l => ({ ...l, label: label(l.medium) })), regions: regions.slice(0, 15),
    findings, reports, canEdit: EDITORS.includes(ctx.role), weekStart: mondayOf(range.from),
  };
}
