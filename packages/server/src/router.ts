/**
 * Framework-free HTTP router: takes a standard Request, returns a standard Response.
 * Next.js route handlers, tests and any other runtime can all call `handle`.
 */
import { z } from 'zod';
import { authenticate, loadContext, HttpError, type Deps } from './context';
import { importCsv } from './imports';
import { runPipeline } from './pipeline';
import { listJourneys, listPartners, listViolations, listActions, me } from './queries';
import { requestAction, decideAction } from './actions';
import { signIn, refreshSession } from './auth';
import { listWorkspaces, createWorkspace, switchSampleRole } from './workspaces';
import { schemaReady } from './schema';
import { startConnect, finishConnect, socialOverview, syncTenant, syncAll, syncConnection, disconnect, growthOverview, addCompetitor, removeCompetitor } from './social';
import { ROLES, type RoleCode } from '@vtology/core';
import { listSources, createSource, updateSource, deleteSource, syncSource, syncTenantSources, dueSources } from './sources';
import { listOffline, createOffline, appendOffline, finishOffline, deleteOffline, crossMediaOverview } from './crossmedia';
import { contentOverview, addTopics, removeTopic, suggestTopics, scanTopics, videoRetention, contentTrends, refreshAllTrends, checkTrendRanksNow } from './content';
import { healthSummary } from './health';
import { listReports, createReport, appendMediaRows, finishReport, deleteReport, mediaOverview } from './media';
import { listAudiences, createList, appendRows, finishList, deleteList, createBucket, updateBucket, previewBucket, deleteBucket, computeBucket, exportBucket, purgeAllExpired } from './audiences';

