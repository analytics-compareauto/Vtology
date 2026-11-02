'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Dimension, Insight, ScoredPost, Segment } from '@vtology/core';
import type { WorkspaceData } from '../Dashboard';
import { api, ApiError } from '../api';
import { ago, inr, num, pct } from '../format';

interface Connection { id: string; provider: string; label: string; status: string; scopes: string[]; connected_at: string; last_sync_at: string | null; last_error: string | null }
interface Account { id: string; platform: string; name: string; handle: string | null; followers: number | null; posts_count: number | null; profile_url: string | null }
interface Campaign { code: string; name: string; channel: string; spend: number | null; platform_conversions: number; journeys: number; progressed: number; converted: number }
interface Overview {
  canConnect: boolean;
  providers: { meta: boolean; youtube: boolean; linkedin: boolean; secret: boolean };
  connections: Connection[]; accounts: Account[]; campaigns: Campaign[];
  analysis: { windowDays: number; posts: number; lowAudience?: number; byPlatform: { platform: string; posts: number; views: number; interactions: number; medianEngagement: number | null }[]; segments: Segment[]; insights: Insight[]; top: (ScoredPost & { postedAt: string })[]; bottom: (ScoredPost & { postedAt: string })[] };
}

const PLATFORM: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube', linkedin: 'LinkedIn' };
const PROVIDERS = [
  { id: 'meta', name: 'Instagram and Facebook', covers: 'Posts, reach, saves, shares, ad campaigns and lead-form leads' },
  { id: 'youtube', name: 'YouTube', covers: 'Videos and shorts, views, watch time, how much of each video people watch' },
  { id: 'linkedin', name: 'LinkedIn', covers: 'Company page posts and followers' },
];
const DIMS: { id: Dimension; label: string }[] = [
  { id: 'theme', label: 'Theme' }, { id: 'format', label: 'Format' }, { id: 'time', label: 'Time of day' }, { id: 'day', label: 'Day' }, { id: 'language', label: 'Language' }, { id: 'length', label: 'Caption length' },
];

