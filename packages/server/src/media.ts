/**
 * Media reports (DV360 and other DSPs): stored as clean rows, analysed for awareness campaigns.
 * The browser reads the CSV, works out the columns and sends rows in chunks; the server checks every
 * value, stores it, and answers with metrics, comparisons and findings for any date range.
 */
import { CHANNEL_LABEL, addSums, frequencyFindings, frequencyLines, mediaFindings, metrics, quartiles, ZERO, type Channel, type Group, type ReachRow, type Sums } from '@vtology/core';
import { HttpError, requireRole, type Ctx } from './context';

const EDITORS: Ctx['role'][] = ['marketing_head', 'data_steward'];
const VIEWERS: Ctx['role'][] = [...EDITORS, 'finance'];
const CHANNELS = ['ctv', 'audio', 'video', 'display'] as const;
const UUID = /^[0-9a-f-]{36}$/i;
export const MEDIA_CHUNK = 5000;
const NUMS = ['impressions', 'clicks', 'cost', 'viewable', 'measurable', 'starts', 'q1', 'q2', 'q3', 'completes', 'audible', 'conversions'] as const;
const TEXTS = ['campaign', 'lineItem', 'lineItemType', 'creative', 'exchange', 'supply', 'site', 'device', 'region'] as const;

export async function listReports(ctx: Ctx) {
  requireRole(ctx, VIEWERS, 'Media reports');
  return ctx.db.admin.query(`select id, name, kind, source, currency, status, rows, date_from, date_to, created_at from vt.media_reports where tenant_id = $1 order by created_at desc`, [ctx.tenantId]);
}

export async function createReport(ctx: Ctx, body: { name?: unknown; currency?: unknown; source?: unknown; columns?: unknown; kind?: unknown }) {
  requireRole(ctx, EDITORS, 'Uploading media reports');
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
  if (!name) throw new HttpError(400, 'Give the report a name, for example "Lincoln CTV, Oct".');
  const currency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) : '';
  const [row] = await ctx.db.admin.query<{ id: string }>(
    `insert into vt.media_reports (tenant_id, name, source, currency, columns, created_by, kind) values ($1,$2,$3,$4,$5,$6,$7) on conflict (tenant_id, name) do nothing returning id`,
    [ctx.tenantId, name, typeof body.source === 'string' ? body.source.slice(0, 40) : 'dv360', currency, JSON.stringify(body.columns ?? {}), ctx.userId, body.kind === 'reach' ? 'reach' : 'delivery']);
  if (!row) throw new HttpError(409, `A report called "${name}" already exists. Delete it first, or choose another name.`);
  return { id: row.id, chunkMax: MEDIA_CHUNK };
}