const MappingSchema = z.object({
  entity: z.enum(['lead', 'journey_event', 'transaction', 'campaign', 'partner', 'consent']),
  sourceSystem: z.string().min(1),
  fields: z.record(z.string(), z.union([z.string(), z.object({ column: z.string().optional(), transform: z.enum(['trim', 'upper', 'lower', 'number', 'date', 'bool']).optional(), default: z.union([z.string(), z.number(), z.boolean()]).optional() })])),
});
const ImportSchema = z.object({ mapping: MappingSchema, csv: z.string().min(1).max(20_000_000), fileName: z.string().optional() });
const LoginSchema = z.object({ email: z.string().trim().email('Enter a valid email address.'), password: z.string().min(1, 'Enter your password.') });
const RefreshSchema = z.object({ refreshToken: z.string().min(10) });
const WorkspaceSchema = z.object({ name: z.string().trim().min(2, 'Give the workspace a name.').max(80), industry: z.enum(['Automotive', 'BFSI', 'FMCG']), sample: z.boolean().default(false) });
const RoleSchema = z.object({ role: z.enum(Object.keys(ROLES) as [RoleCode, ...RoleCode[]]) });
const ActionSchema = z.object({ type: z.string(), objectId: z.string().min(1), newPartnerId: z.string().uuid().optional(), reason: z.string().max(500).optional() });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new HttpError(400, 'The request body must be JSON.'); }
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(400, 'The request body is not valid.', r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`));
  return r.data;
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  try {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    if (parts[0] === 'health') return json(200, { ok: true, service: 'vtology', version: '0.2.0' });
    const top = `${req.method} ${parts.join('/')}`;
    if (top === 'GET auth/config') return json(200, { mode: deps.localSecret ? 'local' : 'supabase', ready: !!(deps.localSecret || (deps.supabaseUrl && deps.supabaseKey)) });
    if (top === 'POST auth/login') { const b = await body(req, LoginSchema); return json(200, await signIn(deps, b.email, b.password)); }
    if (top === 'POST auth/refresh') return json(200, await refreshSession(deps, (await body(req, RefreshSchema)).refreshToken));

    await schemaReady(deps.db);
    // the platform sends the browser back here after the brand approves access; verified by the signed state
    const cb = top.match(/^GET social\/callback\/([a-z]+)$/);
    if (cb) return new Response(null, { status: 302, headers: { location: await finishConnect(deps, cb[1]!, url.searchParams) } });
    if (top === 'GET cron/social-sync' || top === 'POST cron/social-sync') {
      // who may run it: Vercel's scheduler (with CRON_SECRET when set, else its own user agent), or
      // this server calling itself for one connection (a key derived from the server's secret)
      const internalKey = deps.secretKey ? await internalCronKey(deps.secretKey) : undefined;
      const internal = !!internalKey && req.headers.get('x-vt-internal') === internalKey;
      const fromScheduler = deps.cronSecret ? req.headers.get('authorization') === `Bearer ${deps.cronSecret}` : /vercel-cron/i.test(req.headers.get('user-agent') ?? '');
      if (!internal && !fromScheduler) throw new HttpError(401, 'Not allowed.');
      const one = url.searchParams.get('connection'), tenant = url.searchParams.get('tenant');
      const src = url.searchParams.get('source');
      if (internal && src && tenant) {
        const r = await syncSource(deps, tenant, src);
        console.log(`[vtology] daily sync, source ${src}: ${r.leads} leads (${r.newLeads} new, ${r.moved} moved on)${r.more ? ', more next run' : ''}`);
        return json(200, r);
      }
      if (internal && one && tenant) {
        const r = await syncConnection(deps, tenant, one);
        console.log(`[vtology] daily sync, connection ${one}: ${r.accounts} accounts, ${r.posts} posts${r.warnings.length ? `; ${r.warnings.length} warnings` : ''}`);
        return json(200, r);
      }
      const [r, s, purged, trends] = await Promise.all([syncAll(deps, { selfUrl: deps.social?.publicUrl, internalKey }), syncAllSources(deps, { selfUrl: deps.social?.publicUrl, internalKey }), purgeAllExpired(deps), refreshAllTrends(deps).catch(() => ({ due: 0, ok: 0, ranked: 0 }))]);
      console.log(`[vtology] daily sync: ${r.started} connections due, ${r.ok} synced, ${r.failed} failed; ${s.started} data sources due, ${s.ok} pulled, ${s.failed} failed; ${purged} expired audience lists deleted; top searches refreshed for ${trends.ok} of ${trends.due} workspaces`);
      return json(200, { ...r, sources: s, expiredLists: purged, trends });
    }
    const userId = await authenticate(req, deps);
    if (top === 'GET workspaces') return json(200, await listWorkspaces(deps, userId));
    if (top === 'POST workspaces') return json(201, await createWorkspace(deps, userId, await body(req, WorkspaceSchema)));
    if (parts[0] !== 'tenants' || !parts[1]) throw new HttpError(404, 'Not found.');

    const ctx = await loadContext(deps, userId, parts[1]);
    const route = `${req.method} ${parts.slice(2).join('/')}`;

    if (route === 'GET me') return json(200, await me(ctx));
    if (route === 'GET summary') return json(200, await healthSummary(ctx));
    if (route === 'GET social') return json(200, await socialOverview(deps, ctx, rangeParam(url, ctx.now, 180)));
    if (route === 'POST social/sync') return json(200, await syncTenant(deps, ctx));
    if (route === 'GET social/growth') {
      const per = url.searchParams.get('period');
      const pl = url.searchParams.get('platform');
      const range = url.searchParams.get('from') ? rangeParam(url, ctx.now, 30) : (per === 'week' || per === 'quarter' ? per : 'month');
      return json(200, await growthOverview(deps, ctx, range, pl && ['instagram', 'facebook', 'youtube'].includes(pl) ? pl : null));
    }
    // ---- connected data sources (dealer dashboards, DMS, CRM feeds)
    if (route === 'GET sources') return json(200, await listSources(ctx));
    if (route === 'POST sources') return json(201, await createSource(deps, ctx, await req.json().catch(() => ({}))));
    if (route === 'POST sources/sync') return json(200, await syncTenantSources(deps, ctx));
    if (route === 'POST sources/sync-due') {
      // opening the app pulls any source not pulled in the last hour (the scheduler only runs daily)
      if (!['marketing_head', 'data_steward', 'sales_ops'].includes(ctx.role)) return json(200, { pulled: 0, results: {} });
      const due = await dueSources(deps, ctx.tenantId);
      const out: Record<string, unknown> = {};
      for (const d of due) { try { out[d.id] = await syncSource(deps, ctx.tenantId, d.id, 25_000); } catch (e) { out[d.id] = { error: (e as Error).message }; } }
      return json(200, { pulled: due.length, results: out });
    }
    const ss = route.match(/^(PATCH|DELETE|POST) sources\/([0-9a-f-]{36})(\/sync)?$/);
    if (ss) {
      if (ss[1] === 'PATCH' && !ss[3]) return json(200, await updateSource(deps, ctx, ss[2]!, await req.json().catch(() => ({}))));
      if (ss[1] === 'DELETE' && !ss[3]) return json(200, await deleteSource(ctx, ss[2]!));
      if (ss[1] === 'POST' && ss[3]) {
        if (!['marketing_head', 'data_steward', 'sales_ops'].includes(ctx.role)) throw new HttpError(403, 'Your role cannot sync data sources.');
        return json(200, await syncSource(deps, ctx.tenantId, ss[2]!));
      }
    }
    // ---- content: outliers, topics people search, video checks and retention
    if (route === 'GET content') return json(200, await contentOverview(deps, ctx, rangeParam(url, ctx.now, 90)));
    if (route === 'POST content/topics') return json(201, await addTopics(ctx, await req.json().catch(() => ({}))));
    if (route === 'POST content/topics/scan') return json(200, await scanTopics(deps, ctx, await req.json().catch(() => ({}))));
    if (route === 'GET content/trends') return json(200, await contentTrends(deps, ctx));
    if (route === 'POST content/trends/ranks') return json(200, await checkTrendRanksNow(deps, ctx));
    if (route === 'GET content/topics/suggest') return json(200, await suggestTopics(deps, ctx, url.searchParams.get('q') ?? ''));
    const ct = route.match(/^DELETE content\/topics\/([0-9a-f-]{36})$/);
    if (ct) return json(200, await removeTopic(ctx, ct[1]!));
    const cv = route.match(/^GET content\/videos\/([0-9a-f-]{36})\/retention$/);
    if (cv) return json(200, await videoRetention(deps, ctx, cv[1]!));
    // ---- media: DSP delivery reports for awareness analysis (CTV, audio, video, display)
    // ---- all media together: TV, print, radio, outdoor and results next to digital
    if (route === 'GET crossmedia') return json(200, await crossMediaOverview(ctx, rangeParam(url, ctx.now, 180)));
    if (route === 'GET crossmedia/reports') return json(200, await listOffline(ctx));
    if (route === 'POST crossmedia/reports') return json(201, await createOffline(ctx, await req.json().catch(() => ({}))));
    const om = route.match(/^(POST|DELETE) crossmedia\/reports\/([0-9a-f-]{36})(\/rows|\/finish)?$/);
    if (om) {
      if (om[1] === 'DELETE' && !om[3]) return json(200, await deleteOffline(ctx, om[2]!));
      if (om[3] === '/rows') return json(200, await appendOffline(ctx, om[2]!, await req.json().catch(() => ({}))));
      if (om[3] === '/finish') return json(200, await finishOffline(ctx, om[2]!));
    }
    if (route === 'GET media') return json(200, await mediaOverview(ctx, rangeParam(url, ctx.now, 30), { channel: url.searchParams.get('channel'), report: url.searchParams.get('report') }));
    if (route === 'GET media/reports') return json(200, await listReports(ctx));
    if (route === 'POST media/reports') return json(201, await createReport(ctx, await req.json().catch(() => ({}))));
    const mr = route.match(/^(POST|DELETE) media\/reports\/([0-9a-f-]{36})(?:\/(rows|finish))?$/);
    if (mr) {
      if (mr[1] === 'POST' && mr[3] === 'rows') return json(200, await appendMediaRows(ctx, mr[2]!, await req.json().catch(() => ({}))));
      if (mr[1] === 'POST' && mr[3] === 'finish') return json(200, await finishReport(ctx, mr[2]!));
      if (mr[1] === 'DELETE' && !mr[3]) return json(200, await deleteReport(ctx, mr[2]!));
    }
    // ---- audiences: hashed lists, buckets with holdouts, logged exports
    if (route === 'GET audiences') return json(200, await listAudiences(ctx));
    if (route === 'POST audiences/lists') return json(201, await createList(ctx, await req.json().catch(() => ({}))));
    if (route === 'POST audiences/buckets') return json(201, await createBucket(ctx, await req.json().catch(() => ({}))));
    if (route === 'POST audiences/buckets/preview') return json(200, await previewBucket(ctx, await req.json().catch(() => ({}))));
    const al = route.match(/^(POST|DELETE) audiences\/lists\/([0-9a-f-]{36})(?:\/(rows|finish))?$/);
    if (al) {
      if (al[1] === 'POST' && al[3] === 'rows') return json(200, await appendRows(ctx, al[2]!, await req.json().catch(() => ({}))));
      if (al[1] === 'POST' && al[3] === 'finish') return json(200, await finishList(ctx, al[2]!));
      if (al[1] === 'DELETE' && !al[3]) return json(200, await deleteList(ctx, al[2]!));
    }
    const ab = route.match(/^(PATCH|DELETE|POST|GET) audiences\/buckets\/([0-9a-f-]{36})(?:\/(refresh|export))?$/);
    if (ab) {
      if (ab[1] === 'PATCH' && !ab[3]) return json(200, await updateBucket(ctx, ab[2]!, await req.json().catch(() => ({}))));
      if (ab[1] === 'DELETE' && !ab[3]) return json(200, await deleteBucket(ctx, ab[2]!));
      if (ab[1] === 'POST' && ab[3] === 'refresh') {
        if (!['marketing_head', 'data_steward'].includes(ctx.role)) throw new HttpError(403, 'Your role cannot refresh buckets.');
        return json(200, await computeBucket(ctx.db.admin, ctx.tenantId, ab[2]!));
      }
      if (ab[1] === 'GET' && ab[3] === 'export') return json(200, await exportBucket(ctx, ab[2]!, url));
    }
    if (route === 'POST social/competitors') {
      const b = await req.json().catch(() => ({})) as { platform?: unknown; handle?: unknown };
      if (typeof b.platform !== 'string' || typeof b.handle !== 'string') throw new HttpError(400, 'Send a platform and a handle.');
      return json(201, await addCompetitor(deps, ctx, b.platform, b.handle));
    }
    const rc = route.match(/^DELETE social\/competitors\/([0-9a-f-]{36})$/);
    if (rc) return json(200, await removeCompetitor(ctx, rc[1]!));
    const sc = route.match(/^POST social\/connect\/([a-z]+)$/);
    if (sc) return json(200, await startConnect(deps, ctx, sc[1]!));
    const sd = route.match(/^DELETE social\/([0-9a-f-]{36})$/);
    if (sd) return json(200, await disconnect(ctx, sd[1]!));
    if (route === 'POST sample/role') return json(200, await switchSampleRole(ctx, (await body(req, RoleSchema)).role));
    if (route === 'POST imports') return json(201, await importCsv(ctx, await body(req, ImportSchema)));
    if (route === 'POST pipeline/run') return json(200, await runPipeline(ctx));
    if (route === 'GET journeys') return json(200, await listJourneys(ctx, { stalledOnly: url.searchParams.get('stalled') === 'true' }));
    if (route === 'GET partners') return json(200, await listPartners(ctx));
    // names only, so anyone (including partner users) can pick a partner when requesting a reassignment
    if (route === 'GET partners/directory') return json(200, await ctx.db.admin.query(`select id, name, city from vt.partners where tenant_id = $1 and active order by name`, [ctx.tenantId]));
    if (route === 'GET violations') return json(200, await listViolations(ctx));
    if (route === 'GET actions') return json(200, await listActions(ctx));
    if (route === 'POST actions') return json(201, await requestAction(ctx, await body(req, ActionSchema)));
    const m = route.match(/^POST actions\/([0-9a-f-]{36})\/(approve|reject)$/);
    if (m) return json(200, await decideAction(ctx, m[1]!, m[2] === 'approve'));
    throw new HttpError(404, 'Not found.');
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message, details: e.details });
    console.error(e);
    // a short reason helps whoever reports it; no stack, no data
    const reason = String((e as Error)?.message ?? '').replace(/\s+/g, ' ').slice(0, 160);
    return json(500, { error: `Something went wrong on our side${reason ? ` (${reason})` : ''}. The error has been logged.` });
  }
}

/** A key only this server can derive, for calling itself from the daily job. */
async function internalCronKey(secret: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`vtology-cron:${secret}`));
  return Buffer.from(d).toString('hex');
}

/** ?from=YYYY-MM-DD&to=YYYY-MM-DD (both included); defaults to the last `days` days. At most 2 years back, 400 days long. */
function rangeParam(url: URL, now: Date, days: number): { from: string; to: string } {
  const ok = (x: string | null) => !!x && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(x));
  const today = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  let to = url.searchParams.get('to'), from = url.searchParams.get('from');
  if (!ok(to) || to! > today) to = today;
  if (!ok(from) || from! > to!) from = new Date(Date.parse(to!) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const earliest = new Date(Date.parse(today) - 730 * 86_400_000).toISOString().slice(0, 10);
  if (from! < earliest) from = earliest;
  if (Date.parse(to!) - Date.parse(from!) > 400 * 86_400_000) from = new Date(Date.parse(to!) - 400 * 86_400_000).toISOString().slice(0, 10);
  return { from: from!, to: to! };
}

/** Daily: every data source due for a pull, each in its own request (own time limit), in parallel. */
async function syncAllSources(deps: Deps, opts: { selfUrl?: string; internalKey?: string }) {
  const due = await dueSources(deps);
  if (opts.selfUrl && opts.internalKey) {
    const f = deps.fetch ?? fetch;
    const results = await Promise.allSettled(due.map(d => f(`${opts.selfUrl}/api/cron/social-sync?source=${d.id}&tenant=${d.tenant_id}`, { method: 'POST', headers: { 'x-vt-internal': opts.internalKey! }, signal: AbortSignal.timeout(55_000) })
      .then(r => { if (!r.ok) throw new Error(String(r.status)); })));
    return { started: due.length, ok: results.filter(r => r.status === 'fulfilled').length, failed: results.filter(r => r.status === 'rejected').length };
  }
  let ok = 0, failed = 0;
  await Promise.all(due.map(async d => { try { await syncSource(deps, d.tenant_id, d.id); ok++; } catch { failed++; } }));
  return { started: due.length, ok, failed };
}
