/**
 * Social connections. Each platform is reached directly through its official API after the brand
 * approves access on the platform's own consent screen (OAuth). No aggregator sits in between.
 *
 *  connect   -> we return the platform's consent URL with a signed, 15-minute "state"
 *  callback  -> the platform sends the brand back with a code; we swap it for access keys,
 *               encrypt them, and run a first sync
 *  sync      -> pull accounts, recent posts and their metrics (and Meta ad campaigns), daily and on demand
 *
 * Only brand-level data is stored: the brand's own accounts, posts and aggregate metrics. Comments
 * are counted, never stored, and nothing about individual followers is collected.
 */
import { analyzeSocial, hashValue, normalizeEmail, normalizePhone, type Industry, type SocialAccount, type SocialPost } from '@vtology/core';
import { loadContext } from './context';
import { runPipeline } from './pipeline';
import { HttpError, requireRole, type Ctx, type Deps } from './context';
import { decrypt, encrypt, requireSecret, signState, verifyState } from './secrets';
import type { Sql } from './db';

export type ProviderId = 'meta' | 'youtube';
export interface SocialConfig {
  publicUrl: string;
  meta?: { appId: string; appSecret: string; version?: string; configId?: string };
  google?: { clientId: string; clientSecret: string };
}

interface Tokens { accessToken: string; refreshToken?: string | null; expiresAt?: Date | null; extra?: Record<string, string> | null }
interface AccountSnap { platform: SocialPost['platform']; externalId: string; handle?: string | null; name: string; followers?: number | null; postsCount?: number | null; profileUrl?: string | null }
interface PostSnap { platform: SocialPost['platform']; accountExternalId: string; externalId: string; postedAt: string; format: string; caption?: string | null; permalink?: string | null; durationS?: number | null;
  views?: number | null; reach?: number | null; likes?: number | null; comments?: number | null; shares?: number | null; saves?: number | null; watchMinutes?: number | null; avgViewPct?: number | null }
interface CampaignSnap { externalCode: string; name: string; channel: string; startDate?: string | null; endDate?: string | null; spendInr: number; conversions: number }
interface LeadSnap { externalId: string; createdAt: string; name: string | null; phone: string | null; email: string | null; city: string | null; pincode: string | null; campaignId: string | null; campaignName: string | null; formName: string; pageName: string }
interface SyncResult { accounts: AccountSnap[]; posts: PostSnap[]; campaigns: CampaignSnap[]; leads?: LeadSnap[]; warnings: string[]; tokens?: Tokens }

const redirect = (cfg: SocialConfig, p: ProviderId) => `${cfg.publicUrl.replace(/\/$/, '')}/api/social/callback/${p}`;

class PlatformError extends Error { constructor(public status: number, message: string, public expired = false) { super(message); } }

async function getJson<T>(f: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const res = await f(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number; type?: string } | string; error_description?: string };
  if (!res.ok) {
    const e = body.error;
    const msg = typeof e === 'string' ? `${e}${body.error_description ? `: ${body.error_description}` : ''}` : e?.message ?? `HTTP ${res.status}`;
    const expired = res.status === 401 || (typeof e === 'object' && e?.code === 190) || /invalid_grant|expired/i.test(msg);
    throw new PlatformError(res.status, msg, expired);
  }
  return body;
}

// ===================================================================== Meta (Instagram + Facebook)
const META_SCOPES = ['pages_show_list', 'pages_read_engagement', 'read_insights', 'instagram_basic', 'instagram_manage_insights', 'business_management', 'ads_read', 'leads_retrieval', 'pages_manage_ads'];

