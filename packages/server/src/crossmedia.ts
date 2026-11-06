/**
 * All media on one grid: TV, print, radio and outdoor reports and the brand's results, stored as daily
 * totals (region × vehicle), read next to the digital media already imported. The answer: spend and
 * reach by medium and week, results by week, the lift for each medium, and where each medium ran
 * against where results came from.
 */
import { OFFLINE_LABEL, CHANNEL_LABEL, crossFindings, mediaLift, regionFit, mondayOf, type MediumWeek, type OfflineMedium, type OutcomeWeek } from '@vtology/core';
import { HttpError, requireRole, type Ctx } from './context';
const compact = (n: number) => (n >= 1e7 ? `${(n / 1e7).toFixed(1)} crore` : n >= 1e5 ? `${(n / 1e5).toFixed(1)} lakh` : Math.round(n).toLocaleString('en-IN'));
import { moneyFormat } from './media';
import { perfOverview } from './perf';

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

const PERF_LABEL: Record<string, string> = { Search: 'Google Search', 'Performance Max': 'Performance Max', YouTube: 'YouTube (Google Ads)', Display: 'Display (Google Ads)', 'Demand Gen': 'Demand Gen (Google Ads)', Shopping: 'Google Shopping', Meta: 'Meta (Facebook, Instagram)' };
/** programmatic (DV360) lines named so they can't be mixed up with the same formats bought in Google Ads */
const PROG_LABEL: Record<string, string> = { ctv: 'Connected TV', video: 'Programmatic video', audio: 'Programmatic audio', display: 'Programmatic display' };
const label = (m: string) => m.startsWith('perf:') ? PERF_LABEL[m.slice(5)] ?? `${m.slice(5)} ads` : PROG_LABEL[m] ?? OFFLINE_LABEL[m as OfflineMedium] ?? CHANNEL_LABEL[m as keyof typeof CHANNEL_LABEL] ?? m;
/** which group a medium belongs to, and the tab with its details */
/** every medium has a job: make people aware, or get the lead or sale; the job decides how it's judged and where its details are */
const AWARE_PERF = ['YouTube', 'Display', 'Demand Gen'];
export const jobOf = (m: string): 'aware' | 'convert' => (m.startsWith('perf:') && !AWARE_PERF.includes(m.slice(5)) ? 'convert' : 'aware');
const groupOf = (m: string) => jobOf(m) === 'convert' ? { group: 'Get the lead or sale', tab: 'search' } : { group: 'Make people aware', tab: m.startsWith('perf:') ? 'search' : 'awareness' };

