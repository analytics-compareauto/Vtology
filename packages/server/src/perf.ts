/**
 * Performance campaigns (Google Ads, Meta) kept as daily totals per campaign and ad group, and search
 * terms as totals. The answer: spend, conversions and cost per conversion by kind of campaign and by
 * campaign, findings (brand searches, waste, negatives, the effect of mainline media) and next
 * month's plan at the same budget.
 */
import { isBrand, campaignIsBrand, perfFindings, perfPlan, type PerfLine, type PerfWeek } from '@vtology/core';
import { HttpError, requireRole, type Ctx } from './context';
import { moneyFormat } from './media';

const EDITORS: Ctx['role'][] = ['marketing_head', 'data_steward'];
const VIEWERS: Ctx['role'][] = [...EDITORS, 'finance'];
const UUID = /^[0-9a-f-]{36}$/i;
export const PERF_CHUNK = 5000;
const N = ['cost', 'impressions', 'clicks', 'conversions', 'value'] as const;

export async function listPerf(ctx: Ctx) {
  requireRole(ctx, VIEWERS, 'Performance reports');
  return ctx.db.admin.query(`select id, name, platform, kind, currency, status, rows, date_from::text, date_to::text, created_at from vt.perf_reports where tenant_id = $1 order by created_at desc`, [ctx.tenantId]);
}

export async function createPerf(ctx: Ctx, body: { name?: unknown; platform?: unknown; kind?: unknown; currency?: unknown }) {
  requireRole(ctx, EDITORS, 'Uploading performance reports');
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
  if (!name) throw new HttpError(400, 'Give the report a name, for example "Google Ads, October".');
  const platform = ['google', 'meta', 'other'].includes(body.platform as string) ? body.platform : 'other';
  const kind = body.kind === 'terms' ? 'terms' : 'campaigns';
  const currency = typeof body.currency === 'string' && /^[A-Za-z]{3}$/.test(body.currency.trim()) ? body.currency.trim().toUpperCase() : 'INR';
  const [row] = await ctx.db.admin.query<{ id: string }>(`insert into vt.perf_reports (tenant_id, name, platform, kind, currency, created_by) values ($1,$2,$3,$4,$5,$6) on conflict (tenant_id, name) do nothing returning id`, [ctx.tenantId, name, platform, kind, currency, ctx.userId]);
  if (!row) throw new HttpError(409, `A report called "${name}" already exists. Delete it first, or choose another name.`);
  return { id: row.id, chunkMax: PERF_CHUNK };
}

