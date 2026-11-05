/**
 * Content intelligence for brands: outliers (brand and competitors), category patterns, YouTube topic
 * demand, video checks and retention curves. Built on the posts the social sync already stores, plus
 * YouTube search and analytics through the brand's own connected account.
 */
import { DEFAULT_TOPICS, findOutliers, outlierPatterns, scoreTopic, videoChecks, type ContentAccount, type SocialPost, type TopicResult, type TopicVideo } from '@vtology/core';
import { HttpError, requireRole, type Ctx, type Deps } from './context';
import { refreshSampleSocial } from './demo';
import { youtubeToken } from './social';

const VIEWERS: Ctx['role'][] = ['marketing_head', 'sales_ops', 'data_steward', 'finance'];
const EDITORS: Ctx['role'][] = ['marketing_head', 'data_steward'];
const Y = 'https://www.googleapis.com/youtube/v3';
const MAX_TOPICS = 30;
/** a topic is scanned again after a week (YouTube's daily search quota is shared by every workspace) */
const RESCAN_DAYS = 7;

async function getJson<T>(deps: Deps, url: string, token?: string): Promise<T> {
  const r = await (deps.fetch ?? fetch)(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15_000) });
  const body = await r.json().catch(() => ({})) as { error?: { message?: string; errors?: { reason?: string }[] } };
  if (!r.ok) {
    const reason = body.error?.errors?.[0]?.reason;
    throw new HttpError(r.status === 403 && /quota/i.test(reason ?? '') ? 429 : 502, reason && /quota/i.test(reason) ? 'YouTube’s daily search allowance is used up; topics will be scanned again tomorrow.' : `YouTube said: ${body.error?.message ?? r.status}`);
  }
  return body as T;
}