export async function appendMediaRows(ctx: Ctx, id: string, body: { rows?: unknown }) {
  requireRole(ctx, EDITORS, 'Uploading media reports');
  if (!UUID.test(id)) throw new HttpError(404, 'Report not found.');
  const [rep] = await ctx.db.admin.query<{ status: string; currency: string; kind: string }>(`select status, currency, kind from vt.media_reports where id = $1 and tenant_id = $2`, [id, ctx.tenantId]);
  if (!rep) throw new HttpError(404, 'Report not found.');
  if (rep.status !== 'uploading') throw new HttpError(409, 'This report is complete. Upload a new one to add rows.');
  if (!Array.isArray(body.rows) || body.rows.length > MEDIA_CHUNK) throw new HttpError(400, `Send up to ${MEDIA_CHUNK} rows at a time.`);
  if (rep.kind === 'reach') {
    const ok = (body.rows as Record<string, unknown>[]).filter(r => typeof r?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.day as string) && typeof r.campaign === 'string' && [r.impressions, r.reach, r.cost].every(n => Number.isFinite(Number(n ?? 0)) && Number(n ?? 0) >= 0));
    if (ok.length) await ctx.db.admin.query(`insert into vt.media_reach (tenant_id, report_id, day, campaign, impressions, reach, cost) select $1, $2, d::date, c, i, r, k from unnest($3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[]) as t(d, c, i, r, k)`,
      [ctx.tenantId, id, ok.map(r => r.day), ok.map(r => String(r.campaign).slice(0, 200)), ok.map(r => Number(r.impressions ?? 0)), ok.map(r => Number(r.reach ?? 0)), ok.map(r => Number(r.cost ?? 0))]);
    return { accepted: ok.length, refused: body.rows.length - ok.length };
  }
  const cols: Record<string, unknown[]> = { day: [], channel: [], deal: [], currency: [] };
  for (const k of [...TEXTS, ...NUMS]) cols[k] = [];
  let bad = 0;
  for (const raw of body.rows) {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (typeof r.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || Number.isNaN(Date.parse(r.day)) || !CHANNELS.includes(r.channel as Channel)) { bad++; continue; }
    const nums = NUMS.map(k => Number(r[k] ?? 0));
    if (nums.some(n => !Number.isFinite(n) || n < 0 || n > 1e12)) { bad++; continue; }
    cols.day!.push(r.day); cols.channel!.push(r.channel); cols.deal!.push(r.deal === true ? 'true' : 'false'); cols.currency!.push(String(r.currency ?? '').toUpperCase().slice(0, 3));
    for (const k of TEXTS) cols[k]!.push(String(r[k] ?? '').trim().slice(0, 200) || (k === 'supply' ? 'Open auction' : ''));
    NUMS.forEach((k, j) => cols[k]!.push(nums[j]));
  }
  if (cols.day!.length) await ctx.db.admin.query(
    `insert into vt.media_rows (tenant_id, report_id, day, channel, deal, campaign, line_item, line_item_type, creative, exchange, supply, site, device, region, ${NUMS.join(', ')})
     select $1, $2, d::date, ch, dl::boolean, c1, c2, c3, c4, c5, c6, c7, c8, c9, n1, n2, n3, n4, n5, n6, n7, n8, n9, n10, n11, n12
       from unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[], $14::text[],
                   $15::numeric[], $16::numeric[], $17::numeric[], $18::numeric[], $19::numeric[], $20::numeric[], $21::numeric[], $22::numeric[], $23::numeric[], $24::numeric[], $25::numeric[], $26::numeric[])
         as t(d, ch, dl, c1, c2, c3, c4, c5, c6, c7, c8, c9, n1, n2, n3, n4, n5, n6, n7, n8, n9, n10, n11, n12)`,
    [ctx.tenantId, id, cols.day, cols.channel, cols.deal, ...TEXTS.map(k => cols[k]), ...NUMS.map(k => cols[k])]);
  // the report's currency: as chosen, else the one its rows carry
  if (!rep.currency) { const c = (cols.currency as string[]).find(Boolean); if (c) await ctx.db.admin.query(`update vt.media_reports set currency = $3 where id = $1 and tenant_id = $2`, [id, ctx.tenantId, c]); }
  return { accepted: cols.day!.length, refused: bad };
}

export async function finishReport(ctx: Ctx, id: string) {
  requireRole(ctx, EDITORS, 'Uploading media reports');
  if (!UUID.test(id)) throw new HttpError(404, 'Report not found.');
  const [k] = await ctx.db.admin.query<{ kind: string }>(`select kind from vt.media_reports where id = $1 and tenant_id = $2`, [id, ctx.tenantId]);
  if (!k) throw new HttpError(404, 'Report not found.');
  const table = k.kind === 'reach' ? 'vt.media_reach' : 'vt.media_rows';
  const [s] = await ctx.db.admin.query<{ n: number; f: string | null; t: string | null }>(`select count(*)::int as n, min(day)::text as f, max(day)::text as t from ${table} where report_id = $1 and tenant_id = $2`, [id, ctx.tenantId]);
  if (!s!.n) throw new HttpError(400, 'No rows arrived, so the report was not saved.');
  await ctx.db.admin.query(`update vt.media_reports set status = 'ready', rows = $3, date_from = $4, date_to = $5 where id = $1 and tenant_id = $2`, [id, ctx.tenantId, s!.n, s!.f, s!.t]);
  if (k.kind !== 'reach') await ctx.db.admin.query(`insert into vt.media_daily (tenant_id, report_id, day, channel, impressions, cost, starts, completes)
    select tenant_id, report_id, day, channel, sum(impressions), sum(cost), sum(starts), sum(completes) from vt.media_rows where report_id = $1 and tenant_id = $2 group by tenant_id, report_id, day, channel
    on conflict (report_id, day, channel) do update set impressions = excluded.impressions, cost = excluded.cost, starts = excluded.starts, completes = excluded.completes`, [id, ctx.tenantId]);
  // another ready report covering the same days would count the same delivery twice
  const overlap = await ctx.db.admin.query<{ name: string }>(`select name from vt.media_reports where tenant_id = $1 and id <> $2 and status = 'ready' and kind = $5 and date_from <= $4 and date_to >= $3`, [ctx.tenantId, id, s!.f, s!.t, k.kind]);
  return { rows: s!.n, from: s!.f, to: s!.t, overlaps: overlap.map(o => o.name) };
}