export async function appendPerf(ctx: Ctx, id: string, body: { rows?: unknown }) {
  requireRole(ctx, EDITORS, 'Uploading performance reports');
  if (!UUID.test(id)) throw new HttpError(404, 'Report not found.');
  const [rep] = await ctx.db.admin.query<{ status: string; kind: string; platform: string }>(`select status, kind, platform from vt.perf_reports where id = $1 and tenant_id = $2`, [id, ctx.tenantId]);
  if (!rep) throw new HttpError(404, 'Report not found.');
  if (rep.status !== 'uploading') throw new HttpError(409, 'This report is complete. Upload a new one to add rows.');
  if (!Array.isArray(body.rows) || body.rows.length > PERF_CHUNK) throw new HttpError(400, `Send up to ${PERF_CHUNK} rows at a time.`);
  const acc = new Map<string, { k: string[]; n: number[] }>();
  let bad = 0;
  for (const raw of body.rows) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const n = [...N.map(k => Number(r[k] ?? 0)), r.lostBudget === null || r.lostBudget === undefined ? -1 : Number(r.lostBudget)];
    if (n.slice(0, 5).some(x => !Number.isFinite(x) || x < 0 || x > 1e13)) { bad++; continue; }
    const s = (k: string, max = 200) => String(r[k] ?? '').trim().slice(0, max);
    let key: string[];
    if (rep.kind === 'terms') { if (!s('term')) { bad++; continue; } key = [s('term'), s('campaign')]; }
    else {
      if (typeof r.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || Number.isNaN(Date.parse(r.day))) { bad++; continue; }
      key = [r.day, s('campaignType', 60) || 'Other', s('campaign') || '(no campaign)', s('adGroup')];
    }
    const lost = n[5]! >= 0 && n[5]! <= 1 ? n[5]! : null;
    const vals = [...n.slice(0, 5), lost === null ? 0 : lost * n[0]!, lost === null ? 0 : n[0]!];
    const id2 = key.join('|'), e = acc.get(id2);
    if (e) vals.forEach((x, i) => { e.n[i]! += x; }); else acc.set(id2, { k: key, n: vals });
  }
  const v = [...acc.values()];
  if (v.length && rep.kind === 'terms') await ctx.db.admin.query(
    `insert into vt.perf_terms (tenant_id, report_id, term, campaign, cost, clicks, conversions, value)
     select $1, $2, t, c, a, b, d, e from unnest($3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[]) as x(t, c, a, b, d, e)
     on conflict (report_id, term, campaign) do update set cost = perf_terms.cost + excluded.cost, clicks = perf_terms.clicks + excluded.clicks, conversions = perf_terms.conversions + excluded.conversions, value = perf_terms.value + excluded.value`,
    [ctx.tenantId, id, v.map(x => x.k[0]), v.map(x => x.k[1]), v.map(x => x.n[0]), v.map(x => x.n[2]), v.map(x => x.n[3]), v.map(x => x.n[4])]);
  else if (v.length) await ctx.db.admin.query(
    `insert into vt.perf_daily (tenant_id, report_id, day, platform, campaign_type, campaign, ad_group, cost, impressions, clicks, conversions, value, lost_cost, lost_weight)
     select $1, $2, d::date, $3, ty, c, g, a, i, k, cv, va, lc, lw from unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::numeric[], $9::numeric[], $10::numeric[], $11::numeric[], $12::numeric[], $13::numeric[], $14::numeric[]) as x(d, ty, c, g, a, i, k, cv, va, lc, lw)
     on conflict (report_id, day, campaign, ad_group) do update set cost = perf_daily.cost + excluded.cost, impressions = perf_daily.impressions + excluded.impressions, clicks = perf_daily.clicks + excluded.clicks,
       conversions = perf_daily.conversions + excluded.conversions, value = perf_daily.value + excluded.value, lost_cost = perf_daily.lost_cost + excluded.lost_cost, lost_weight = perf_daily.lost_weight + excluded.lost_weight`,
    [ctx.tenantId, id, rep.platform, v.map(x => x.k[0]), v.map(x => x.k[1]), v.map(x => x.k[2]), v.map(x => x.k[3]), ...[0, 1, 2, 3, 4, 5, 6].map(i => v.map(x => x.n[i]))]);
  return { accepted: body.rows.length - bad, refused: bad };
}

export async function finishPerf(ctx: Ctx, id: string) {
  requireRole(ctx, EDITORS, 'Uploading performance reports');
  if (!UUID.test(id)) throw new HttpError(404, 'Report not found.');
  const [rep] = await ctx.db.admin.query<{ kind: string }>(`select kind from vt.perf_reports where id = $1 and tenant_id = $2`, [id, ctx.tenantId]);
  if (!rep) throw new HttpError(404, 'Report not found.');
  const [r] = rep.kind === 'terms'
    ? await ctx.db.admin.query<{ n: number; f: string | null; t: string | null }>(`select count(*)::int as n, null::text as f, null::text as t from vt.perf_terms where report_id = $1`, [id])
    : await ctx.db.admin.query<{ n: number; f: string | null; t: string | null }>(`select count(*)::int as n, min(day)::text as f, max(day)::text as t from vt.perf_daily where report_id = $1`, [id]);
  if (!r?.n) { await ctx.db.admin.query(`delete from vt.perf_reports where id = $1`, [id]); throw new HttpError(400, 'No rows could be read, so nothing was saved.'); }
  await ctx.db.admin.query(`update vt.perf_reports set status = 'ready', rows = $2, date_from = $3, date_to = $4 where id = $1`, [id, r.n, r.f, r.t]);
  return { rows: r.n, from: r.f, to: r.t };
}

