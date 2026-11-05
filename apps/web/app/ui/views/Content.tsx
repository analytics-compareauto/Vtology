'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { LineChart } from '../charts';
import { DateRangePicker, rangeQuery, type Range } from '../DateRange';
import { ago, compact, pct } from '../format';
import { IconImage, IconPlay, IconRefresh } from '../icons';

interface Acc { id: string; platform: string; name: string; handle: string | null; followers: number | null; isCompetitor: boolean; profileUrl: string | null }
interface Out { id: string; accountId: string; platform: string; format: string; title: string; postedAt: string; permalink: string | null; thumbnailUrl: string | null; score: number; value: number; metric: string; usual: number; ageDays: number; themes: string[] }
interface Pattern { kind: string; key: string; label: string; outliers: number; posts: number; outlierShare: number; postShare: number; ratio: number; byCompetitors: number }
interface TopicVideo { id: string; title: string; channel: string; channelId: string; publishedAt: string; views: number }
interface Topic { id: string; phrase: string; last_scan_at: string | null; last_error: string | null; result: { demand: number; medianAgeDays: number; biggerChannels: number | null; nearSize?: number | null; ownRank: number | null; competitorRanks: { name: string; rank: number }[]; opportunity: number; videos: TopicVideo[] } | null }
interface Check { id: string; label: string; pass: boolean; fix: string }
interface Video { id: string; title: string; postedAt: string; permalink: string | null; thumbnailUrl: string | null; format: string; views: number | null; avgViewPct: number | null; durationS: number | null; checks: Check[]; score: number | null }
interface Data { canEdit: boolean; isDemo: boolean; youtubeConnected: boolean; accounts: Acc[]; outliers: Out[]; patterns: Pattern[]; topics: Topic[]; suggestedTopics: string[]; brandDomain: string | null; usualViewPct: number | null; videos: Video[] }

const PLATFORM: Record<string, string> = { instagram: 'Instagram', youtube: 'YouTube', facebook: 'Facebook' };
const COLOR: Record<string, string> = { instagram: '#c13584', youtube: '#e62117', facebook: '#1877f2' };