export async function crossMediaOverview(ctx: Ctx, range: { from: string; to: string }) {
  requireRole(ctx, VIEWERS, 'Media reports');
  const sql = ctx.db.admin;
  // offline media and results by week and region, digital by week (the whole country)
  const off = await sql.query<{ week: string; medium: string; region: string; currency: string; spend: string; reach: string; units: string; leads: string; sales: string; value: string }>(
    `select date_trunc('week', d.day)::date::text as week, r.medium, d.region, r.currency, sum(d.spend) as spend, sum(d.reach) as reach, sum(d.units) as units, sum(d.leads) as leads, sum(d.sales) as sales, sum(d.value) as value
       from vt.offline_daily d join vt.offline_reports r on r.id = d.report_id
      where d.tenant_id = $1 and r.status = 'ready' and d.day between $2::date and $3::date group by 1, 2, 3, 4`, [ctx.tenantId, range.from, range.to]);
  const dig = await sql.query<{ week: string; medium: string; currency: string; spend: string; reach: string; completes: string }>(
    `select date_trunc('week', d.day)::date::text as week, d.channel as medium, coalesce(nullif(r.currency, ''), 'INR') as currency, sum(d.cost) as spend, sum(d.impressions) as reach, sum(d.completes) as completes
       from vt.media_daily d join vt.media_reports r on r.id = d.report_id where d.tenant_id = $1 and d.day between $2::date and $3::date group by 1, 2, 3`, [ctx.tenantId, range.from, range.to]);
  // search and social ads (Google Ads, Meta) by week and kind of campaign, with their conversions
  const perf = await sql.query<{ week: string; medium: string; currency: string; spend: string; reach: string; conversions: string }>(
    `select date_trunc('week', d.day)::date::text as week, 'perf:' || d.campaign_type as medium, r.currency, sum(d.cost) as spend, sum(d.impressions) as reach, sum(d.conversions) as conversions
       from vt.perf_daily d join vt.perf_reports r on r.id = d.report_id where d.tenant_id = $1 and r.status = 'ready' and d.day between $2::date and $3::date group by 1, 2, 3`, [ctx.tenantId, range.from, range.to]);
  // one currency is compared; the others are named so nobody adds rupees to dollars
  const byCur = new Map<string, number>();
  for (const x of [...off.filter(o => o.medium !== 'results'), ...dig, ...perf]) byCur.set(x.currency, (byCur.get(x.currency) ?? 0) + Number(x.spend));
  const currency = [...byCur.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'INR';
  const leftOut = [...byCur.keys()].filter(c => c !== currency);
  const media: (MediumWeek & { kind: 'offline' | 'digital'; units: number })[] = [
    ...off.filter(o => o.medium !== 'results' && o.currency === currency).map(o => ({ week: o.week, medium: o.medium, region: o.region, spend: Number(o.spend), reach: Number(o.reach), units: Number(o.units), kind: 'offline' as const })),
    ...dig.filter(d => d.currency === currency).map(d => ({ week: d.week, medium: d.medium, region: 'All India', spend: Number(d.spend), reach: Number(d.reach), units: 0, kind: 'digital' as const })),
  ];
  const perfMedia = perf.filter(p => p.currency === currency).map(p => ({ week: p.week, medium: p.medium, region: 'All India', spend: Number(p.spend), reach: Number(p.reach), units: 0, kind: 'digital' as const, conversions: Number(p.conversions) }));
  // results: the brand's own file; without one, the conversions the ad platforms report
  let outcomes: OutcomeWeek[] = off.filter(o => o.medium === 'results').map(o => ({ week: o.week, region: o.region, leads: Number(o.leads), sales: Number(o.sales), value: Number(o.value) }));
  const resultsFrom: 'file' | 'platforms' | 'none' = outcomes.length ? 'file' : perfMedia.length ? 'platforms' : 'none';
  if (!outcomes.length && perfMedia.length) {
    const byWeek = new Map<string, number>();
    for (const p of perfMedia) byWeek.set(p.week, (byWeek.get(p.week) ?? 0) + p.conversions);
    outcomes = [...byWeek].map(([week, leads]) => ({ week, region: 'All India', leads, sales: 0, value: 0 }));
  }
  const fm = moneyFormat(currency);
  const lift = mediaLift(media, outcomes);
  const regions = regionFit(media, outcomes, lift.measure);
  // headline figures short (₹5.4L, ₹1.5Cr), sentences exact
  const fshort = (v: number) => (currency === 'INR' && v >= 1e5 ? `₹${v >= 1e7 ? `${(v / 1e7).toFixed(1)}Cr` : `${(v / 1e5).toFixed(1)}L`}` : fm(v));
  const findings = outcomes.length ? crossFindings(lift.lifts, regions, lift.measure, label, fm, fshort) : [];
  // every week in the range that has anything, for the two aligned charts
  const all = [...media, ...perfMedia];
  const weeks = [...new Set([...all.map(m => m.week), ...outcomes.map(o => o.week)])].sort();
  const mediums = [...new Set(all.map(m => m.medium))];
  const series = mediums.map(m => ({ medium: m, label: label(m), kind: all.find(x => x.medium === m)!.kind, values: weeks.map(w => all.filter(x => x.medium === m && x.week === w).reduce((a, x) => a + x.spend, 0)) }));
  const results = weeks.map(w => outcomes.filter(o => o.week === w).reduce((a, o) => a + o[lift.measure], 0));
  const totals = mediums.map(m => {
    const xs = all.filter(x => x.medium === m);
    return { medium: m, label: label(m), kind: xs[0]!.kind, spend: xs.reduce((a, x) => a + x.spend, 0), reach: xs.reduce((a, x) => a + x.reach, 0), units: xs.reduce((a, x) => a + x.units, 0), weeks: new Set(xs.filter(x => x.spend > 0).map(x => x.week)).size };
  }).sort((a, b) => b.spend - a.spend);
  const reports = await listOffline(ctx);

  // ---- the whole picture: every medium in one line, with what it did and what to do
  const p = perfMedia.length ? await perfOverview(ctx, range).catch(() => null) : null;
  const totalSpend = totals.reduce((a, t) => a + t.spend, 0);
  const totalResults = outcomes.reduce((a, o) => a + o[lift.measure], 0);
  const scored = lift.lifts.filter(l => l.verdict === 'lift' && l.costPerExtra).sort((a, b) => a.costPerExtra! - b.costPerExtra!);
  const perfCpa = p?.totals.cpa ?? null;
  const glance = totals.map(t => {
    const g = groupOf(t.medium);
    if (t.medium.startsWith('perf:') && jobOf(t.medium) === 'aware') {
      const ty = p?.types.find(x => x.type === t.medium.slice(5));
      return { ...t, ...g, did: `${compact(t.reach)} impressions`, verdict: 'keep', measure: ty?.conversions ? `also ${Math.round(ty.conversions).toLocaleString('en-IN')} conversions` : 'judged on reach, not conversions' };
    }
    if (t.medium.startsWith('perf:')) {
      const ty = p?.types.find(x => x.type === t.medium.slice(5));
      const cpa = ty?.cpa ?? null;
      const verdict = !cpa ? 'cut' : perfCpa && cpa <= 0.8 * perfCpa ? 'add' : perfCpa && cpa >= 1.5 * perfCpa ? 'cut' : 'keep';
      return { ...t, ...g, did: cpa ? `${fm(cpa)} per conversion` : 'No conversions', verdict, measure: cpa ? `${Math.round(ty!.conversions).toLocaleString('en-IN')} conversions` : '' };
    }
    const l = lift.lifts.find(x => x.medium === t.medium);
    if (!l || !outcomes.length) return { ...t, ...g, did: 'Add results to judge', verdict: 'unknown', measure: '' };
    if (l.verdict === 'lift') return { ...t, ...g, did: `+${Math.round(l.lift! * 100)}% ${lift.measure} in its weeks`, verdict: scored[0]?.medium === l.medium ? 'add' : 'keep', measure: l.costPerExtra ? `${fm(l.costPerExtra)} per extra ${lift.measure.slice(0, -1)}` : '' };
    if (l.verdict === 'none') return { ...t, ...g, did: `No clear rise in ${lift.measure}`, verdict: 'cut', measure: '' };
    return { ...t, ...g, did: l.weeksOff < 3 ? 'Ran every week: test a pause in one region' : 'Too few weeks to judge', verdict: 'test', measure: '' };
  });
  // the few things to do next, across everything, biggest money first
  const next: { tone: 'good' | 'bad' | 'neutral'; text: string; tab: string }[] = [];
  if (scored[0]) next.push({ tone: 'good', text: `Put more into ${label(scored[0].medium)}: the cheapest extra ${lift.measure.slice(0, -1)} of all media (${fm(scored[0].costPerExtra!)} each).`, tab: 'summary' });
  for (const l of lift.lifts.filter(x => x.verdict === 'none').slice(0, 2)) next.push({ tone: 'bad', text: `Cut or move ${label(l.medium)}: ${fshort(l.spend)} with no clear rise in ${lift.measure}.`, tab: groupOf(l.medium).tab });
  if (p) {
    const pauses = p.plan.plan.filter(x => x.change === 'pause');
    if (pauses.length) next.push({ tone: 'bad', text: `Pause ${pauses.length} ad ${pauses.length === 1 ? 'campaign' : 'campaigns'} with no conversions (${fshort(pauses.reduce((a, x) => a + x.now, 0))} a month).`, tab: 'search' });
    if (p.plan.convNext > p.plan.convNow) next.push({ tone: 'good', text: `Rebalance search and social ads at the same budget: about +${Math.round(p.plan.convNext - p.plan.convNow).toLocaleString('en-IN')} conversions a month.`, tab: 'search' });
    const halo = p.findings.find(f => /in .+ weeks$/.test(f.title) && f.tone === 'good');
    if (halo) next.push({ tone: 'good', text: `${halo.title} (${halo.figure}): raise search budgets during ${p.mainline} bursts.`, tab: 'search' });
  }
  const dark = regions.filter(r => r.resultShare >= 0.05 && r.spend === 0);
  if (dark.length) next.push({ tone: 'neutral', text: `${dark.slice(0, 3).map(r => r.region).join(', ')} ${dark.length === 1 ? 'brings' : 'bring'} ${Math.round(dark.reduce((a, r) => a + r.resultShare, 0) * 100)}% of ${lift.measure} with no local media: test a small local burst.`, tab: 'summary' });

  // ---- the chain: aware → look for you (brand searches) → lead or sale
  const aware = totals.filter(t => jobOf(t.medium) === 'aware'), convert = totals.filter(t => jobOf(t.medium) === 'convert');
  const grps = off.filter(o => o.medium === 'tv' && o.currency === currency).reduce((a, o) => a + Number(o.reach), 0);
  const readers = off.filter(o => ['print', 'radio', 'ooh'].includes(o.medium) && o.currency === currency).reduce((a, o) => a + Number(o.reach), 0);
  const impressions = dig.filter(d => d.currency === currency).reduce((a, d) => a + Number(d.reach), 0) + perfMedia.filter(x => jobOf(x.medium) === 'aware').reduce((a, x) => a + x.reach, 0);
  const completes = dig.filter(d => d.currency === currency).reduce((a, d) => a + Number(d.completes), 0);
  // the awareness medium that switched on and off most clearly: its weeks against the rest, for brand searches and lead cost
  const pw = p?.weeks ?? [];
  const pwSet = new Set(pw.map(w => w.week));
  const burst = [...new Set(media.map(m => m.medium))].map(m => {
    const on = new Set(media.filter(x => x.medium === m && x.spend > 0 && pwSet.has(x.week)).map(x => x.week));
    return { m, on, spend: media.filter(x => x.medium === m).reduce((a, x) => a + x.spend, 0), ok: on.size >= 3 && pwSet.size - on.size >= 3 };
  }).filter(b => b.ok).sort((a, b) => b.spend - a.spend)[0];
  let look: { burst: string; brandOn: number; brandOff: number; cpaOn: number | null; cpaOff: number | null } | null = null;
  if (burst) {
    const on = pw.filter(w => burst.on.has(w.week)), offw = pw.filter(w => !burst.on.has(w.week));
    const avg = (xs: typeof pw, k: 'brandClicks') => xs.reduce((a, w) => a + w[k], 0) / Math.max(1, xs.length);
    const cpa = (xs: typeof pw) => { const c = xs.reduce((a, w) => a + w.conversions, 0); return c ? xs.reduce((a, w) => a + w.cost, 0) / c : null; };
    look = { burst: label(burst.m), brandOn: avg(on, 'brandClicks'), brandOff: avg(offw, 'brandClicks'), cpaOn: cpa(on), cpaOff: cpa(offw) };
  }
  const lead = scored[0] ? { medium: label(scored[0].medium), lift: scored[0].lift } : null;
  const chain = {
    aware: { spend: aware.reduce((a, t) => a + t.spend, 0), media: aware.map(t => ({ medium: t.medium, label: t.label, spend: t.spend })), grps, readers, impressions, completes },
    look, lead,
    convert: { spend: convert.reduce((a, t) => a + t.spend, 0), media: convert.map(t => ({ medium: t.medium, label: t.label, spend: t.spend })), results: totalResults, perResult: totalResults ? totalSpend / totalResults : null, platformConversions: p?.totals.conversions ?? null, platformCpa: p?.totals.cpa ?? null },
  };
  // what the brand has shared, for the "what you get" view
  const shared = { mainline: off.some(o => o.medium !== 'results'), results: resultsFrom === 'file', programmatic: dig.length > 0, search: perfMedia.some(x => jobOf(x.medium) === 'convert' && x.medium !== 'perf:Meta'), meta: perfMedia.some(x => x.medium === 'perf:Meta'), terms: !!p?.hasTerms };

  return {
    picture: { spend: totalSpend, results: totalResults, perResult: totalResults ? totalSpend / totalResults : null, resultsFrom, glance, next: next.slice(0, 6), chain, shared },
    currency, leftOut, measure: lift.measure, hasResults: outcomes.length > 0, hasDigital: dig.length > 0 || perfMedia.length > 0,
    weeks, series, results, totals, lifts: lift.lifts.map(l => ({ ...l, label: label(l.medium) })), regions: regions.slice(0, 15),
    findings, reports, canEdit: EDITORS.includes(ctx.role), workspace: ctx.tenantName, isDemo: ctx.isDemo, weekStart: mondayOf(range.from), from: range.from, to: range.to,
  };
}