export async function contentOverview(deps: Deps, ctx: Ctx, range: { from: string; to: string }) {
  requireRole(ctx, VIEWERS, 'Content insights');
  await refreshSampleSocial(ctx);
  const sql = ctx.db.admin;
  const accountsRaw = await sql.query<{ id: string; platform: SocialPost['platform']; name: string; handle: string | null; followers: number | null; is_competitor: boolean; external_id: string; profile_url: string | null }>(
    `select id, platform, name, handle, followers, is_competitor, external_id, profile_url from vt.social_accounts where tenant_id = $1`, [ctx.tenantId]);
  const postsRaw = await sql.query<{ id: string; account_id: string; posted_at: string; format: string; caption: string | null; permalink: string | null; thumbnail_url: string | null; views: string | null; likes: string | null; comments: string | null; shares: string | null; avg_view_pct: string | null; duration_s: number | null; retention_at: string | null }>(
    `select id, account_id, posted_at, format, caption, permalink, thumbnail_url, views, likes, comments, shares, avg_view_pct, duration_s, retention_at from vt.social_posts
      where tenant_id = $1 and posted_at >= least($2::date, now() - interval '180 days') order by posted_at desc limit 12000`, [ctx.tenantId, range.from]);
  const num = (x: string | null) => (x === null ? null : Number(x));
  const plat = new Map(accountsRaw.map(a => [a.id, a.platform]));
  const posts: SocialPost[] = postsRaw.map(p => ({ id: p.id, accountId: p.account_id, platform: plat.get(p.account_id)!, postedAt: new Date(p.posted_at), format: p.format, caption: p.caption, permalink: p.permalink, thumbnailUrl: p.thumbnail_url,
    views: num(p.views), likes: num(p.likes), comments: num(p.comments), shares: num(p.shares), avgViewPct: num(p.avg_view_pct) }));
  const accounts: ContentAccount[] = accountsRaw.map(a => ({ id: a.id, platform: a.platform, name: a.name, handle: a.handle, followers: a.followers, isCompetitor: a.is_competitor }));
  const win = { from: new Date(`${range.from}T00:00:00+05:30`), to: new Date(`${range.to}T23:59:59+05:30`) };
  const outliers = findOutliers(posts, accounts, ctx.industry, ctx.now, win);
  const patterns = outlierPatterns(posts, outliers, ctx.industry, win);

  // topics
  const topics = await sql.query<{ id: string; phrase: string; last_scan_at: string | null; result: TopicResult | null; last_error: string | null }>(
    `select id, phrase, last_scan_at, result, last_error from vt.content_topics where tenant_id = $1 order by added_at`, [ctx.tenantId]);

  // the brand's own YouTube videos, checked
  const own = new Set(accountsRaw.filter(a => !a.is_competitor && a.platform === 'youtube').map(a => a.id));
  const ownVideos = postsRaw.filter(p => own.has(p.account_id));
  const pcts = ownVideos.map(v => num(v.avg_view_pct)).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const usualViewPct = pcts.length >= 5 ? pcts[Math.floor(pcts.length / 2)]! : null;
  // the brand's site: the domain its own descriptions link to most (social sites aside)
  const domains = new Map<string, number>();
  for (const v of ownVideos) for (const l of v.caption?.match(/https?:\/\/([^/\s?#]+)/g) ?? []) {
    const d = l.replace(/^https?:\/\/(www\.)?/, '').toLowerCase();
    if (!/youtube|youtu\.be|instagram|facebook|twitter|x\.com|wa\.me|whatsapp|linkedin|bit\.ly/.test(d)) domains.set(d, (domains.get(d) ?? 0) + 1);
  }
  const brandDomains = [...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1).map(([d]) => d);
  const phrases = topics.map(t => t.phrase);
  const videos = ownVideos.filter(v => new Date(v.posted_at) >= win.from && new Date(v.posted_at) <= win.to).slice(0, 40).map(v => {
    const [title, ...rest] = (v.caption ?? '').split('\n');
    const checks = videoChecks({ title: title ?? '', description: rest.join('\n'), durationS: v.duration_s, avgViewPct: num(v.avg_view_pct), format: v.format, views: num(v.views) }, { topics: phrases, usualViewPct, brandDomains });
    return { id: v.id, title, postedAt: v.posted_at, permalink: v.permalink, thumbnailUrl: v.thumbnail_url, format: v.format, views: num(v.views), avgViewPct: num(v.avg_view_pct), durationS: v.duration_s, hasRetention: !!v.retention_at, checks, score: checks.length ? checks.filter(c => c.pass).length / checks.length : null };
  });
  const conn = await sql.query<{ scopes: string[] }>(`select scopes from vt.social_connections where tenant_id = $1 and provider = 'youtube'`, [ctx.tenantId]);
  return {
    canEdit: EDITORS.includes(ctx.role), isDemo: ctx.isDemo, youtubeConnected: conn.length > 0 || ctx.isDemo,
    accounts: accountsRaw.map(a => ({ id: a.id, platform: a.platform, name: a.name, handle: a.handle, followers: a.followers, isCompetitor: a.is_competitor, profileUrl: a.profile_url })),
    outliers: outliers.slice(0, 60).map(o => ({ id: o.post.id, accountId: o.account.id, platform: o.post.platform, format: o.post.format, title: (o.post.caption ?? '').split('\n')[0]!.slice(0, 160), postedAt: o.post.postedAt.toISOString(), permalink: o.post.permalink, thumbnailUrl: o.post.thumbnailUrl,
      score: o.score, value: o.value, metric: o.metric, usual: o.usual, ageDays: o.ageDays, themes: o.themes })),
    patterns, topics, suggestedTopics: topics.length ? [] : DEFAULT_TOPICS[ctx.industry], brandDomain: brandDomains[0] ?? null, usualViewPct, videos,
  };
}

export async function addTopics(ctx: Ctx, body: { phrases?: unknown }) {
  requireRole(ctx, EDITORS, 'Tracking topics');
  const list = (Array.isArray(body.phrases) ? body.phrases : [body.phrases]).filter((p): p is string => typeof p === 'string').map(p => p.trim().replace(/\s+/g, ' ').slice(0, 80)).filter(p => p.length >= 3);
  if (!list.length) throw new HttpError(400, 'Type a search phrase, for example "best suv under 15 lakh".');
  const [{ n }] = await ctx.db.admin.query<{ n: number }>(`select count(*)::int as n from vt.content_topics where tenant_id = $1`, [ctx.tenantId]) as [{ n: number }];
  if (n + list.length > MAX_TOPICS) throw new HttpError(400, `Track up to ${MAX_TOPICS} topics; remove some first.`);
  for (const p of list) await ctx.db.admin.query(`insert into vt.content_topics (tenant_id, phrase, added_by) values ($1,$2,$3) on conflict do nothing`, [ctx.tenantId, p, ctx.userId]);
  return { added: list.length };
}

export async function removeTopic(ctx: Ctx, id: string) {
  requireRole(ctx, EDITORS, 'Tracking topics');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'Topic not found.');
  await ctx.db.admin.query(`delete from vt.content_topics where id = $1 and tenant_id = $2`, [id, ctx.tenantId]);
  return { removed: true };
}

/** YouTube's own search suggestions for a phrase (what people type next). */
export async function suggestTopics(deps: Deps, ctx: Ctx, seed: string) {
  requireRole(ctx, VIEWERS, 'Content insights');
  const q = seed.trim().slice(0, 80);
  if (q.length < 2) return { suggestions: [] };
  try {
    const r = await (deps.fetch ?? fetch)(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=en&gl=IN&q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(6000) });
    const j = await r.json() as [string, string[]];
    return { suggestions: (j[1] ?? []).filter(s => s.toLowerCase() !== q.toLowerCase()).slice(0, 10) };
  } catch { return { suggestions: [], note: 'YouTube suggestions are unavailable right now.' }; }
}

/** Search YouTube for each topic due for a scan (or the ones asked for) and score what comes back. */
export async function scanTopics(deps: Deps, ctx: Ctx, body: { ids?: unknown; force?: unknown }) {
  requireRole(ctx, EDITORS, 'Scanning topics');
  const sql = ctx.db.admin;
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)) : null;
  const due = await sql.query<{ id: string; phrase: string }>(
    `select id, phrase from vt.content_topics where tenant_id = $1 ${ids ? 'and id = any($2::uuid[])' : `and (last_scan_at is null or last_scan_at < now() - interval '${RESCAN_DAYS} days')`} order by last_scan_at nulls first limit 10`,
    ids ? [ctx.tenantId, ids] : [ctx.tenantId]);
  if (!due.length) return { scanned: 0 };
  const accounts = await sql.query<{ external_id: string; name: string; followers: number | null; is_competitor: boolean }>(`select external_id, name, followers, is_competitor from vt.social_accounts where tenant_id = $1 and platform = 'youtube'`, [ctx.tenantId]);
  const own = { channelIds: accounts.filter(a => !a.is_competitor).map(a => a.external_id), subscribers: accounts.find(a => !a.is_competitor)?.followers ?? null };
  const competitors = accounts.filter(a => a.is_competitor).map(a => ({ channelId: a.external_id, name: a.name }));
  if (ctx.isDemo) {
    for (const t of due) await sql.query(`update vt.content_topics set result = $3, last_scan_at = now(), last_error = null where id = $1 and tenant_id = $2`, [t.id, ctx.tenantId, JSON.stringify(sampleScan(t.phrase, ctx.now, own, competitors))]);
    return { scanned: due.length, sample: true };
  }
  const yt = await youtubeToken(deps, ctx.tenantId);
  if (!yt) throw new HttpError(400, 'Connect the brand’s YouTube channel first (Social → Connect YouTube): topics are searched through it.');
  let scanned = 0;
  for (const t of due) {
    try {
      const s = await getJson<{ items?: { id: { videoId?: string } }[] }>(deps, `${Y}/search?part=id&type=video&maxResults=20&order=relevance&regionCode=IN&relevanceLanguage=en&q=${encodeURIComponent(t.phrase)}`, yt.token);
      const vids = (s.items ?? []).map(i => i.id.videoId).filter((x): x is string => !!x);
      const v = vids.length ? await getJson<{ items: { id: string; snippet: { title: string; channelId: string; channelTitle: string; publishedAt: string }; statistics?: { viewCount?: string } }[] }>(deps, `${Y}/videos?part=snippet,statistics&id=${vids.join(',')}`, yt.token) : { items: [] };
      const chIds = [...new Set(v.items.map(x => x.snippet.channelId))];
      const ch = chIds.length ? await getJson<{ items: { id: string; statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean } }[] }>(deps, `${Y}/channels?part=statistics&id=${chIds.join(',')}`, yt.token) : { items: [] };
      const subs = new Map(ch.items.map(c => [c.id, c.statistics?.hiddenSubscriberCount ? null : Number(c.statistics?.subscriberCount ?? 0)]));
      const byId = new Map(v.items.map(x => [x.id, x]));
      const videos: TopicVideo[] = vids.map(id => byId.get(id)).filter((x): x is NonNullable<typeof x> => !!x).map(x => ({ id: x.id, title: x.snippet.title, channelId: x.snippet.channelId, channel: x.snippet.channelTitle, publishedAt: x.snippet.publishedAt, views: Number(x.statistics?.viewCount ?? 0), channelSubscribers: subs.get(x.snippet.channelId) ?? null }));
      await sql.query(`update vt.content_topics set result = $3, last_scan_at = now(), last_error = null where id = $1 and tenant_id = $2`, [t.id, ctx.tenantId, JSON.stringify(scoreTopic(videos, ctx.now, own, competitors))]);
      scanned++;
    } catch (e) {
      await sql.query(`update vt.content_topics set last_error = $3 where id = $1 and tenant_id = $2`, [t.id, ctx.tenantId, (e as Error).message.slice(0, 300)]);
      if (e instanceof HttpError && e.status === 429) break;
    }
  }
  return { scanned };
}

