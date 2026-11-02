'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Action, BenchRow, GrowthReport, IndustryPost, Period, Tag, Trend } from '@vtology/core';
import type { WorkspaceData } from '../Dashboard';
import { api, ApiError } from '../api';
import { change, compact, num, pct } from '../format';
import { BarChart, LineChart } from '../charts';
import { IconImage, IconPlay, IconSpark } from '../icons';

interface Competitor { id: string; platform: string; handle: string; account_id: string | null; last_error: string | null; added_at: string }
interface GrowthData { canEdit: boolean; connected: string[]; isSample: boolean; accounts: { id: string; platform: string; name: string; handle: string | null; followers: number | null; isCompetitor: boolean }[]; competitors: Competitor[]; report: GrowthReport }

const PLATFORM: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube', linkedin: 'LinkedIn' };
const SHORT: Record<string, string> = { instagram: 'IG', facebook: 'FB', youtube: 'YT', linkedin: 'IN' };
const PERIODS: { id: Period; label: string; noun: string }[] = [{ id: 'week', label: 'Week', noun: 'week' }, { id: 'month', label: 'Month', noun: '30 days' }, { id: 'quarter', label: 'Quarter', noun: '90 days' }];
// you first, then competitors in fixed order (validated categorical slots)
const SERIES = ['var(--s-facebook)', 'var(--s-instagram)', 'var(--s-youtube)', 'var(--s-linkedin)', '#e87ba4', '#eda100', '#008300', '#e34948'];
const dayLabel = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const handleOf = (h: string | null) => (h ? (h.startsWith('@') ? h : '@' + h) : '');