export async function deleteReport(ctx: Ctx, id: string) {
  requireRole(ctx, EDITORS, 'Deleting media reports');
  if (!UUID.test(id)) throw new HttpError(404, 'Report not found.');
  const r = await ctx.db.admin.query(`delete from vt.media_reports where id = $1 and tenant_id = $2 returning id`, [id, ctx.tenantId]);
  if (!r.length) throw new HttpError(404, 'Report not found.');
  return { removed: true };
}

const SUMS = NUMS.map(k => `coalesce(sum(r.${k}::float8), 0) as ${k}`).join(', ');
const pickSums = (r: Record<string, unknown>): Sums => Object.fromEntries(NUMS.map(k => [k, Number(r[k] ?? 0)])) as unknown as Sums;
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

export function moneyFormat(currency: string) {
  return (v: number) => {
    const digits = Math.abs(v) < 1 ? 3 : Math.abs(v) < 10 ? 2 : 0;
    if (!/^[A-Z]{3}$/.test(currency)) return v.toLocaleString('en', { maximumFractionDigits: digits });
    try { return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v); }
    catch { return `${currency} ${v.toFixed(digits)}`; }
  };
}

/** Everything the Media tab shows, for one date range, optionally one channel and one report. */
export async function mediaOverview(ctx: Ctx, range: { from: string; to: string }, opts: { channel?: string | null; report?: string | null }) {
  requireRole(ctx, VIEWERS, 'Media reports');
  // the answer only changes when reports change: keep it, keyed by the question and the reports' state
  const [v] = await ctx.db.admin.query<{ version: string }>(`select coalesce(count(*)::text || ':' || max(created_at)::text || ':' || sum(rows)::text || ':' || string_agg(status, ''), 'none') as version from vt.media_reports where tenant_id = $1`, [ctx.tenantId]);
  const key = JSON.stringify(['v3', range.from, range.to, opts.channel ?? null, opts.report ?? null]); // bump when the result's shape changes
  const [hit] = await ctx.db.admin.query<{ result: unknown }>(`select result from vt.media_cache where tenant_id = $1 and key = $2 and version = $3`, [ctx.tenantId, key, v!.version]);
  if (hit) return typeof hit.result === 'string' ? JSON.parse(hit.result) : hit.result;
  const result = await computeMediaOverview(ctx, range, opts);
  await ctx.db.admin.query(`delete from vt.media_cache where tenant_id = $1 and (version <> $2 or created_at < now() - interval '7 days')`, [ctx.tenantId, v!.version]);
  await ctx.db.admin.query(`insert into vt.media_cache (tenant_id, key, version, result) values ($1,$2,$3,$4) on conflict (tenant_id, key) do update set version = excluded.version, result = excluded.result, created_at = now()`, [ctx.tenantId, key, v!.version, JSON.stringify(result)]);
  return result;
}