/** Where viewers leave one of the brand's own videos, from YouTube Analytics (kept for a day). */
export async function videoRetention(deps: Deps, ctx: Ctx, postId: string) {
  requireRole(ctx, VIEWERS, 'Content insights');
  if (!/^[0-9a-f-]{36}$/i.test(postId)) throw new HttpError(404, 'Video not found.');
  const [p] = await ctx.db.admin.query<{ external_id: string; posted_at: string; retention: { at: number; watching: number; relative: number | null }[] | null; retention_at: string | null; platform: string; is_competitor: boolean }>(
    `select p.external_id, p.posted_at, p.retention, p.retention_at, a.platform, a.is_competitor from vt.social_posts p join vt.social_accounts a on a.id = p.account_id where p.id = $1 and p.tenant_id = $2`, [postId, ctx.tenantId]);
  if (!p || p.platform !== 'youtube' || p.is_competitor) throw new HttpError(404, 'Retention is available for your own YouTube videos.');
  if (p.retention && p.retention_at && Date.now() - Date.parse(p.retention_at) < 86_400_000) return { curve: p.retention };
  let curve: { at: number; watching: number; relative: number | null }[];
  if (ctx.isDemo) curve = Array.from({ length: 21 }, (_, i) => ({ at: i / 20, watching: Math.max(0.08, (i === 0 ? 1 : 0.78) * Math.exp(-1.6 * (i / 20))), relative: 0.5 + (i < 4 ? -0.12 : 0.04) }));
  else {
    const yt = await youtubeToken(deps, ctx.tenantId);
    if (!yt) throw new HttpError(400, 'Connect the brand’s YouTube channel first.');
    const q = new URLSearchParams({ ids: 'channel==MINE', startDate: p.posted_at.slice(0, 10), endDate: ctx.now.toISOString().slice(0, 10), dimensions: 'elapsedVideoTimeRatio', metrics: 'audienceWatchRatio,relativeRetentionPerformance', filters: `video==${p.external_id}` });
    const r = await getJson<{ rows?: [number, number, number][] }>(deps, `https://youtubeanalytics.googleapis.com/v2/reports?${q}`, yt.token);
    curve = (r.rows ?? []).map(([at, watching, relative]) => ({ at, watching, relative: relative ?? null }));
    if (!curve.length) throw new HttpError(404, 'YouTube has no retention data for this video yet (it needs some views first).');
  }
  await ctx.db.admin.query(`update vt.social_posts set retention = $3, retention_at = now() where id = $1 and tenant_id = $2`, [postId, ctx.tenantId, JSON.stringify(curve)]);
  return { curve };
}

