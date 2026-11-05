/**
 * Brand health: one line per area of Vtology, for the Overview. Cheap queries only; each area says
 * whether things are good, worth watching or need fixing, with its key number and where to look.
 */
import type { Ctx } from './context';

type Status = 'good' | 'watch' | 'fix' | 'none';
interface Tile { area: string; tab: string; status: Status; figure: string; label: string; detail: string }
const pct = (x: number) => `${Math.round(x * 100)}%`;
const chg = (now: number, before: number) => (before > 0 ? (now - before) / before : now > 0 ? 1 : 0);
const signed = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))}%`;

export async function healthSummary(ctx: Ctx) {
  const q = <T,>(sql: string, p: unknown[] = [ctx.tenantId]) => ctx.db.admin.query<T & Record<string, unknown>>(sql, p);
  const tiles: Tile[] = [];

  // pipeline
  const [j] = await q<{ n: number; idle: number; conv: number }>(`select count(*)::int as n,
      count(*) filter (where j.last_activity_at < now() - make_interval(days => coalesce(s.sla_days, 7)) and not j.crm_converted)::int as idle,
      count(*) filter (where j.crm_converted)::int as conv
    from vt.journeys j left join vt.stage_defs s on s.industry = (select industry from vt.tenants where id = $1) and s.idx = j.stage_index where j.tenant_id = $1`);
  tiles.push(j!.n ? { area: 'Pipeline', tab: 'overview', status: j!.idle / j!.n > 0.3 ? 'fix' : j!.idle / j!.n > 0.15 ? 'watch' : 'good', figure: pct(j!.idle / j!.n), label: 'of journeys idle past their time limit', detail: `${j!.n.toLocaleString('en-IN')} customer journeys, ${j!.conv.toLocaleString('en-IN')} converted.` }
    : { area: 'Pipeline', tab: 'data', status: 'none', figure: '–', label: 'no journeys yet', detail: 'Connect a lead source or import leads on the Data tab.' });

  // social: own posts, last 30 days against the 30 before
  const [s] = await q<{ now_posts: number; before_posts: number; now_int: number; before_int: number }>(`select
      count(*) filter (where p.posted_at >= now() - interval '30 days')::int as now_posts, count(*) filter (where p.posted_at < now() - interval '30 days')::int as before_posts,
      coalesce(sum(coalesce(p.likes,0)+coalesce(p.comments,0)+coalesce(p.shares,0)+coalesce(p.saves,0)) filter (where p.posted_at >= now() - interval '30 days'),0)::float as now_int,
      coalesce(sum(coalesce(p.likes,0)+coalesce(p.comments,0)+coalesce(p.shares,0)+coalesce(p.saves,0)) filter (where p.posted_at < now() - interval '30 days'),0)::float as before_int
    from vt.social_posts p join vt.social_accounts a on a.id = p.account_id where p.tenant_id = $1 and not a.is_competitor and p.posted_at >= now() - interval '60 days'`);
  if (s!.now_posts + s!.before_posts) { const c = chg(s!.now_int, s!.before_int); tiles.push({ area: 'Social', tab: 'social', status: c < -0.2 ? 'fix' : c < 0 ? 'watch' : 'good', figure: signed(c), label: 'interactions, last 30 days vs the 30 before', detail: `${s!.now_posts} posts in the last 30 days (${s!.before_posts} before).` }); }
  else tiles.push({ area: 'Social', tab: 'social', status: 'none', figure: '–', label: 'no accounts connected', detail: 'Connect Instagram, Facebook or YouTube on the Social tab.' });

  // growth: followers now vs 30 days ago, own accounts
  const [g] = await q<{ now: number; before: number }>(`select coalesce(sum(case when d.day = x.last then d.followers end),0)::float as now, coalesce(sum(case when d.day = x.first then d.followers end),0)::float as before
    from vt.social_account_daily d join vt.social_accounts a on a.id = d.account_id
    join (select account_id, max(day) as last, min(day) filter (where day >= current_date - 30) as first from vt.social_account_daily where tenant_id = $1 and followers is not null group by account_id) x on x.account_id = d.account_id
    where d.tenant_id = $1 and not a.is_competitor and d.followers is not null and x.first <= x.last - 20`);
  if (g!.now) { const c = chg(g!.now, g!.before); tiles.push({ area: 'Growth', tab: 'growth', status: c < 0 ? 'fix' : c < 0.005 ? 'watch' : 'good', figure: signed(c), label: 'followers in 30 days', detail: `${Math.round(g!.now).toLocaleString('en-IN')} followers across your accounts.` }); }

  // content: tracked searches and whether the brand ranks
  const topics = await q<{ phrase: string; result: { ownRank: number | null; opportunity: number } | null }>(`select phrase, result from vt.content_topics where tenant_id = $1`);
  const scanned = topics.map(t => ({ ...t, result: typeof t.result === 'string' ? JSON.parse(t.result as unknown as string) : t.result })).filter(t => t.result);
  if (scanned.length) {
    const ranked = scanned.filter(t => t.result!.ownRank).length;
    const best = [...scanned].sort((a, b) => b.result!.opportunity - a.result!.opportunity)[0]!;
    tiles.push({ area: 'Content', tab: 'content', status: ranked === 0 ? 'fix' : ranked < scanned.length / 2 ? 'watch' : 'good', figure: `${ranked}/${scanned.length}`, label: 'tracked YouTube searches where you rank in the top 20', detail: `Best chance next: “${best.phrase}” (${best.result!.opportunity}/100).` });
  } else tiles.push({ area: 'Content', tab: 'content', status: 'none', figure: '–', label: 'no searches tracked', detail: 'Track what people search on the Content tab.' });

  // media: last 30 days of the latest report, and the worst frequency
  const [m] = await q<{ cost: number; completes: number; starts: number; imps: number; last: string | null; currency: string | null }>(`select coalesce(sum(r.cost),0)::float as cost, coalesce(sum(r.completes),0)::float as completes, coalesce(sum(r.starts),0)::float as starts, coalesce(sum(r.impressions),0)::float as imps,
      max(r.day)::text as last, max(m.currency) as currency
    from vt.media_daily r join vt.media_reports m on m.id = r.report_id where r.tenant_id = $1 and r.day > (select max(day) - 30 from vt.media_daily where tenant_id = $1)`);
  const freq = await q<{ campaign: string; f: number }>(`select campaign, avg(impressions / nullif(reach, 0))::float as f from vt.media_reach where tenant_id = $1 and reach > 0 and day > (select max(day) - 30 from vt.media_reach where tenant_id = $1) group by campaign order by f desc limit 1`);
  if (m!.imps) {
    const comp = m!.completes / Math.max(1, m!.starts || m!.imps);
    const heavy = freq[0] && freq[0].f >= 4;
    tiles.push({ area: 'Media', tab: 'media', status: heavy || comp < 0.5 ? 'fix' : comp < 0.7 ? 'watch' : 'good', figure: pct(comp), label: 'of video and audio ads played to the end', detail: `${m!.currency ?? ''} ${Math.round(m!.cost).toLocaleString('en-IN')} spent in the 30 days to ${m!.last}.${heavy ? ` ${freq[0]!.campaign} shows the ad ${freq[0]!.f.toFixed(1)} times a day per person: cap it.` : ''}` });
  } else if (freq.length) tiles.push({ area: 'Media', tab: 'media', status: freq[0]!.f >= 4 ? 'fix' : freq[0]!.f >= 3 ? 'watch' : 'good', figure: `${freq[0]!.f.toFixed(1)}×`, label: 'highest ads per person a day', detail: `${freq[0]!.campaign}. Import a delivery report for completion and cost.` });
  else tiles.push({ area: 'Media', tab: 'media', status: 'none', figure: '–', label: 'no media reports', detail: 'Import a DV360 report on the Media tab.' });

  // audiences: buckets and measured lift
  const buckets = await q<{ stats: { targeted?: number; measured?: { lift: number | null } } }>(`select stats from vt.audience_buckets where tenant_id = $1`);
  if (buckets.length) {
    const st = buckets.map(b => (typeof b.stats === 'string' ? JSON.parse(b.stats as unknown as string) : b.stats));
    const lifts = st.map(x => x?.measured?.lift).filter((x): x is number => typeof x === 'number');
    const reach = st.reduce((a, x) => a + (x?.targeted ?? 0), 0);
    tiles.push({ area: 'Audiences', tab: 'audiences', status: lifts.length ? (Math.max(...lifts) >= 1.2 ? 'good' : 'watch') : 'watch', figure: lifts.length ? `${Math.max(...lifts).toFixed(1)}×` : reach.toLocaleString('en-IN'), label: lifts.length ? 'best lift against the held-back group' : 'people ready to reach', detail: `${buckets.length} bucket${buckets.length === 1 ? '' : 's'}${lifts.length ? '' : '; upload a buyers list to measure lift'}.` });
  }

  // connections: sources and social, any errors
  const conns = await q<{ kind: string; name: string; status: string; last: string | null }>(`select 'source' as kind, name, status, last_sync_at::text as last from vt.data_sources where tenant_id = $1
     union all select 'social', label, status, last_sync_at::text from vt.social_connections where tenant_id = $1`);
  const broken = conns.filter(c => c.status === 'error' || c.status === 'expired');
  tiles.push(conns.length ? { area: 'Connections', tab: 'data', status: broken.length ? 'fix' : 'good', figure: `${conns.length - broken.length}/${conns.length}`, label: 'connections working', detail: broken.length ? `Needs attention: ${broken.map(b => b.name).join(', ')}.` : 'Everything synced on schedule.' }
    : { area: 'Connections', tab: 'data', status: 'none', figure: '0', label: 'nothing connected', detail: 'Connect social accounts and data sources to fill this report.' });

  const rated = tiles.filter(t => t.status !== 'none');
  const score = rated.length ? Math.round((rated.reduce((a, t) => a + (t.status === 'good' ? 1 : t.status === 'watch' ? 0.5 : 0), 0) / rated.length) * 100) : null;
  return { score, tiles };
}