async function computeMediaOverview(ctx: Ctx, range: { from: string; to: string }, opts: { channel?: string | null; report?: string | null }) {
  const sql = ctx.db.admin;
  const reports = await sql.query<{ id: string; name: string; kind: string; currency: string; date_from: string; date_to: string; rows: number; created_at: string; status: string }>(
    `select id, name, kind, currency, date_from::text, date_to::text, rows, created_at, status from vt.media_reports where tenant_id = $1 order by created_at desc`, [ctx.tenantId]);
  // frequency, from reach reports in the same dates
  const reachIds = reports.filter(r => r.status === 'ready' && r.kind === 'reach').map(r => r.id);
  const reachRows = reachIds.length ? (await sql.query<ReachRow & { impressions: string; reach: string; cost: string }>(
    `select day::text as day, campaign, impressions, reach, cost from vt.media_reach where tenant_id = $1 and report_id = any($2::uuid[]) and day between $3::date and $4::date`, [ctx.tenantId, reachIds, range.from, range.to]))
    .map(r => ({ day: r.day, campaign: r.campaign, impressions: Number(r.impressions), reach: Number(r.reach), cost: Number(r.cost) })) : [];
  const frequency = frequencyLines(reachRows);
  const reachCurrency = reports.find(r => r.kind === 'reach' && r.currency)?.currency ?? '';
  const ready = reports.filter(r => r.status === 'ready' && r.kind !== 'reach' && (!opts.report || r.id === opts.report));
  const coverage = ready.length ? { from: ready.map(r => r.date_from).sort()[0]!, to: ready.map(r => r.date_to).sort().at(-1)! } : null;
  const currencies = [...new Set(ready.map(r => r.currency || ''))];
  const reachCoverage = reachIds.length ? { from: reports.filter(r => reachIds.includes(r.id)).map(r => r.date_from).sort()[0]!, to: reports.filter(r => reachIds.includes(r.id)).map(r => r.date_to).sort().at(-1)! } : null;
  const base = { reports, coverage: coverage ?? reachCoverage, currencies, frequency, frequencyFindings: frequencyFindings(frequency, moneyFormat(currencies[0] || reachCurrency)), reachCurrency };
  if (!ready.length) return { ...base, empty: true as const };
  if (currencies.length > 1) return { ...base, empty: true as const, mixed: true };
  const currency = currencies[0]!;
  const channel = CHANNELS.includes(opts.channel as Channel) ? opts.channel as Channel : null;
  const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1;
  const prev = { from: addDays(range.from, -days), to: addDays(range.from, -1) };

  const params = [ctx.tenantId, ready.map(r => r.id), range.from, range.to, channel];
  const where = `r.tenant_id = $1 and r.report_id = any($2::uuid[]) and r.day between $3::date and $4::date and ($5::text is null or r.channel = $5)`;
  // one pass over the rows for every breakdown (grouping sets), instead of one scan per breakdown
  const DIMS = ['r.channel', 'r.supply', 'r.site', 'r.creative', "date_trunc('week', r.day)", 'r.device', 'r.region', 'r.day', 'r.campaign', 'r.line_item'];
  const SETS: Record<string, number[]> = { total: [], channel: [0], supply: [0, 1], site: [0, 2], creativeWeek: [0, 3, 4], device: [0, 5], region: [6], day: [7], line: [0, 8, 9], creative: [0, 3] };
  const maskOf = (idx: number[]) => DIMS.reduce((m, _, i) => m | (idx.includes(i) ? 0 : 1 << (DIMS.length - 1 - i)), 0);
  const rowsAll = await sql.query<Record<string, unknown> & { g: number }>(
    `select grouping(${DIMS.join(', ')}) as g, r.channel, r.supply, bool_or(r.deal) as deal, r.site, r.creative, date_trunc('week', r.day)::date::text as week, r.device, r.region, r.day::text as day, r.campaign, r.line_item, ${SUMS}
       from vt.media_rows r where ${where}
      group by grouping sets (${Object.values(SETS).map(ix => `(${ix.map(i => DIMS[i]).join(', ')})`).join(', ')})`, params);
  const part = <T,>(name: string) => rowsAll.filter(r => Number(r.g) === maskOf(SETS[name]!)) as unknown as (T & Record<string, unknown>)[];
  const [total] = part<object>('total');
  const [previous] = await sql.query<Record<string, unknown>>(`select ${SUMS} from vt.media_rows r where r.tenant_id = $1 and r.report_id = any($2::uuid[]) and r.day between $3::date and $4::date and ($5::text is null or r.channel = $5)`, [ctx.tenantId, ready.map(r => r.id), prev.from, prev.to, channel]);
  const byChannel = part<{ channel: Channel }>('channel'), bySupply = part<{ channel: Channel; supply: string; deal: boolean }>('supply'), bySite = part<{ channel: Channel; site: string }>('site');
  const byCreativeWeek = part<{ channel: Channel; creative: string; week: string }>('creativeWeek'), byDevice = part<{ channel: Channel; device: string }>('device'), byRegion = part<{ region: string }>('region');
  const daily = part<{ day: string }>('day'), byLine = part<{ channel: Channel; campaign: string; line_item: string }>('line'), byCreative = part<{ channel: Channel; creative: string }>('creative');
  const money = moneyFormat(currency);
  const g = (key: string, row: Record<string, unknown>, extra: Partial<Group> = {}): Group => ({ key, sums: pickSums(row), ...extra });
  const findings = mediaFindings({
    total: pickSums(total!), previous: pickSums(previous!), money,
    byChannel: byChannel.map(r => g(CHANNEL_LABEL[r.channel], r, { channel: r.channel })),
    bySupply: bySupply.map(r => g(r.supply, r, { channel: r.channel, deal: r.deal })),
    bySite: bySite.map(r => g(r.site, r, { channel: r.channel })),
    byCreativeWeek: byCreativeWeek.map(r => ({ key: r.creative, channel: r.channel, week: r.week, sums: pickSums(r) })),
    byDevice: byDevice.map(r => g(r.device, r, { channel: r.channel })),
    byRegion: byRegion.map(r => g(r.region, r)),
    daily: daily.map(r => ({ day: r.day, sums: pickSums(r) })),
  });
  const withM = <T extends Record<string, unknown>>(rows: T[], top = 200) => rows.map(r => ({ ...Object.fromEntries(Object.entries(r).filter(([k]) => !(NUMS as readonly string[]).includes(k))), ...metrics(pickSums(r)) }))
    .sort((a, b) => b.cost - a.cost).slice(0, top);
  // a day-by-day (or week-by-week past 60 days) trend of spend and completed views
  const byDay = new Map(daily.map(r => [r.day, pickSums(r)]));
  const points: { x: string; sums: Sums }[] = [];
  const weekly = days > 60;
  for (let d = range.from; d <= range.to; d = addDays(d, weekly ? 7 : 1)) {
    let s = ZERO;
    for (let k = 0; k < (weekly ? 7 : 1); k++) { const v = byDay.get(addDays(d, k)); if (v && addDays(d, k) <= range.to) s = addSums(s, v); }
    points.push({ x: d, sums: s });
  }
  const channelTotals = byChannel.map(r => ({ channel: r.channel, label: CHANNEL_LABEL[r.channel], ...metrics(pickSums(r)), quartiles: quartiles(pickSums(r)) }));
  return {
    ...base, empty: false as const, currency, range, previousRange: prev, channel, weekly,
    total: metrics(pickSums(total!)), previous: metrics(pickSums(previous!)),
    channels: channelTotals.sort((a, b) => b.cost - a.cost),
    trend: points.map(p => ({ x: p.x, cost: p.sums.cost, completes: p.sums.completes, impressions: p.sums.impressions })),
    supply: withM(bySupply), sites: withM(bySite, 100), lineItems: withM(byLine), creatives: withM(byCreative, 60), devices: withM(byDevice), regions: withM(byRegion, 40),
    findings,
    creativeTrend: creativeTrend(byCreativeWeek, byCreative),
  };
}