/** Made-up search results for sample workspaces, so the screen can be seen working. */
function sampleScan(phrase: string, now: Date, own: { channelIds: string[]; subscribers: number | null }, competitors: { channelId: string; name: string }[]) {
  let h = 0; for (const c of phrase) h = (h * 31 + c.charCodeAt(0)) % 100_000;
  const rnd = () => { h = (h * 16807) % 2147483647; return h / 2147483647; };
  const chans = [...competitors.map(c => ({ id: c.channelId, name: c.name, subs: 400_000 + Math.round(rnd() * 900_000) })), { id: 'UC-sample-a', name: 'Auto Review Hub', subs: 2_100_000 }, { id: 'UC-sample-b', name: 'Drive Talk', subs: 85_000 }, { id: 'UC-sample-c', name: 'Gaadi Guide', subs: 640_000 }];
  if (own.channelIds[0] && rnd() > 0.6) chans.push({ id: own.channelIds[0], name: 'You', subs: own.subscribers ?? 50_000 });
  const videos: TopicVideo[] = Array.from({ length: 20 }, (_, i) => {
    const c = chans[Math.floor(rnd() * chans.length)]!;
    const ageDays = 20 + Math.round(rnd() * 900);
    return { id: `sample-${i}`, title: `${phrase.replace(/\b\w/g, m => m.toUpperCase())} ${['explained', 'tested', 'compared', 'all you need to know', 'review'][i % 5]}`, channelId: c.id, channel: c.name, publishedAt: new Date(now.getTime() - ageDays * 86_400_000).toISOString(), views: Math.round(5000 + rnd() * 900_000 * (i < 5 ? 2 : 1)), channelSubscribers: c.subs };
  });
  return scoreTopic(videos, now, own, competitors);
}