const meta = {
  graph: (cfg: SocialConfig) => `https://graph.facebook.com/${cfg.meta?.version ?? 'v23.0'}`,
  authUrl(cfg: SocialConfig, state: string) {
    const m = cfg.meta!;
    const q = new URLSearchParams({ client_id: m.appId, redirect_uri: redirect(cfg, 'meta'), state, response_type: 'code' });
    if (m.configId) q.set('config_id', m.configId); else q.set('scope', META_SCOPES.join(','));
    return `https://www.facebook.com/${m.version ?? 'v23.0'}/dialog/oauth?${q}`;
  },
  async exchange(cfg: SocialConfig, f: typeof fetch, code: string) {
    const m = cfg.meta!, G = meta.graph(cfg);
    const short = await getJson<{ access_token: string }>(f, `${G}/oauth/access_token?${new URLSearchParams({ client_id: m.appId, client_secret: m.appSecret, redirect_uri: redirect(cfg, 'meta'), code })}`);
    const long = await getJson<{ access_token: string; expires_in?: number }>(f, `${G}/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: m.appId, client_secret: m.appSecret, fb_exchange_token: short.access_token })}`);
    const me = await getJson<{ name?: string }>(f, `${G}/me?fields=name&access_token=${encodeURIComponent(long.access_token)}`);
    const perms = await getJson<{ data: { permission: string; status: string }[] }>(f, `${G}/me/permissions?access_token=${encodeURIComponent(long.access_token)}`).catch(() => ({ data: [] }));
    return {
      label: me.name ? `Facebook: ${me.name}` : 'Facebook account', scopes: perms.data.filter(p => p.status === 'granted').map(p => p.permission),
      tokens: { accessToken: long.access_token, expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null } as Tokens,
    };
  },
  async sync(cfg: SocialConfig, f: typeof fetch, t: Tokens, since: Date): Promise<SyncResult> {
    const G = meta.graph(cfg), warnings: string[] = [];
    const accounts: AccountSnap[] = [], posts: PostSnap[] = [], campaigns: CampaignSnap[] = [];
    const sinceUnix = Math.floor(since.getTime() / 1000);
    const pages = await getJson<{ data: { id: string; name: string; username?: string; link?: string; followers_count?: number; fan_count?: number; access_token: string;
      instagram_business_account?: { id: string; username?: string; name?: string; followers_count?: number; media_count?: number } }[] }>(f,
      `${G}/me/accounts?fields=id,name,username,link,followers_count,fan_count,access_token,instagram_business_account{id,username,name,followers_count,media_count}&limit=100&access_token=${encodeURIComponent(t.accessToken)}`);
    if (!pages.data.length) warnings.push('No Facebook Pages were shared during approval. Reconnect and tick the brand’s Page (and its Instagram account).');

    for (const pg of pages.data) {
      const tok = encodeURIComponent(pg.access_token);
      accounts.push({ platform: 'facebook', externalId: pg.id, handle: pg.username ?? null, name: pg.name, followers: pg.followers_count ?? pg.fan_count ?? null, profileUrl: pg.link ?? `https://facebook.com/${pg.id}` });
      try {
        let url: string | null = `${G}/${pg.id}/posts?fields=id,message,created_time,permalink_url,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),attachments{media_type}&since=${sinceUnix}&limit=100&access_token=${tok}`;
        for (let page = 0; url && page < 5; page++) {
          const r: { data: { id: string; message?: string; created_time: string; permalink_url?: string; shares?: { count: number }; reactions?: { summary?: { total_count: number } }; comments?: { summary?: { total_count: number } }; attachments?: { data: { media_type?: string }[] } }[]; paging?: { next?: string } } = await getJson(f, url);
          for (const p of r.data) {
            const mt = p.attachments?.data?.[0]?.media_type ?? '';
            posts.push({ platform: 'facebook', accountExternalId: pg.id, externalId: p.id, postedAt: p.created_time, caption: p.message ?? null, permalink: p.permalink_url ?? null,
              format: mt === 'video' ? 'video' : mt === 'album' ? 'carousel' : mt === 'photo' ? 'image' : mt === 'link' || mt === 'share' ? 'link' : 'text',
              likes: p.reactions?.summary?.total_count ?? null, comments: p.comments?.summary?.total_count ?? null, shares: p.shares?.count ?? 0 });
          }
          url = r.paging?.next ?? null;
        }
      } catch (e) { warnings.push(`Facebook posts for ${pg.name}: ${(e as Error).message}`); }

      const ig = pg.instagram_business_account;
      if (!ig) continue;
      accounts.push({ platform: 'instagram', externalId: ig.id, handle: ig.username ?? null, name: ig.name ?? ig.username ?? pg.name, followers: ig.followers_count ?? null, postsCount: ig.media_count ?? null, profileUrl: ig.username ? `https://instagram.com/${ig.username}` : null });
      try {
        let url: string | null = `${G}/${ig.id}/media?fields=id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count&limit=100&access_token=${tok}`;
        let done = false;
        for (let page = 0; url && !done && page < 5; page++) {
          const r: { data: { id: string; caption?: string; media_type?: string; media_product_type?: string; permalink?: string; timestamp: string; like_count?: number; comments_count?: number }[]; paging?: { next?: string } } = await getJson(f, url);
          for (const m of r.data) {
            if (new Date(m.timestamp) < since) { done = true; break; }
            const snap: PostSnap = { platform: 'instagram', accountExternalId: ig.id, externalId: m.id, postedAt: m.timestamp, caption: m.caption ?? null, permalink: m.permalink ?? null,
              format: m.media_product_type === 'REELS' ? 'reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : m.media_type === 'VIDEO' ? 'video' : 'image',
              likes: m.like_count ?? null, comments: m.comments_count ?? null };
            // per-post insights; the available metrics differ by post type and change over time, so fall back gracefully
            for (const metrics of ['reach,saved,shares,views', 'reach,saved,shares', 'reach']) {
              try {
                const ins = await getJson<{ data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(f, `${G}/${m.id}/insights?metric=${metrics}&access_token=${tok}`);
                for (const d of ins.data) {
                  const v = d.values?.[0]?.value ?? d.total_value?.value ?? null;
                  if (d.name === 'reach') snap.reach = v; else if (d.name === 'saved') snap.saves = v; else if (d.name === 'shares') snap.shares = v; else if (d.name === 'views') snap.views = v;
                }
                break;
              } catch { /* try a smaller metric set */ }
            }
            posts.push(snap);
          }
          url = r.paging?.next ?? null;
        }
      } catch (e) { warnings.push(`Instagram posts for @${ig.username ?? ig.id}: ${(e as Error).message}`); }
    }

    // lead ads: each submitted form becomes a customer record and an inquiry journey tagged to its campaign
    const leads: LeadSnap[] = [];
    for (const pg of pages.data) {
      const tok = encodeURIComponent(pg.access_token);
      try {
        const forms = await getJson<{ data: { id: string; name?: string }[] }>(f, `${G}/${pg.id}/leadgen_forms?fields=id,name,status&limit=100&access_token=${tok}`);
        for (const form of forms.data) {
          const filter = encodeURIComponent(JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: sinceUnix }]));
          let url: string | null = `${G}/${form.id}/leads?fields=id,created_time,field_data,campaign_id,campaign_name,ad_id&limit=500&filtering=${filter}&access_token=${tok}`;
          for (let page = 0; url && page < 20; page++) {
            const r: { data: { id: string; created_time: string; campaign_id?: string; campaign_name?: string; field_data?: { name: string; values?: string[] }[] }[]; paging?: { next?: string } } = await getJson(f, url);
            for (const l of r.data) {
              const fd = new Map((l.field_data ?? []).map(x => [x.name.toLowerCase(), x.values?.[0] ?? null]));
              const pick = (...keys: string[]) => keys.map(k => fd.get(k)).find(v => v) ?? null;
              const first = pick('first_name'), last = pick('last_name');
              leads.push({ externalId: l.id, createdAt: l.created_time, name: pick('full_name', 'name') ?? ([first, last].filter(Boolean).join(' ') || null),
                phone: pick('phone_number', 'phone', 'mobile', 'mobile_number'), email: pick('email', 'work_email'), city: pick('city'), pincode: pick('zip_code', 'post_code', 'postal_code', 'pincode', 'zip'),
                campaignId: l.campaign_id ?? null, campaignName: l.campaign_name ?? null, formName: form.name ?? form.id, pageName: pg.name });
            }
            url = r.paging?.next ?? null;
          }
        }
      } catch (e) { warnings.push(`Lead forms for ${pg.name}: ${(e as Error).message}. If you use lead ads, allow Vtology under Business settings → Integrations → Leads access.`); }
    }

    // paid: Meta ad campaigns become Vtology campaigns, so the existing journey and leakage checks cover them
    try {
      const ads = await getJson<{ data: { id: string; name: string; currency?: string }[] }>(f, `${G}/me/adaccounts?fields=id,name,currency&limit=50&access_token=${encodeURIComponent(t.accessToken)}`);
      for (const a of ads.data) {
        const ins = await getJson<{ data: { campaign_id: string; campaign_name: string; spend?: string; date_start?: string; date_stop?: string; actions?: { action_type: string; value: string }[] }[] }>(f,
          `${G}/${a.id}/insights?level=campaign&fields=campaign_id,campaign_name,spend,actions,date_start,date_stop&date_preset=last_90d&limit=200&access_token=${encodeURIComponent(t.accessToken)}`);
        if (a.currency && a.currency !== 'INR') warnings.push(`Ad account ${a.name} reports in ${a.currency}; spend is stored as reported.`);
        for (const c of ins.data) {
          const leads = (c.actions ?? []).filter(x => /lead/.test(x.action_type)).reduce((s, x) => s + Number(x.value || 0), 0);
          campaigns.push({ externalCode: `meta:${c.campaign_id}`, name: c.campaign_name, channel: 'Meta ads', startDate: c.date_start ?? null, endDate: c.date_stop ?? null, spendInr: Number(c.spend ?? 0), conversions: Math.round(leads) });
        }
      }
    } catch (e) { warnings.push(`Meta ads: ${(e as Error).message}`); }
    return { accounts, posts, campaigns, leads, warnings };
  },
};