export function Growth({ data, workspaceId, notify }: { data: WorkspaceData; workspaceId: string; notify: (m: string) => void }) {
  const [g, setG] = useState<GrowthData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>('month');
  const [platform, setPlatform] = useState<string>('all');
  const [loading, setLoading] = useState(false);
  const T = `/tenants/${workspaceId}`;

  const load = useCallback(() => {
    setLoading(true);
    return api<GrowthData>('GET', `${T}/social/growth?period=${period}${platform !== 'all' ? `&platform=${platform}` : ''}`)
      .then(r => { setG(r); setError(null); })
      .catch(e => setError(e instanceof ApiError ? e.message : 'Could not load growth data.'))
      .finally(() => setLoading(false));
  }, [T, period, platform]);
  useEffect(() => { load(); }, [load]);

  if (error) return <div className="error-box" role="alert">{error}</div>;
  if (!g) return <div className="progress" />;

  const r = g.report;
  const p = r.period, now = p.now, before = p.before;
  const per = PERIODS.find(x => x.id === period)!;
  const ownPlatforms = [...new Set(g.accounts.filter(a => !a.isCompetitor).map(a => a.platform))];
  // compare only where there is someone to compare with
  const benchPlatforms = Object.keys(r.benchmark).filter(pl => r.benchmark[pl]!.some(x => !x.isYou) && (platform === 'all' || pl === platform));
  const scopeName = platform === 'all' ? 'all platforms' : PLATFORM[platform];
  const followerGain = p.followersNow !== null && p.followersBefore !== null ? p.followersNow - p.followersBefore : null;

  // headline sentence, written from the numbers
  const bits: string[] = [];
  if (now.newFollowers !== null) bits.push(`${num(now.newFollowers)} new followers (${change(now.newFollowers, before.newFollowers ?? 0)})`);
  else if (followerGain !== null) bits.push(`${followerGain >= 0 ? '+' : '−'}${num(Math.abs(followerGain))} followers`);
  bits.push(`${num(now.posts)} posts (${change(now.posts, before.posts)})`);
  bits.push(`${compact(now.interactions)} interactions (${change(now.interactions, before.interactions)})`);

  return (
    <div className="growth" style={{ display: 'grid', gap: 24, opacity: loading ? 0.6 : 1, transition: 'opacity .15s' }}>
      <div className="toolbar no-print" style={{ justifyContent: 'space-between' }}>
        <div className="toolbar">
          <div className="seg" role="group" aria-label="Platform">
            <button aria-pressed={platform === 'all'} onClick={() => setPlatform('all')}>All platforms</button>
            {['instagram', 'facebook', 'youtube'].filter(pl => ownPlatforms.includes(pl) || g.competitors.some(c => c.platform === pl)).map(pl => <button key={pl} aria-pressed={platform === pl} onClick={() => setPlatform(pl)}>{PLATFORM[pl]}</button>)}
          </div>
          <div className="seg" role="group" aria-label="Period">
            {PERIODS.map(x => <button key={x.id} aria-pressed={period === x.id} onClick={() => setPeriod(x.id)}>{x.label}</button>)}
          </div>
        </div>
        <button className="btn" onClick={() => window.print()}>Download report (PDF)</button>
      </div>

      <div className="print-only" style={{ display: 'none' }}>
        <h1>{data.me.tenantName}: growth report</h1>
        <p className="muted">{scopeName}, last {per.noun} ({dayLabel(p.from)} to {dayLabel(p.to)}) against the {per.noun} before. Prepared with Vtology.</p>
      </div>

      {/* the period in one line, then the numbers */}
      <section className="panel">
        <div className="panel-head" style={{ marginBottom: 14 }}>
          <div>
            <h2>Last {per.noun}: {bits.join(', ')}</h2>
            <p>{dayLabel(p.from)} to {dayLabel(p.to)} compared with {dayLabel(p.prevFrom)} to {dayLabel(p.from)}, {scopeName}, your accounts only.</p>
          </div>
        </div>
        <div className="kpis" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
          <Delta label="New followers" now={now.newFollowers} before={before.newFollowers} note={now.newFollowers === null ? 'Instagram and Facebook report this; tracking from today otherwise' : undefined} />
          <Delta label="Followers" now={p.followersNow} before={p.followersBefore} note={p.followersBefore === null ? 'history builds from daily tracking' : undefined} />
          <Delta label="Posts" now={now.posts} before={before.posts} />
          <Delta label="Interactions" now={now.interactions} before={before.interactions} />
          <Delta label="Per post" now={now.engagementPerPost} before={before.engagementPerPost} note="interactions per post" />
          <Delta label="Views (impressions)" now={now.views} before={before.views} />
          <Delta label="Reach" now={now.reach} before={before.reach} />
          <Delta label="Hours watched" now={now.watchHours} before={before.watchHours} hours note={now.watchHours === null ? 'reels and videos; YouTube needs Analytics' : undefined} />
        </div>
      </section>

      <FollowerPanel g={g} platform={platform} />

      {r.competitorCount === 0 && (
        <section className="panel" style={{ borderStyle: 'dashed' }}>
          <h2>Add competitors to see how you compare</h2>
          <p className="muted" style={{ marginTop: 6, maxWidth: '75ch' }}>Track up to 10 Instagram business or creator accounts and 10 YouTube channels. Vtology reads what is public on each (followers, posts, likes, comments and YouTube views) through your own connected accounts, so no other tool is needed.</p>
        </section>
      )}

      {/* the plan first: what to do */}
      {r.plan.length > 0 && (
        <section className="panel">
          <div className="panel-head"><div><h2>Growth plan: {r.plan.length} {r.plan.length === 1 ? 'move' : 'moves'}, most impact first</h2><p>Each move comes from your numbers against your competitors’ over the last weeks and months.</p></div></div>
          <ol className="plan">{r.plan.map((a, i) => <PlanItem key={i} a={a} />)}</ol>
        </section>
      )}

      {benchPlatforms.map(pl => (
        <PlatformBlock key={pl} pl={pl} rows={r.benchmark[pl]!} trends={r.trends[pl] ?? []} tags={r.hashtags[pl] ?? []} posts={(r.topPosts[pl] ?? []).slice(0, platform === 'all' ? 4 : 8)} />
      ))}
      {platform === 'facebook' && (
        <section className="panel" style={{ borderStyle: 'dashed' }}>
          <h2>Facebook competitors aren’t available yet</h2>
          <p className="muted" style={{ marginTop: 6, maxWidth: '75ch' }}>Reading other brands’ Facebook Pages needs Meta’s “Page Public Content Access” approval. Your own Facebook numbers above are complete; competitor comparisons run on Instagram and YouTube.</p>
        </section>
      )}

      <Competitors g={g} workspaceId={workspaceId} notify={notify} reload={load} />
      <p className="muted small">How this is measured: competitors are compared on public numbers (likes and comments; views on YouTube). Engagement per follower is likes and comments on a post divided by the account’s followers, the standard measure for comparing accounts of different sizes. “Usual” means the typical (median) post of that same account over the last four months.</p>
    </div>
  );
}