/** Week by week, per creative (the 15 with most spend): completion, or click rate where nothing plays. */
function creativeTrend(weeks: ({ channel: Channel; creative: string; week: string } & Record<string, unknown>)[], totals: ({ channel: Channel; creative: string } & Record<string, unknown>)[]) {
  const top = totals.map(t => ({ t, s: pickSums(t) })).sort((a, b) => b.s.cost - a.s.cost).slice(0, 15);
  return top.map(({ t, s }) => {
    const ws = weeks.filter(w => w.creative === t.creative && w.channel === t.channel).map(w => ({ week: w.week, m: metrics(pickSums(w)) })).filter(w => w.m.impressions >= 200).sort((a, b) => a.week.localeCompare(b.week));
    const plays = s.completes > 0;
    const series = ws.map(w => ({ week: w.week, value: plays ? w.m.completion ?? 0 : w.m.ctr ?? 0, impressions: w.m.impressions }));
    const early = series.slice(0, 2), late = series.slice(-2);
    const avg = (xs: typeof series) => (xs.length ? xs.reduce((a, x) => a + x.value, 0) / xs.length : 0);
    const change = series.length >= 4 && avg(early) > 0 ? avg(late) / avg(early) - 1 : null;
    return { creative: t.creative || '(none)', channel: t.channel, measure: plays ? 'completion' : 'click rate', weeks: series.length, cost: s.cost, series, early: avg(early), late: avg(late), change,
      status: change === null ? 'new' : change <= -0.12 ? 'wearing out' : change <= -0.05 ? 'slipping' : 'steady' };
  });
}