// ===================================================================== YouTube
const YT_SCOPES = ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly'];
const isoSeconds = (d?: string) => { const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d ?? ''); return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : null; };

const youtube = {
  authUrl(cfg: SocialConfig, state: string) {
    const q = new URLSearchParams({ client_id: cfg.google!.clientId, redirect_uri: redirect(cfg, 'youtube'), response_type: 'code', scope: YT_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  },
  async token(cfg: SocialConfig, f: typeof fetch, body: Record<string, string>) {
    return getJson<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }>(f, 'https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.google!.clientId, client_secret: cfg.google!.clientSecret, ...body }).toString(),
    });
  },
  async exchange(cfg: SocialConfig, f: typeof fetch, code: string) {
    const t = await youtube.token(cfg, f, { code, grant_type: 'authorization_code', redirect_uri: redirect(cfg, 'youtube') });
    const ch = await getJson<{ items?: { snippet?: { title?: string } }[] }>(f, 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { authorization: `Bearer ${t.access_token}` } });
    return {
      label: ch.items?.[0]?.snippet?.title ? `YouTube: ${ch.items[0].snippet.title}` : 'YouTube account', scopes: (t.scope ?? '').split(' ').filter(Boolean),
      tokens: { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: new Date(Date.now() + (t.expires_in ?? 3600) * 1000) } as Tokens,
    };
  },
  async sync(cfg: SocialConfig, f: typeof fetch, t0: Tokens, since: Date, now: Date): Promise<SyncResult> {
    let t = t0, refreshed: Tokens | undefined;
    if (t.refreshToken && (!t.expiresAt || t.expiresAt.getTime() - 60_000 < Date.now())) {
      const r = await youtube.token(cfg, f, { refresh_token: t.refreshToken, grant_type: 'refresh_token' });
      t = refreshed = { accessToken: r.access_token, refreshToken: t.refreshToken, expiresAt: new Date(Date.now() + (r.expires_in ?? 3600) * 1000) };
    }
    const auth = { headers: { authorization: `Bearer ${t.accessToken}` } };
    const Y = 'https://www.googleapis.com/youtube/v3';
    const warnings: string[] = [], accounts: AccountSnap[] = [], posts: PostSnap[] = [];
    const ch = await getJson<{ items?: { id: string; snippet: { title: string; customUrl?: string }; statistics?: { subscriberCount?: string; videoCount?: string; hiddenSubscriberCount?: boolean }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] }>(f,
      `${Y}/channels?part=snippet,statistics,contentDetails&mine=true`, auth);
    for (const c of ch.items ?? []) {
      accounts.push({ platform: 'youtube', externalId: c.id, handle: c.snippet.customUrl ?? null, name: c.snippet.title, followers: c.statistics?.hiddenSubscriberCount ? null : Number(c.statistics?.subscriberCount ?? 0), postsCount: Number(c.statistics?.videoCount ?? 0), profileUrl: `https://youtube.com/channel/${c.id}` });
      const uploads = c.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) continue;
      const ids: string[] = [];
      let token: string | undefined, stop = false;
      for (let page = 0; page < 4 && !stop; page++) {
        const pl = await getJson<{ items: { contentDetails: { videoId: string; videoPublishedAt?: string } }[]; nextPageToken?: string }>(f, `${Y}/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}${token ? `&pageToken=${token}` : ''}`, auth);
        for (const it of pl.items) { if (it.contentDetails.videoPublishedAt && new Date(it.contentDetails.videoPublishedAt) < since) { stop = true; break; } ids.push(it.contentDetails.videoId); }
        token = pl.nextPageToken; if (!token) break;
      }
      // per-video analytics (watch time, retention), when the analytics permission was granted
      const analytics = new Map<string, { views: number; minutes: number; pct: number; shares: number }>();
      try {
        const q = new URLSearchParams({ ids: 'channel==MINE', startDate: since.toISOString().slice(0, 10), endDate: now.toISOString().slice(0, 10), metrics: 'views,estimatedMinutesWatched,averageViewPercentage,shares', dimensions: 'video', sort: '-views', maxResults: '200' });
        const rep = await getJson<{ rows?: [string, number, number, number, number][] }>(f, `https://youtubeanalytics.googleapis.com/v2/reports?${q}`, auth);
        for (const [id, views, minutes, pct, shares] of rep.rows ?? []) analytics.set(id, { views, minutes, pct, shares });
      } catch (e) { warnings.push(`YouTube Analytics: ${(e as Error).message}`); }
      for (let i = 0; i < ids.length; i += 50) {
        const vs = await getJson<{ items: { id: string; snippet: { publishedAt: string; title: string; description?: string }; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string }; contentDetails?: { duration?: string } }[] }>(f,
          `${Y}/videos?part=snippet,statistics,contentDetails&id=${ids.slice(i, i + 50).join(',')}`, auth);
        for (const v of vs.items) {
          const secs = isoSeconds(v.contentDetails?.duration);
          const a = analytics.get(v.id);
          posts.push({ platform: 'youtube', accountExternalId: c.id, externalId: v.id, postedAt: v.snippet.publishedAt, caption: `${v.snippet.title}\n${(v.snippet.description ?? '').slice(0, 500)}`,
            permalink: `https://youtube.com/watch?v=${v.id}`, durationS: secs, format: secs !== null && secs <= 60 ? 'short' : 'video',
            views: Number(v.statistics?.viewCount ?? a?.views ?? 0), likes: Number(v.statistics?.likeCount ?? 0), comments: Number(v.statistics?.commentCount ?? 0),
            shares: a?.shares ?? null, watchMinutes: a?.minutes ?? null, avgViewPct: a?.pct ?? null });
        }
      }
    }
    if (!accounts.length) warnings.push('This Google account has no YouTube channel. Reconnect with the account that owns the brand’s channel.');
    return { accounts, posts, campaigns: [], warnings, tokens: refreshed };
  },
};