export function Content({ workspaceId, notify, range, onRange }: { workspaceId: string; notify: (m: string) => void; range: Range; onRange: (r: Range) => void }) {
  const T = `/tenants/${workspaceId}`;
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [who, setWho] = useState<'all' | 'you' | 'them'>('all');
  const [platform, setPlatform] = useState<string>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => api<Data>('GET', `${T}/content?${rangeQuery(range)}`).then(r => { setD(r); setErr(null); }).catch(e => setErr(e instanceof ApiError ? e.message : 'Could not load content insights.')), [T, range]);
  useEffect(() => { load(); }, [load]);
  // topics not scanned this week: scan quietly on open
  useEffect(() => {
    if (!d?.canEdit || !d.youtubeConnected) return;
    if (!d.topics.some(t => !t.last_scan_at || Date.now() - Date.parse(t.last_scan_at) > 7 * 86_400_000)) return;
    api<{ scanned: number }>('POST', `${T}/content/topics/scan`, {}).then(r => { if (r.scanned) load(); }).catch(() => undefined);
  }, [d?.topics.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <div className="error-box" role="alert">{err}</div>;
  if (!d) return <div className="progress" />;
  const acc = new Map(d.accounts.map(a => [a.id, a]));
  const outs = d.outliers.filter(o => (who === 'all' || (who === 'you') === !acc.get(o.accountId)?.isCompetitor) && (platform === 'all' || o.platform === platform));
  const platforms = [...new Set(d.outliers.map(o => o.platform))];
  const competitors = d.accounts.filter(a => a.isCompetitor);

  async function scan(ids?: string[]) {
    setBusy('scan');
    try { const r = await api<{ scanned: number }>('POST', `${T}/content/topics/scan`, ids ? { ids } : {}); notify(r.scanned ? `Searched YouTube for ${r.scanned} ${r.scanned === 1 ? 'topic' : 'topics'}.` : 'Every topic was searched this week already.'); await load(); }
    catch (e) { notify(e instanceof ApiError ? e.message : 'The search failed.'); } finally { setBusy(null); }
  }
  async function add(phrases: string[]) {
    try { await api('POST', `${T}/content/topics`, { phrases }); await load(); if (d!.youtubeConnected) scan(); }
    catch (e) { notify(e instanceof ApiError ? e.message : 'Could not add the topic.'); }
  }

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div className="toolbar no-print">
        <DateRangePicker value={range} onChange={onRange} />
        <div className="seg" role="group" aria-label="Whose posts">
          {(['all', 'you', 'them'] as const).map(k => <button key={k} aria-pressed={who === k} onClick={() => setWho(k)}>{k === 'all' ? 'Everyone' : k === 'you' ? 'Yours' : 'Competitors'}</button>)}
        </div>
        {platforms.length > 1 && <div className="seg" role="group" aria-label="Platform">
          <button aria-pressed={platform === 'all'} onClick={() => setPlatform('all')}>All</button>
          {platforms.map(p => <button key={p} aria-pressed={platform === p} onClick={() => setPlatform(p)}>{PLATFORM[p] ?? p}</button>)}
        </div>}
      </div>

      <section className="panel">
        <div className="panel-head"><div><h2>Breaking out</h2><p>Posts that did at least 2.5× their own account’s usual, judged on what each platform shows publicly (YouTube views; Instagram and Facebook likes and comments), so your posts and competitors’ compare fairly. Posts need two days to count.</p></div></div>
        {outs.length ? <div className="posts">{outs.slice(0, 16).map(o => <OutCard key={o.id} o={o} a={acc.get(o.accountId)} />)}</div>
          : <div className="empty">{competitors.length ? 'Nothing broke out in these dates. Try a longer range.' : 'Add competitors on the Growth tab to see what breaks out across your category.'}</div>}
      </section>

      {d.patterns.length > 0 && (
        <section className="panel">
          <div className="panel-head"><div><h2>What breaks out in your category</h2><p>Themes and formats that show up among breakout posts more often than they are posted, across you and your competitors.</p></div></div>
          <div className="rows">
            {d.patterns.map(p => (
              <div className="row" key={`${p.kind}:${p.key}`}>
                <div className="row-main"><span><b>{p.label}</b> <span className="tag plain">{p.kind === 'theme' ? 'Theme' : 'Format'}</span></span><b>{p.ratio.toFixed(1)}× as likely to break out</b></div>
                <div className="aud-compare" style={{ maxWidth: 640, gridTemplateColumns: '150px minmax(0, 1fr) 48px' }}>
                  <span className="small">Share of breakouts</span><div className="share-bar"><i style={{ width: `${p.outlierShare * 100}%` }} /></div><b>{pct(p.outlierShare)}</b>
                  <span className="small">Share of all posts</span><div className="share-bar"><i style={{ width: `${p.postShare * 100}%`, background: 'var(--muted)' }} /></div><b>{pct(p.postShare)}</b>
                </div>
                <span className="small muted">{p.outliers} breakout {p.outliers === 1 ? 'post' : 'posts'}, {p.byCompetitors} of them by competitors.</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <Topics T={T} d={d} busy={busy === 'scan'} onScan={scan} onAdd={add} onRemove={async id => { await api('DELETE', `${T}/content/topics/${id}`); load(); }} />

      <section className="panel">
        <div className="panel-head"><div><h2>Your YouTube videos: checks</h2><p>The basics that help a video get found and watched{d.brandDomain ? `, and tracked back to ${d.brandDomain}` : ''}. Each failed check comes with its fix.</p></div></div>
        {d.videos.length > 0 && <CheckSummary videos={d.videos} />}
        {d.videos.length ? <div className="rows">{d.videos.map(v => <VideoRow key={v.id} v={v} T={T} usual={d.usualViewPct} />)}</div>
          : <div className="empty">{d.youtubeConnected ? 'No videos of yours in these dates.' : 'Connect your YouTube channel on the Social tab to check your videos.'}</div>}
      </section>
    </div>
  );
}

function OutCard({ o, a }: { o: Out; a: Acc | undefined }) {
  const [broken, setBroken] = useState(false);
  const Fmt = /video|reel|short/.test(o.format) ? IconPlay : IconImage;
  const body = (
    <>
      <div className="thumb">
        {o.thumbnailUrl && !broken ? <img src={o.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
          : <div className="ph" style={{ background: `linear-gradient(135deg, ${COLOR[o.platform] ?? '#2f5bd8'}, #131a33)` }}><Fmt /></div>}
        <span className="badge up">{o.score >= 10 ? Math.round(o.score) : o.score.toFixed(1)}×</span>
      </div>
      <div className="body">
        <span className="small" style={{ fontWeight: 650 }}>{a?.name ?? 'Account'}{a?.isCompetitor ? '' : ' (you)'} · {PLATFORM[o.platform] ?? o.platform}</span>
        <span className="cap">{o.title || 'Untitled post'}</span>
        <span className="meta"><span>{compact(o.value)} {o.metric === 'views' ? 'views' : 'likes + comments'}</span><span>usual {compact(o.usual)}</span><span>{o.ageDays}d old</span></span>
      </div>
    </>
  );
  return o.permalink ? <a className="post" href={o.permalink} target="_blank" rel="noreferrer">{body}</a> : <div className="post">{body}</div>;
}

function Topics({ T, d, busy, onScan, onAdd, onRemove }: { T: string; d: Data; busy: boolean; onScan: (ids?: string[]) => void; onAdd: (p: string[]) => void; onRemove: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [sug, setSug] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (q.trim().length < 3) { setSug([]); return; }
    const t = setTimeout(() => api<{ suggestions: string[] }>('GET', `${T}/content/topics/suggest?q=${encodeURIComponent(q)}`).then(r => setSug(r.suggestions)).catch(() => setSug([])), 350);
    return () => clearTimeout(t);
  }, [q, T]);
  const sorted = [...d.topics].sort((a, b) => (b.result?.opportunity ?? -1) - (a.result?.opportunity ?? -1));
  return (
    <section className="panel">
      <div className="panel-head">
        <div><h2>Topics people search on YouTube</h2><p>For each phrase: how much the top 10 videos get watched a day, how old they are, how many come from channels near your size, and where you and competitors rank. Old results, and channels like yours already ranking, leave room for a new video. Searched weekly.</p></div>
        {d.canEdit && d.topics.length > 0 && <button className="btn" onClick={() => onScan(d.topics.map(t => t.id).slice(0, 10))} disabled={busy || !d.youtubeConnected}><IconRefresh />{busy ? 'Searching…' : 'Search again'}</button>}
      </div>
      {!d.youtubeConnected && <div className="note-box" style={{ marginBottom: 12 }}>Connect your YouTube channel on the Social tab: topics are searched through it.</div>}
      {d.canEdit && (
        <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
          <form className="toolbar" onSubmit={e => { e.preventDefault(); if (q.trim()) { onAdd([q.trim()]); setQ(''); setSug([]); } }}>
            <input className="input" style={{ maxWidth: 360 }} value={q} onChange={e => setQ(e.target.value)} placeholder="A phrase people search, e.g. hyryder vs grand vitara" maxLength={80} />
            <button className="btn primary" type="submit" disabled={!q.trim()}>Track topic</button>
          </form>
          {sug.length > 0 && <div className="toolbar" style={{ gap: 6 }}><span className="small muted">YouTube suggests:</span>{sug.map(s => <button key={s} className="tag flow" style={{ border: 0, cursor: 'pointer' }} onClick={() => { onAdd([s]); setQ(''); setSug([]); }}>+ {s}</button>)}</div>}
          {d.suggestedTopics.length > 0 && <div className="toolbar" style={{ gap: 6 }}><span className="small muted">Start with:</span>{d.suggestedTopics.map(s => <span key={s} className="tag plain">{s}</span>)}<button className="btn small" onClick={() => onAdd(d.suggestedTopics)}>Track all of these</button></div>}
        </div>
      )}
      {sorted.length > 0 && (
        <div className="table-wrap" style={{ boxShadow: 'none' }}>
          <table>
            <thead><tr><th>Topic</th><th style={{ width: 160 }}>Opportunity</th><th className="num">Daily views, top 10</th><th className="num">Typical age</th><th className="num">Channels near your size</th><th>You</th><th>Competitors</th><th /></tr></thead>
            <tbody>{sorted.map(t => {
              const r = t.result;
              return [
                <tr key={t.id}>
                  <td><button className="btn link" style={{ padding: 0, fontWeight: 650, textAlign: 'left' }} onClick={() => setOpen(open === t.id ? null : t.id)}>{t.phrase}</button>{t.last_error && <div className="small" style={{ color: 'var(--warn)' }}>{t.last_error}</div>}{!r && !t.last_error && <div className="small muted">Not searched yet</div>}</td>
                  <td>{r && <div className="aud-index score"><i style={{ width: `${r.opportunity}%`, background: r.opportunity >= 60 ? 'var(--ok)' : r.opportunity >= 35 ? 'var(--flow)' : 'var(--muted)' }} /><span>{r.opportunity}</span></div>}</td>
                  <td className="num">{r ? compact(r.demand) : '–'}</td>
                  <td className="num">{r ? (r.medianAgeDays >= 60 ? `${Math.round(r.medianAgeDays / 30)} months` : `${r.medianAgeDays} days`) : '–'}</td>
                  <td className="num">{r?.nearSize != null ? `${Math.round(r.nearSize * 10)} of 10` : r?.biggerChannels != null ? `${10 - Math.round(r.biggerChannels * 10)} of 10` : '–'}</td>
                  <td>{r ? (r.ownRank ? <span className="tag ok">#{r.ownRank}</span> : <span className="tag plain">not in top 20</span>) : ''}</td>
                  <td className="small">{r?.competitorRanks.length ? r.competitorRanks.map(c => `${c.name} #${c.rank}`).join(', ') : r ? 'none in top 20' : ''}</td>
                  <td>{d.canEdit && <button className="btn small link" onClick={() => onRemove(t.id)}>Remove</button>}</td>
                </tr>,
                open === t.id && r && (
                  <tr key={`${t.id}-v`}><td colSpan={8} style={{ background: 'var(--surface-2)' }}>
                    <b className="small">Top results{t.last_scan_at ? `, searched ${ago(t.last_scan_at)}` : ''}</b>
                    <ol className="small" style={{ margin: '6px 0 0', paddingLeft: 20, display: 'grid', gap: 3 }}>
                      {r.videos.slice(0, 10).map(v => <li key={v.id}><a href={`https://youtube.com/watch?v=${v.id}`} target="_blank" rel="noreferrer">{v.title}</a> <span className="muted">· {v.channel} · {compact(v.views)} views · {new Date(v.publishedAt).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}</span></li>)}
                    </ol>
                  </td></tr>
                ),
              ];
            })}</tbody>
          </table>
        </div>
      )}
      {d.isDemo && d.topics.some(t => t.result) && <p className="small muted" style={{ marginTop: 8 }}>Sample workspace: search results are made up.</p>}
    </section>
  );
}

/** Which checks fail most across the videos: fix the habit once rather than video by video. */
function CheckSummary({ videos }: { videos: Video[] }) {
  const tally = new Map<string, { label: string; fix: string; failed: number; total: number }>();
  for (const v of videos) for (const c of v.checks) {
    const t = tally.get(c.id) ?? { label: c.label, fix: c.fix, failed: 0, total: 0 };
    t.total++; if (!c.pass) t.failed++; tally.set(c.id, t);
  }
  const GENERIC: Record<string, string> = {
    title_length: 'Keep titles between 20 and 70 characters, hashtags aside, and say what the viewer gets.',
    topic: 'Use the words people search for (see Topics above) in the title.',
    link: 'Put a link to the relevant page on your site in the first two lines of every description.',
    utm: 'Tag those links with utm_source=youtube&utm_medium=organic&utm_campaign=<video>, so leads from each video can be counted.',
    hashtags: 'Three to five specific hashtags (model, brand, topic); drop generic ones such as #viral and #fyp.',
    chapters: 'Add chapters to long videos: timestamps from 0:00 in the description.',
    retention: 'Open the retention curve of these videos to see where viewers leave, and tighten the opening.',
  };
  for (const [id, t] of tally) t.fix = GENERIC[id] ?? t.fix;
  const rows = [...tally.values()].filter(t => t.failed).sort((a, b) => b.failed / b.total - a.failed / a.total);
  if (!rows.length) return <div className="note-box" style={{ marginBottom: 12 }}>Every video passes every check.</div>;
  return (
    <div className="table-wrap" style={{ boxShadow: 'none', marginBottom: 14 }}>
      <table>
        <thead><tr><th>Check</th><th className="num">Videos failing</th><th>How to fix</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.label}><td><b>{r.label}</b></td><td className="num">{r.failed} of {r.total}</td><td className="small">{r.fix}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function VideoRow({ v, T, usual }: { v: Video; T: string; usual: number | null }) {
  const [curve, setCurve] = useState<{ at: number; watching: number; relative: number | null }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showFixes, setShowFixes] = useState(false);
  const failed = v.checks.filter(c => !c.pass);
  async function retention() {
    if (curve) { setCurve(null); return; }
    setBusy(true); setErr(null);
    try { setCurve((await api<{ curve: typeof curve }>('GET', `${T}/content/videos/${v.id}/retention`)).curve); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not load retention.'); } finally { setBusy(false); }
  }
  // where the most viewers leave, and how the start compares with similar videos on YouTube
  const drop = curve && curve.length > 2 ? curve.slice(1).map((p, i) => ({ at: p.at, lost: curve[i]!.watching - p.watching })).sort((a, b) => b.lost - a.lost)[0] : null;
  const early = curve?.filter(p => p.at <= 0.15 && p.relative !== null).map(p => p.relative!) ?? [];
  const rel = early.length ? early.reduce((a, b) => a + b, 0) / early.length : null;
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  return (
    <div className="row" style={{ gap: 8 }}>
      <div className="row-main">
        <span style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
          {v.score !== null && <span className={`tag ${v.score >= 0.8 ? 'ok' : v.score >= 0.5 ? 'warn' : 'leak'}`}>{v.checks.filter(c => c.pass).length}/{v.checks.length}</span>}
          {v.permalink ? <a href={v.permalink} target="_blank" rel="noreferrer"><b>{v.title}</b></a> : <b>{v.title}</b>}
        </span>
        <span className="toolbar"><span className="small muted">{v.views !== null ? `${compact(v.views)} views` : ''}{v.avgViewPct !== null ? ` · ${Math.round(v.avgViewPct)}% watched${usual ? ` (usual ${Math.round(usual)}%)` : ''}` : ''}</span>
          <button className="btn small" onClick={retention} disabled={busy}>{busy ? 'Loading…' : curve ? 'Hide retention' : 'Retention'}</button></span>
      </div>
      {failed.length > 0 ? (
        <>
          <span className="small">Fails: {failed.map(c => c.label.toLowerCase()).join('; ')}. <button className="btn small link" onClick={() => setShowFixes(!showFixes)}>{showFixes ? 'Hide fixes' : 'Show fixes'}</button></span>
          {showFixes && <ul className="small" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 3 }}>{failed.map(c => <li key={c.id}><b>{c.label}:</b> {c.fix}</li>)}</ul>}
        </>
      ) : <span className="small" style={{ color: 'var(--ok)' }}>Passes every check.</span>}
      {err && <span className="small" style={{ color: 'var(--warn)' }}>{err}</span>}
      {curve && (
        <div style={{ display: 'grid', gap: 6 }}>
          <LineChart x={curve.map(p => (v.durationS ? mmss(p.at * v.durationS) : pct(p.at)))} series={[{ key: 'w', label: 'still watching', color: 'var(--flow)', values: curve.map(p => p.watching) }]} format={pct} height={180} />
          <span className="small">{drop ? `The most viewers leave around ${v.durationS ? mmss(drop.at * v.durationS) : pct(drop.at)}. ` : ''}{rel !== null ? `In the first 15%, this video holds viewers ${rel >= 0.55 ? 'better than' : rel <= 0.45 ? 'worse than' : 'about as well as'} YouTube videos of similar length.` : ''}</span>
        </div>
      )}
    </div>
  );
}