export function Social({ data, workspaceId, notify }: { data: WorkspaceData; workspaceId: string; notify: (m: string) => void }) {
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dim, setDim] = useState<Dimension>('theme');
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

  const segs = useMemo(() => (o?.analysis.segments ?? []).filter(s => s.dimension === dim).sort((a, b) => b.lift - a.lift), [o, dim]);
  if (error) return <div className="error-box" role="alert">{error}</div>;
  if (!o) return <div className="progress" />;

  const a = o.analysis;
  const byKind = (k: Insight['kind']) => a.insights.filter(i => i.kind === k).slice(0, 5);
  const real = o.connections.filter(c => c.provider !== 'sample');
  const sample = o.connections.find(c => c.provider === 'sample');
  const maxLift = Math.max(2, ...segs.map(s => s.lift));
  const seesMoney = o.campaigns.some(c => c.spend !== null);
  const paid = o.campaigns.filter(c => /meta|google|youtube|search|programmatic/i.test(c.channel) || c.code.startsWith('meta:'));

  return (
    <>
      <section style={{ display: 'grid', gap: 12 }}>
        <div className="section-title">
          <h2>Connected accounts</h2>
          {real.length > 0 && <button className="btn" onClick={sync} disabled={busy === 'sync'}>{busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>}
        </div>
        {busy === 'sync' && <div><div className="progress" /><p className="muted small" style={{ marginTop: 6 }}>Fetching posts, insights, ad campaigns and leads from the connected accounts…</p></div>}
        {sample && <div className="note-box small">This sample workspace shows fictional accounts for {data.me.tenantName}. Connect real accounts in a workspace for your own brand.</div>}
        {!data.me.isDemo && <div className="rows">
          {PROVIDERS.map(p => {
            const c = real.find(x => x.provider === p.id);
            const ready = p.id === 'linkedin' ? false : o.providers[p.id as 'meta' | 'youtube'] && o.providers.secret;
            return (
              <div className="row" key={p.id}>
                <div className="row-main">
                  <span><b>{p.name}</b>{c && <span className={`tag ${c.status === 'active' ? 'ok' : 'leak'}`} style={{ marginLeft: 8 }}>{c.status === 'active' ? 'Connected' : c.status === 'expired' ? 'Needs reconnecting' : 'Problem'}</span>}</span>
                  <span className="toolbar">
                    {c && o.canConnect && <button className="btn small" onClick={() => disconnect(c)} disabled={busy === c.id}>Disconnect</button>}
                    {o.canConnect && p.id !== 'linkedin' && <button className={`btn small${c ? '' : ' primary'}`} onClick={() => connect(p.id)} disabled={!ready || busy === p.id}>{c ? 'Reconnect' : 'Connect'}</button>}
                  </span>
                </div>
                <span className="muted small">
                  {c ? `${c.label}. Last synced ${c.last_sync_at ? ago(c.last_sync_at) : 'never'}.` : p.covers + '.'}
                  {p.id === 'linkedin' && ' Available once LinkedIn approves Vtology’s access request.'}
                  {p.id !== 'linkedin' && !ready && o.canConnect && ' Not set up on this server yet.'}
                </span>
                {c?.last_error && <span className="small" style={{ color: 'var(--warn)' }}>{c.last_error}</span>}
              </div>
            );
          })}
        </div>}
        {!data.me.isDemo && !o.canConnect && <p className="muted small">Marketing heads and data stewards can connect accounts.</p>}
      </section>

      {a.posts === 0 ? (
        <div className="empty">No posts yet. Connect an account to see what’s working.</div>
      ) : (
        <>
          <section className="figures" aria-label="Social footprint">
            {o.accounts.slice(0, 3).map(acc => (
              <div className="figure" key={acc.id}><b>{acc.followers !== null ? num(acc.followers) : '—'}</b><span>{PLATFORM[acc.platform]} followers{acc.handle ? `, ${acc.handle.startsWith('@') ? acc.handle : '@' + acc.handle}` : ''}</span></div>
            ))}
            <div className="figure"><b>{num(a.posts)}</b><span>posts in the last {Math.round(a.windowDays / 30)} months</span></div>
          </section>

          <section className="split3">
            <InsightList title="What’s working" items={byKind('working')} tone="ok" />
            <InsightList title="What’s not" items={byKind('not_working')} tone="leak" />
            <InsightList title="Try next" items={byKind('try')} tone="flow" />
          </section>

          <section style={{ display: 'grid', gap: 12 }}>
            <div className="section-title">
              <h2>Compared with your usual post</h2>
              <div className="seg" role="group" aria-label="Group by">
                {DIMS.map(d => <button key={d.id} aria-pressed={dim === d.id} onClick={() => setDim(d.id)}>{d.label}</button>)}
              </div>
            </div>
            <p className="muted small" style={{ maxWidth: '72ch' }}>1× is each account’s typical engagement. Groups with fewer than 3 posts are left out; groups under 8 posts are early signals.{a.lowAudience ? ` ${num(a.lowAudience)} posts reached fewer than 50 people (or have no reach figure and a following under 50), so they are not compared: a few likes on a handful of views would look like a huge win.` : ''}</p>
            {segs.length === 0 ? <div className="empty">Not enough posts in any group yet.</div> : (
              <div className="lift-list">
                {segs.map(sg => (
                  <div className="lift-row" key={sg.key}>
                    <span className="lift-name">{sg.label}<span className="muted small"> {sg.posts} posts</span></span>
                    <div className="lift-track" aria-hidden="true">
                      <span className="lift-one" style={{ left: `${(1 / maxLift) * 100}%` }} />
                      <i className={sg.lift >= 1.3 ? 'up' : sg.lift <= 0.75 ? 'down' : ''} style={{ width: `${Math.min(100, (sg.lift / maxLift) * 100)}%` }} />
                    </div>
                    <b className="lift-val">{sg.lift.toFixed(1)}×</b>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="split">
            <PostList title="Best posts" posts={a.top} />
            <PostList title="Weakest posts" posts={a.bottom} />
          </div>
        </>
      )}

      {paid.length > 0 && (
        <section style={{ display: 'grid', gap: 10 }}>
          <div className="section-title"><h2>Paid campaigns, followed through to the pipeline</h2></div>
          <p className="muted small" style={{ maxWidth: '72ch' }}>Leads the platform reports, set against what actually arrived and moved forward. Progress after the first stage appears once the dealer’s or branch’s follow-up data is imported on the Data tab.</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Campaign</th><th>Channel</th>{seesMoney && <th className="num">Spend</th>}<th className="num">Leads reported</th><th className="num">Journeys</th><th className="num">Moved forward</th><th className="num">Converted</th>{seesMoney && <th className="num">Cost per converted</th>}</tr></thead>
              <tbody>
                {paid.map(c => (
                  <tr key={c.code}>
                    <td><b>{c.name}</b></td><td className="small">{c.channel}</td>
                    {seesMoney && <td className="num">{inr(c.spend)}</td>}
                    <td className="num">{num(c.platform_conversions)}</td>
                    <td className="num">{c.journeys === 0 && (c.spend ?? 1) > 0 ? <span className="tag leak">0</span> : num(c.journeys)}</td>
                    <td className="num">{num(c.progressed)}{c.journeys ? <span className="muted small"> ({pct(c.progressed / c.journeys)})</span> : null}</td>
                    <td className="num">{num(c.converted)}</td>
                    {seesMoney && <td className="num">{c.converted && c.spend ? inr(c.spend / c.converted) : '—'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

function InsightList({ title, items, tone }: { title: string; items: Insight[]; tone: 'ok' | 'leak' | 'flow' }) {
  return (
    <div className={`insights ${tone}`}>
      <h2>{title}</h2>
      {items.length === 0 ? <p className="muted small">Nothing clear yet.</p> : (
        <ul>{items.map(i => <li key={i.title}><b>{i.title}</b><span className="muted small">{i.detail}</span></li>)}</ul>
      )}
    </div>
  );
}

function PostList({ title, posts }: { title: string; posts: (ScoredPost & { postedAt: string | Date })[] }) {
  return (
    <section>
      <div className="section-title"><h2>{title}</h2></div>
      <div className="rows">
        {posts.map(p => (
          <div className="row" key={p.id}>
            <div className="row-main">
              <span style={{ minWidth: 0 }}>{p.permalink ? <a href={p.permalink} target="_blank" rel="noreferrer">{(p.caption ?? '(no caption)').split('\n')[0]!.slice(0, 90)}</a> : (p.caption ?? '(no caption)').split('\n')[0]!.slice(0, 90)}</span>
              <b className="nowrap">{p.lift !== null ? `${p.lift.toFixed(1)}×` : '—'}</b>
            </div>
            <span className="muted small">{PLATFORM[p.platform]} {p.format}, {new Date(p.postedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}. {p.views != null ? `${num(p.views)} views, ` : p.reach != null ? `${num(p.reach)} reached, ` : 'Reach not available, '}{num(p.interactions)} interactions.</span>
          </div>
        ))}
      </div>
    </section>
  );
}
