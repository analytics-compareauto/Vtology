'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { liftPhrase, type Dimension, type Insight, type PlatformSummary, type ScoredPost, type Segment, type SocialView } from '@vtology/core';
import type { WorkspaceData } from '../Dashboard';
import { api, ApiError } from '../api';
import { ago, change, compact, inr, num, pct } from '../format';
import { EffortMap, LineChart, Sparkline } from '../charts';
import { IconDown, IconImage, IconPlay, IconRefresh, IconSpark, IconText, IconUp } from '../icons';

interface Connection { id: string; provider: string; label: string; status: string; scopes: string[]; connected_at: string; last_sync_at: string | null; last_error: string | null }
interface Account { id: string; platform: string; name: string; handle: string | null; followers: number | null; posts_count: number | null; profile_url: string | null }
interface Campaign { code: string; name: string; channel: string; spend: number | null; platform_conversions: number; journeys: number; progressed: number; converted: number }
type Post = ScoredPost & { postedAt: string; thumbnailUrl?: string | null };
interface Overview {
  canConnect: boolean;
  providers: { meta: boolean; youtube: boolean; linkedin: boolean; secret: boolean };
  connections: Connection[]; accounts: Account[]; campaigns: Campaign[];
  analysis: {
    windowDays: number; posts: number; lowAudience?: number;
    weekly?: { week: string; platform: string; posts: number; interactions: number; views: number; reach: number; watchHours?: number }[];
    byPlatform: PlatformSummary[];
    segments: Segment[]; insights: Insight[]; top: Post[]; bottom: Post[];
    perPlatform?: Record<string, SocialView>;
  };
}

const PLATFORM: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube', linkedin: 'LinkedIn' };
const SHORT: Record<string, string> = { instagram: 'IG', facebook: 'FB', youtube: 'YT', linkedin: 'IN' };
const COLOR: Record<string, string> = { instagram: 'var(--s-instagram)', facebook: 'var(--s-facebook)', youtube: 'var(--s-youtube)', linkedin: 'var(--s-linkedin)' };
const ORDER = ['instagram', 'facebook', 'youtube', 'linkedin'];
const PROVIDERS = [
  { id: 'meta', name: 'Instagram and Facebook', platforms: ['instagram', 'facebook'], covers: 'Posts, reach, saves, shares, ad campaigns and lead-form leads' },
  { id: 'youtube', name: 'YouTube', platforms: ['youtube'], covers: 'Videos and shorts, views, watch time, how much of each video people watch' },
  { id: 'linkedin', name: 'LinkedIn', platforms: ['linkedin'], covers: 'Company page posts and followers' },
];
const DIMS: { id: Dimension; label: string; noun: string }[] = [
  { id: 'theme', label: 'Theme', noun: 'themes' }, { id: 'format', label: 'Format', noun: 'formats' }, { id: 'time', label: 'Time of day', noun: 'times of day' },
  { id: 'day', label: 'Day', noun: 'days' }, { id: 'language', label: 'Language', noun: 'languages' }, { id: 'length', label: 'Caption length', noun: 'caption lengths' },
];
const METRICS = [
  { id: 'interactions', label: 'Interactions', noun: 'interactions' },
  { id: 'views', label: 'Views', noun: 'views' },
  { id: 'reach', label: 'Reach', noun: 'reach' },
  { id: 'watchHours', label: 'Hours watched', noun: 'hours watched' },
  { id: 'posts', label: 'Posts', noun: 'posts' },
] as const;
/** What each platform reports, so a missing number is explained rather than shown as zero. */
const NOT_REPORTED: Record<string, { views?: string; reach?: string; watchHours?: string }> = {
  facebook: { watchHours: 'Facebook reports watch time for native videos only' },
  youtube: { reach: 'YouTube reach needs the YouTube Analytics connection', watchHours: 'YouTube watch time needs the YouTube Analytics connection' },
  instagram: {},
};
type Metric = typeof METRICS[number]['id'];