function Delta({ label, now, before, note, hours }: { label: string; now: number | null; before: number | null; note?: string; hours?: boolean }) {
  const fmt = (x: number) => (hours ? (x >= 10 ? `${Math.round(x)} h` : `${x.toFixed(1)} h`) : compact(x));
  const up = now !== null && before !== null && now >= before;
  return (
    <div className="kpi" style={{ padding: '14px 16px' }}>
      <span className="label">{label}</span>
      <span className="value" style={{ fontSize: 26 }}>{now === null ? '—' : fmt(now)}</span>
      {now !== null && before !== null ? (
        <span className="sub"><b style={{ color: up ? 'var(--ok)' : 'var(--leak)' }}>{up ? '▲' : '▼'} {change(now, before).replace(/^[+−]/, '')}</b> vs {fmt(before)}</span>
      ) : <span className="sub">{note ?? 'no earlier data'}</span>}
    </div>
  );
}

function FollowerPanel({ g, platform }: { g: GrowthData; platform: string }) {
  const r = g.report;
  const own = g.accounts.filter(a => !a.isCompetitor && (platform === 'all' || a.platform === platform));
  const ownIds = new Set(own.map(a => a.id));
  // weekly new followers (own accounts, where the platform reports it)
  const weeks = [...new Set(r.newFollowersWeekly.filter(w => ownIds.has(w.accountId)).map(w => w.week))].sort();
  const weekly = weeks.map(w => r.newFollowersWeekly.filter(x => x.week === w && ownIds.has(x.accountId)).reduce((s, x) => s + x.newFollowers, 0));
  // follower growth since the first tracked day, you against competitors, on one platform
  const pl = platform !== 'all' ? platform : g.accounts.some(a => a.isCompetitor && a.platform === 'instagram') ? 'instagram' : own[0]?.platform ?? 'instagram';
  const set = g.accounts.filter(a => a.platform === pl).sort((a, b) => Number(a.isCompetitor) - Number(b.isCompetitor));
  const series = set.map(a => r.followerSeries.find(s => s.accountId === a.id)).filter(Boolean) as GrowthReport['followerSeries'];
  const days = [...new Set(series.flatMap(s => s.points.map(p => p.day)))].sort();
  const step = Math.max(1, Math.ceil(days.length / 40));
  const xs = days.filter((_, i) => i % step === 0 || i === days.length - 1);
  const lines = set.map((a, i) => {
    const s = series.find(x => x.accountId === a.id);
    if (!s || s.points.length < 2) return null;
    const base = s.points[0]!.followers || 1;
    let last = s.points[0]!.followers;
    const values = xs.map(d => { const pt = s.points.find(p => p.day === d); if (pt) last = pt.followers; return ((last - base) / base) * 100; });
    return { key: a.id, label: a.isCompetitor ? a.name : `You (${a.name})`, color: SERIES[i % SERIES.length]!, values };
  }).filter(Boolean) as { key: string; label: string; color: string; values: number[] }[];
  const you = lines.find(l => l.label.startsWith('You'));
  const compEnd = lines.filter(l => !l.label.startsWith('You')).map(l => l.values[l.values.length - 1]!).sort((a, b) => a - b);
  const compMid = compEnd.length ? compEnd[Math.floor(compEnd.length / 2)]! : null;
  const youEnd = you ? you.values[you.values.length - 1]! : null;
  const totalNew = weekly.reduce((a, b) => a + b, 0);

  return (
    <div className="grid-2">
      <section className="panel">
        <div className="panel-head"><div>
          <h2>{weekly.length ? `${num(totalNew)} new followers in ${weeks.length} weeks` : 'New followers per week'}</h2>
          <p>{weekly.length >= 2 ? `Latest week ${num(weekly[weekly.length - 1]!)}, the week before ${num(weekly[weekly.length - 2]!)}. ` : ''}Your {platform === 'all' ? 'Instagram and Facebook' : PLATFORM[platform]} accounts, as the platform reports them.</p>
        </div></div>
        {weekly.length ? <BarChart x={weeks} values={weekly} xFormat={dayLabel} label="new followers" color="var(--ok)" /> : <div className="empty">{platform === 'youtube' ? 'YouTube reports subscriber gains through YouTube Analytics, which needs the Google billing verification.' : 'Not reported yet. Instagram shares this for accounts with 100 or more followers; it fills in after the next sync.'}</div>}
      </section>
      <section className="panel">
        <div className="panel-head"><div>
          <h2>{youEnd !== null && compMid !== null ? `${PLATFORM[pl]} followers: you ${youEnd >= 0 ? '+' : ''}${youEnd.toFixed(1)}%, competitors ${compMid >= 0 ? '+' : ''}${compMid.toFixed(1)}%` : `${PLATFORM[pl]} follower growth`}</h2>
          <p>Change since {xs[0] ? dayLabel(xs[0]) : 'tracking began'}, as a percentage of each account’s own size, so a small and a large account compare fairly.</p>
        </div></div>
        {lines.length && xs.length >= 2 ? (
          <>
            <div className="legend" style={{ marginBottom: 8 }}>{lines.map(l => <span key={l.key}><i className="line" style={{ background: l.color }} />{l.label}</span>)}</div>
            <LineChart x={xs} series={lines} xFormat={dayLabel} format={v => `${v.toFixed(v !== 0 && Math.abs(v) < 10 ? 1 : 0)}%`} height={230} />
          </>
        ) : <div className="empty">Vtology records followers daily, for you and your competitors. This chart fills in after a few days of tracking.</div>}
      </section>
    </div>
  );
}