const PROVIDERS = { meta, youtube };
const providerReady = (cfg: SocialConfig | undefined, p: ProviderId) => !!cfg && (p === 'meta' ? !!cfg.meta?.appId && !!cfg.meta.appSecret : !!cfg.google?.clientId && !!cfg.google.clientSecret);

// ===================================================================== flows
export async function startConnect(deps: Deps, ctx: Ctx, provider: string): Promise<{ url: string }> {
  requireRole(ctx, ['marketing_head', 'data_steward'], 'Connecting social accounts');
  if (provider !== 'meta' && provider !== 'youtube') throw new HttpError(400, provider === 'linkedin' ? 'LinkedIn can be connected once LinkedIn approves Vtology’s access request.' : 'Unknown platform.');
  const secret = requireSecret(deps.secretKey);
  if (!providerReady(deps.social, provider)) throw new HttpError(503, provider === 'meta' ? 'Meta is not set up yet: add META_APP_ID and META_APP_SECRET in Vercel and redeploy.' : 'YouTube is not set up yet: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel and redeploy.');
  const state = await signState(secret, { tenantId: ctx.tenantId, userId: ctx.userId, provider });
  return { url: PROVIDERS[provider].authUrl(deps.social!, state) };
}

/** The platform sends the browser back here. Returns where to send the browser next. */
export async function finishConnect(deps: Deps, provider: string, params: URLSearchParams): Promise<string> {
  const back = (q: Record<string, string>) => `${deps.social?.publicUrl.replace(/\/$/, '') ?? ''}/?${new URLSearchParams({ tab: 'social', ...q })}`;
  if (provider !== 'meta' && provider !== 'youtube') return back({ social: 'error', message: 'Unknown platform.' });
  try {
    const secret = requireSecret(deps.secretKey);
    const st = await verifyState(secret, params.get('state') ?? '', provider);
    if (params.get('error')) return back({ social: 'error', provider, message: params.get('error_description') ?? params.get('error_reason') ?? 'Access was not granted.' });
    const code = params.get('code');
    if (!code) return back({ social: 'error', provider, message: 'The platform did not return an approval code.' });
    // the person must still be a member allowed to connect
    const [m] = await deps.db.admin.query<{ role: string }>(`select role from vt.memberships where tenant_id = $1 and user_id = $2`, [st.tenantId, st.userId]);
    if (!m || !['marketing_head', 'data_steward'].includes(m.role)) return back({ social: 'error', provider, message: 'Your role can no longer connect accounts in this workspace.' });
    const f = deps.fetch ?? fetch;
    const got = await PROVIDERS[provider].exchange(deps.social!, f, code);
    const [conn] = await deps.db.admin.query<{ id: string }>(
      `insert into vt.social_connections (tenant_id, provider, label, scopes, status, connected_by, connected_at, last_error)
       values ($1,$2,$3,$4,'active',$5, now(), null)
       on conflict (tenant_id, provider) do update set label = excluded.label, scopes = excluded.scopes, status = 'active', connected_by = excluded.connected_by, connected_at = now(), last_error = null
       returning id`, [st.tenantId, provider, got.label, got.scopes, st.userId]);
    await saveTokens(deps.db.admin, secret, conn!.id, st.tenantId, got.tokens);
    const r = await syncConnection(deps, st.tenantId, conn!.id);
    return back({ social: 'connected', provider, posts: String(r.posts), accounts: String(r.accounts) });
  } catch (e) {
    return back({ social: 'error', provider, message: e instanceof HttpError ? e.message : `The platform refused the connection: ${(e as Error).message}`.slice(0, 300) });
  }
}