function mondayOf(d: Date) {
  const ist = new Date(d.getTime() + 330 * 60_000);
  const dow = (ist.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - dow));
}
const weekLabel = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function Social({ data, workspaceId, notify }: { data: WorkspaceData; workspaceId: string; notify: (m: string) => void }) {
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dim, setDim] = useState<Dimension>('format');
  const [metric, setMetric] = useState<Metric>('interactions');
  const [manage, setManage] = useState(false);
  const [only, setOnly] = useState<string>('all');
  const T = `/tenants/${workspaceId}`;

  const load = useCallback(() => api<Overview>('GET', `${T}/social`).then(r => { setO(r); setError(null); return r; }).catch(e => { setError(e instanceof ApiError ? e.message : 'Could not load social data.'); return null; }), [T]);

  useEffect(() => {
    load().then(r => {
      // keep connected accounts fresh: sync in the background if the last sync is over 12 hours old
      const stale = r?.connections.some(c => c.provider !== 'sample' && c.status === 'active' && (!c.last_sync_at || Date.now() - new Date(c.last_sync_at).getTime() > 12 * 3600_000));
      if (stale && r?.canConnect) {
        setBusy('sync');
        api('POST', `${T}/social/sync`).then(() => load()).catch(() => undefined).finally(() => setBusy(null));
      }
    });
  }, [load, T]);

  async function connect(provider: string) {
    setBusy(provider);
    try { const r = await api<{ url: string }>('POST', `${T}/social/connect/${provider}`); window.location.href = r.url; }
    catch (e) { notify(e instanceof ApiError ? e.message : 'Could not start the connection.'); setBusy(null); }
  }
  async function sync() {
    setBusy('sync');
    try {
      const r = await api<Record<string, { posts?: number; newLeads?: number; error?: string }>>('POST', `${T}/social/sync`);
      const parts = Object.entries(r).map(([p, x]) => x.error ? `${p}: ${x.error}` : `${p}: ${x.posts ?? 0} posts${x.newLeads ? `, ${x.newLeads} new leads` : ''}`);
      notify(`Synced. ${parts.join('; ')}`);
      await load();
    } catch (e) { notify(e instanceof ApiError ? e.message : 'Sync failed.'); }
    finally { setBusy(null); }
  }
  async function disconnect(c: Connection) {
    if (!window.confirm(`Disconnect ${c.label}? Its accounts and posts are removed from Vtology. You can reconnect later.`)) return;
    setBusy(c.id);
    try { await api('DELETE', `${T}/social/${c.id}`); notify('Disconnected.'); await load(); }
    catch (e) { notify(e instanceof ApiError ? e.message : 'Could not disconnect.'); }
    finally { setBusy(null); }
  }

  // ---- derived numbers
  const derived = useMemo(() => {
    if (!o) return null;
    const a = o.analysis;
    const weekly = a.weekly ?? [];
    const present = ORDER.filter(p => a.byPlatform.some(b => b.platform === p && b.posts > 0));
    const platforms = only === 'all' ? present : present.filter(p => p === only);
    // the last 26 complete-or-current weeks, gaps filled with zero
    const end = mondayOf(new Date());
    const weeks = Array.from({ length: 26 }, (_, i) => new Date(end.getTime() - (25 - i) * 7 * 86_400_000).toISOString().slice(0, 10));
    const val = (p: string, w: string, m: Metric) => { const r = weekly.find(x => x.platform === p && x.week === w); return r ? r[m] ?? 0 : 0; };
    const series = (m: Metric) => platforms.map(p => ({ key: p, label: PLATFORM[p]!, color: COLOR[p]!, values: weeks.map(w => val(p, w, m)) }));
    const last4 = (vals: number[]) => sum(vals.slice(-4)), prev4 = (vals: number[]) => sum(vals.slice(-8, -4));
    const view: SocialView = only !== 'all' && a.perPlatform?.[only] ? a.perPlatform[only]! : { platform: null, rated: 0, segments: a.segments, insights: a.insights, top: a.top, bottom: a.bottom };
    return { a, present, platforms, weeks, series, last4, prev4, view };
  }, [o, only]);

  const segs = useMemo(() => (derived?.view.segments ?? []).filter(s => s.dimension === dim && !(s.dimension === 'theme' && s.key === 'other')).sort((x, y) => y.lift - x.lift), [derived, dim]);

  if (error) return <div className="error-box" role="alert">{error}</div>;
  if (!o || !derived) return <div className="progress" />;

  const { a, present, platforms, weeks, series, last4, prev4, view } = derived;
  const plName = only === 'all' ? null : PLATFORM[only]!;
  const scopeSummaries = a.byPlatform.filter(b => platforms.includes(b.platform));
  const sumOrNull = (k: 'views' | 'reach' | 'watchHours') => { const xs = scopeSummaries.map(b => b[k]).filter((x): x is number => x !== null); return xs.length ? sum(xs) : null; };
  const viewsAll = sumOrNull('views'), reachAll = sumOrNull('reach'), watchAll = sumOrNull('watchHours');
  const postsScope = sum(scopeSummaries.map(b => b.posts));
  const metricsHere = METRICS.filter(m => m.id === 'interactions' || m.id === 'posts' || (m.id === 'views' ? viewsAll !== null : m.id === 'reach' ? reachAll !== null : watchAll !== null));
  const real = o.connections.filter(c => c.provider !== 'sample');
  const sample = o.connections.find(c => c.provider === 'sample');
  const lastSync = real.map(c => c.last_sync_at).filter(Boolean).sort().pop();
  const seesMoney = o.campaigns.some(c => c.spend !== null);
  const paid = o.campaigns.filter(c => /meta|google|youtube|search|programmatic/i.test(c.channel) || c.code.startsWith('meta:'));
  const m0: Metric = metricsHere.some(x => x.id === metric) ? metric : 'interactions';
  const trend = series(m0);
  const totalNow = sum(trend.map(s => last4(s.values))), totalBefore = sum(trend.map(s => prev4(s.values)));
  const mover = [...trend].sort((x, y) => (last4(y.values) - prev4(y.values)) - (last4(x.values) - prev4(x.values)))[0];
  const metricNoun = METRICS.find(m => m.id === m0)!.noun;
  const followers = sum(o.accounts.filter(x => platforms.includes(x.platform)).map(x => x.followers ?? 0));
  const iNow = sum(series('interactions').map(s => last4(s.values))), iBefore = sum(series('interactions').map(s => prev4(s.values)));

  const best = segs.find(s => s.lift >= 1.15);
  const cut = segs.filter(s => s.lift <= 0.85).sort((x, y) => y.share - x.share)[0];
  const more = segs.filter(s => s.lift >= 1.15 && s.share < 0.3).sort((x, y) => y.lift - x.lift)[0];
  const dimNoun = DIMS.find(d => d.id === dim)!.noun;

  const reported = sum(paid.map(c => c.platform_conversions)), arrived = sum(paid.map(c => c.journeys)), moved = sum(paid.map(c => c.progressed)), won = sum(paid.map(c => c.converted));

  return (
    <>
      {/* connections */}
      <section className="panel" style={{ padding: '14px 18px' }}>
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="conn-strip">
            {PROVIDERS.map(p => {
              const c = p.id === 'linkedin' ? undefined : real.find(x => x.provider === p.id);
              const warn = c?.last_error;
              return (
                <button key={p.id} className="conn" onClick={() => setManage(m => !m)} aria-expanded={manage}>
                  {p.platforms.map(pl => <span key={pl} className={`pf ${pl}`} style={{ width: 22, height: 22, fontSize: 9.5, borderRadius: 6 }}>{SHORT[pl]}</span>)}
                  {p.name}
                  <span className={`dot ${c ? (warn ? 'warn' : 'ok') : 'off'}`} />
                  <span className="muted small" style={{ fontWeight: 500 }}>{c ? (warn ? 'Partly connected' : 'Connected') : p.id === 'linkedin' ? 'Awaiting LinkedIn approval' : data.me.isDemo ? 'Sample' : 'Not connected'}</span>
                </button>
              );
            })}
          </div>
          <div className="toolbar">
            {lastSync && <span className="muted small">Updated {ago(lastSync)}</span>}
            {real.length > 0 && <button className="btn" onClick={sync} disabled={busy === 'sync'}><IconRefresh />{busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>}
          </div>
        </div>
        {busy === 'sync' && <div style={{ marginTop: 12 }}><div className="progress" /><p className="muted small" style={{ marginTop: 6 }}>Fetching posts, insights, ad campaigns and leads. This takes up to a minute.</p></div>}
        {sample && <p className="muted small" style={{ marginTop: 10 }}>These are fictional accounts for {data.me.tenantName}. Connect real accounts in a workspace for your own brand.</p>}
        {manage && !data.me.isDemo && (
          <div className="conn-detail" style={{ marginTop: 10, borderTop: '1px solid var(--line-soft)' }}>
            {PROVIDERS.map(p => {
              const c = real.find(x => x.provider === p.id);
              const ready = p.id === 'linkedin' ? false : o.providers[p.id as 'meta' | 'youtube'] && o.providers.secret;
              return (
                <div className="row" key={p.id}>
                  <div className="row-main">
                    <span><b>{p.name}</b> <span className="muted small">{c ? `${c.label}, connected ${ago(c.connected_at)}` : p.covers}</span></span>
                    <span className="toolbar">
                      {c && o.canConnect && <button className="btn small" onClick={() => disconnect(c)} disabled={busy === c.id}>Disconnect</button>}
                      {o.canConnect && p.id !== 'linkedin' && <button className={`btn small${c ? '' : ' primary'}`} onClick={() => connect(p.id)} disabled={!ready || busy === p.id}>{c ? 'Reconnect' : 'Connect'}</button>}
                    </span>
                  </div>
                  {p.id === 'linkedin' && <span className="muted small">Available once LinkedIn approves Vtology’s access request.</span>}
                  {c?.last_error && <span className="warnline">{c.last_error.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').slice(0, 260)}</span>}
                </div>
              );
            })}
            {!o.canConnect && <p className="muted small" style={{ paddingTop: 10 }}>Marketing heads and data stewards can connect accounts.</p>}
          </div>
        )}
      </section>

      {a.posts === 0 ? (
        <div className="empty">No posts yet. Connect an account to see what’s working.</div>
      ) : (
        <>
          {/* one filter scopes everything below */}
          <div className="toolbar" style={{ justifyContent: 'space-between' }}>
            <div className="seg" role="group" aria-label="Platform">
              <button aria-pressed={only === 'all'} onClick={() => setOnly('all')}>All platforms</button>
              {present.map(p => <button key={p} aria-pressed={only === p} onClick={() => setOnly(p)}>{PLATFORM[p]}</button>)}
            </div>
            <span className="muted small">Last {Math.round(a.windowDays / 30)} months{plName ? `, ${plName} only` : ''}</span>
          </div>

          {/* headline numbers */}
          <section className="kpis" aria-label="Headline numbers" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
            <div className="kpi"><span className="label">Followers</span><span className="value">{compact(followers)}</span><span className="sub">{plName ?? `across ${o.accounts.length} accounts`}</span></div>
            <div className="kpi"><span className="label">Posts</span><span className="value">{num(postsScope)}</span><span className="sub">{(postsScope / (a.windowDays / 7)).toFixed(1)} a week</span></div>
            <div className="kpi"><span className="label">Views (impressions)</span><span className="value">{viewsAll === null ? '—' : compact(viewsAll)}</span><span className="sub">{viewsAll === null ? (plName ? NOT_REPORTED[only]?.views ?? 'not reported' : 'not reported') : `times your posts were played or shown${scopeSummaries.some(b => b.views === null) ? `, ${scopeSummaries.filter(b => b.views !== null).map(b => PLATFORM[b.platform]).join(' and ')} only` : ''}`}</span></div>
            <div className="kpi"><span className="label">Reach</span><span className="value">{reachAll === null ? '—' : compact(reachAll)}</span><span className="sub">{reachAll === null ? (plName ? NOT_REPORTED[only]?.reach ?? 'not reported' : 'not reported') : `people who saw a post, added up per post${scopeSummaries.some(b => b.reach === null) ? `; ${scopeSummaries.filter(b => b.reach !== null).map(b => PLATFORM[b.platform]).join(' and ')} only` : ''}`}</span></div>
            <div className="kpi"><span className="label">Hours watched</span><span className="value">{watchAll === null ? '—' : watchAll >= 10 ? compact(Math.round(watchAll)) : watchAll.toFixed(1)}</span><span className="sub">{watchAll === null ? (plName ? NOT_REPORTED[only]?.watchHours ?? 'not reported' : 'reels and videos; YouTube needs Analytics') : `on reels and videos${scopeSummaries.some(b => b.watchHours === null) ? `, ${scopeSummaries.filter(b => b.watchHours !== null).map(b => PLATFORM[b.platform]).join(' and ')} only` : ''}`}</span></div>
            <div className="kpi"><span className="label">Interactions, last 4 weeks</span><span className="value">{compact(iNow)}</span>
              <span className="sub"><b style={{ color: iNow >= iBefore ? 'var(--ok)' : 'var(--leak)' }}>{change(iNow, iBefore)}</b> vs the 4 weeks before ({compact(iBefore)})</span></div>
          </section>

          {/* per platform */}
          {only === 'all' && (
            <section className="pf-tiles">
              {platforms.map(p => {
                const b = a.byPlatform.find(x => x.platform === p)!;
                const acc = o.accounts.find(x => x.platform === p);
                const vals = series('interactions').find(s => s.key === p)!.values;
                const n = last4(vals), before = prev4(vals);
                return (
                  <button className="pf-tile" key={p} style={{ ['--pf' as string]: COLOR[p], textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }} onClick={() => setOnly(p)} title={`Show ${PLATFORM[p]} only`}>
                    <div className="head">
                      <span className={`pf lg ${p}`}>{SHORT[p]}</span>
                      <div style={{ minWidth: 0 }}><b>{PLATFORM[p]}</b><span>{acc?.handle ? (acc.handle.startsWith('@') ? acc.handle : '@' + acc.handle) : acc?.name}</span></div>
                    </div>
                    <div className="big">{acc?.followers != null ? compact(acc.followers) : '—'}<small>followers</small></div>
                    <div>
                      <div className="small" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span className="muted">Weekly interactions</span>
                        <b style={{ color: n >= before ? 'var(--ok)' : 'var(--leak)' }}>{change(n, before)}</b>
                      </div>
                      <Sparkline values={vals} color={COLOR[p]!} />
                    </div>
                    <div className="pf-stats" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
                      <div><b>{num(b.posts)}</b><span>posts</span></div>
                      <div title={b.views === null ? NOT_REPORTED[p]?.views : undefined}><b>{b.views === null ? '—' : compact(b.views)}</b><span>views</span></div>
                      <div title={b.reach === null ? NOT_REPORTED[p]?.reach : undefined}><b>{b.reach === null ? '—' : compact(b.reach)}</b><span>reach</span></div>
                      <div><b>{b.medianEngagement != null ? `${(b.medianEngagement * 100).toFixed(1)}%` : '—'}</b><span>engagement</span></div>
                    </div>
                  </button>
                );
              })}
            </section>
          )}

          {/* trend */}
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>{totalBefore === 0 && totalNow === 0 ? `Weekly ${metricNoun}` : `${plName ? `${plName} ${metricNoun}` : metricNoun[0]!.toUpperCase() + metricNoun.slice(1)} ${totalNow >= totalBefore ? 'up' : 'down'} ${change(totalNow, totalBefore).replace(/^[+−]/, '')} in the last 4 weeks`}</h2>
                <p>{compact(totalNow)} {metricNoun} in the last 4 weeks against {compact(totalBefore)} in the 4 before.{!plName && mover && last4(mover.values) !== prev4(mover.values) ? ` ${mover.label} moved most: ${compact(prev4(mover.values))} to ${compact(last4(mover.values))}.` : ''}</p>
              </div>
              <div className="seg" role="group" aria-label="Measure">
                {metricsHere.map(m => <button key={m.id} aria-pressed={m0 === m.id} onClick={() => setMetric(m.id)}>{m.label}</button>)}
              </div>
            </div>
            <div className="legend" style={{ marginBottom: 8 }}>{trend.map(s => <span key={s.key}><i className="line" style={{ background: s.color }} />{s.label}</span>)}</div>
            <LineChart x={weeks} series={trend} xFormat={weekLabel} />
            {(m0 === 'views' || m0 === 'reach' || m0 === 'watchHours') && platforms.some(p => a.byPlatform.find(b => b.platform === p)?.[m0] === null) && (
              <p className="muted small" style={{ marginTop: 8 }}>{platforms.filter(p => a.byPlatform.find(b => b.platform === p)?.[m0] === null).map(p => NOT_REPORTED[p]?.[m0]).filter(Boolean).join('. ')}.</p>
            )}
          </section>

          {/* what to do */}
          <section className="panel" style={{ padding: '14px 18px' }}>
            <p className="small" style={{ maxWidth: '100ch' }}><b>How to read the findings below.</b> Each one compares a group of posts (a theme, format, time of day, language) with the <b>typical post on the same account</b>: the middle engagement rate, where engagement rate is interactions divided by people reached. “60% more” means that group gets 1.6 times the engagement of a typical post there. {plName ? `Showing ${plName} only.` : 'Each finding names its platform; pick one above to focus on it.'}</p>
          </section>
          <section className="verdicts">
            <Verdict title="What’s working" tone="ok" icon={<IconUp />} items={view.insights.filter(i => i.kind === 'working').slice(0, 5)} showPlatform={!plName}
              empty="No group of posts clearly beats your typical post (by 30% or more) yet." />
            <Verdict title="What’s not" tone="leak" icon={<IconDown />} items={view.insights.filter(i => i.kind === 'not_working').slice(0, 5)} showPlatform={!plName}
              empty="Nothing is clearly underperforming: no group of 3 or more posts gets 25% less engagement than your typical post." />
            <Verdict title="Try next" tone="flow" icon={<IconSpark />} items={view.insights.filter(i => i.kind === 'try').slice(0, 5)} showPlatform={!plName}
              empty="No clear move yet. Keep posting; suggestions appear as each group passes 3 posts seen by 50 or more people." />
          </section>

          {/* effort vs return */}
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>{cut && more ? `${plName ? `On ${plName}, shift` : 'Shift'} effort from ${cut.label.toLowerCase()} to ${more.label.toLowerCase()}` : best ? `${plName ? `On ${plName}, ` : ''}${best.label.toLowerCase()} get ${liftPhrase(best.lift, plName ? only : null)}` : `Where your effort goes, and what it returns`}</h2>
                <p>{cut ? `${cut.label} are ${pct(cut.share)} of your posts but get ${liftPhrase(cut.lift, plName ? only : null)}. ` : ''}{more ? `${more.label} get ${liftPhrase(more.lift, plName ? only : null)} from only ${pct(more.share)} of posts. ` : ''}{!cut && !more && !best ? `No clear gap between ${dimNoun} yet. ` : ''}Across: how much of your posting each group is. Up: engagement against your typical post. Bubble size: number of posts.</p>
              </div>
              <div className="seg" role="group" aria-label="Group by">
                {DIMS.map(d => <button key={d.id} aria-pressed={dim === d.id} onClick={() => setDim(d.id)}>{d.label}</button>)}
              </div>
            </div>
            {segs.length === 0 ? <div className="empty">Not enough posts in any group yet.</div> : (
              <div className="effort-wrap">
                <EffortMap points={segs.map(s => ({ key: s.key, label: s.label, share: s.share, lift: s.lift, posts: s.posts }))} />
                <div>
                  <div className="lift-axis"><span /><div><span>−75%</span><span>typical</span><span>4×</span></div><span /></div>
                  <div className="lift-list">
                    {segs.map(sg => {
                      const pos = Math.max(-1, Math.min(1, Math.log(sg.lift) / Math.log(4)));
                      const d = Math.round((sg.lift - 1) * 100);
                      return (
                        <div className="lift-row" key={sg.key} title={liftPhrase(sg.lift, plName ? only : null)}>
                          <span className="lift-name">{sg.label}<span>{sg.posts} posts, {pct(sg.share)}{sg.posts < 8 ? ', early signal' : ''}</span></span>
                          <div className="lift-track" aria-hidden="true">
                            <span className="mid" />
                            <i className={sg.lift >= 1.15 ? 'up' : sg.lift <= 0.85 ? 'down' : pos >= 0 ? 'up flat' : 'down flat'} style={{ width: `${Math.max(1, Math.abs(pos) * 50)}%` }} />
                          </div>
                          <b className="lift-val" style={{ color: sg.lift >= 1.15 ? 'var(--ok)' : sg.lift <= 0.85 ? 'var(--leak)' : undefined }}>{sg.lift >= 2 ? `${sg.lift.toFixed(1)}×` : `${d >= 0 ? '+' : '−'}${Math.abs(d)}%`}</b>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
            <p className="muted small" style={{ marginTop: 14, maxWidth: '90ch' }}>{plName ? `${plName} posts only.` : 'All platforms together; each post is measured against its own account, so platforms of different sizes compare fairly.'} Groups under 3 posts are left out.{a.lowAudience ? ` ${num(a.lowAudience)} posts reached fewer than 50 people and are not compared yet.` : ''}</p>
          </section>

          {/* posts */}
          <div className="grid-2">
            <section className="panel">
              <div className="panel-head"><div><h2>Top posts{plName ? ` on ${plName}` : ''}</h2><p>Most engagement compared with the typical post on the same account.</p></div></div>
              {view.top.length ? <div className="posts">{view.top.slice(0, 4).map(p => <PostCard key={p.id} p={p as Post} />)}</div> : <div className="empty">No posts seen by 50 or more people yet.</div>}
            </section>
            <section className="panel">
              <div className="panel-head"><div><h2>Weakest posts{plName ? ` on ${plName}` : ''}</h2><p>Seen by 50 or more people, but few interacted.</p></div></div>
              {view.bottom.length ? <div className="posts">{view.bottom.slice(0, 4).map(p => <PostCard key={p.id} p={p as Post} />)}</div> : <div className="empty">No posts seen by 50 or more people yet.</div>}
            </section>
          </div>
        </>
      )}

      {paid.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>{reported > 0 ? `${pct(arrived / reported)} of reported leads reached your pipeline` : 'Paid campaigns, followed into the pipeline'}</h2>
              <p>{reported > 0 ? `Platforms reported ${num(reported)} leads; ${num(arrived)} arrived as customer journeys, ${num(moved)} moved past the first stage and ${num(won)} converted. ` : ''}Stages after the first fill in once dealer or branch follow-up data is imported on the Data tab.</p>
            </div>
            <div className="legend">
              <span><i style={{ background: 'color-mix(in srgb, var(--flow) 35%, var(--surface))' }} />Reported by platform</span>
              <span><i style={{ background: 'var(--flow)' }} />Arrived</span>
              <span><i style={{ background: 'color-mix(in srgb, var(--ok) 70%, var(--flow))' }} />Moved forward</span>
              <span><i style={{ background: 'var(--ok)' }} />Converted</span>
            </div>
          </div>
          <div className="funnel-list">
            {[...paid].sort((x, y) => y.platform_conversions - x.platform_conversions || y.journeys - x.journeys).map(c => {
              const top = Math.max(1, c.platform_conversions, c.journeys);
              const missing = c.platform_conversions - c.journeys;
              const bars: [string, string, number][] = [['reported', 'Reported', c.platform_conversions], ['arrived', 'Arrived', c.journeys], ['moved', 'Moved forward', c.progressed], ['won', 'Converted', c.converted]];
              return (
                <div className="funnel" key={c.code}>
                  <div className="name"><b>{c.name}</b><span>{c.channel}{seesMoney && c.spend ? `, ${inr(c.spend)} spent` : ''}</span></div>
                  <div className="funnel-bars">
                    {bars.map(([k, label, v]) => (
                      <div className={`fbar ${k}`} key={k} title={`${label}: ${num(v)}`}>
                        <div className="tr"><i style={{ width: `${(v / top) * 100}%` }} /></div><span>{num(v)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="gap">
                    {c.platform_conversions === 0 && c.journeys === 0 ? <span className="muted">No leads reported</span>
                      : missing > 0 ? <><b style={{ color: 'var(--leak)' }}>{num(missing)}</b><span className="muted">reported leads not in your pipeline</span></>
                        : <><b style={{ color: 'var(--ok)' }}>{pct(c.journeys ? c.progressed / c.journeys : 0)}</b><span className="muted">moved forward</span></>}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

function Verdict({ title, tone, icon, items, showPlatform, empty }: { title: string; tone: 'ok' | 'leak' | 'flow'; icon: React.ReactNode; items: Insight[]; showPlatform: boolean; empty: string }) {
  return (
    <div className={`verdict ${tone}`}>
      <header><span className="ic">{icon}</span><h2 style={{ fontSize: 17 }}>{title}</h2></header>
      {items.length === 0 ? <p className="none">{empty}</p> : (
        <ul>
          {items.map(i => (
            <li key={`${i.platform}-${i.title}`}>
              {showPlatform && i.platform && <span style={{ display: 'flex', alignItems: 'center', gap: 6 }} className="small muted"><span className={`pf ${i.platform}`} style={{ width: 18, height: 18, fontSize: 8.5, borderRadius: 5 }}>{SHORT[i.platform]}</span>{PLATFORM[i.platform]}</span>}
              <span className="t">{i.title}</span>
              {i.lift !== undefined && i.kind !== 'try' && <LiftMeter lift={i.lift} />}
              <span className="d">{i.detail}</span>
              {i.early && <span className="early">Early signal: fewer than 8 posts</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LiftMeter({ lift }: { lift: number }) {
  const pos = Math.max(-1, Math.min(1, Math.log(lift) / Math.log(4)));
  const up = lift >= 1;
  return (
    <div className="meter" aria-label={`${lift.toFixed(1)} times usual engagement`}>
      <div className="meter-track">
        <span className="one" style={{ left: '50%' }} />
        <i style={{ left: up ? '50%' : `${50 + pos * 50}%`, width: `${Math.abs(pos) * 50}%`, background: up ? 'var(--ok)' : 'var(--leak)' }} />
      </div>
      <b style={{ color: up ? 'var(--ok)' : 'var(--leak)' }}>{lift >= 2 ? `${lift.toFixed(1)}×` : `${up ? '+' : '−'}${Math.abs(Math.round((lift - 1) * 100))}%`}</b>
    </div>
  );
}

function PostCard({ p }: { p: Post }) {
  const [broken, setBroken] = useState(false);
  const cap = (p.caption ?? '').split('\n')[0]!.trim() || 'Untitled post';
  const lift = p.lift;
  const Fmt = /video|reel|short/.test(p.format) ? IconPlay : p.format === 'text' || p.format === 'link' ? IconText : IconImage;
  const body = (
    <>
      <div className="thumb">
        {p.thumbnailUrl && !broken ? <img src={p.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
          : <div className="ph" style={{ background: `linear-gradient(135deg, ${COLOR[p.platform]}, color-mix(in srgb, ${COLOR[p.platform]} 55%, #131a33))` }}><Fmt /></div>}
        {lift !== null && <span className={`badge ${lift >= 1.15 ? 'up' : lift <= 0.85 ? 'down' : 'flat'}`}>{lift.toFixed(1)}×</span>}
        <span className={`pf ${p.platform}`}>{SHORT[p.platform]}</span>
      </div>
      <div className="body">
        <span className="cap">{cap}</span>
        <span className="meta">
          <span>{new Date(p.postedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, {p.format}</span>
          <span>{p.views != null ? `${compact(p.views)} views` : p.reach != null ? `${compact(p.reach)} reached` : 'reach n/a'}</span>
          <span>{compact(p.interactions)} interactions</span>
        </span>
      </div>
    </>
  );
  return p.permalink ? <a className="post" href={p.permalink} target="_blank" rel="noreferrer">{body}</a> : <div className="post">{body}</div>;
}