export async function deletePerf(ctx: Ctx, id: string) {
  requireRole(ctx, EDITORS, 'Uploading performance reports');
  if (!UUID.test(id)) throw new HttpError(404, 'Report not found.');
  await ctx.db.admin.query(`delete from vt.perf_reports where id = $1 and tenant_id = $2`, [id, ctx.tenantId]);
  return { deleted: true };
}

/** The brand's own name, as people search it ("CompareAuto" → compareauto, compare auto). */
function brandWords(name: string): string[] {
  const n = name.trim().toLowerCase();
  const spaced = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return [...new Set([n, n.replace(/\s+/g, ''), spaced, n.split(/\s+/)[0]!].filter(w => w.length >= 3))];
}

export async function perfOverview(ctx: Ctx, range: { from: string; to: string }) {
  requireRole(ctx, VIEWERS, 'Performance reports');
  const sql = ctx.db.admin;
  const rows = await sql.query<{ platform: string; campaign_type: string; campaign: string; currency: string; cost: string; impressions: string; clicks: string; conversions: string; value: string; lost_cost: string; lost_weight: string }>(
    `select d.platform, d.campaign_type, d.campaign, r.currency, sum(d.cost) as cost, sum(d.impressions) as impressions, sum(d.clicks) as clicks, sum(d.conversions) as conversions, sum(d.value) as value, sum(d.lost_cost) as lost_cost, sum(d.lost_weight) as lost_weight
       from vt.perf_daily d join vt.perf_reports r on r.id = d.report_id where d.tenant_id = $1 and r.status = 'ready' and d.day between $2::date and $3::date group by 1, 2, 3, 4`, [ctx.tenantId, range.from, range.to]);
  const reports = await listPerf(ctx);
  const byCur = new Map<string, number>();
  for (const r of rows) byCur.set(r.currency, (byCur.get(r.currency) ?? 0) + Number(r.cost));
  const currency = [...byCur.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'INR';
  const fm = moneyFormat(currency);
  const words = brandWords(ctx.tenantName);
  const lines: PerfLine[] = rows.filter(r => r.currency === currency).map(r => ({ name: r.campaign, type: r.campaign_type, platform: r.platform, cost: Number(r.cost), clicks: Number(r.clicks), impressions: Number(r.impressions), conversions: Number(r.conversions), value: Number(r.value),
    lostBudget: Number(r.lost_weight) > 0 ? Number(r.lost_cost) / Number(r.lost_weight) : null, brand: campaignIsBrand(r.campaign, r.campaign_type, words) }));
  const wk = await sql.query<{ week: string; campaign: string; campaign_type: string; cost: string; conversions: string; clicks: string }>(
    `select date_trunc('week', d.day)::date::text as week, d.campaign, d.campaign_type, sum(d.cost) as cost, sum(d.conversions) as conversions, sum(d.clicks) as clicks
       from vt.perf_daily d join vt.perf_reports r on r.id = d.report_id where d.tenant_id = $1 and r.status = 'ready' and r.currency = $4 and d.day between $2::date and $3::date group by 1, 2, 3`, [ctx.tenantId, range.from, range.to, currency]);
  const weeksMap = new Map<string, PerfWeek>();
  for (const w of wk) {
    const e = weeksMap.get(w.week) ?? { week: w.week, cost: 0, conversions: 0, clicks: 0, brandClicks: 0 };
    e.cost += Number(w.cost); e.conversions += Number(w.conversions); e.clicks += Number(w.clicks);
    if (campaignIsBrand(w.campaign, w.campaign_type, words)) e.brandClicks += Number(w.clicks);
    weeksMap.set(w.week, e);
  }
  const weeks = [...weeksMap.values()].sort((a, b) => a.week.localeCompare(b.week));
  // the mainline medium that switched on and off the most clearly in these weeks (TV, print, radio, outdoor, CTV, online video)
  const ml = await sql.query<{ medium: string; week: string; spend: string }>(
    `select r.medium, date_trunc('week', d.day)::date::text as week, sum(d.spend) as spend from vt.offline_daily d join vt.offline_reports r on r.id = d.report_id
      where d.tenant_id = $1 and r.status = 'ready' and r.medium <> 'results' and d.day between $2::date and $3::date group by 1, 2
     union all
     select channel as medium, date_trunc('week', day)::date::text, sum(cost) from vt.media_daily where tenant_id = $1 and channel in ('ctv', 'video') and day between $2::date and $3::date group by 1, 2`, [ctx.tenantId, range.from, range.to]);
  const LABEL: Record<string, string> = { tv: 'TV', print: 'print', radio: 'radio', ooh: 'outdoor', ctv: 'Connected TV', video: 'online video' };
  const weekSet = new Set(weeks.map(w => w.week));
  const cands = [...new Set(ml.map(m => m.medium))].map(m => {
    const on = new Set(ml.filter(x => x.medium === m && Number(x.spend) > 0 && weekSet.has(x.week)).map(x => x.week));
    return { label: LABEL[m] ?? m, weeks: on, spend: ml.filter(x => x.medium === m).reduce((a, x) => a + Number(x.spend), 0), balance: Math.min(on.size, weekSet.size - on.size) };
  }).filter(c => c.balance >= 3).sort((a, b) => b.spend - a.spend);
  const terms = (await sql.query<{ term: string; cost: string; clicks: string; conversions: string }>(
    `select t.term, sum(t.cost) as cost, sum(t.clicks) as clicks, sum(t.conversions) as conversions from vt.perf_terms t join vt.perf_reports r on r.id = t.report_id where t.tenant_id = $1 and r.status = 'ready' and r.currency = $2 group by 1 order by 2 desc limit 2000`, [ctx.tenantId, currency]))
    .map(t => ({ term: t.term, cost: Number(t.cost), clicks: Number(t.clicks), conversions: Number(t.conversions), brand: isBrand(t.term, words) }));
  const days = weeks.length ? Math.max(7, (Date.parse(range.to) - Math.max(Date.parse(range.from), Date.parse(weeks[0]!.week))) / 86_400_000 + 1) : 30;
  const plan = perfPlan(lines, 30 / days);
  const fshort = (v: number) => (currency === 'INR' && v >= 1e5 ? `₹${v >= 1e7 ? `${(v / 1e7).toFixed(1)}Cr` : `${(v / 1e5).toFixed(1)}L`}` : fm(v));
  const findings = perfFindings(lines, terms, weeks, cands[0] ?? null, fm, fshort);
  const total = lines.reduce((a, l) => a + l.cost, 0), conv = lines.reduce((a, l) => a + l.conversions, 0), value = lines.reduce((a, l) => a + l.value, 0);
  const types = new Map<string, { cost: number; conversions: number; value: number; clicks: number }>();
  for (const l of lines) { const t = types.get(l.type) ?? { cost: 0, conversions: 0, value: 0, clicks: 0 }; t.cost += l.cost; t.conversions += l.conversions; t.value += l.value; t.clicks += l.clicks; types.set(l.type, t); }
  return {
    currency, canEdit: EDITORS.includes(ctx.role), reports, hasTerms: terms.length > 0, mainline: cands[0]?.label ?? null,
    totals: { cost: total, conversions: conv, value, cpa: conv ? total / conv : null, roas: value && total ? value / total : null, clicks: lines.reduce((a, l) => a + l.clicks, 0) },
    types: [...types.entries()].map(([type, t]) => ({ type, ...t, cpa: t.conversions ? t.cost / t.conversions : null })).sort((a, b) => b.cost - a.cost),
    campaigns: [...lines].sort((a, b) => b.cost - a.cost).slice(0, 20).map(l => ({ ...l, cpa: l.conversions ? l.cost / l.conversions : null })),
    weeks, plan, findings,
  };
}