async function saveTokens(sql: Sql, secret: string, connectionId: string, tenantId: string, t: Tokens) {
  await sql.query(
    `insert into vt.social_tokens (connection_id, tenant_id, access_token_enc, refresh_token_enc, expires_at, extra_enc, updated_at) values ($1,$2,$3,$4,$5,$6, now())
     on conflict (connection_id) do update set access_token_enc = excluded.access_token_enc, refresh_token_enc = coalesce(excluded.refresh_token_enc, vt.social_tokens.refresh_token_enc),
       expires_at = excluded.expires_at, extra_enc = coalesce(excluded.extra_enc, vt.social_tokens.extra_enc), updated_at = now()`,
    [connectionId, tenantId, encrypt(secret, t.accessToken), t.refreshToken ? encrypt(secret, t.refreshToken) : null, t.expiresAt ?? null, t.extra ? encrypt(secret, JSON.stringify(t.extra)) : null]);
}

export async function syncConnection(deps: Deps, tenantId: string, connectionId: string): Promise<{ accounts: number; posts: number; campaigns: number; leads: number; newLeads: number; warnings: string[] }> {
  const secret = requireSecret(deps.secretKey);
  const [c] = await deps.db.admin.query<{ provider: ProviderId; access_token_enc: string; refresh_token_enc: string | null; expires_at: string | null; industry: Industry; phone_salt: string; connected_by: string | null }>(
    `select c.provider, t.access_token_enc, t.refresh_token_enc, t.expires_at, tn.industry, tn.phone_salt, c.connected_by from vt.social_connections c join vt.social_tokens t on t.connection_id = c.id join vt.tenants tn on tn.id = c.tenant_id
      where c.id = $1 and c.tenant_id = $2`, [connectionId, tenantId]);
  if (!c) throw new HttpError(404, 'Connection not found.');
  const now = deps.now ? deps.now() : new Date();
  const since = new Date(now.getTime() - 180 * 86_400_000);
  const tokens: Tokens = { accessToken: decrypt(secret, c.access_token_enc), refreshToken: c.refresh_token_enc ? decrypt(secret, c.refresh_token_enc) : null, expiresAt: c.expires_at ? new Date(c.expires_at) : null };
  const f = deps.fetch ?? fetch;
  let r: SyncResult;
  try {
    r = c.provider === 'meta' ? await meta.sync(deps.social!, f, tokens, since) : await youtube.sync(deps.social!, f, tokens, since, now);
  } catch (e) {
    const expired = e instanceof PlatformError && e.expired;
    await deps.db.admin.query(`update vt.social_connections set status = $3, last_error = $4 where id = $1 and tenant_id = $2`, [connectionId, tenantId, expired ? 'expired' : 'error', (e as Error).message.slice(0, 500)]);
    throw new HttpError(502, expired ? 'Access to this account has expired or was removed. Reconnect it from the Social tab.' : `Sync failed: ${(e as Error).message}`);
  }
  let newLeads = 0;
  await deps.db.transaction(async sql => {
    if (r.tokens) await saveTokens(sql, secret, connectionId, tenantId, r.tokens);
    const idOf = new Map<string, string>();
    for (const a of r.accounts) {
      const [row] = await sql.query<{ id: string }>(
        `insert into vt.social_accounts (tenant_id, connection_id, platform, external_id, handle, name, followers, posts_count, profile_url, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
         on conflict (tenant_id, platform, external_id) do update set connection_id = excluded.connection_id, handle = excluded.handle, name = excluded.name,
           followers = excluded.followers, posts_count = excluded.posts_count, profile_url = excluded.profile_url, updated_at = now()
         returning id`, [tenantId, connectionId, a.platform, a.externalId, a.handle ?? null, a.name, a.followers ?? null, a.postsCount ?? null, a.profileUrl ?? null]);
      idOf.set(`${a.platform}:${a.externalId}`, row!.id);
      if (a.followers !== null && a.followers !== undefined) await sql.query(
        `insert into vt.social_account_daily (account_id, tenant_id, day, followers) values ($1,$2,$3,$4) on conflict (account_id, day) do update set followers = excluded.followers`,
        [row!.id, tenantId, now.toISOString().slice(0, 10), a.followers]);
    }
    for (const p of r.posts) {
      const accountId = idOf.get(`${p.platform}:${p.accountExternalId}`);
      if (!accountId) continue;
      await sql.query(
        `insert into vt.social_posts (tenant_id, account_id, external_id, posted_at, format, caption, permalink, duration_s, views, reach, likes, comments, shares, saves, watch_minutes, avg_view_pct, metrics_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
         on conflict (tenant_id, account_id, external_id) do update set format = excluded.format, caption = excluded.caption, permalink = excluded.permalink, duration_s = excluded.duration_s,
           views = excluded.views, reach = excluded.reach, likes = excluded.likes, comments = excluded.comments, shares = excluded.shares, saves = excluded.saves,
           watch_minutes = excluded.watch_minutes, avg_view_pct = excluded.avg_view_pct, metrics_at = now()`,
        [tenantId, accountId, p.externalId, p.postedAt, p.format, p.caption ?? null, p.permalink ?? null, p.durationS ?? null, p.views ?? null, p.reach ?? null, p.likes ?? null,
         p.comments ?? null, p.shares ?? null, p.saves ?? null, p.watchMinutes ?? null, p.avgViewPct ?? null]);
    }
    for (const c2 of r.campaigns) await sql.query(
      `insert into vt.campaigns (tenant_id, external_code, name, channel, start_date, end_date, spend_inr, platform_reported_conversions) values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (tenant_id, external_code) do update set name = excluded.name, channel = excluded.channel, start_date = excluded.start_date, end_date = excluded.end_date,
         spend_inr = excluded.spend_inr, platform_reported_conversions = excluded.platform_reported_conversions`,
      [tenantId, c2.externalCode, c2.name, c2.channel, c2.startDate ?? null, c2.endDate ?? null, c2.spendInr, c2.conversions]);
    for (const l of r.leads ?? []) {
      const ref = `metalead:${l.externalId}`;
      const exists = await sql.query(`select 1 from vt.source_records where tenant_id = $1 and source_system = 'Meta lead ads' and external_id = $2 limit 1`, [tenantId, ref]);
      if (exists.length) continue;
      const phone = normalizePhone(l.phone), email = normalizeEmail(l.email);
      const phoneHash = phone ? await hashValue(c.phone_salt, 'phone', phone) : null;
      await sql.query(
        `insert into vt.source_records (tenant_id, source_system, external_id, raw_name, phone_hash, email_hash, pincode, city, payload) values ($1,'Meta lead ads',$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId, ref, l.name, phoneHash, email ? await hashValue(c.phone_salt, 'email', email) : null, l.pincode, l.city,
         JSON.stringify({ created_at: l.createdAt, form: l.formName, page: l.pageName, campaign: l.campaignName })]);
      let campaignId: string | null = null;
      if (l.campaignId) {
        const [cm] = await sql.query<{ id: string }>(
          `insert into vt.campaigns (tenant_id, external_code, name, channel) values ($1,$2,$3,'Meta ads')
           on conflict (tenant_id, external_code) do update set name = vt.campaigns.name returning id`, [tenantId, `meta:${l.campaignId}`, l.campaignName ?? `Meta campaign ${l.campaignId}`]);
        campaignId = cm!.id;
      }
      await sql.query(
        `insert into vt.journeys (tenant_id, external_ref, person_ref, person_phone_hash, campaign_id, stage_index, stage_entered_at, last_activity_at, crm_converted)
         values ($1,$2,$2,$3,$4,0,$5,$5,false) on conflict (tenant_id, external_ref) do nothing`, [tenantId, ref, phoneHash, campaignId, l.createdAt]);
      newLeads++;
    }
    await sql.query(`update vt.social_connections set status = 'active', last_sync_at = now(), last_error = $3 where id = $1 and tenant_id = $2`,
      [connectionId, tenantId, r.warnings.length ? r.warnings.join(' | ').slice(0, 1000) : null]);
  });
  // new leads: resolve them into customers and refresh findings
  if (newLeads > 0 && c.connected_by) {
    try { await runPipeline(await loadContext(deps, c.connected_by, tenantId)); }
    catch (e) { r.warnings.push(`Leads saved; run matching on the Data tab to link them (${(e as Error).message}).`); }
  }
  return { accounts: r.accounts.length, posts: r.posts.length, campaigns: r.campaigns.length, leads: r.leads?.length ?? 0, newLeads, warnings: r.warnings };
}

export async function syncTenant(deps: Deps, ctx: Ctx) {
  requireRole(ctx, ['marketing_head', 'data_steward', 'sales_ops'], 'Syncing social accounts');
  const conns = await deps.db.admin.query<{ id: string; provider: string }>(`select id, provider from vt.social_connections where tenant_id = $1 and provider <> 'sample'`, [ctx.tenantId]);
  if (!conns.length) throw new HttpError(409, 'No social accounts are connected yet.');
  const out: Record<string, unknown> = {};
  for (const c of conns) {
    try { out[c.provider] = await syncConnection(deps, ctx.tenantId, c.id); }
    catch (e) { out[c.provider] = { error: (e as Error).message }; }
  }
  return out;
}

/** Daily job: sync every connected account in every workspace. */
export async function syncAll(deps: Deps) {
  const conns = await deps.db.admin.query<{ id: string; tenant_id: string }>(`select id, tenant_id from vt.social_connections where provider <> 'sample' and status in ('active', 'error') order by last_sync_at nulls first limit 50`);
  let ok = 0, failed = 0;
  for (const c of conns) { try { await syncConnection(deps, c.tenant_id, c.id); ok++; } catch { failed++; } }
  return { ok, failed };
}

export async function disconnect(ctx: Ctx, connectionId: string) {
  requireRole(ctx, ['marketing_head', 'data_steward'], 'Disconnecting social accounts');
  const r = await ctx.db.admin.query(`delete from vt.social_connections where id = $1 and tenant_id = $2 returning id`, [connectionId, ctx.tenantId]);
  if (!r.length) throw new HttpError(404, 'Connection not found.');
  return { disconnected: true };
}

// ===================================================================== reading
export async function socialOverview(deps: Deps, ctx: Ctx) {
  if (['partner_user', 'relationship_manager'].includes(ctx.role)) throw new HttpError(403, 'Social insights are not part of your role’s view.');
  // paid campaigns against the pipeline they produced (spend only for roles that see money)
    const seesMoney = ['marketing_head', 'finance'].includes(ctx.role);
    const campaigns = await deps.db.admin.query<{ code: string; name: string; channel: string; spend: string; platform_conversions: number; journeys: number; progressed: number; converted: number }>(
      `select c.external_code as code, c.name, c.channel, c.spend_inr as spend, c.platform_reported_conversions as platform_conversions,
              count(j.id)::int as journeys, count(j.id) filter (where j.stage_index > 0)::int as progressed, count(j.id) filter (where j.crm_converted)::int as converted
         from vt.campaigns c left join vt.journeys j on j.campaign_id = c.id
        where c.tenant_id = $1 group by c.id order by c.spend_inr desc`, [ctx.tenantId]);
  return ctx.db.asUser(ctx.userId, async sql => {
    const connections = await sql.query<{ id: string; provider: string; label: string; status: string; scopes: string[]; connected_at: string; last_sync_at: string | null; last_error: string | null }>(
      `select id, provider, label, status, scopes, connected_at, last_sync_at, last_error from vt.social_connections where tenant_id = $1 order by provider`, [ctx.tenantId]);
    const accountsRaw = await sql.query<{ id: string; platform: SocialPost['platform']; name: string; handle: string | null; followers: number | null; posts_count: number | null; profile_url: string | null; is_competitor: boolean }>(
      `select id, platform, name, handle, followers, posts_count, profile_url, is_competitor from vt.social_accounts where tenant_id = $1 order by platform, name`, [ctx.tenantId]);
    const postsRaw = await sql.query<{ id: string; account_id: string; posted_at: string; format: string; caption: string | null; permalink: string | null; views: string | null; reach: string | null; likes: string | null; comments: string | null; shares: string | null; saves: string | null; watch_minutes: string | null; avg_view_pct: string | null }>(
      `select id, account_id, posted_at, format, caption, permalink, views, reach, likes, comments, shares, saves, watch_minutes, avg_view_pct
         from vt.social_posts where tenant_id = $1 and posted_at > now() - interval '200 days' order by posted_at desc limit 2000`, [ctx.tenantId]);
    const num = (x: string | null) => (x === null ? null : Number(x));
    const platformOf = new Map(accountsRaw.map(a => [a.id, a.platform]));
    const accounts: SocialAccount[] = accountsRaw.map(a => ({ id: a.id, platform: a.platform, name: a.name, handle: a.handle, followers: a.followers }));
    const posts: SocialPost[] = postsRaw.map(p => ({ id: p.id, accountId: p.account_id, platform: platformOf.get(p.account_id)!, postedAt: new Date(p.posted_at), format: p.format, caption: p.caption, permalink: p.permalink,
      views: num(p.views), reach: num(p.reach), likes: num(p.likes), comments: num(p.comments), shares: num(p.shares), saves: num(p.saves), watchMinutes: num(p.watch_minutes), avgViewPct: num(p.avg_view_pct) }));
    const analysis = analyzeSocial(ctx.industry, accounts, posts, ctx.now);
    return {
      canConnect: ['marketing_head', 'data_steward'].includes(ctx.role),
      providers: { meta: providerReady(deps.social, 'meta'), youtube: providerReady(deps.social, 'youtube'), linkedin: false, secret: !!deps.secretKey && deps.secretKey.length >= 32 },
      connections, accounts: accountsRaw, analysis,
      campaigns: campaigns.map(c => ({ ...c, spend: seesMoney ? Number(c.spend) : null })),
    };
  });
}