function PlanItem({ a }: { a: Action }) {
  return (
    <li>
      <div className="plan-head">
        {a.platform && <span className={`pf ${a.platform}`} style={{ width: 20, height: 20, fontSize: 9, borderRadius: 6 }}>{SHORT[a.platform]}</span>}
        <b>{a.title}</b>
        <span className={`tag ${a.impact === 'high' ? 'ok' : 'flow'}`}>{a.impact === 'high' ? 'High impact' : 'Worth doing'}</span>
      </div>
      <p>{a.why}</p>
      <span className="muted small">Based on: {a.evidence}</span>
    </li>
  );
}

function PlatformBlock({ pl, rows, trends, tags, posts }: { pl: string; rows: BenchRow[]; trends: Trend[]; tags: Tag[]; posts: IndustryPost[] }) {
  const name = PLATFORM[pl]!;
  const you = rows.find(r => r.isYou);
  const comps = rows.filter(r => !r.isYou);
  const byEr = [...rows].filter(r => r.erPerPost !== null).sort((a, b) => b.erPerPost! - a.erPerPost!);
  const rank = you ? byEr.findIndex(r => r.isYou) + 1 : 0;
  const sizeGap = you && you.followers && comps.length ? Math.max(...comps.map(c => c.followers ?? 0)) / you.followers : 0;
  const maxF = Math.max(1, ...rows.map(r => r.followers ?? 0));
  const maxEr = Math.max(0.0001, ...rows.filter(r => r.comparable).map(r => r.erPerPost ?? 0));
  const cad = comps.length ? [...comps.map(c => c.postsPerWeek)].sort((a, b) => a - b)[Math.floor(comps.length / 2)]! : null;
  const rising = trends.filter(t => t.status === 'rising'), falling = trends.filter(t => t.status === 'falling');
  const formats = trends.filter(t => t.dimension === 'format' && t.liftRecent !== null).sort((a, b) => b.liftRecent! - a.liftRecent!);

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span className={`pf ${pl}`}>{SHORT[pl]}</span>
              {you && comps.length ? (you.comparable ? `${name}: you rank #${rank} of ${byEr.length} on engagement${cad !== null ? `, and post ${you.postsPerWeek.toFixed(1)} times a week against ${cad.toFixed(1)}` : ''}` : `${name}: competitors are up to ${compact(sizeGap)}× your size and post ${cad !== null ? `${cad.toFixed(1)} times a week against your ${you.postsPerWeek.toFixed(1)}` : 'more often'}`) : `${name}: you and your competitors`}</h2>
            <p>Last 4 weeks for posting and share of voice; last 4 months for engagement. Your row is highlighted.{you && !you.comparable ? ' Engagement per follower is greyed out where accounts differ in size by more than 10×: a small account’s posts often reach people beyond its followers, which inflates the rate.' : ''}</p>
          </div>
        </div>
        <div className="table-wrap" style={{ boxShadow: 'none' }}>
          <table className="bench">
            <thead><tr><th>Account</th><th>Followers</th><th className="num">Growth, 30 days</th><th className="num">Posts a week</th><th>Engagement per follower</th><th>Most used format</th><th>Share of voice</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.accountId} className={r.isYou ? 'you' : ''}>
                  <td><b>{r.isYou ? 'You' : r.name}</b><div className="muted small">{r.isYou ? r.name : handleOf(r.handle)}</div></td>
                  <td><div className="cell-bar"><span>{r.followers === null ? '—' : compact(r.followers)}</span><i style={{ width: `${((r.followers ?? 0) / maxF) * 100}%` }} /></div></td>
                  <td className="num">{r.growth === null ? <span className="muted small">{r.growthDays ? `${r.growthDays} days tracked` : 'tracking'}</span> : <b style={{ color: r.growth >= 0 ? 'var(--ok)' : 'var(--leak)' }}>{r.growth >= 0 ? '+' : ''}{(r.growth * 100).toFixed(1)}%</b>}</td>
                  <td className="num">{r.postsPerWeek.toFixed(1)}</td>
                  <td style={{ opacity: r.comparable ? 1 : 0.45 }} title={r.comparable ? undefined : 'Not comparable: account size differs by more than 10×'}><div className="cell-bar"><span>{r.erPerPost === null ? '—' : `${(r.erPerPost * 100).toFixed(2)}%`}</span><i className="alt" style={{ width: `${Math.min(100, ((r.erPerPost ?? 0) / maxEr) * 100)}%` }} /></div></td>
                  <td>{r.topFormat ?? '—'}{r.topFormatShare !== null && <span className="muted small"> {pct(r.topFormatShare)}</span>}</td>
                  <td><div className="cell-bar"><span>{pct(r.shareOfVoice)}</span><i className="sov" style={{ width: `${r.shareOfVoice * 100}%` }} /></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid-main">
        <section className="panel">
          <div className="panel-head"><div>
            <h2>{rising.length ? `Rising on ${name}: ${rising.slice(0, 2).map(t => t.label.toLowerCase()).join(' and ')}` : `What’s trending on ${name}`}</h2>
            <p>Across you and your competitors: the last 4 weeks against the 3 months before. Engagement is against each account’s usual post.</p>
          </div></div>
          {trends.length === 0 ? <div className="empty">Needs a few more posts from you and your competitors.</div> : (
            <div className="trends">
              {[...rising, ...trends.filter(t => t.status === 'steady' && t.dimension !== 'time').slice(0, Math.max(0, 6 - rising.length)), ...falling.slice(0, 3)].map(t => (
                <div className={`trend ${t.status}`} key={`${t.dimension}-${t.key}`}>
                  <span className={`tag ${t.status === 'rising' ? 'ok' : t.status === 'falling' ? 'leak' : 'plain'}`}>{t.status === 'rising' ? '▲ Rising' : t.status === 'falling' ? '▼ Fading' : 'Steady'}</span>
                  <b>{t.label}</b>
                  <span className="small">{pct(t.shareBefore)} → <b>{pct(t.shareRecent)}</b> of posts{t.liftRecent !== null ? `, ${t.liftRecent >= 1 ? '+' : '−'}${Math.abs(Math.round((t.liftRecent - 1) * 100))}% engagement` : ''}</span>
                  <span className="muted small">You: {pct(t.yourShare)} of your posts</span>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="panel">
          <div className="panel-head"><div><h2>Formats that win on {name}</h2><p>Engagement against each account’s usual post, last 4 weeks, everyone in the set. Under each: its share of industry posts, and of yours.</p></div></div>
          {formats.length === 0 ? <div className="empty">Not enough recent posts.</div> : (
            <div className="lift-list">
              {formats.map(f => {
                const pos = Math.max(-1, Math.min(1, Math.log(f.liftRecent!) / Math.log(4)));
                return (
                  <div className="lift-row" key={f.key} style={{ gridTemplateColumns: 'minmax(100px, 140px) minmax(0, 1fr) 50px' }}>
                    <span className="lift-name">{f.label}<span>industry {pct(f.shareRecent)}, you {pct(f.yourShare)}</span></span>
                    <div className="lift-track"><span className="mid" /><i className={f.liftRecent! >= 1.1 ? 'up' : f.liftRecent! <= 0.9 ? 'down' : pos >= 0 ? 'up flat' : 'down flat'} style={{ width: `${Math.max(1, Math.abs(pos) * 50)}%` }} /></div>
                    <b className="lift-val" style={{ color: f.liftRecent! >= 1.1 ? 'var(--ok)' : f.liftRecent! <= 0.9 ? 'var(--leak)' : undefined }}>{f.liftRecent! >= 2 ? `${f.liftRecent!.toFixed(1)}×` : `${f.liftRecent! >= 1 ? '+' : '−'}${Math.abs(Math.round((f.liftRecent! - 1) * 100))}%`}</b>
                  </div>
                );
              })}
            </div>
          )}
          {tags.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <h3 style={{ fontSize: 15, marginBottom: 8 }}>Hashtags in use, last 30 days</h3>
              <div className="tags">{tags.slice(0, 12).map(t => <span key={t.tag} className={`hashtag${(t.lift ?? 0) >= 1.2 ? ' good' : ''}`} title={`${t.posts} posts by ${t.accounts} accounts`}>{t.tag}<em>{t.accounts} acc{t.lift !== null ? `, ${t.lift >= 1 ? '+' : '−'}${Math.abs(Math.round((t.lift - 1) * 100))}%` : ''}</em></span>)}</div>
            </div>
          )}
        </section>
      </div>

      {posts.length > 0 && (
        <section className="panel">
          <div className="panel-head"><div><h2>Best posts in your industry on {name}, last 30 days</h2><p>Ranked by engagement against each account’s usual post, so a smaller account’s hit counts as much as a big one’s. Open any to see what they did.</p></div></div>
          <div className="posts">{posts.slice(0, 8).map(p => <IndustryCard key={p.id} p={p} />)}</div>
        </section>
      )}
    </>
  );
}

function IndustryCard({ p }: { p: IndustryPost }) {
  const [broken, setBroken] = useState(false);
  const Fmt = /video|reel|short/.test(p.format) ? IconPlay : IconImage;
  const body = (
    <>
      <div className="thumb">
        {p.thumbnailUrl && !broken ? <img src={p.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
          : <div className="ph" style={{ background: `linear-gradient(135deg, var(--s-${p.platform}), color-mix(in srgb, var(--s-${p.platform}) 55%, #131a33))` }}><Fmt /></div>}
        {p.lift !== null && <span className={`badge ${p.lift >= 1.15 ? 'up' : p.lift <= 0.85 ? 'down' : 'flat'}`}>{p.lift.toFixed(1)}×</span>}
        {p.isYou && <span className="you-flag">You</span>}
      </div>
      <div className="body">
        <span className="small" style={{ fontWeight: 650 }}>{p.isYou ? 'You' : p.accountName} <span className="muted" style={{ fontWeight: 400 }}>{handleOf(p.handle)}</span></span>
        <span className="cap">{(p.caption ?? '').split('\n')[0]!.trim() || 'Untitled post'}</span>
        <span className="meta"><span>{new Date(p.postedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, {p.format}</span><span>{compact(p.engagement)} likes and comments</span>{p.views ? <span>{compact(p.views)} views</span> : null}</span>
      </div>
    </>
  );
  return p.permalink ? <a className="post" href={p.permalink} target="_blank" rel="noreferrer">{body}</a> : <div className="post">{body}</div>;
}

function Competitors({ g, workspaceId, notify, reload }: { g: GrowthData; workspaceId: string; notify: (m: string) => void; reload: () => Promise<void> }) {
  const [platform, setPlatform] = useState('instagram');
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const T = `/tenants/${workspaceId}`;
  const names = useMemo(() => new Map(g.accounts.map(a => [a.id, a])), [g.accounts]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!handle.trim()) return;
    setBusy('add');
    try {
      const r = await api<{ added: string; synced: boolean; message: string | null }>('POST', `${T}/social/competitors`, { platform, handle });
      notify(r.synced ? `Added @${r.added}. Their numbers are in.` : r.message ?? `Saved @${r.added}.`);
      setHandle('');
      await reload();
    } catch (err) { notify(err instanceof ApiError ? err.message : 'Could not add the competitor.'); }
    finally { setBusy(null); }
  }
  async function remove(c: Competitor) {
    if (!window.confirm(`Stop tracking @${c.handle}? Their stored numbers are removed.`)) return;
    setBusy(c.id);
    try { await api('DELETE', `${T}/social/competitors/${c.id}`); notify(`Removed @${c.handle}.`); await reload(); }
    catch (err) { notify(err instanceof ApiError ? err.message : 'Could not remove.'); }
    finally { setBusy(null); }
  }

  return (
    <section className="panel no-print">
      <div className="panel-head"><div><h2>Competitors you track</h2><p>Up to 10 per platform. Instagram accounts must be business or creator accounts (most brands are). Numbers refresh daily.</p></div></div>
      {g.competitors.length === 0 ? <p className="muted small" style={{ marginBottom: 14 }}>None yet.</p> : (
        <div className="rows" style={{ marginBottom: 14 }}>
          {g.competitors.map(c => {
            const a = c.account_id ? names.get(c.account_id) : undefined;
            return (
              <div className="row" key={c.id}>
                <div className="row-main">
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className={`pf ${c.platform}`} style={{ width: 20, height: 20, fontSize: 9, borderRadius: 6 }}>{SHORT[c.platform]}</span><b>{a?.name ?? '@' + c.handle}</b> <span className="muted small">@{c.handle.replace(/^@/, '')}{a?.followers != null ? `, ${compact(a.followers)} followers` : ''}</span></span>
                  {g.canEdit && !g.isSample && <button className="btn small" onClick={() => remove(c)} disabled={busy === c.id}>Remove</button>}
                </div>
                {c.last_error ? <span className="small" style={{ color: 'var(--warn)' }}>{c.last_error}</span> : !a && <span className="muted small">Looking up on the next sync.</span>}
              </div>
            );
          })}
        </div>
      )}
      {g.canEdit && !g.isSample && (
        <form className="toolbar" onSubmit={add}>
          <select className="input" style={{ width: 'auto' }} value={platform} onChange={e => setPlatform(e.target.value)} aria-label="Platform">
            <option value="instagram">Instagram</option><option value="youtube">YouTube</option>
          </select>
          <input className="input" style={{ maxWidth: 280 }} value={handle} onChange={e => setHandle(e.target.value)} placeholder={platform === 'instagram' ? 'Handle, e.g. cardekho' : 'Channel handle, e.g. @CarDekho'} aria-label="Handle" />
          <button className="btn primary" type="submit" disabled={busy === 'add'}><IconSpark />{busy === 'add' ? 'Adding… (up to a minute)' : 'Add competitor'}</button>
        </form>
      )}
      {g.isSample && <p className="muted small">These are fictional competitors for the sample workspace.</p>}
    </section>
  );
}
